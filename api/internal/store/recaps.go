package store

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The AI recap of a session (migrations/0128). One row per webinar: ScheduleRecap writes
 * it when the session ends, the recap lane claims it when it is due, and it ends ready,
 * skipped or failed. See api/internal/api/recap.go for the flow. */

// RecapJob is a due recap, claimed by one runner.
type RecapJob struct {
	WebinarID string
	Slug      string
	WaitUntil *time.Time
	Attempts  int
}

// RecapRow is a recap as stored.
type RecapRow struct {
	WebinarID   string
	Status      string
	Reason      string
	Source      string
	Model       string
	WaitUntil   *time.Time
	GeneratedAt *time.Time
	EmailedAt   *time.Time
	Recap       *types.SessionRecap
}

/* ScheduleRecap writes the pending row for the session behind slug, due after delay.
 * waitFor, when positive, is how long the recap waits for the after-session transcript.
 * A second end (a session restarted, then ended again) meets the existing row and changes
 * nothing: one recap per session. Reports whether a row was written. */
func (s *Store) ScheduleRecap(ctx context.Context, slug string, delay, waitFor time.Duration) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO session_recaps (webinar_id, due_at, wait_until)
		SELECT w.id, now() + make_interval(secs => $2),
		       CASE WHEN $3 > 0 THEN now() + make_interval(secs => $3) END
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO NOTHING`, slug, delay.Seconds(), waitFor.Seconds())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* SkipRecap records, at the end of a session, that it gets no recap: the row is written
 * skipped with reason straight away (the room's AI switch was off), so the Results page says
 * so at once rather than showing "processing". A row already settled is left alone. */
func (s *Store) SkipRecap(ctx context.Context, slug, reason string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_recaps (webinar_id, status, reason)
		SELECT w.id, 'skipped', $2 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO UPDATE
		   SET status = 'skipped', reason = excluded.reason, claimed_until = NULL
		 WHERE session_recaps.status = 'pending'`, slug, reason)
	return err
}

// NudgeRecap makes a pending recap due now: the transcript it was waiting for has arrived.
func (s *Store) NudgeRecap(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_recaps r SET due_at = now()
		  FROM webinars w
		 WHERE r.webinar_id = w.id AND w.slug = $1 AND r.status = 'pending'`, slug)
	return err
}

/* ClaimDueRecap takes the oldest due pending recap for claimFor. ok=false when nothing is
 * due. A claim that is never released (the runner died) lapses, and the row is due again. */
func (s *Store) ClaimDueRecap(ctx context.Context, claimFor time.Duration) (RecapJob, bool, error) {
	var j RecapJob
	err := s.pool.QueryRow(ctx, `
		UPDATE session_recaps r
		   SET claimed_until = now() + make_interval(secs => $1)
		  FROM webinars w
		 WHERE w.id = r.webinar_id
		   AND r.webinar_id = (
		     SELECT webinar_id FROM session_recaps
		      WHERE status = 'pending' AND due_at <= now()
		        AND (claimed_until IS NULL OR claimed_until < now())
		      ORDER BY due_at
		      LIMIT 1
		      FOR UPDATE SKIP LOCKED)
		RETURNING r.webinar_id::text, w.slug, r.wait_until, r.attempts`, claimFor.Seconds()).
		Scan(&j.WebinarID, &j.Slug, &j.WaitUntil, &j.Attempts)
	if noRows(err) {
		return RecapJob{}, false, nil
	}
	if err != nil {
		return RecapJob{}, false, err
	}
	return j, true, nil
}

/* ClaimRecapForSlug is ClaimDueRecap for one session: it claims that session's recap only
 * when it is pending, due and not already claimed (by the tick, or by another request). */
func (s *Store) ClaimRecapForSlug(ctx context.Context, slug string, claimFor time.Duration) (RecapJob, bool, error) {
	var j RecapJob
	err := s.pool.QueryRow(ctx, `
		UPDATE session_recaps r
		   SET claimed_until = now() + make_interval(secs => $2)
		  FROM webinars w
		 WHERE w.id = r.webinar_id AND w.slug = $1
		   AND r.status = 'pending' AND r.due_at <= now()
		   AND (r.claimed_until IS NULL OR r.claimed_until < now())
		RETURNING r.webinar_id::text, w.slug, r.wait_until, r.attempts`, slug, claimFor.Seconds()).
		Scan(&j.WebinarID, &j.Slug, &j.WaitUntil, &j.Attempts)
	if noRows(err) {
		return RecapJob{}, false, nil
	}
	if err != nil {
		return RecapJob{}, false, err
	}
	return j, true, nil
}

// DeferRecap releases a claimed recap to be looked at again at due.
func (s *Store) DeferRecap(ctx context.Context, webinarID string, due time.Time, attempts int, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_recaps
		   SET due_at = $2, attempts = $3, reason = $4, claimed_until = NULL
		 WHERE webinar_id = $1::uuid AND status = 'pending'`, webinarID, due, attempts, reason)
	return err
}

