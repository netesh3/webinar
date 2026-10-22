package store

import (
	"context"
	"encoding/json"
	"strconv"
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
 * not hidden by moderation; polls that were actually opened. Images are left out — their bytes
 * belong to the original webinar's room and its access rules.
 *
 * Bounded so a very long session cannot make one replay response unbounded: the first
 * replayMaxRows of each kind.
 */
const replayMaxRows = 3000

func (s *Store) ReplaySource(ctx context.Context, recordingID string) (replay.Source, error) {
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
		return replay.Source{}, ErrNotFound
	}
	if err != nil {
		return replay.Source{}, err
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

	rows, err = s.pool.Query(ctx, `
		SELECT p.id::text, p.question, p.kind, p.options, p.correct_option, p.share_results,
		       p.opened_at, p.closed_at,
		       COALESCE((SELECT jsonb_object_agg(v.choice::text, v.n)
		                   FROM (SELECT choice, count(*) AS n FROM poll_votes
		                          WHERE poll_id = p.id GROUP BY choice) v), '{}'::jsonb)
		  FROM polls p
		 WHERE p.webinar_id = $1::uuid AND p.state <> 'draft' AND p.opened_at IS NOT NULL
		   AND p.opened_at >= $2 AND p.opened_at <= $3
		 ORDER BY p.opened_at
		 LIMIT 200`, webinarID, start, end)
	if err != nil {
		return replay.Source{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			p       replay.Poll
			kind    string
			options []byte
			counts  []byte
			opened  *time.Time
		)
		if err := rows.Scan(&p.ID, &p.Question, &kind, &options, &p.Correct, &p.ShareResults,
			&opened, &p.ClosedAt, &counts); err != nil {
			return replay.Source{}, err
		}
		if opened == nil {
			continue
		}
		p.OpenedAt = *opened
		p.Quiz = kind == string(types.PollQuizKind)
		_ = json.Unmarshal(options, &p.Options)
		byChoice := map[string]int{}
		_ = json.Unmarshal(counts, &byChoice)
		p.Counts = make([]int, len(p.Options))
		for i := range p.Counts {
			p.Counts[i] = byChoice[strconv.Itoa(i)]
		}
		src.Polls = append(src.Polls, p)
	}
	return src, rows.Err()
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
	if hidden {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO simulive_replay_hidden (webinar_id, item_key)
			SELECT w.id, $2 FROM webinars w WHERE w.slug = $1 OR w.id::text = $1
			ON CONFLICT DO NOTHING`, slug, key)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		DELETE FROM simulive_replay_hidden h
		 USING webinars w
		 WHERE h.webinar_id = w.id AND (w.slug = $1 OR w.id::text = $1) AND h.item_key = $2`, slug, key)
	return err
}
