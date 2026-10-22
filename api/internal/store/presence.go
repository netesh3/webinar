package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

/* Presence over the API: an attendee whose browser is still talking to us while it has no
 * LiveKit connection (the presence poll, api/internal/api/presence.go). See
 * migrations/0144_attendance_api_presence.sql.
 *
 * Separate from attendance.last_seen_at on purpose. That column is also written by the host's
 * roster poll for everyone LiveKit lists, so it cannot say who is reachable WITHOUT LiveKit:
 * a viewer who closed their tab would linger on the roster for as long as it stayed fresh. */

// presenceTouchEvery throttles the write: the poll comes every few seconds, and nothing reads
// the column more finely than the roster's one-minute window.
const presenceTouchEvery = 5 * time.Second

// TouchPresence records that this attendee was just heard from over the API.
//
// It only updates the attendance row their join wrote: presence never creates attendance on
// its own, because a row there is what the report counts as "attended".
func (s *Store) TouchPresence(ctx context.Context, slug, identity string, at time.Time) error {
	if identity == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance a
		   SET api_seen_at = $3
		  FROM webinars w
		 WHERE a.webinar_id = w.id AND w.slug = $1 AND a.identity = $2
		   AND (a.api_seen_at IS NULL OR a.api_seen_at < $3::timestamptz - $4::interval)`,
		slug, identity, at, presenceTouchEvery)
	return err
}

/* PresentViewers is every attendee heard from over the API within `within` of now, by name,
 * for the host's roster. Somebody the host removed from this run is left out even while their
 * browser is still asking. */
func (s *Store) PresentViewers(ctx context.Context, slug string, within time.Duration) ([]EdgeViewer, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.identity, a.name, a.first_joined_at
		  FROM attendance a
		  JOIN webinars w ON w.id = a.webinar_id
		 WHERE w.slug = $1 AND a.identity LIKE 'att\_%'
		   AND a.api_seen_at >= now() - $2::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM room_removals rr
		      WHERE rr.webinar_id = w.id AND rr.identity = a.identity
		        AND rr.removed_at >= COALESCE(w.started_at, '-infinity'::timestamptz))
		 ORDER BY a.first_joined_at`, slug, within)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (EdgeViewer, error) {
		var v EdgeViewer
		err := row.Scan(&v.Identity, &v.Name, &v.JoinedAt)
		return v, err
	})
}

// IsPresent reports whether one attendee was heard from over the API within `within`.
func (s *Store) IsPresent(ctx context.Context, slug, identity string, within time.Duration) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM attendance a JOIN webinars w ON w.id = a.webinar_id
		   WHERE w.slug = $1 AND a.identity = $2 AND a.api_seen_at >= now() - $3::interval)`,
		slug, identity, within).Scan(&ok)
	return ok, err
}

// PendingStageInvite is the open, unexpired invite for one person, if there is one. It does
// not take the invite: answering it is still TakeStageInvite's job.
func (s *Store) PendingStageInvite(ctx context.Context, slug, identity string) (StageInvite, bool, error) {
	var inv StageInvite
	err := s.pool.QueryRow(ctx, `
		SELECT i.audio_only FROM webinar_stage_invites i JOIN webinars w ON w.id = i.webinar_id
		 WHERE w.slug = $1 AND i.identity = $2 AND i.expires_at > now()`, slug, identity).
		Scan(&inv.AudioOnly)
	if noRows(err) {
		return StageInvite{}, false, nil
	}
	if err != nil {
		return StageInvite{}, false, err
	}
	return inv, true, nil
}
