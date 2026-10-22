package store

import (
	"context"
	"sort"
	"time"
)

/* A simulive's Auto mode (api/internal/api/qa_auto.go): which audience questions the assistant
 * is to consider, claiming a batch of them, and posting or retracting its answers. The columns
 * are migration 0137's. */

// The auto_state values (migration 0137).
const (
	AutoPending    = "pending"
	AutoWorking    = "working"
	AutoAnswered   = "answered"
	AutoUngrounded = "ungrounded"
	AutoLimited    = "limited"
	AutoFailed     = "failed"
	AutoOff        = "off"
	AutoRetracted  = "retracted"
)

// AutoQuestion is one question of an Auto mode batch.
type AutoQuestion struct {
	ID       string
	Identity string
	Text     string
	At       time.Time
}

// SetSimuliveAutoAnswer switches a webinar's Auto mode (options.simuliveAutoAnswer).
func (s *Store) SetSimuliveAutoAnswer(ctx context.Context, slug string, on bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars
		   SET options = jsonb_set(COALESCE(options, '{}'::jsonb), '{simuliveAutoAnswer}', to_jsonb($2::bool))
		 WHERE slug = $1`, slug, on)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* MarkQuestionAutoPending puts a just-asked question in line for the next batch. Only a question
 * of this asker that Auto mode has never considered, so a resent id cannot put one back. */
func (s *Store) MarkQuestionAutoPending(ctx context.Context, slug, id, identity string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE session_questions q
		   SET auto_state = 'pending', auto_at = now()
		  FROM webinars w
		 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = $2 AND q.identity = $3
		   AND q.auto_state = '' AND NOT q.answered`, slug, id, identity)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* ClaimAutoQuestions takes up to limit waiting questions for one batch, oldest first: they are
 * 'working' until the batch settles them, so two requests never answer the same one. A question
 * the host answered or hid meanwhile is not taken (and is left as it is). */
func (s *Store) ClaimAutoQuestions(ctx context.Context, slug string, limit int) ([]AutoQuestion, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE session_questions q
		   SET auto_state = 'working', auto_at = now()
		 WHERE q.id IN (
			SELECT q2.id FROM session_questions q2
			  JOIN webinars w ON w.id = q2.webinar_id
			 WHERE w.slug = $1 AND NOT q2.answered AND NOT q2.dismissed
			   AND NOT `+aiOffAtSQL("q2.webinar_id", "q2.created_at")+`
			   -- 'working' for minutes is a batch whose request died: taken again.
			   AND (q2.auto_state = 'pending'
			        OR (q2.auto_state = 'working' AND q2.auto_at < now() - interval '2 minutes'))
			 ORDER BY q2.created_at, q2.id
			 LIMIT $2
			 FOR UPDATE OF q2 SKIP LOCKED)
		RETURNING q.id, q.identity, q.body, q.created_at`, slug, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AutoQuestion
	for rows.Next() {
		var q AutoQuestion
		if err := rows.Scan(&q.ID, &q.Identity, &q.Text, &q.At); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	return out, rows.Err()
}

// SetAutoState settles questions of a batch that were not answered. Only those still 'working'.
func (s *Store) SetAutoState(ctx context.Context, slug string, ids []string, state string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE session_questions q
		   SET auto_state = $3, auto_at = now()
		  FROM webinars w
		 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = ANY($2) AND q.auto_state = 'working'`,
		slug, ids, state)
	return err
}

/* AutoAnswerCounts is what the session's assistant has answered: in all (retracted ones count,
 * the call was made), and per asker since `since`, for the rate limit. */
func (s *Store) AutoAnswerCounts(ctx context.Context, slug string, since time.Time) (int, map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.identity, count(*)::int, count(*) FILTER (WHERE q.auto_at >= $2)::int
		  FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND q.auto_state IN ('answered', 'retracted')
		 GROUP BY q.identity`, slug, since)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	total, recent := 0, map[string]int{}
	for rows.Next() {
		var (
			id     string
			all, n int
		)
		if err := rows.Scan(&id, &all, &n); err != nil {
			return 0, nil, err
		}
		total += all
		recent[id] = n
	}
	return total, recent, rows.Err()
}

/* PostAutoAnswer is the assistant's answer on one claimed question, signed with label. False
 * when the host answered it first: theirs stands. */
func (s *Store) PostAutoAnswer(ctx context.Context, slug, id, answer, label string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE session_questions q
		   SET answered = true, answer = $3, answer_by = $4,
		       answered_at = COALESCE(q.answered_at, now()),
		       auto_state = 'answered', auto_at = now()
		  FROM webinars w
		 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = $2
		   AND q.auto_state = 'working' AND NOT q.answered`, slug, id, answer, label)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* RetractAutoAnswer takes the assistant's answer back off a question: it is open again, for the
 * host, and never answered automatically again. False when the question has no assistant answer
 * (a host's answer is not retracted this way). */
func (s *Store) RetractAutoAnswer(ctx context.Context, slug, id string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE session_questions q
		   SET answered = false, answer = '', answer_by = '',
		       auto_state = 'retracted', auto_at = now()
		  FROM webinars w
		 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = $2 AND q.answer_by <> ''`, slug, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
