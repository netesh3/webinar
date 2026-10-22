package store

import (
	"context"
	"time"
)

/* A simulive goes live and ends on its own.
 *
 * At starts_at the recording starts playing for everyone ("auto", the default — a "manual"
 * one waits for the host's Start Simulive), and once the original session's length has
 * played the session is over. The API runs on Cloud Run, where a process has CPU only while
 * it answers a request, so neither moment can wait for a clock to tick: every request that
 * touches a simulive (its page, join, the replay, the host's page) asks StartSimuliveIfDue /
 * EndSimuliveIfDue, and the sweeper asks the same questions when it runs. Each is one
 * guarded UPDATE: whichever caller's statement reaches the row first makes the transition
 * and is told so (true); every other caller, at the same moment or later, matches nothing.
 * So the work that follows a transition runs exactly once.
 *
 * The session's length is how long the ORIGINAL session ran from the moment its recording
 * began (the original's ended_at − the recording's created_at), or the recording's own length
 * when that is shorter or the original's end is unknown; the scheduled duration only when
 * neither is known. Thirty seconds of grace follow, so a viewer whose player is a little
 * behind the shared clock sees the last of it. Whether the host is in the room — which keeps
 * it live past that — is the caller's question (it needs the SFU).
 *
 * started_at is the SCHEDULED start, not the moment somebody happened to ask: the shared
 * clock (the position everybody is seeked to) must not depend on when the first request
 * arrived. A host who starts it by hand starts the clock then instead (SetStatus).
 */

// simuliveJoins brings in the recording r and the original webinar o, for a simulive w.
const simuliveJoins = `JOIN recordings r ON r.id = w.simulive_recording_id
	JOIN webinars o ON o.id = r.webinar_id`

// simuliveLengthSQL is the session's length in ms (see above).
const simuliveLengthSQL = `LEAST(
	COALESCE(
		NULLIF(r.duration_ms, 0)::bigint,
		CASE WHEN r.stopped_at > r.created_at
		     THEN (extract(epoch FROM r.stopped_at - r.created_at) * 1000)::bigint END,
		w.duration_min::bigint * 60000),
	COALESCE(
		CASE WHEN o.ended_at > r.created_at
		     THEN (extract(epoch FROM o.ended_at - r.created_at) * 1000)::bigint END,
		9223372036854775807))`

// simuliveEndsSQL is when a started simulive is over.
const simuliveEndsSQL = `COALESCE(w.started_at, w.starts_at)
	+ make_interval(secs => (` + simuliveLengthSQL + `) / 1000.0 + 30)`

// simuliveDueSQL: an automatic simulive, scheduled, whose start has come and which would not
// already be over.
const simuliveDueSQL = `w.kind = 'simulive' AND w.status = 'scheduled'
	AND COALESCE(w.options->>'simuliveStart', '') <> 'manual'
	AND w.starts_at <= now()
	AND w.starts_at + make_interval(secs => (` + simuliveLengthSQL + `) / 1000.0) > now()`

// simuliveOverSQL: live, and the session's length (plus the grace) has played.
const simuliveOverSQL = `w.kind = 'simulive' AND w.status = 'live' AND ` + simuliveEndsSQL + ` <= now()`

// StartSimuliveIfDue moves a due simulive live, and reports whether this call did it.
func (s *Store) StartSimuliveIfDue(ctx context.Context, slug string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars w SET status = 'live', started_at = COALESCE(w.started_at, w.starts_at),
		       ended_at = NULL, empty_since = NULL, ai_off_this_session = NOT w.ai_enabled,
		       updated_at = now()
		  FROM recordings r JOIN webinars o ON o.id = r.webinar_id
		 WHERE r.id = w.simulive_recording_id AND w.slug = $1 AND `+simuliveDueSQL, slug)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// EndSimuliveIfDue marks a simulive whose session has played through ended, and reports
// whether this call did it. The caller has already decided nobody on the host team is in the
// room, and then does what ending a session does (api.afterSessionEnded).
func (s *Store) EndSimuliveIfDue(ctx context.Context, slug string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars w SET status = 'ended', ended_at = now(), empty_since = NULL, updated_at = now()
		  FROM recordings r JOIN webinars o ON o.id = r.webinar_id
		 WHERE r.id = w.simulive_recording_id AND w.slug = $1 AND `+simuliveOverSQL, slug)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// SimuliveEndsAt is when a live simulive is over (see above). False when it is not a live
// simulive.
func (s *Store) SimuliveEndsAt(ctx context.Context, slug string) (time.Time, bool, error) {
	var ends time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT `+simuliveEndsSQL+`
		  FROM webinars w `+simuliveJoins+`
		 WHERE w.slug = $1 AND w.kind = 'simulive' AND w.status = 'live'`, slug).Scan(&ends)
	if noRows(err) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return ends, true, nil
}

/* SetSimuliveStart changes how a scheduled simulive starts (options.simuliveStart and
 * options.simuliveDoorsOpenMin; nil doors removes the key, the default). ErrNotFound when it is
 * not a simulive; ErrConflict once it is no longer scheduled — it has started. */
func (s *Store) SetSimuliveStart(ctx context.Context, slug, mode string, doors *int) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET options = CASE WHEN $3::int IS NULL
		         THEN (options - 'simuliveDoorsOpenMin') || jsonb_build_object('simuliveStart', $2::text)
		         ELSE options || jsonb_build_object('simuliveStart', $2::text, 'simuliveDoorsOpenMin', $3::int) END,
		       updated_at = now()
		 WHERE slug = $1 AND kind = 'simulive' AND status = 'scheduled'`, slug, mode, doors)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM webinars WHERE slug = $1 AND kind = 'simulive'`, slug).Scan(&status); err != nil {
		if noRows(err) {
			return ErrNotFound
		}
		return err
	}
	return ErrConflict
}

// DueSimuliveSlugs and ExpiredSimuliveSlugs are the sweeper's candidates for the two
// transitions above, which it then makes one by one through the same guarded path.
func (s *Store) DueSimuliveSlugs(ctx context.Context) ([]string, error) {
	return s.slugs(ctx, `SELECT w.slug FROM webinars w `+simuliveJoins+` WHERE `+simuliveDueSQL)
}

func (s *Store) ExpiredSimuliveSlugs(ctx context.Context) ([]string, error) {
	return s.slugs(ctx, `SELECT w.slug FROM webinars w `+simuliveJoins+` WHERE `+simuliveOverSQL)
}

func (s *Store) slugs(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		out = append(out, slug)
	}
	return out, rows.Err()
}
