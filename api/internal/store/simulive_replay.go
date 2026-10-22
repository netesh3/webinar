package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/netkumar/webcast/api/internal/replay"
	"github.com/netkumar/webcast/api/types"
)

/* ReplaySource gathers what a simulive's engagement replay is built from: the original
 * session of one recording, within the recording's window.
 *
 * The recording maps to its original webinar (recordings.webinar_id), and its row was written
 * when recording began (created_at), which is the zero of the timeline. The window's end is
 * created_at + duration_ms, or stopped_at when the duration is unknown. Only what the original
 * audience saw is read: chat sent to everyone, as text, not deleted by moderation; questions
 * not hidden by moderation; polls that were actually opened (never their votes — the
 * simulive's audience votes in copies of its own); the per-second reaction counts. Images
 * are left out — their bytes belong to the original webinar's room and its access rules.
 *
 * Bounded so a very long session cannot make one replay response unbounded: the first
 * replayMaxRows of each kind.
 */
const (
	replayMaxRows      = 3000
	replayMaxReactions = 20000
)

// replayWindow is the original webinar of a recording and the recording's window.
func (s *Store) replayWindow(ctx context.Context, recordingID string) (string, replay.Source, time.Time, error) {
	var (
		webinarID  string
		start      time.Time
		durationMs int64
		stoppedAt  *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT r.webinar_id::text, r.created_at, r.duration_ms, r.stopped_at
		  FROM recordings r WHERE r.id = $1::uuid`, recordingID,
	).Scan(&webinarID, &start, &durationMs, &stoppedAt)
	if noRows(err) {
		return "", replay.Source{}, time.Time{}, ErrNotFound
	}
	if err != nil {
		return "", replay.Source{}, time.Time{}, err
	}
	src := replay.Source{RecordingStart: start, Duration: time.Duration(durationMs) * time.Millisecond}
	if src.Duration <= 0 && stoppedAt != nil && stoppedAt.After(start) {
		src.Duration = stoppedAt.Sub(start)
	}
	// No known end: a day is longer than any session, and keeps the read bounded.
	end := start.Add(24 * time.Hour)
	if src.Duration > 0 {
		end = start.Add(src.Duration)
	}
	return webinarID, src, end, nil
}

func (s *Store) ReplaySource(ctx context.Context, recordingID string) (replay.Source, error) {
	webinarID, src, end, err := s.replayWindow(ctx, recordingID)
	if err != nil {
		return replay.Source{}, err
	}
	start := src.RecordingStart

	rows, err := s.pool.Query(ctx, `
		SELECT id, sender_identity, sender_name, sender_role, content, created_at
		  FROM chat_messages
		 WHERE webinar_id = $1::uuid AND deleted_at IS NULL
		   AND destination = 'everyone' AND message_type = 'text'
		   AND created_at >= $2 AND created_at <= $3
		 ORDER BY seq
		 LIMIT $4`, webinarID, start, end, replayMaxRows)
	if err != nil {
		return replay.Source{}, err
	}
	for rows.Next() {
		var c replay.Chat
		var role string
		if err := rows.Scan(&c.ID, &c.Identity, &c.Name, &role, &c.Text, &c.At); err != nil {
			rows.Close()
			return replay.Source{}, err
		}
		c.Role = types.Role(role)
		src.Chat = append(src.Chat, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return replay.Source{}, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT id, identity, name, role, body, anonymous, answered, answer, answered_at, created_at
		  FROM session_questions
		 WHERE webinar_id = $1::uuid AND NOT dismissed
		   AND created_at >= $2 AND created_at <= $3
		 ORDER BY created_at, id
		 LIMIT $4`, webinarID, start, end, replayMaxRows)
	if err != nil {
		return replay.Source{}, err
	}
	for rows.Next() {
		var q replay.Question
		var role string
		if err := rows.Scan(&q.ID, &q.Identity, &q.Name, &role, &q.Text, &q.Anonymous,
			&q.Answered, &q.Answer, &q.AnsweredAt, &q.At); err != nil {
			rows.Close()
			return replay.Source{}, err
		}
		q.Role = types.Role(role)
		src.Questions = append(src.Questions, q)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return replay.Source{}, err
	}

	if src.Polls, err = s.replayPolls(ctx, webinarID, start, end); err != nil {
		return replay.Source{}, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT at, emoji, n FROM reaction_buckets
		 WHERE webinar_id = $1::uuid AND at >= date_trunc('second', $2::timestamptz) AND at <= $3
		 ORDER BY at, emoji
		 LIMIT $4`, webinarID, start, end, replayMaxReactions)
	if err != nil {
		return replay.Source{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var b replay.ReactionBucket
		if err := rows.Scan(&b.At, &b.Emoji, &b.N); err != nil {
			return replay.Source{}, err
		}
		// A bucket is the whole second; one that began just before the recording did is
		// the recording's first instant.
		if b.At.Before(start) {
			b.At = start
		}
		src.Reactions = append(src.Reactions, b)
	}
	return src, rows.Err()
}

// ReplayPollSource is ReplaySource's polls alone: what syncing the simulive's copies needs.
func (s *Store) ReplayPollSource(ctx context.Context, recordingID string) (replay.Source, error) {
	webinarID, src, end, err := s.replayWindow(ctx, recordingID)
	if err != nil {
		return replay.Source{}, err
	}
	src.Polls, err = s.replayPolls(ctx, webinarID, src.RecordingStart, end)
	return src, err
}

func (s *Store) replayPolls(ctx context.Context, webinarID string, start, end time.Time) ([]replay.Poll, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id::text, p.question, p.kind, p.options, p.correct_option, p.share_results,
		       p.opened_at, p.closed_at
		  FROM polls p
		 WHERE p.webinar_id = $1::uuid AND p.state <> 'draft' AND p.opened_at IS NOT NULL
		   AND p.opened_at >= $2 AND p.opened_at <= $3
		 ORDER BY p.opened_at
		 LIMIT 200`, webinarID, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []replay.Poll
	for rows.Next() {
		var (
			p       replay.Poll
			kind    string
			options []byte
			opened  *time.Time
		)
		if err := rows.Scan(&p.ID, &p.Question, &kind, &options, &p.Correct, &p.ShareResults,
			&opened, &p.ClosedAt); err != nil {
			return nil, err
		}
		if opened == nil {
			continue
		}
		p.OpenedAt = *opened
		p.Quiz = kind == string(types.PollQuizKind)
		_ = json.Unmarshal(options, &p.Options)
		out = append(out, p)
	}
	return out, rows.Err()
}

/* ApplyReplayPolls brings a live simulive's copies of the original polls to where the
 * shared clock is (posMs into the recording): opens the one whose moment has come, closes
 * the ones whose moment has passed (replay.PollActions decides). Reports whether anything
 * changed, so the caller tells the room.
 *
 * Serialised per webinar with a transaction-scoped advisory lock, and the copies' current
 * states are read inside it, so two instances (or two requests) syncing at once make one
 * copy and one transition; the unique index on (webinar_id, replay_key) backs that up.
 * Opening a copy closes whatever else was open, as a host's launch does.
 */
func (s *Store) ApplyReplayPolls(
	ctx context.Context, slug string, sched []replay.ScheduledPoll, hidden map[string]bool, posMs int64,
) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var webinarID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM webinars WHERE slug = $1`, slug).Scan(&webinarID); err != nil {
		if noRows(err) {
			return false, ErrNotFound
		}
		return false, err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('replay-polls:' || $1::text, 0))`, webinarID); err != nil {
		return false, err
	}
	have := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT replay_key, state FROM polls WHERE webinar_id = $1::uuid AND replay_key IS NOT NULL`, webinarID)
	if err != nil {
		return false, err
	}
	for rows.Next() {
		var k, st string
		if err := rows.Scan(&k, &st); err != nil {
			rows.Close()
			return false, err
		}
		have[k] = st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}

	actions := replay.PollActions(sched, hidden, have, posMs)
	if len(actions) == 0 {
		return false, nil
	}
	for _, a := range actions {
		switch a.Op {
		case replay.OpClose:
			if _, err := tx.Exec(ctx, `
				UPDATE polls SET state = 'closed', closed_at = now()
				 WHERE webinar_id = $1::uuid AND replay_key = $2 AND state = 'open'`, webinarID, a.Poll.Key); err != nil {
				return false, err
			}
		case replay.OpOpen:
			p := a.Poll
			kind := types.PollOpinion
			var correct *int
			if p.Quiz && p.Correct != nil && *p.Correct >= 0 && *p.Correct < len(p.Options) {
				kind, correct = types.PollQuizKind, p.Correct
			}
			options := p.Options
			if len(options) > maxPollOptions {
				options = options[:maxPollOptions]
			}
			if len(options) < 2 {
				continue
			}
			encoded, err := json.Marshal(options)
			if err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE polls SET state = 'closed', closed_at = now()
				 WHERE webinar_id = $1::uuid AND state = 'open'`, webinarID); err != nil {
				return false, err
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO polls (webinar_id, question, kind, options, correct_option, state, share_results,
				                   opened_at, replay_key)
				VALUES ($1::uuid, $2, $3, $4::jsonb, $5, 'open', $6, now(), $7)
				ON CONFLICT (webinar_id, replay_key) WHERE replay_key IS NOT NULL DO NOTHING`,
				webinarID, p.Question, string(kind), string(encoded), correct, p.ShareResults, p.Key); err != nil {
				return false, err
			}
		}
	}
	return true, tx.Commit(ctx)
}

// LiveSimuliveSlugs is every live simulive, for the sweeper's replay sync.
func (s *Store) LiveSimuliveSlugs(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug FROM webinars
		 WHERE kind = 'simulive' AND status = 'live' AND simulive_recording_id IS NOT NULL`)
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