/* SettleRecap ends a recap without one: status skipped or failed, with the reason. Only
 * a pending row moves, so a recap written meanwhile is not undone. */
func (s *Store) SettleRecap(ctx context.Context, webinarID, status, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_recaps
		   SET status = $2, reason = $3, claimed_until = NULL
		 WHERE webinar_id = $1::uuid AND status = 'pending'`, webinarID, status, reason)
	return err
}

/* SaveRecap stores a written recap, creating the row if the session never had one.
 * emailed_at is left alone: a recap is mailed once. */
func (s *Store) SaveRecap(ctx context.Context, slug string, recap types.SessionRecap, source, model string) error {
	body, err := json.Marshal(recap)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO session_recaps (webinar_id, status, recap, source, model, generated_at)
		SELECT w.id, 'ready', $2::jsonb, $3, $4, now() FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO UPDATE
		   SET status = 'ready', reason = '', recap = EXCLUDED.recap, source = EXCLUDED.source,
		       model = EXCLUDED.model, generated_at = now(), claimed_until = NULL`,
		slug, string(body), source, model)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SessionRecap is the stored recap for slug, ErrNotFound when the session has none.
func (s *Store) SessionRecap(ctx context.Context, slug string) (RecapRow, error) {
	var (
		r      RecapRow
		raw    []byte
		source *string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT r.webinar_id::text, r.status, r.reason, r.source, r.model, r.wait_until,
		       r.generated_at, r.emailed_at, r.recap
		  FROM session_recaps r JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1`, slug).Scan(&r.WebinarID, &r.Status, &r.Reason, &source, &r.Model,
		&r.WaitUntil, &r.GeneratedAt, &r.EmailedAt, &raw)
	if noRows(err) {
		return RecapRow{}, ErrNotFound
	}
	if err != nil {
		return RecapRow{}, err
	}
	if source != nil {
		r.Source = *source
	}
	if len(raw) > 0 {
		var rec types.SessionRecap
		if err := json.Unmarshal(raw, &rec); err != nil {
			return RecapRow{}, err
		}
		r.Recap = &rec
	}
	return r, nil
}

// RecapChapters is the chapters of a ready recap for slug; empty when there are none.
func (s *Store) RecapChapters(ctx context.Context, slug string) ([]types.RecapChapter, error) {
	row, err := s.SessionRecap(ctx, slug)
	if err == ErrNotFound || (err == nil && (row.Status != types.RecapReady || row.Recap == nil)) {
		return []types.RecapChapter{}, nil
	}
	if err != nil {
		return nil, err
	}
	if row.Recap.Chapters == nil {
		return []types.RecapChapter{}, nil
	}
	return row.Recap.Chapters, nil
}

/* QueueRecapEmail marks a ready recap emailed and writes its outbox rows, in one
 * transaction: either both happen or neither. ok=false when it was already emailed (or
 * is not ready), and nothing is written — which is what makes the email once per session
 * however many times generation runs. */
func (s *Store) QueueRecapEmail(ctx context.Context, webinarID string, msgs ...Notification) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE session_recaps SET emailed_at = now()
		 WHERE webinar_id = $1::uuid AND status = 'ready' AND emailed_at IS NULL`, webinarID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	for _, m := range msgs {
		if err := s.Notify(ctx, tx, m); err != nil {
			return false, err
		}
	}
	return true, tx.Commit(ctx)
}

/* TranscriptSince is the after-session transcript for slug stored at or after since (the
 * session's start, so a previous session's transcript is not used), for the AI: without the
 * segments said while AI was paused (ai_off.go). found is false when there is none.
 *
 * One caption-agent job posts one transcript when it leaves the room, and a session can have
 * several: the agent leaves when AI is paused with captions hidden and is dispatched again on
 * resume. So every transcript since the start is read and merged in time order (a repeated
 * post of the same lines counted once); model is the newest one's. */
func (s *Store) TranscriptSince(ctx context.Context, slug string, since time.Time) (model string, segments []TranscriptSegment, found bool, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.model, t.segments
		  FROM session_transcripts t JOIN webinars w ON w.id = t.webinar_id
		 WHERE w.slug = $1 AND t.created_at >= $2
		 ORDER BY t.created_at, t.id`, slug, since)
	if err != nil {
		return "", nil, false, err
	}
	type key struct {
		identity string
		start    int64
		text     string
	}
	seen := map[key]bool{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&model, &raw); err != nil {
			rows.Close()
			return "", nil, false, err
		}
		var segs []TranscriptSegment
		if err := json.Unmarshal(raw, &segs); err != nil {
			rows.Close()
			return "", nil, false, err
		}
		found = true
		for _, sg := range segs {
			if k := (key{sg.Identity, sg.Start, sg.Text}); !seen[k] {
				seen[k] = true
				segments = append(segments, sg)
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", nil, false, err
	}
	if !found {
		return "", nil, false, nil
	}
	sort.SliceStable(segments, func(i, j int) bool { return segments[i].Start < segments[j].Start })
	// Said while AI was paused: out. found stays true, so a transcript that was all paused is
	// not mistaken for one still to come.
	windows, err := s.AIOffWindows(ctx, slug)
	if err != nil {
		return "", nil, false, err
	}
	if len(windows) > 0 {
		kept := segments[:0]
		for _, sg := range segments {
			if !windows.ContainsMs(sg.Start) {
				kept = append(kept, sg)
			}
		}
		segments = kept
	}
	return model, segments, true, nil
}

// TranscriptAfterEnd reports whether a transcript for slug was stored at or after the
// session's end: for the recap, whether the one the agent posts on leaving at the end has
// arrived, rather than only one it posted mid-session when it left on a pause.
func (s *Store) TranscriptAfterEnd(ctx context.Context, slug string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM session_transcripts tr JOIN webinars w ON w.id = tr.webinar_id
		                WHERE w.slug = $1 AND w.ended_at IS NOT NULL AND tr.created_at >= w.ended_at)`, slug).Scan(&ok)
	return ok, err
}

