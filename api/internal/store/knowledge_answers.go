package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/types"
)

/* The past answers (migration 0136): a host's answers to questions from their own ended
 * sessions, as entries of their AI knowledge. See api/internal/api/knowledge_answers.go.
 *
 * Every read and write is scoped to the owner (host_id): another host's entry is not found,
 * not forbidden. Entries hold the question and answer text only. */

// HarvestSession is an ended session the harvest has work to do on.
type HarvestSession struct {
	WebinarID string
	Slug      string
	Topic     string
	EndedAt   time.Time
}

// WebinarIDBySlug is a session's row id.
func (s *Store) WebinarIDBySlug(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM webinars WHERE slug = $1`, slug).Scan(&id)
	if noRows(err) {
		return "", ErrNotFound
	}
	return id, err
}

// SessionsToHarvest is up to limit of a host's ended sessions whose typed answers were never
// harvested, newest first.
func (s *Store) SessionsToHarvest(ctx context.Context, hostID string, limit int) ([]HarvestSession, error) {
	return s.harvestSessions(ctx, `
		SELECT w.id::text, w.slug, w.topic, COALESCE(w.ended_at, w.updated_at)
		  FROM webinars w LEFT JOIN knowledge_harvests h ON h.webinar_id = w.id
		 WHERE w.host_id = $1 AND w.status = 'ended' AND h.typed_at IS NULL
		 ORDER BY w.ended_at DESC NULLS LAST, w.id
		 LIMIT $2`, hostID, limit)
}

// SessionsToHarvestAloud is up to limit of a host's sessions ended since then whose
// answered-aloud pass has not run, newest first.
func (s *Store) SessionsToHarvestAloud(ctx context.Context, hostID string, since time.Time, limit int) ([]HarvestSession, error) {
	return s.harvestSessions(ctx, `
		SELECT w.id::text, w.slug, w.topic, w.ended_at
		  FROM webinars w LEFT JOIN knowledge_harvests h ON h.webinar_id = w.id
		 WHERE w.host_id = $1 AND w.status = 'ended' AND w.ended_at >= $3 AND h.aloud_at IS NULL
		 ORDER BY w.ended_at DESC, w.id
		 LIMIT $2`, hostID, limit, since)
}

func (s *Store) harvestSessions(ctx context.Context, sql string, args ...any) ([]HarvestSession, error) {
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HarvestSession{}
	for rows.Next() {
		var h HarvestSession
		if err := rows.Scan(&h.WebinarID, &h.Slug, &h.Topic, &h.EndedAt); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

/* HarvestQuestion is one question of a session, or one cluster of them, the harvest has not
 * dealt with yet. Key is the cluster id, or "q_" + the question's id; Question is the
 * cluster's wording or the question as asked; Answer the host's typed answer ("" when none). */
type HarvestQuestion struct {
	Key      string
	Question string
	Answer   string
	Answered bool
	Upvotes  int
}

/* HarvestQuestions is a session's questions not yet harvested, oldest first, one per cluster:
 * hidden questions left out. A cluster's answer is its newest typed answer, and it counts as
 * answered when any of its questions is. */
func (s *Store) HarvestQuestions(ctx context.Context, webinarID string) ([]HarvestQuestion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.id, q.body, q.answer, q.answered, q.upvotes,
		       COALESCE(q.cluster_id, ''), COALESCE(c.canonical, '')
		  FROM session_questions q
		  LEFT JOIN session_qa_clusters c ON c.id = q.cluster_id
		 WHERE q.webinar_id = $1 AND NOT q.dismissed
		   AND NOT EXISTS (SELECT 1 FROM knowledge_answer_sources src
		                    WHERE src.webinar_id = q.webinar_id
		                      AND src.source_key = COALESCE(q.cluster_id, 'q_' || q.id))
		 ORDER BY q.created_at, q.id`, webinarID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var order []string
	by := map[string]*HarvestQuestion{}
	for rows.Next() {
		var (
			id, body, answer, cluster, canonical string
			answered                             bool
			upvotes                              int
		)
		if err := rows.Scan(&id, &body, &answer, &answered, &upvotes, &cluster, &canonical); err != nil {
			return nil, err
		}
		key, question := "q_"+id, body
		if cluster != "" {
			key = cluster
			if strings.TrimSpace(canonical) != "" {
				question = canonical
			}
		}
		h, ok := by[key]
		if !ok {
			h = &HarvestQuestion{Key: key, Question: question}
			by[key] = h
			order = append(order, key)
		}
		h.Answered = h.Answered || answered
		h.Upvotes += upvotes
		if a := strings.TrimSpace(answer); a != "" {
			h.Answer = a // oldest first, so the newest answer wins
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]HarvestQuestion, 0, len(order))
	for _, k := range order {
		out = append(out, *by[k])
	}
	return out, nil
}

