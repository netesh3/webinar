package store

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/internal/survey"
	"github.com/netkumar/webcast/api/types"
)

/* The audience's side of a survey: what they are offered, their own response, and the
 * two writes they can make. Every statement carries availableSQL, so a survey the host has
 * closed (or never sent) cannot be answered even by a client holding an old copy. */

/* AudienceSurvey is the survey as an attendee may see it — questions, no counts — plus
 * whether it is live and their own response. Survey is nil when nothing is available. */
func (s *Store) AudienceSurvey(ctx context.Context, slug, identity string) (types.AudienceSurvey, error) {
	out := types.AudienceSurvey{}
	var sv types.Survey
	err := scanSurvey(s.pool.QueryRow(ctx, `
		SELECT `+surveyColumns+`
		  FROM surveys s JOIN webinars w ON w.id = s.webinar_id
		 WHERE w.slug = $1 AND `+availableSQL, slug), &sv)
	if noRows(err) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	live := sv.Status == types.SurveyLive
	if sv.Questions, err = surveyQuestions(ctx, s.pool, sv.ID); err != nil {
		return out, err
	}
	var rating *int
	var submitted, clicked *time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT rating, submitted_at, link_clicked_at FROM survey_responses
		 WHERE survey_id = $1::uuid AND identity = $2`, sv.ID, identity).Scan(&rating, &submitted, &clicked)
	if err != nil && !noRows(err) {
		return out, err
	}
	out.Survey, out.Live = &sv, live
	out.Mine = types.MySurveyResponse{Submitted: submitted != nil, LinkClicked: clicked != nil}
	if rating != nil {
		out.Mine.Rating = *rating
	}
	if submitted != nil {
		out.Mine.SubmittedAt = submitted.UTC().Format(time.RFC3339)
	}
	return out, nil
}

/* SubmitSurvey stores one attendee's response, once.
 *
 * Idempotent: the unique (survey_id, identity) row is claimed with an upsert that only
 * writes while submitted_at is still NULL, so a retry or a second tab gets already=true and
 * changes nothing. A row a link click created first is completed rather than duplicated.
 * ErrConflict when the survey is no longer (or not yet) available. */
func (s *Store) SubmitSurvey(
	ctx context.Context, slug, surveyID, identity, registrationID string, rating *int, answers []survey.Answer,
) (already bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ok bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM surveys s JOIN webinars w ON w.id = s.webinar_id
		                WHERE w.slug = $1 AND s.id = $2::uuid AND `+availableSQL+`)`,
		slug, surveyID).Scan(&ok); err != nil {
		return false, err
	}
	if !ok {
		return false, ErrConflict
	}

	var responseID string
	err = tx.QueryRow(ctx, `
		INSERT INTO survey_responses (survey_id, identity, registration_id, rating, submitted_at)
		VALUES ($1::uuid, $2, NULLIF($3, '')::uuid, $4, now())
		ON CONFLICT (survey_id, identity) DO UPDATE
		   SET rating = EXCLUDED.rating, submitted_at = now(),
		       registration_id = coalesce(survey_responses.registration_id, EXCLUDED.registration_id)
		 WHERE survey_responses.submitted_at IS NULL
		RETURNING id::text`,
		surveyID, identity, registrationID, rating).Scan(&responseID)
	if noRows(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	for _, a := range answers {
		var text *string
		if a.Number == nil {
			t := a.Text
			text = &t
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_answers (response_id, question_id, number, text)
			VALUES ($1::uuid, $2::uuid, $3, $4)`, responseID, a.QuestionID, a.Number, text); err != nil {
			return false, err
		}
	}
	return false, tx.Commit(ctx)
}

// RecordSurveyClick notes the first time an attendee opened a link survey.
func (s *Store) RecordSurveyClick(ctx context.Context, slug, surveyID, identity, registrationID string) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO survey_responses (survey_id, identity, registration_id, link_clicked_at)
		SELECT s.id, $3, NULLIF($4, '')::uuid, now()
		  FROM surveys s JOIN webinars w ON w.id = s.webinar_id
		 WHERE w.slug = $1 AND s.id = $2::uuid AND s.mode = 'link' AND `+availableSQL+`
		ON CONFLICT (survey_id, identity) DO UPDATE
		   SET link_clicked_at = coalesce(survey_responses.link_clicked_at, now())`,
		slug, surveyID, identity, registrationID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}
