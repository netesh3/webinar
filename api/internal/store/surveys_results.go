package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/netkumar/webcast/api/internal/survey"
	"github.com/netkumar/webcast/api/types"
)

// commentsInSummary is how many of the newest text answers the results page carries inline.
const commentsInSummary = 10

// respondentName is who answered, as the host knows them: their registration, else the
// name they joined under, else "Attendee".
const respondentName = `COALESCE(
	NULLIF(btrim(COALESCE(reg.first_name,'') || ' ' || COALESCE(reg.last_name,'')), ''),
	NULLIF(btrim(att.name), ''), 'Attendee')`

const respondentJoins = `
	LEFT JOIN registrations reg ON reg.id = r.registration_id
	LEFT JOIN attendance att ON att.webinar_id = sv.webinar_id AND att.identity = r.identity`

/* SurveyTally loads everything the results page aggregates, grouped in SQL: one row per
 * (question, value) rather than one per answer. ErrNotFound when there is no survey. */
func (s *Store) SurveyTally(ctx context.Context, slug string) (survey.Tally, error) {
	t := survey.Tally{TextCounts: map[string]int{}}
	sv, err := s.HostSurvey(ctx, slug)
	if err != nil {
		return t, err
	}
	t.Survey, t.Responses, t.LinkClicks = sv, sv.Responses, sv.LinkClicks
	if t.Attended, err = s.SurveyAttended(ctx, slug); err != nil {
		return t, err
	}

	b := &pgx.Batch{}
	b.Queue(`
		SELECT rating, count(*)::int FROM survey_responses
		 WHERE survey_id = $1::uuid AND submitted_at IS NOT NULL AND rating IS NOT NULL
		 GROUP BY rating`, sv.ID).
		Query(func(rows pgx.Rows) error {
			for rows.Next() {
				var rating, n int
				if err := rows.Scan(&rating, &n); err != nil {
					return err
				}
				if rating >= 1 && rating <= 5 {
					t.RatingCounts[rating-1] = n
				}
			}
			return rows.Err()
		})
	b.Queue(`
		SELECT a.question_id::text, a.number, count(*)::int
		  FROM survey_answers a JOIN survey_questions q ON q.id = a.question_id
		 WHERE q.survey_id = $1::uuid AND a.number IS NOT NULL
		 GROUP BY 1, 2`, sv.ID).
		Query(scanAll(&t.Numbers, func(rows pgx.Rows, b *survey.Bucket) error {
			return rows.Scan(&b.QuestionID, &b.Number, &b.Count)
		}))
	b.Queue(`
		SELECT a.question_id::text, count(*)::int
		  FROM survey_answers a JOIN survey_questions q ON q.id = a.question_id
		 WHERE q.survey_id = $1::uuid AND a.text IS NOT NULL
		 GROUP BY 1`, sv.ID).
		Query(func(rows pgx.Rows) error {
			for rows.Next() {
				var id string
				var n int
				if err := rows.Scan(&id, &n); err != nil {
					return err
				}
				t.TextCounts[id] = n
			}
			return rows.Err()
		})
	b.Queue(`
		SELECT q.id::text, q.prompt, `+respondentName+`, a.text, r.submitted_at
		  FROM survey_answers a
		  JOIN survey_questions q ON q.id = a.question_id
		  JOIN survey_responses r ON r.id = a.response_id
		  JOIN surveys sv ON sv.id = r.survey_id`+respondentJoins+`
		 WHERE sv.id = $1::uuid AND a.text IS NOT NULL
		 ORDER BY r.submitted_at DESC, r.id, q.position
		 LIMIT $2`, sv.ID, commentsInSummary).
		Query(scanAll(&t.Comments, func(rows pgx.Rows, c *types.SurveyComment) error {
			var at time.Time
			if err := rows.Scan(&c.QuestionID, &c.Prompt, &c.Name, &c.Text, &at); err != nil {
				return err
			}
			c.SubmittedAt = at.UTC().Format(time.RFC3339)
			return nil
		}))
	if err := s.pool.SendBatch(ctx, b).Close(); err != nil {
		return t, err
	}
	return t, nil
}

/* SurveyTextAnswers pages one text question's answers, newest first. The offset cursor is
 * fine here: answers only ever arrive, and a page that shifts by one new answer while a host
 * reads it repeats a line rather than losing one. ErrNotFound for a question that is not a
 * text question of this webinar's survey. */
func (s *Store) SurveyTextAnswers(ctx context.Context, slug, questionID string, offset, limit int) (types.SurveyTextPage, error) {
	page := types.SurveyTextPage{Answers: []types.SurveyTextAnswer{}}
	var ok bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM survey_questions q JOIN surveys sv ON sv.id = q.survey_id
		                 JOIN webinars w ON w.id = sv.webinar_id
		                WHERE w.slug = $1 AND q.id::text = $2 AND q.kind = 'text')`,
		slug, questionID).Scan(&ok); err != nil {
		return page, err
	}
	if !ok {
		return page, ErrNotFound
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM survey_answers WHERE question_id = $1::uuid AND text IS NOT NULL`,
		questionID).Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+respondentName+`, a.text, r.submitted_at
		  FROM survey_answers a
		  JOIN survey_responses r ON r.id = a.response_id
		  JOIN surveys sv ON sv.id = r.survey_id`+respondentJoins+`
		 WHERE a.question_id = $1::uuid AND a.text IS NOT NULL
		 ORDER BY r.submitted_at DESC, r.id
		 OFFSET $2 LIMIT $3`, questionID, offset, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var a types.SurveyTextAnswer
		var at time.Time
		if err := rows.Scan(&a.Name, &a.Text, &at); err != nil {
			return page, err
		}
		a.SubmittedAt = at.UTC().Format(time.RFC3339)
		page.Answers = append(page.Answers, a)
	}
	return page, rows.Err()
}
