package store

import (
	"context"
	"time"
)

/* Content repurposing (migrations/0155): one draft per session and format, and the host's
 * brand voice. See api/internal/api/repurpose.go.
 *
 * Written inside requests, not by a background lane: Cloud Run gives the instance CPU only
 * while one is in flight, and the host's card polls while a draft is queued, so each poll
 * claims what is due and writes it. A claim outlives one model call; a request cut short
 * leaves its claim to lapse and the next poll tries again, up to a few attempts. */

// AIOutputRepurposeNotes is the shared notes on a long transcript (session_ai_outputs.kind).
const AIOutputRepurposeNotes = "repurpose_notes"

// RepurposeRow is one format's draft as stored.
type RepurposeRow struct {
	Format      string
	Status      string // AIOutputPending, AIOutputReady or AIOutputFailed
	Reason      string
	Body        string
	Edited      *string
	Reviewed    bool
	Claimed     bool
	Attempts    int
	GeneratedAt *time.Time
}

// RepurposeDrafts is every draft of the session behind slug.
func (s *Store) RepurposeDrafts(ctx context.Context, slug string) ([]RepurposeRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT d.format, d.status, d.reason, d.body, d.edited, d.reviewed_at IS NOT NULL,
		       COALESCE(d.claimed_until > now(), false), d.attempts, d.generated_at
		  FROM repurpose_drafts d JOIN webinars w ON w.id = d.webinar_id
		 WHERE w.slug = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RepurposeRow
	for rows.Next() {
		var r RepurposeRow
		if err := rows.Scan(&r.Format, &r.Status, &r.Reason, &r.Body, &r.Edited, &r.Reviewed,
			&r.Claimed, &r.Attempts, &r.GeneratedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

/* QueueRepurpose asks for a new draft of each format: pending, attempts from zero. A draft
 * being written right now is left to finish (a second press is not a second call); one
 * already there keeps its text readable until the new one replaces it. */
func (s *Store) QueueRepurpose(ctx context.Context, slug string, formats []string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO repurpose_drafts (webinar_id, format)
		SELECT w.id, f FROM webinars w, unnest($2::text[]) AS f WHERE w.slug = $1
		ON CONFLICT (webinar_id, format) DO UPDATE
		   SET status = 'pending', reason = '', attempts = 0, claimed_until = NULL,
		       requested_at = now(), updated_at = now()
		 WHERE repurpose_drafts.claimed_until IS NULL OR repurpose_drafts.claimed_until < now()
		    OR repurpose_drafts.status <> 'pending'`, slug, formats)
	return err
}

/* ClaimRepurpose takes up to limit queued drafts of the session for claimFor, counting an
 * attempt on each. A queued draft that has already used maxAttempts (each one a request that
 * was cut short or a provider that failed) is settled failed instead of tried again. */
func (s *Store) ClaimRepurpose(ctx context.Context, slug string, limit, maxAttempts int, claimFor time.Duration) ([]string, error) {
	if _, err := s.pool.Exec(ctx, `
		UPDATE repurpose_drafts d
		   SET status = 'failed', reason = CASE WHEN d.reason = '' THEN 'failed' ELSE d.reason END,
		       claimed_until = NULL, updated_at = now()
		  FROM webinars w
		 WHERE w.id = d.webinar_id AND w.slug = $1 AND d.status = 'pending'
		   AND (d.claimed_until IS NULL OR d.claimed_until < now()) AND d.attempts >= $2`,
		slug, maxAttempts); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		UPDATE repurpose_drafts d
		   SET claimed_until = now() + make_interval(secs => $3), attempts = d.attempts + 1, updated_at = now()
		  FROM (SELECT d2.webinar_id, d2.format
		          FROM repurpose_drafts d2 JOIN webinars w ON w.id = d2.webinar_id
		         WHERE w.slug = $1 AND d2.status = 'pending'
		           AND (d2.claimed_until IS NULL OR d2.claimed_until < now())
		         ORDER BY d2.requested_at, d2.format
		         LIMIT $2
		           FOR UPDATE OF d2 SKIP LOCKED) due
		 WHERE d.webinar_id = due.webinar_id AND d.format = due.format
		RETURNING d.format`, slug, limit, claimFor.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

/* SaveRepurpose stores a new draft and releases the claim. The host's edit and review mark
 * belonged to the previous draft, so they go. */
func (s *Store) SaveRepurpose(ctx context.Context, slug, format, body, model string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE repurpose_drafts d
		   SET status = 'ready', reason = '', body = $3, model = $4, edited = NULL, reviewed_at = NULL,
		       claimed_until = NULL, generated_at = now(), updated_at = now()
		  FROM webinars w
		 WHERE w.id = d.webinar_id AND w.slug = $1 AND d.format = $2`, slug, format, body, model)
	return err
}

/* FailRepurpose settles a draft failed with reason (final), or puts it back in the queue
 * after retryAfter with the reason noted, for a failure worth another try. */
func (s *Store) FailRepurpose(ctx context.Context, slug, format, reason string, final bool, retryAfter time.Duration) error {
	if final {
		_, err := s.pool.Exec(ctx, `
			UPDATE repurpose_drafts d
			   SET status = 'failed', reason = $3, claimed_until = NULL, updated_at = now()
			  FROM webinars w
			 WHERE w.id = d.webinar_id AND w.slug = $1 AND d.format = $2 AND d.status = 'pending'`,
			slug, format, reason)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE repurpose_drafts d
		   SET reason = $3, claimed_until = now() + make_interval(secs => $4), updated_at = now()
		  FROM webinars w
		 WHERE w.id = d.webinar_id AND w.slug = $1 AND d.format = $2 AND d.status = 'pending'`,
		slug, format, reason, retryAfter.Seconds())
	return err
}

/* ReleaseRepurpose hands claimed drafts back to the queue untried, the attempt not counted:
 * this request ran out of time before it could start them (the long transcript's notes took
 * it), and the next poll picks them up. */
func (s *Store) ReleaseRepurpose(ctx context.Context, slug string, formats []string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE repurpose_drafts d
		   SET claimed_until = NULL, attempts = GREATEST(d.attempts - 1, 0), updated_at = now()
		  FROM webinars w
		 WHERE w.id = d.webinar_id AND w.slug = $1 AND d.format = ANY($2::text[]) AND d.status = 'pending'`,
		slug, formats)
	return err
}

/* EditRepurpose stores the host's text and review mark on a draft that has text (ready, or
 * failed or pending with an earlier draft still there). ErrNotFound when there is none. */
func (s *Store) EditRepurpose(ctx context.Context, slug, format, text string, reviewed bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE repurpose_drafts d
		   SET edited = CASE WHEN $3 = d.body THEN NULL ELSE $3 END,
		       reviewed_at = CASE WHEN $4 THEN COALESCE(d.reviewed_at, now()) END,
		       updated_at = now()
		  FROM webinars w
		 WHERE w.id = d.webinar_id AND w.slug = $1 AND d.format = $2 AND d.body <> ''`,
		slug, format, text, reviewed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// BrandVoiceRow is a host's brand voice as stored.
type BrandVoiceRow struct {
	Tone, Audience, DoWords, DontWords, Sample string
	UpdatedAt                                  time.Time
}

// BrandVoice is the host's brand voice; ErrNotFound when they never set one.
func (s *Store) BrandVoice(ctx context.Context, userID string) (BrandVoiceRow, error) {
	var v BrandVoiceRow
	err := s.pool.QueryRow(ctx, `
		SELECT tone, audience, do_words, dont_words, sample, updated_at
		  FROM brand_voices WHERE user_id = $1`, userID).
		Scan(&v.Tone, &v.Audience, &v.DoWords, &v.DontWords, &v.Sample, &v.UpdatedAt)
	if noRows(err) {
		return v, ErrNotFound
	}
	return v, err
}

// SaveBrandVoice replaces the host's brand voice.
func (s *Store) SaveBrandVoice(ctx context.Context, userID string, v BrandVoiceRow) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO brand_voices (user_id, tone, audience, do_words, dont_words, sample, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (user_id) DO UPDATE
		   SET tone = EXCLUDED.tone, audience = EXCLUDED.audience, do_words = EXCLUDED.do_words,
		       dont_words = EXCLUDED.dont_words, sample = EXCLUDED.sample, updated_at = now()`,
		userID, v.Tone, v.Audience, v.DoWords, v.DontWords, v.Sample)
	return err
}