// ReplayHidden is the set of item keys the host hid from this simulive's replay.
func (s *Store) ReplayHidden(ctx context.Context, slug string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT h.item_key FROM simulive_replay_hidden h
		  JOIN webinars w ON w.id = h.webinar_id
		 WHERE w.slug = $1 OR w.id::text = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out[k] = true
	}
	return out, rows.Err()
}

// SetReplayHidden hides one item of this simulive's replay, or shows it again.
func (s *Store) SetReplayHidden(ctx context.Context, slug, key string, hidden bool) error {
	_, err := s.SetReplayHiddenMany(ctx, slug, []string{key}, hidden)
	return err
}

// SetReplayHiddenMany hides items of this simulive's replay, or shows them again, and says
// how many changed.
func (s *Store) SetReplayHiddenMany(ctx context.Context, slug string, keys []string, hidden bool) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}
	if hidden {
		tag, err := s.pool.Exec(ctx, `
			INSERT INTO simulive_replay_hidden (webinar_id, item_key)
			SELECT w.id, k FROM webinars w, unnest($2::text[]) AS k
			 WHERE w.slug = $1 OR w.id::text = $1
			ON CONFLICT DO NOTHING`, slug, keys)
		return int(tag.RowsAffected()), err
	}
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM simulive_replay_hidden h
		 USING webinars w
		 WHERE h.webinar_id = w.id AND (w.slug = $1 OR w.id::text = $1) AND h.item_key = ANY($2::text[])`, slug, keys)
	return int(tag.RowsAffected()), err
}