// MarkTypedHarvested records that a session's typed answers have been harvested.
func (s *Store) MarkTypedHarvested(ctx context.Context, webinarID, hostID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO knowledge_harvests (webinar_id, host_id, typed_at) VALUES ($1, $2, now())
		ON CONFLICT (webinar_id) DO UPDATE SET typed_at = now()`, webinarID, hostID)
	return err
}

// ClaimAloudHarvest takes a session's answered-aloud pass; false when it was already taken.
func (s *Store) ClaimAloudHarvest(ctx context.Context, webinarID, hostID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO knowledge_harvests (webinar_id, host_id, aloud_at) VALUES ($1, $2, now())
		ON CONFLICT (webinar_id) DO UPDATE SET aloud_at = now()
		 WHERE knowledge_harvests.aloud_at IS NULL`, webinarID, hostID)
	return err == nil && tag.RowsAffected() > 0, err
}

// SettleAloudHarvest records how the pass went; release hands it back, to run again later.
func (s *Store) SettleAloudHarvest(ctx context.Context, webinarID, reason string, release bool) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE knowledge_harvests
		   SET aloud_reason = $2, aloud_at = CASE WHEN $3 THEN NULL ELSE aloud_at END
		 WHERE webinar_id = $1`, webinarID, reason, release)
	return err
}

// AloudHarvestReason is how a session's answered-aloud pass went ("" before it ran).
func (s *Store) AloudHarvestReason(ctx context.Context, webinarID string) (string, error) {
	var r string
	err := s.pool.QueryRow(ctx, `SELECT aloud_reason FROM knowledge_harvests WHERE webinar_id = $1`, webinarID).Scan(&r)
	if noRows(err) {
		return "", nil
	}
	return r, err
}

// PastAnswerIn is an entry to save, from a session.
type PastAnswerIn struct {
	// Key is the session question (or cluster) it came from: saved once per session.
	Key       string
	WebinarID string
	Topic     string
	At        time.Time
	Question  string
	Answer    string
	// Status is approved (typed) or pending (aloud).
	Status string
	Origin string
	// Vec is the question's embedding; nil when there is none (backfilled later).
	Vec []float32
}

func vectorArg(v []float32) any {
	if len(v) == 0 {
		return nil
	}
	return VectorLiteral(v)
}

/* findRepeat is the host's approved entry asking the same question, other than except: the
 * nearest by embedding at knowledge.RepeatSimilarity or better, else the newest with the same
 * words (knowledge.SameQuestion). "" when there is none. */
func findRepeat(ctx context.Context, tx pgx.Tx, hostID, except, question string, vec []float32) (string, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, question,
		       CASE WHEN $2::halfvec IS NULL OR embedding IS NULL THEN 0
		            ELSE 1 - (embedding <=> $2::halfvec) END
		  FROM knowledge_answers
		 WHERE host_id = $1 AND status = 'approved' AND id::text <> $3
		 ORDER BY updated_at DESC, id`, hostID, vectorArg(vec), except)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	best, bestSim, same := "", 0.0, ""
	for rows.Next() {
		var (
			id, q string
			sim   float64
		)
		if err := rows.Scan(&id, &q, &sim); err != nil {
			return "", err
		}
		if sim >= knowledge.RepeatSimilarity && sim > bestSim {
			best, bestSim = id, sim
		}
		if same == "" && knowledge.SameQuestion(q, question) {
			same = id
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if best != "" {
		return best, nil
	}
	return same, nil
}

// updateFromRepeat puts a repeat's text on an entry, keeping what it replaces for one Undo.
// Nothing changes when the answer is the one it already holds.
func updateFromRepeat(ctx context.Context, tx pgx.Tx, id string, in PastAnswerIn) (bool, error) {
	var at any
	if !in.At.IsZero() {
		at = in.At
	}
	tag, err := tx.Exec(ctx, `
		UPDATE knowledge_answers
		   SET prev_question = question, prev_answer = answer, prev_topic = source_topic,
		       prev_at = source_at, prev_webinar_id = source_webinar_id,
		       question = $2, answer = $3, source_webinar_id = NULLIF($4, '')::uuid,
		       source_topic = $5, source_at = $6, embedding = $7::halfvec, origin = $8,
		       updated_at = now()
		 WHERE id::text = $1 AND answer <> $3`,
		id, in.Question, in.Answer, in.WebinarID, in.Topic, at, vectorArg(in.Vec), in.Origin)
	return err == nil && tag.RowsAffected() > 0, err
}

/* SavePastAnswers saves a session's entries for a host, each once per session (its Key): an
 * approved one that repeats an existing entry updates it, anything else is added while the
 * host has fewer than types.PastAnswerMaxEntries. The host's row is locked, so two harvests
 * at once cannot both add the same entry. Returns how many were added and updated. */
func (s *Store) SavePastAnswers(ctx context.Context, hostID string, items []PastAnswerIn) (added, updated int, err error) {
	if len(items) == 0 {
		return 0, 0, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, hostID); err != nil {
		return 0, 0, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM knowledge_answers WHERE host_id = $1`, hostID).Scan(&count); err != nil {
		return 0, 0, err
	}
	for _, in := range items {
		if in.Key != "" && in.WebinarID != "" {
			tag, err := tx.Exec(ctx, `
				INSERT INTO knowledge_answer_sources (webinar_id, source_key) VALUES ($1, $2)
				ON CONFLICT DO NOTHING`, in.WebinarID, in.Key)
			if err != nil {
				return 0, 0, err
			}
			if tag.RowsAffected() == 0 {
				continue // saved already
			}
		}
		if in.Status == types.PastAnswerApproved {
			id, err := findRepeat(ctx, tx, hostID, "", in.Question, in.Vec)
			if err != nil {
				return 0, 0, err
			}
			if id != "" {
				ok, err := updateFromRepeat(ctx, tx, id, in)
				if err != nil {
					return 0, 0, err
				}
				if ok {
					updated++
				}
				continue
			}
		}
		if count >= types.PastAnswerMaxEntries {
			continue
		}
		var at any
		if !in.At.IsZero() {
			at = in.At
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO knowledge_answers (host_id, question, answer, status, origin,
			                               source_webinar_id, source_topic, source_at, embedding)
			VALUES ($1, $2, $3, $4, $5, NULLIF($6, '')::uuid, $7, $8, $9::halfvec)`,
			hostID, in.Question, in.Answer, in.Status, in.Origin, in.WebinarID, in.Topic, at,
			vectorArg(in.Vec)); err != nil {
			return 0, 0, err
		}
		count++
		added++
	}
	return added, updated, tx.Commit(ctx)
}

