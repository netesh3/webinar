package store

import (
	"context"
)

/* CopyWebinarExtras carries what a copied webinar keeps beyond its form fields:
 * the price, the poll and quiz questions, and the survey with its questions.
 *
 * Definitions only. Polls come back as drafts with no votes, the survey as a
 * draft that has never been sent, so the copy starts as clean as a new webinar
 * that happened to be written the same way. Both webinars must belong to hostID;
 * the handler checks that already, and the WHERE clauses check it again. */
func (s *Store) CopyWebinarExtras(ctx context.Context, hostID, fromSlug, toSlug string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var fromID, toID string
	if err := tx.QueryRow(ctx, `
		SELECT f.id::text, t.id::text
		  FROM webinars f, webinars t
		 WHERE f.slug = $2 AND t.slug = $3 AND f.host_id = $1::uuid AND t.host_id = $1::uuid`,
		hostID, fromSlug, toSlug).Scan(&fromID, &toID); err != nil {
		if noRows(err) {
			return ErrNotFound
		}
		return err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE webinars t SET price_cents = f.price_cents
		  FROM webinars f
		 WHERE f.id = $1::uuid AND t.id = $2::uuid`, fromID, toID); err != nil {
		return err
	}

	// created_at is spread a millisecond apart so the copies list in the same order.
	if _, err := tx.Exec(ctx, `
		INSERT INTO polls (webinar_id, question, kind, options, correct_option, state, share_results, created_at)
		SELECT $2::uuid, p.question, p.kind, p.options, p.correct_option, 'draft', p.share_results,
		       now() + (row_number() OVER (ORDER BY p.created_at, p.id)) * interval '1 millisecond'
		  FROM polls p
		 WHERE p.webinar_id = $1::uuid`, fromID, toID); err != nil {
		return err
	}

	var newSurvey string
	err = tx.QueryRow(ctx, `
		INSERT INTO surveys (webinar_id, mode, title, button_label, external_url, ask_rating,
		                     status, send_at, send_after_min)
		SELECT $2::uuid, mode, title, button_label, external_url, ask_rating,
		       'draft', send_at, send_after_min
		  FROM surveys WHERE webinar_id = $1::uuid
		RETURNING id::text`, fromID, toID).Scan(&newSurvey)
	if err != nil && !noRows(err) {
		return err
	}
	if newSurvey != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_questions (survey_id, position, kind, prompt, required, options)
			SELECT $2::uuid, q.position, q.kind, q.prompt, q.required, q.options
			  FROM survey_questions q
			  JOIN surveys s ON s.id = q.survey_id
			 WHERE s.webinar_id = $1::uuid`, fromID, newSurvey); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
