package store

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The room's Q&A, read back for somebody joining or reconnecting.
 *
 * Questions were always written down (session_questions, via the relay) but nothing
 * ever read them back into the room, so a reload or a dropped connection emptied the
 * Q&A panel. RoomQuestions is that read.
 */

// roomQuestionLimit caps one read. It matches MAX_QUESTIONS in web/lib/realtime.ts:
// the client keeps no more than this, so sending more would be thrown away.
const roomQuestionLimit = 300

/* UpvoteQuestion records one person's vote, once.
 *
 * Scoped to the webinar, so a question id from one session cannot be voted on through
 * another's slug. Returns whether the vote was new: a repeat is not an error — a
 * rejoined tab clicking again is the ordinary way to get here — it just changes nothing.
 * ErrNotFound when there is no such question on record (asked before questions were
 * persisted for everyone), so the caller can still deliver the vote live.
 */
func (s *Store) UpvoteQuestion(ctx context.Context, slug, id, identity string) (bool, error) {
	if id == "" || identity == "" {
		return false, ErrNotFound
	}
	var found, added int
	err := s.pool.QueryRow(ctx, `
		WITH q AS (
			SELECT q.id FROM session_questions q
			  JOIN webinars w ON w.id = q.webinar_id
			 WHERE w.slug = $1 AND q.id = $2
		), vote AS (
			INSERT INTO session_question_votes (question_id, identity)
			SELECT q.id, $3 FROM q
			ON CONFLICT DO NOTHING
			RETURNING question_id
		), bump AS (
			UPDATE session_questions SET upvotes = upvotes + 1
			 WHERE id IN (SELECT question_id FROM vote)
			RETURNING id
		)
		SELECT (SELECT count(*) FROM q)::int, (SELECT count(*) FROM bump)::int`,
		slug, id, identity).Scan(&found, &added)
	if err != nil {
		return false, err
	}
	if found == 0 {
		return false, ErrNotFound
	}
	return added > 0, nil
}

/* RoomQuestions is the Q&A as `viewer` is entitled to see it.
 *
 * forStage is decided by the handler, like ChatBacklog's. The audience does not get
 * the questions the stage hid — only their ids, in Hidden, so a client holding one
 * from before a drop can remove it. An anonymous question is returned without its
 * asker unless the asker is the viewer, who still needs to see "(you)".
 *
 * The newest roomQuestionLimit, returned oldest first.
 */
func (s *Store) RoomQuestions(
	ctx context.Context, slug, viewer string, forStage bool,
) (types.RoomQuestions, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, identity, name, body, anonymous, answered, answer, pinned, dismissed,
		       upvotes, created_at, role, voted
		  FROM (
			SELECT q.id, q.identity, q.name, q.body, q.anonymous, q.answered, q.answer,
			       q.pinned, q.dismissed, q.upvotes, q.created_at, q.role,
			       EXISTS (SELECT 1 FROM session_question_votes v
			                WHERE v.question_id = q.id AND v.identity = $2) AS voted
			  FROM session_questions q
			  JOIN webinars w ON w.id = q.webinar_id
			 WHERE w.slug = $1 AND ($3 OR NOT q.dismissed)
			 ORDER BY q.created_at DESC, q.id DESC
			 LIMIT $4
		  ) recent
		 ORDER BY created_at, id`,
		slug, viewer, forStage, roomQuestionLimit)
	if err != nil {
		return types.RoomQuestions{}, err
	}
	defer rows.Close()

	out := types.RoomQuestions{Questions: []types.SessionQuestion{}, Hidden: []string{}}
	for rows.Next() {
		var (
			q    types.SessionQuestion
			at   time.Time
			role string
		)
		if err := rows.Scan(&q.ID, &q.Identity, &q.Name, &q.Text, &q.Anonymous, &q.Answered,
			&q.Answer, &q.Pinned, &q.Dismissed, &q.Upvotes, &at, &role, &q.VotedByMe); err != nil {
			return types.RoomQuestions{}, err
		}
		q.CreatedAt = at.Format(time.RFC3339Nano)
		q.Role = types.Role(role)
		if q.Anonymous && q.Identity != viewer {
			q.Identity, q.Name = "", ""
		}
		out.Questions = append(out.Questions, q)
	}
	if err := rows.Err(); err != nil {
		return types.RoomQuestions{}, err
	}
	if forStage {
		return out, nil
	}

	hidden, err := s.pool.Query(ctx, `
		SELECT q.id FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND q.dismissed
		 ORDER BY q.created_at DESC
		 LIMIT $2`, slug, roomQuestionLimit)
	if err != nil {
		return types.RoomQuestions{}, err
	}
	defer hidden.Close()
	for hidden.Next() {
		var id string
		if err := hidden.Scan(&id); err != nil {
			return types.RoomQuestions{}, err
		}
		out.Hidden = append(out.Hidden, id)
	}
	return out, hidden.Err()
}