const pastAnswerColumns = `a.id::text, a.question, a.answer, a.status, a.origin, a.source_topic,
	a.source_at, a.prev_answer IS NOT NULL, a.updated_at`

func scanPastAnswer(r rowScanner) (types.PastAnswer, error) {
	var (
		p   types.PastAnswer
		at  *time.Time
		upd time.Time
	)
	if err := r.Scan(&p.ID, &p.Question, &p.Answer, &p.Status, &p.Origin, &p.SourceTopic, &at,
		&p.CanUndo, &upd); err != nil {
		return p, err
	}
	if at != nil {
		p.SourceAt = at.UTC().Format(time.RFC3339)
	}
	if p.CanUndo {
		p.UpdatedFrom, p.UpdatedFromAt = p.SourceTopic, p.SourceAt
	}
	p.UpdatedAt = upd.UTC().Format(time.RFC3339)
	return p, nil
}

// PastAnswers is a host's entries: pending first, then approved, newest first.
func (s *Store) PastAnswers(ctx context.Context, hostID string) ([]types.PastAnswer, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+pastAnswerColumns+`
		  FROM knowledge_answers a WHERE a.host_id = $1
		 ORDER BY a.status = 'approved', a.updated_at DESC, a.id`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.PastAnswer{}
	for rows.Next() {
		p, err := scanPastAnswer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PastAnswer is one of a host's entries; ErrNotFound for another's.
func (s *Store) PastAnswer(ctx context.Context, hostID, id string) (types.PastAnswer, error) {
	p, err := scanPastAnswer(s.pool.QueryRow(ctx, `SELECT `+pastAnswerColumns+`
		  FROM knowledge_answers a WHERE a.id::text = $1 AND a.host_id = $2`, id, hostID))
	if noRows(err) {
		return p, ErrNotFound
	}
	return p, err
}

/* EditPastAnswer replaces an entry's text with the host's correction; ErrNotFound for
 * another's. The embedding is dropped (re-embedded from the new text) and so is the version
 * an Undo would have restored: the correction is the host's word on it. */
func (s *Store) EditPastAnswer(ctx context.Context, hostID, id, question, answer string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE knowledge_answers
		   SET question = $3, answer = $4, embedding = NULL, updated_at = now(),
		       prev_question = NULL, prev_answer = NULL, prev_topic = NULL, prev_at = NULL,
		       prev_webinar_id = NULL
		 WHERE id::text = $1 AND host_id = $2`, id, hostID, question, answer)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

/* ApprovePastAnswer approves a pending entry with the text given (the host's edit). When it
 * repeats an approved entry, that entry is updated instead (keeping its previous version for
 * Undo) and the draft is removed: merged, and id is the entry updated. ErrNotFound for an
 * entry that is not the host's or not pending. */
func (s *Store) ApprovePastAnswer(ctx context.Context, hostID, id, question, answer string, vec []float32) (string, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, hostID); err != nil {
		return "", false, err
	}
	var (
		webinarID, topic string
		at               *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(source_webinar_id::text, ''), source_topic, source_at
		  FROM knowledge_answers WHERE id::text = $1 AND host_id = $2 AND status = 'pending'`,
		id, hostID).Scan(&webinarID, &topic, &at)
	if noRows(err) {
		return "", false, ErrNotFound
	}
	if err != nil {
		return "", false, err
	}
	in := PastAnswerIn{WebinarID: webinarID, Topic: topic, Question: question, Answer: answer,
		Origin: types.PastAnswerAloud, Vec: vec}
	if at != nil {
		in.At = *at
	}
	repeat, err := findRepeat(ctx, tx, hostID, id, question, vec)
	if err != nil {
		return "", false, err
	}
	if repeat != "" {
		if _, err := updateFromRepeat(ctx, tx, repeat, in); err != nil {
			return "", false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM knowledge_answers WHERE id::text = $1`, id); err != nil {
			return "", false, err
		}
		return repeat, true, tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE knowledge_answers
		   SET status = 'approved', question = $2, answer = $3, embedding = $4::halfvec, updated_at = now()
		 WHERE id::text = $1`, id, question, answer, vectorArg(vec)); err != nil {
		return "", false, err
	}
	return id, false, tx.Commit(ctx)
}

// UndoPastAnswer puts back the version a repeat replaced; ErrNotFound for another host's entry
// or one with nothing to undo.
func (s *Store) UndoPastAnswer(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE knowledge_answers
		   SET question = prev_question, answer = prev_answer, source_topic = COALESCE(prev_topic, ''),
		       source_at = prev_at, source_webinar_id = prev_webinar_id, embedding = NULL,
		       prev_question = NULL, prev_answer = NULL, prev_topic = NULL, prev_at = NULL,
		       prev_webinar_id = NULL, updated_at = now()
		 WHERE id::text = $1 AND host_id = $2 AND prev_answer IS NOT NULL`, id, hostID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// DeletePastAnswer removes one of a host's entries (Skip, for a pending one); ErrNotFound for
// another's. Its session question stays harvested, so it does not come back.
func (s *Store) DeletePastAnswer(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM knowledge_answers WHERE id::text = $1 AND host_id = $2`, id, hostID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// PastAnswerRef is an entry to embed.
type PastAnswerRef struct {
	ID       string
	Question string
}

// PastAnswersWithoutEmbedding is up to limit of a host's entries not embedded yet.
func (s *Store) PastAnswersWithoutEmbedding(ctx context.Context, hostID string, limit int) ([]PastAnswerRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, question FROM knowledge_answers
		 WHERE host_id = $1 AND embedding IS NULL
		 ORDER BY status = 'pending', updated_at DESC, id LIMIT $2`, hostID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PastAnswerRef{}
	for rows.Next() {
		var p PastAnswerRef
		if err := rows.Scan(&p.ID, &p.Question); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetPastAnswerEmbeddings stores each entry's vector, unless its question changed meanwhile.
func (s *Store) SetPastAnswerEmbeddings(ctx context.Context, refs []PastAnswerRef, vecs [][]float32) error {
	batch := &pgx.Batch{}
	for i, p := range refs {
		if i >= len(vecs) || len(vecs[i]) == 0 {
			continue
		}
		batch.Queue(`UPDATE knowledge_answers SET embedding = $2::halfvec WHERE id::text = $1 AND question = $3`,
			p.ID, VectorLiteral(vecs[i]), p.Question)
	}
	if batch.Len() == 0 {
		return nil
	}
	return s.pool.SendBatch(ctx, batch).Close()
}

// SessionPastAnswers is the session's "Past answers" item: the host's approved entries, and
// whether this session uses them.
func (s *Store) SessionPastAnswers(ctx context.Context, slug string) (types.SessionPastAnswers, error) {
	var p types.SessionPastAnswers
	err := s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*)::int FROM knowledge_answers a
		         WHERE a.host_id = w.host_id AND a.status = 'approved'),
		       NOT EXISTS (SELECT 1 FROM session_past_answers_off o WHERE o.webinar_id = w.id)
		  FROM webinars w WHERE w.slug = $1`, slug).Scan(&p.Count, &p.Included)
	if noRows(err) {
		return p, ErrNotFound
	}
	return p, err
}

// SetSessionPastAnswers ticks or unticks the past answers for one session.
func (s *Store) SetSessionPastAnswers(ctx context.Context, slug string, included bool) error {
	var err error
	if included {
		_, err = s.pool.Exec(ctx, `
			DELETE FROM session_past_answers_off o USING webinars w
			 WHERE o.webinar_id = w.id AND w.slug = $1`, slug)
	} else {
		_, err = s.pool.Exec(ctx, `
			INSERT INTO session_past_answers_off (webinar_id)
			SELECT id FROM webinars WHERE slug = $1 ON CONFLICT DO NOTHING`, slug)
	}
	return err
}