// CaptionLine is one stored live caption line.
type CaptionLine struct {
	At       time.Time
	Identity string
	Name     string
	Text     string
}

/* RecapCaptions is the live caption lines for slug since since, oldest first, at most
 * limit, for the AI: none said while AI was paused (ai_off.go). Name is the account's name for a stage identity ("user_" + id), else empty. */
func (s *Store) RecapCaptions(ctx context.Context, slug string, since time.Time, limit int) ([]CaptionLine, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.at, c.identity, COALESCE(u.name, ''), c.body
		  FROM session_captions c
		  JOIN webinars w ON w.id = c.webinar_id
		  LEFT JOIN users u ON starts_with(c.identity, 'user_') AND u.id::text = substr(c.identity, 6)
		 WHERE w.slug = $1 AND c.at >= $2
		   -- Said while AI was paused (captions shown, AI off): stored, never for the AI.
		   AND NOT `+aiOffAtSQL("c.webinar_id", "c.at")+`
		 ORDER BY c.at, c.id
		 LIMIT $3`, slug, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CaptionLine{}
	for rows.Next() {
		var l CaptionLine
		if err := rows.Scan(&l.At, &l.Identity, &l.Name, &l.Text); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

/* PeakViewers is the most attendees in the session at once, from their visits. Leaving
 * is counted before joining at the same instant, so a reconnect is not two people. */
func (s *Store) PeakViewers(ctx context.Context, slug string) (int, error) {
	var peak int
	err := s.pool.QueryRow(ctx, attendanceWindow+`
		SELECT COALESCE(max(running), 0)::int FROM (
		  SELECT sum(delta) OVER (ORDER BY t, delta ROWS UNBOUNDED PRECEDING) AS running
		    FROM (
		      SELECT v.joined_at AS t, 1 AS delta
		        FROM attendance_visits v JOIN win ON win.id = v.webinar_id
		       WHERE starts_with(v.identity, 'att_')
		      UNION ALL
		      SELECT COALESCE(v.left_at, win.hi), -1
		        FROM attendance_visits v JOIN win ON win.id = v.webinar_id
		       WHERE starts_with(v.identity, 'att_')
		    ) ev
		) runs`, slug).Scan(&peak)
	return peak, err
}
