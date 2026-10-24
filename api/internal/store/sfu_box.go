package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The on-demand video server's state (migrations/0152, api/internal/api/sfu_box.go).
 *
 * The manager changes a row only while it holds the row's lease (TakeSFUBoxLease), and every
 * write is conditional on still holding it, so two ticks can never both decide to create a
 * droplet. Joins write only requested_until (RequestSFUBox) and the booting → ready promotion
 * (MarkSFUBoxReady), both safe without the lease. */

// Box states (SFUBoxState.Actual).
const (
	BoxDown     = "down"
	BoxCreating = "creating"
	BoxBooting  = "booting"
	BoxReady    = "ready"
	BoxDraining = "draining"
	BoxDeleting = "deleting"
	BoxFailed   = "failed"
)

// SFUBoxState is one project's row.
type SFUBoxState struct {
	Project        string
	Desired        string
	Actual         string
	DropletID      int64
	Since          time.Time
	LastError      string
	Failures       int
	NextAttemptAt  *time.Time
	LastNeededAt   *time.Time
	RequestedUntil *time.Time
	AlertedAt      *time.Time
	UpdatedAt      time.Time
}

const sfuBoxCols = `project, desired, actual, coalesce(droplet_id, 0), since, last_error, failures,
	next_attempt_at, last_needed_at, requested_until, alerted_at, updated_at`

func scanSFUBox(row pgx.Row) (SFUBoxState, error) {
	var b SFUBoxState
	err := row.Scan(&b.Project, &b.Desired, &b.Actual, &b.DropletID, &b.Since, &b.LastError, &b.Failures,
		&b.NextAttemptAt, &b.LastNeededAt, &b.RequestedUntil, &b.AlertedAt, &b.UpdatedAt)
	return b, err
}

// EnsureSFUBox makes the project's row (down) if it has none.
func (s *Store) EnsureSFUBox(ctx context.Context, project string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sfu_box_state (project) VALUES ($1) ON CONFLICT (project) DO NOTHING`, project)
	return err
}

// SFUBox reads the project's row; ErrNotFound when it has none yet.
func (s *Store) SFUBox(ctx context.Context, project string) (SFUBoxState, error) {
	b, err := scanSFUBox(s.pool.QueryRow(ctx, `SELECT `+sfuBoxCols+` FROM sfu_box_state WHERE project = $1`, project))
	if errors.Is(err, pgx.ErrNoRows) {
		return b, ErrNotFound
	}
	return b, err
}

/* TakeSFUBoxLease takes the row for ttl. ok=false (nil error) is somebody else holding it:
 * skip, they are acting. It never waits on a row lock (SKIP LOCKED): a row locked by another
 * backend reads as held, rather than the step waiting out its deadline on it. The holder token must be passed to SaveSFUBox and ReleaseSFUBoxLease. */
func (s *Store) TakeSFUBoxLease(ctx context.Context, project string, ttl time.Duration) (holder string, b SFUBoxState, ok bool, err error) {
	if err := s.EnsureSFUBox(ctx, project); err != nil {
		return "", b, false, err
	}
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", b, false, err
	}
	holder = hex.EncodeToString(raw[:])
	b, err = scanSFUBox(s.pool.QueryRow(ctx, `
		UPDATE sfu_box_state
		   SET lease_holder = $2, lease_until = now() + make_interval(secs => $3)
		 WHERE project = (SELECT project FROM sfu_box_state
		                   WHERE project = $1 AND (lease_until IS NULL OR lease_until <= now())
		                   FOR UPDATE SKIP LOCKED)
		 RETURNING `+sfuBoxCols, project, holder, ttl.Seconds()))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", b, false, nil
	}
	if err != nil {
		return "", b, false, err
	}
	return holder, b, true, nil
}

// ReleaseSFUBoxLease gives the row back early.
func (s *Store) ReleaseSFUBoxLease(ctx context.Context, project, holder string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sfu_box_state SET lease_holder = '', lease_until = NULL
		 WHERE project = $1 AND lease_holder = $2`, project, holder)
	return err
}

