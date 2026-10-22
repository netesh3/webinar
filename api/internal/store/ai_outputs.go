package store

import (
	"context"
	"encoding/json"
	"time"
)

/* What the AI wrote about one session, cached per kind (migrations/0130): the hot-lead
 * reasons and the follow-up drafts. See api/internal/api/leads.go and followups.go. */

// AI output kinds (session_ai_outputs.kind).
const (
	AIOutputLeads             = "leads"
	AIOutputFollowupsEnglish  = "followups:en"
	AIOutputFollowupsHinglish = "followups:hinglish"
)

// AI output states (session_ai_outputs.status).
const (
	AIOutputPending = "pending"
	AIOutputReady   = "ready"
	AIOutputFailed  = "failed"
)

/* AIOutputRow is one cached output. Current is true when it was written for the session's
 * latest end: a session run again and ended again has a new end, and a new output is due.
 * Claimed is true while somebody is writing it, or (after a failure) backing off. */
type AIOutputRow struct {
	Status      string
	Current     bool
	Claimed     bool
	CreatedAt   time.Time
	Body        json.RawMessage
	Edits       json.RawMessage
	Model       string
	GeneratedAt *time.Time
}

// AIOutput reads the cached output of kind for the webinar behind slug. ErrNotFound when
// there is none.
func (s *Store) AIOutput(ctx context.Context, slug, kind string) (AIOutputRow, error) {
	var r AIOutputRow
	var body, edits []byte
	err := s.pool.QueryRow(ctx, `
		SELECT o.status, o.ended_at IS NOT DISTINCT FROM w.ended_at,
		       COALESCE(o.claimed_until > now(), false), o.created_at,
		       o.body, o.edits, o.model, o.generated_at
		  FROM session_ai_outputs o JOIN webinars w ON w.id = o.webinar_id
		 WHERE w.slug = $1 AND o.kind = $2`, slug, kind).
		Scan(&r.Status, &r.Current, &r.Claimed, &r.CreatedAt, &body, &edits, &r.Model, &r.GeneratedAt)
	if noRows(err) {
		return r, ErrNotFound
	}
	r.Body, r.Edits = body, edits
	return r, err
}

/* ClaimAIOutput takes the right to write kind for the session's latest end, for claimFor.
 * It succeeds when there is no row, or the row was written for another end (the session ran
 * again), or the last attempt failed; and nobody else holds the claim. A row already ready
 * for this end is never claimed: that is what makes it one call. */
func (s *Store) ClaimAIOutput(ctx context.Context, slug, kind string, claimFor time.Duration) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO session_ai_outputs (webinar_id, kind, status, ended_at, claimed_until)
		SELECT w.id, $2, 'pending', w.ended_at, now() + make_interval(secs => $3)
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, kind) DO UPDATE
		   SET status = 'pending', ended_at = EXCLUDED.ended_at, claimed_until = EXCLUDED.claimed_until
		 WHERE (session_ai_outputs.status <> 'ready' OR session_ai_outputs.ended_at IS DISTINCT FROM EXCLUDED.ended_at)
		   AND (session_ai_outputs.claimed_until IS NULL OR session_ai_outputs.claimed_until < now())`,
		slug, kind, claimFor.Seconds())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* SaveAIOutput stores what the model wrote and releases the claim. The host's edits are
 * dropped: they were edits of the previous output, for a previous end of the session. */
func (s *Store) SaveAIOutput(ctx context.Context, slug, kind string, body any, model string) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE session_ai_outputs o
		   SET status = 'ready', body = $3::jsonb, model = $4, generated_at = now(), claimed_until = NULL,
		       edits = '{}'::jsonb
		  FROM webinars w
		 WHERE w.id = o.webinar_id AND w.slug = $1 AND o.kind = $2`, slug, kind, string(raw), model)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* FailAIOutput gives up a claim without an output: the row is failed, and the next request
 * may try again once retryAfter has passed (the claim is held until then, so a provider that
 * is down is not asked on every page load). A previous output, if any, stays readable. */
func (s *Store) FailAIOutput(ctx context.Context, slug, kind string, retryAfter time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_ai_outputs o
		   SET status = 'failed', claimed_until = now() + make_interval(secs => $3)
		  FROM webinars w
		 WHERE w.id = o.webinar_id AND w.slug = $1 AND o.kind = $2 AND o.status = 'pending'`,
		slug, kind, retryAfter.Seconds())
	return err
}

/* SaveAIOutputEdit stores the host's edit of one part (key) of a ready, current output.
 * ErrNotFound when there is none to edit. */
func (s *Store) SaveAIOutputEdit(ctx context.Context, slug, kind, key string, edit any) error {
	raw, err := json.Marshal(edit)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE session_ai_outputs o
		   SET edits = jsonb_set(o.edits, ARRAY[$3::text], $4::jsonb, true)
		  FROM webinars w
		 WHERE w.id = o.webinar_id AND w.slug = $1 AND o.kind = $2 AND o.status = 'ready'
		   AND o.ended_at IS NOT DISTINCT FROM w.ended_at`,
		slug, kind, key, string(raw))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
