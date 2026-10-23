package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/netkumar/webcast/api/internal/highlights"
)

/* A recording's suggested highlights (migrations/0156) and the engagement they are found
 * from. See api/internal/api/highlights.go.
 *
 * One row per recording session (the take with no parent), written once and rewritten only
 * when the host asks. Claimed while a request writes it, so two tabs make one set of calls. */

// highlightMaxRows bounds each kind of engagement read for one recording.
const highlightMaxRows = 20000

/* HighlightEvents is what the audience did between from and to in the session behind slug,
 * as moments: reaction counts per second, chat lines to everyone, questions (with their
 * upvotes) not hidden by moderation, and poll launches. Counts only: no text and no names,
 * since none of it goes to a model. */
func (s *Store) HighlightEvents(ctx context.Context, slug string, from, to time.Time) ([]highlights.Event, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT b.at, 'reaction', sum(b.n)::int
		  FROM reaction_buckets b JOIN webinars w ON w.id = b.webinar_id
		 WHERE w.slug = $1 AND b.at >= date_trunc('second', $2::timestamptz) AND b.at <= $3
		 GROUP BY b.at
		UNION ALL
		SELECT * FROM (SELECT m.created_at, 'chat', 1
		  FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1 AND m.deleted_at IS NULL AND m.destination = 'everyone'
		   AND m.message_type = 'text' AND m.created_at >= $2 AND m.created_at <= $3
		 ORDER BY m.created_at LIMIT $4) c
		UNION ALL
		SELECT * FROM (SELECT q.created_at, 'question', 1 + GREATEST(q.upvotes, 0)
		  FROM session_questions q JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND NOT q.dismissed AND q.created_at >= $2 AND q.created_at <= $3
		 ORDER BY q.created_at LIMIT $4) q
		UNION ALL
		SELECT p.opened_at, 'poll', 1
		  FROM polls p JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1 AND p.state <> 'draft' AND p.opened_at IS NOT NULL
		   AND p.opened_at >= $2 AND p.opened_at <= $3`, slug, from, to, highlightMaxRows)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []highlights.Event
	for rows.Next() {
		var e highlights.Event
		if err := rows.Scan(&e.At, &e.Kind, &e.N); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// HighlightsRow is a recording's stored suggestions.
type HighlightsRow struct {
	Status      string // AIOutputPending, AIOutputReady or AIOutputFailed
	Reason      string
	Body        json.RawMessage
	Claimed     bool
	GeneratedAt *time.Time
}

// RecordingHighlights reads the suggestions for the recording session id; ErrNotFound when
// none were ever asked for.
func (s *Store) RecordingHighlights(ctx context.Context, recordingID string) (HighlightsRow, error) {
	var r HighlightsRow
	var body []byte
	err := s.pool.QueryRow(ctx, `
		SELECT status, reason, body, COALESCE(claimed_until > now(), false), generated_at
		  FROM recording_highlights WHERE recording_id = $1::uuid`, recordingID).
		Scan(&r.Status, &r.Reason, &body, &r.Claimed, &r.GeneratedAt)
	if noRows(err) {
		return r, ErrNotFound
	}
	r.Body = body
	return r, err
}

/* ClaimRecordingHighlights takes the right to write the suggestions for claimFor. Without
 * rewrite it succeeds only when there are none ready yet; with it (the host's "Find them
 * again") a ready set is rewritten too. Never while somebody else holds the claim. */
func (s *Store) ClaimRecordingHighlights(ctx context.Context, recordingID string, rewrite bool, claimFor time.Duration) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO recording_highlights (recording_id, status, claimed_until)
		VALUES ($1::uuid, 'pending', now() + make_interval(secs => $3))
		ON CONFLICT (recording_id) DO UPDATE
		   SET status = 'pending', reason = '', claimed_until = EXCLUDED.claimed_until
		 WHERE (recording_highlights.status <> 'ready' OR $2)
		   AND (recording_highlights.claimed_until IS NULL OR recording_highlights.claimed_until < now())`,
		recordingID, rewrite, claimFor.Seconds())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SaveRecordingHighlights stores the suggestions and releases the claim.
func (s *Store) SaveRecordingHighlights(ctx context.Context, recordingID string, body any, model string) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE recording_highlights
		   SET status = 'ready', reason = '', body = $2::jsonb, model = $3, generated_at = now(), claimed_until = NULL
		 WHERE recording_id = $1::uuid`, recordingID, string(raw), model)
	return err
}

/* FailRecordingHighlights gives up a claim with reason. The claim is held for retryAfter so a
 * provider that is down is not asked on every look; suggestions written before stay readable. */
func (s *Store) FailRecordingHighlights(ctx context.Context, recordingID, reason string, retryAfter time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recording_highlights
		   SET status = 'failed', reason = $2, claimed_until = now() + make_interval(secs => $3)
		 WHERE recording_id = $1::uuid AND status = 'pending'`, recordingID, reason, retryAfter.Seconds())
	return err
}