// ErrLeaseLost is a save by a holder whose lease expired and was taken by someone else.
var ErrLeaseLost = errors.New("sfu box: lease lost")

/* SaveSFUBox writes what the manager decided, if holder still has the lease. Leaves
 * requested_until alone: joins write it at any time. */
func (s *Store) SaveSFUBox(ctx context.Context, holder string, b SFUBoxState) error {
	var droplet *int64
	if b.DropletID != 0 {
		droplet = &b.DropletID
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE sfu_box_state
		   SET desired = $3, actual = $4, droplet_id = $5, since = $6, last_error = $7, failures = $8,
		       next_attempt_at = $9, last_needed_at = $10, alerted_at = $11, updated_at = now()
		 WHERE project = $1 AND lease_holder = $2 AND lease_until > now()`,
		b.Project, holder, b.Desired, b.Actual, droplet, b.Since, b.LastError, b.Failures,
		b.NextAttemptAt, b.LastNeededAt, b.AlertedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// RequestSFUBox marks the box wanted until at least until (a join, a Start, an instant session).
func (s *Store) RequestSFUBox(ctx context.Context, project string, until time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sfu_box_state (project, requested_until) VALUES ($1, $2)
		ON CONFLICT (project) DO UPDATE
		   SET requested_until = GREATEST(coalesce(sfu_box_state.requested_until, $2), $2)`,
		project, until)
	return err
}

// RetrySFUBox lets the next step try again now (the host's "Try again" after a failure).
func (s *Store) RetrySFUBox(ctx context.Context, project string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sfu_box_state SET next_attempt_at = now() WHERE project = $1`, project)
	return err
}

/* MarkSFUBoxReady promotes a booting box to ready from a join's own readiness probe, without
 * the lease: conditional on the same droplet still booting, so it can only race with itself. */
func (s *Store) MarkSFUBoxReady(ctx context.Context, project string, dropletID int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sfu_box_state
		   SET actual = 'ready', since = now(), failures = 0, last_error = '', next_attempt_at = NULL,
		       updated_at = now()
		 WHERE project = $1 AND actual = 'booting' AND droplet_id = $2`, project, dropletID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE sfu_box_runs SET ready_at = coalesce(ready_at, now())
		 WHERE project = $1 AND droplet_id = $2`, project, dropletID)
	return true, err
}

// StartSFUBoxRun records a droplet's life starting at created.
func (s *Store) StartSFUBoxRun(ctx context.Context, project string, dropletID int64, created time.Time) error {
	if created.IsZero() {
		created = time.Now()
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sfu_box_runs (project, droplet_id, created_at) VALUES ($1, $2, $3)
		ON CONFLICT (project, droplet_id) DO NOTHING`, project, dropletID, created)
	return err
}

// ReadySFUBoxRun stamps when the droplet first answered.
func (s *Store) ReadySFUBoxRun(ctx context.Context, project string, dropletID int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sfu_box_runs SET ready_at = coalesce(ready_at, now())
		 WHERE project = $1 AND droplet_id = $2`, project, dropletID)
	return err
}

// EndSFUBoxRun records the droplet gone.
func (s *Store) EndSFUBoxRun(ctx context.Context, project string, dropletID int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sfu_box_runs SET deleted_at = coalesce(deleted_at, now())
		 WHERE project = $1 AND droplet_id = $2`, project, dropletID)
	return err
}

/* SFUBoxHours is how many droplet-hours of project fall inside [lo, hi), from sfu_box_runs
 * (an open run counts to now), and when tracking began (the first run's start): before
 * that the box was not managed, and ran around the clock. ok=false when there are no runs. */
