package store

import (
	"context"
	"time"
)

/* The AI Q&A assistant's clusters (migration 0132): questions that ask the same thing,
 * grouped under one canonical wording. Only the stage ever reads these. See
 * api/internal/api/qa_assist.go for when a grouping pass runs. */

// QAQuestion is one question as the Q&A assistant sees it.
type QAQuestion struct {
	ID        string
	Identity  string
	Text      string
	Upvotes   int
	Answered  bool
	Dismissed bool
	CreatedAt time.Time
	// ClusterID is "" for a question no pass has grouped yet.
	ClusterID string
	Canonical string
}

// QANewCluster is a cluster a pass creates.
type QANewCluster struct {
	ID        string
	Canonical string
}

/* QAQuestions is the newest `limit` questions of a session, oldest first. openOnly leaves out
 * the answered and the hidden ones, which is what a grouping pass works on. */
func (s *Store) QAQuestions(ctx context.Context, slug string, openOnly bool, limit int) ([]QAQuestion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, identity, body, upvotes, answered, dismissed, created_at, cluster_id, canonical
		  FROM (
			SELECT q.id, q.identity, q.body, q.upvotes, q.answered, q.dismissed, q.created_at,
			       COALESCE(q.cluster_id, '') AS cluster_id, COALESCE(c.canonical, '') AS canonical
			  FROM session_questions q
			  JOIN webinars w ON w.id = q.webinar_id
			  LEFT JOIN session_qa_clusters c ON c.id = q.cluster_id
			 WHERE w.slug = $1 AND (NOT $2 OR (NOT q.answered AND NOT q.dismissed))
			   -- Asked while AI was paused: out of the assistant (ai_off.go).
			   AND NOT `+aiOffAtSQL("q.webinar_id", "q.created_at")+`
			 ORDER BY q.created_at DESC, q.id DESC
			 LIMIT $3
		  ) recent
		 ORDER BY created_at, id`, slug, openOnly, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []QAQuestion{}
	for rows.Next() {
		var q QAQuestion
		if err := rows.Scan(&q.ID, &q.Identity, &q.Text, &q.Upvotes, &q.Answered, &q.Dismissed,
			&q.CreatedAt, &q.ClusterID, &q.Canonical); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

/* QAPending is how many of the newest `limit` open questions no pass has grouped yet, and
 * when the oldest of them was asked. One small read, made on every question asked while the
 * assistant is on, to decide whether a pass is due. */
func (s *Store) QAPending(ctx context.Context, slug string, limit int) (int, time.Time, error) {
	var (
		n      int
		oldest *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE cluster_id IS NULL)::int,
		       min(created_at) FILTER (WHERE cluster_id IS NULL)
		  FROM (
			SELECT q.cluster_id, q.created_at
			  FROM session_questions q
			  JOIN webinars w ON w.id = q.webinar_id
			 WHERE w.slug = $1 AND NOT q.answered AND NOT q.dismissed
			   AND NOT `+aiOffAtSQL("q.webinar_id", "q.created_at")+`
			 ORDER BY q.created_at DESC, q.id DESC
			 LIMIT $2
		  ) recent`, slug, limit).Scan(&n, &oldest)
	if err != nil || oldest == nil {
		return n, time.Time{}, err
	}
	return n, *oldest, nil
}

/* SaveQAClusters writes one pass: the clusters it created and the cluster of each question it
 * grouped, in one transaction. A question already grouped (by a pass that raced this one on
 * another instance) keeps the cluster it has. */
func (s *Store) SaveQAClusters(ctx context.Context, slug string, created []QANewCluster, assign map[string]string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, c := range created {
		if _, err := tx.Exec(ctx, `
			INSERT INTO session_qa_clusters (id, webinar_id, canonical)
			SELECT $1, w.id, $3 FROM webinars w WHERE w.slug = $2
			ON CONFLICT (id) DO NOTHING`, c.ID, slug, c.Canonical); err != nil {
			return err
		}
	}
	for qid, cid := range assign {
		if _, err := tx.Exec(ctx, `
			UPDATE session_questions q SET cluster_id = $3
			  FROM webinars w, session_qa_clusters c
			 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = $2 AND q.cluster_id IS NULL
			   AND c.id = $3 AND c.webinar_id = w.id`, slug, qid, cid); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// QAClusterCanonical is a cluster's wording, scoped to the session; ErrNotFound for another's.
func (s *Store) QAClusterCanonical(ctx context.Context, slug, id string) (string, error) {
	var canonical string
	err := s.pool.QueryRow(ctx, `
		SELECT c.canonical FROM session_qa_clusters c
		  JOIN webinars w ON w.id = c.webinar_id
		 WHERE w.slug = $1 AND c.id = $2`, slug, id).Scan(&canonical)
	if noRows(err) {
		return "", ErrNotFound
	}
	return canonical, err
}

// QAQuestionTexts is the text of the questions in one cluster, oldest first, at most limit.
func (s *Store) QAQuestionTexts(ctx context.Context, slug, clusterID string, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.body FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND q.cluster_id = $2
		   AND NOT `+aiOffAtSQL("q.webinar_id", "q.created_at")+`
		 ORDER BY q.created_at, q.id
		 LIMIT $3`, slug, clusterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// QAQuestionText is one question's text, scoped to the session; ErrNotFound otherwise, and for
// one asked while AI was paused (ai_off.go).
func (s *Store) QAQuestionText(ctx context.Context, slug, id string) (string, error) {
	var body string
	err := s.pool.QueryRow(ctx, `
		SELECT q.body FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND q.id = $2
		   AND NOT `+aiOffAtSQL("q.webinar_id", "q.created_at")+``, slug, id).Scan(&body)
	if noRows(err) {
		return "", ErrNotFound
	}
	return body, err
}

// SetQALimited records that a grouping pass stopped at an AI cap (nil clears it).
func (s *Store) SetQALimited(ctx context.Context, slug string, at *time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_qa_state (webinar_id, limited_at)
		SELECT w.id, $2 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO UPDATE SET limited_at = EXCLUDED.limited_at`, slug, at)
	return err
}

// QALimitedAt is when a pass last stopped at an AI cap; zero when it has not, or was cleared.
func (s *Store) QALimitedAt(ctx context.Context, slug string) (time.Time, error) {
	var at *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT st.limited_at FROM session_qa_state st
		  JOIN webinars w ON w.id = st.webinar_id
		 WHERE w.slug = $1`, slug).Scan(&at)
	if noRows(err) || at == nil {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return *at, nil
}