func (s *Store) SFUBoxHours(ctx context.Context, project string, lo, hi time.Time) (hours float64, since time.Time, ok bool, err error) {
	var first *time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(extract(epoch FROM
		         least(coalesce(deleted_at, now()), $3) - greatest(created_at, $2))
		       ) FILTER (WHERE least(coalesce(deleted_at, now()), $3) > greatest(created_at, $2)), 0) / 3600.0,
		       min(created_at)
		  FROM sfu_box_runs WHERE project = $1`, project, lo, hi).Scan(&hours, &first)
	if err != nil || first == nil {
		return 0, time.Time{}, false, err
	}
	return hours, *first, true, nil
}

// SFUBoxDemand is what keeps a box wanted, counted for one project.
type SFUBoxDemand struct {
	Live       int // live sessions, and simulives with the doors open
	Soon       int // scheduled to start within the warm lead (or up to 30 min late)
	Recordings int // recordings still recording or processing (uploads from the box)
	// NextStart is the earliest scheduled start among Soon.
	NextStart *time.Time
	// LastEnded is the latest end of a session on the project in the last day.
	LastEnded *time.Time
}

// boxProjectOf is the project a webinar row resolves to (the same order as LiveSessions).
const boxProjectOf = `CASE WHEN coalesce(w.venue, 'app') LIKE 'zoom%' THEN 'zoom'
	ELSE coalesce(NULLIF(w.sfu_project, ''), NULLIF(u.sfu_project, ''), $2) END`

// boxLateStart is how long after its start a scheduled session that has not begun keeps the box.
const boxLateStart = 30 * time.Minute

// SFUBoxDemand counts what needs project's box now. defaultProject is where an unpinned
// session of a host with no assignment goes.
func (s *Store) SFUBoxDemand(ctx context.Context, project, defaultProject string, warmLead time.Duration) (SFUBoxDemand, error) {
	var d SFUBoxDemand
	err := s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		    WHERE (w.status = 'live' OR (w.status = 'scheduled' AND w.kind = 'simulive' AND w.simulive_doors_open))
		      AND `+boxProjectOf+` = $1),
		  (SELECT count(*) FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		    WHERE w.status = 'scheduled'
		      AND w.starts_at <= now() + make_interval(secs => $3)
		      AND w.starts_at >= now() - make_interval(secs => $4)
		      AND `+boxProjectOf+` = $1),
		  (SELECT min(w.starts_at) FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		    WHERE w.status = 'scheduled'
		      AND w.starts_at <= now() + make_interval(secs => $3)
		      AND w.starts_at >= now() - make_interval(secs => $4)
		      AND `+boxProjectOf+` = $1),
		  (SELECT count(*) FROM recordings r JOIN webinars w ON w.id = r.webinar_id
		     LEFT JOIN users u ON u.id = w.host_id
		    WHERE r.status IN ('recording', 'processing')
		      AND r.created_at > now() - interval '12 hours'
		      AND `+boxProjectOf+` = $1),
		  (SELECT max(w.ended_at) FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		    WHERE w.ended_at > now() - interval '1 day'
		      AND `+boxProjectOf+` = $1)`,
		project, defaultProject, warmLead.Seconds(), boxLateStart.Seconds()).
		Scan(&d.Live, &d.Soon, &d.NextStart, &d.Recordings, &d.LastEnded)
	return d, err
}

// FinalizingOn is FinalizingSessions for one project.
func (s *Store) FinalizingOn(ctx context.Context, project, defaultProject string) (int, error) {
	all, err := s.FinalizingSessions(ctx, defaultProject)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, f := range all {
		if f.Project == project {
			n++
		}
	}
	return n, nil
}

// SFUBoxRecentRuns is the last n droplets of project, newest first, for the admin status.
func (s *Store) SFUBoxRecentRuns(ctx context.Context, project string, n int) ([]SFUBoxRun, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT droplet_id, created_at, ready_at, deleted_at FROM sfu_box_runs
		 WHERE project = $1 ORDER BY created_at DESC LIMIT $2`, project, n)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (SFUBoxRun, error) {
		var r SFUBoxRun
		err := row.Scan(&r.DropletID, &r.CreatedAt, &r.ReadyAt, &r.DeletedAt)
		return r, err
	})
}

// SFUBoxRun is one droplet's life.
type SFUBoxRun struct {
	DropletID int64
	CreatedAt time.Time
	ReadyAt   *time.Time
	DeletedAt *time.Time
}

// AdminUserIDs are the admin accounts, for alerts in the bell and by push.
func (s *Store) AdminUserIDs(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM users WHERE is_admin ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
