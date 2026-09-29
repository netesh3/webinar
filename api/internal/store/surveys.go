package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/netkumar/webcast/api/internal/survey"
	"github.com/netkumar/webcast/api/types"
)

/* Post-event surveys. The rules are in api/internal/survey; this file loads and writes.
 *
 * A survey is "available" to the audience when it is live, or when it is set up but not yet
 * sent (draft, any timing) while the webinar itself is live: an attendee leaving early is
 * offered it then, and their answer counts exactly as it would after the host sends it.
 * That condition is written once, as availableSQL, and used by every read and write on the
 * audience's side so the offer and the acceptance cannot disagree. */

const availableSQL = `(s.status = 'live' OR (s.status = 'draft' AND w.status = 'live'))`

const surveyColumns = `s.id::text, s.mode, s.title, s.button_label, s.external_url, s.ask_rating,
	s.status, s.send_at, s.send_after_min, s.launched_at, s.closed_at, s.updated_at`

func scanSurvey(row pgx.Row, sv *types.Survey) error {
	var launched, closed *time.Time
	var updated time.Time
	var mode, status, sendAt string
	if err := row.Scan(&sv.ID, &mode, &sv.Title, &sv.ButtonLabel, &sv.ExternalURL, &sv.AskRating,
		&status, &sendAt, &sv.SendAfterMin, &launched, &closed, &updated); err != nil {
		return err
	}
	sv.Mode, sv.Status, sv.SendAt = types.SurveyMode(mode), types.SurveyStatus(status), types.SurveySendAt(sendAt)
	sv.UpdatedAt = updated.UTC().Format(time.RFC3339)
	if launched != nil {
		sv.LaunchedAt = launched.UTC().Format(time.RFC3339)
	}
	if closed != nil {
		sv.ClosedAt = closed.UTC().Format(time.RFC3339)
	}
	return nil
}

type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func surveyQuestions(ctx context.Context, q querier, surveyID string) ([]types.SurveyQuestion, error) {
	rows, err := q.Query(ctx, `
		SELECT id::text, kind, prompt, required, options FROM survey_questions
		 WHERE survey_id = $1 ORDER BY position`, surveyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.SurveyQuestion{}
	for rows.Next() {
		var qn types.SurveyQuestion
		var kind string
		var opts []byte
		if err := rows.Scan(&qn.ID, &kind, &qn.Prompt, &qn.Required, &opts); err != nil {
			return nil, err
		}
		qn.Kind = types.SurveyQuestionKind(kind)
		if err := json.Unmarshal(opts, &qn.Options); err != nil {
			return nil, err
		}
		if qn.Options == nil {
			qn.Options = []string{}
		}
		out = append(out, qn)
	}
	return out, rows.Err()
}

// HostSurvey is the host's view of a webinar's survey. ErrNotFound when none is set up.
func (s *Store) HostSurvey(ctx context.Context, slug string) (types.Survey, error) {
	return hostSurvey(ctx, s.pool, slug)
}

func hostSurvey(ctx context.Context, q querier, slug string) (types.Survey, error) {
	var sv types.Survey
	err := scanSurvey(q.QueryRow(ctx, `
		SELECT `+surveyColumns+` FROM surveys s JOIN webinars w ON w.id = s.webinar_id
		 WHERE w.slug = $1`, slug), &sv)
	if noRows(err) {
		return sv, ErrNotFound
	}
	if err != nil {
		return sv, err
	}
	if sv.Questions, err = surveyQuestions(ctx, q, sv.ID); err != nil {
		return sv, err
	}
	var anyRows bool
	if err := q.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE submitted_at IS NOT NULL),
		       count(*) FILTER (WHERE link_clicked_at IS NOT NULL),
		       count(*) > 0
		  FROM survey_responses WHERE survey_id = $1`, sv.ID).
		Scan(&sv.Responses, &sv.LinkClicks, &anyRows); err != nil {
		return sv, err
	}
	sv.Locked = sv.Responses > 0
	return sv, nil
}

// SurveyAttended is how many attendees have been in the room: the response-rate denominator.
func (s *Store) SurveyAttended(ctx context.Context, slug string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM attendance a JOIN webinars w ON w.id = a.webinar_id
		 WHERE w.slug = $1 AND starts_with(a.identity, 'att_')`, slug).Scan(&n)
	return n, err
}

/* SaveSurvey writes the whole configuration, creating the survey on first save.
 *
 * Questions are matched by id: a kept id is updated in place (so answers stay attached),
 * a new one is inserted, and one no longer listed is deleted with its answers. Once anybody
 * has submitted, only the presentation may change — title, button label, link and timing —
 * and anything else is ErrConflict, so every stored answer still means what it meant. */
func (s *Store) SaveSurvey(ctx context.Context, slug string, c survey.Config) (types.Survey, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Survey{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var webinarID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM webinars WHERE slug = $1 FOR UPDATE`, slug).
		Scan(&webinarID); noRows(err) {
		return types.Survey{}, ErrNotFound
	} else if err != nil {
		return types.Survey{}, err
	}

	current, err := hostSurvey(ctx, tx, slug)
	exists := err == nil
	if err != nil && !errors.Is(err, ErrNotFound) {
		return types.Survey{}, err
	}
	if exists && current.Locked && structureChanged(current, c) {
		return types.Survey{}, ErrConflict
	}

	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO surveys (webinar_id, mode, title, button_label, external_url, ask_rating, send_at, send_after_min)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (webinar_id) DO UPDATE SET
		       mode = EXCLUDED.mode, title = EXCLUDED.title, button_label = EXCLUDED.button_label,
		       external_url = EXCLUDED.external_url, ask_rating = EXCLUDED.ask_rating,
		       send_at = EXCLUDED.send_at, send_after_min = EXCLUDED.send_after_min, updated_at = now()
		RETURNING id::text`,
		webinarID, string(c.Mode), c.Title, c.ButtonLabel, c.ExternalURL, c.AskRating, string(c.SendAt), c.SendAfterMin,
	).Scan(&id); err != nil {
		return types.Survey{}, err
	}

	keep := map[string]bool{}
	existing := map[string]bool{}
	for _, q := range current.Questions {
		existing[q.ID] = true
	}
	for _, q := range c.Questions {
		if existing[q.ID] {
			keep[q.ID] = true
		}
	}
	for qid := range existing {
		if !keep[qid] {
			if _, err := tx.Exec(ctx, `DELETE FROM survey_questions WHERE id = $1::uuid`, qid); err != nil {
				return types.Survey{}, err
			}
		}
	}
	for i, q := range c.Questions {
		opts, err := json.Marshal(q.Options)
		if err != nil {
			return types.Survey{}, err
		}
		if keep[q.ID] {
			_, err = tx.Exec(ctx, `
				UPDATE survey_questions SET position = $2, kind = $3, prompt = $4, required = $5, options = $6::jsonb
				 WHERE id = $1::uuid`, q.ID, i, string(q.Kind), q.Prompt, q.Required, string(opts))
		} else {
			_, err = tx.Exec(ctx, `
				INSERT INTO survey_questions (survey_id, position, kind, prompt, required, options)
				VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)`, id, i, string(q.Kind), q.Prompt, q.Required, string(opts))
		}
		if err != nil {
			return types.Survey{}, err
		}
	}
	saved, err := hostSurvey(ctx, tx, slug)
	if err != nil {
		return types.Survey{}, err
	}
	return saved, tx.Commit(ctx)
}

// structureChanged reports whether c alters anything an existing answer depends on.
func structureChanged(cur types.Survey, c survey.Config) bool {
	if cur.Mode != c.Mode || cur.AskRating != c.AskRating || len(cur.Questions) != len(c.Questions) {
		return true
	}
	for i, q := range cur.Questions {
		n := c.Questions[i]
		if q.ID != n.ID || q.Kind != n.Kind || q.Prompt != n.Prompt || q.Required != n.Required ||
			len(q.Options) != len(n.Options) {
			return true
		}
		for j := range q.Options {
			if q.Options[j] != n.Options[j] {
				return true
			}
		}
	}
	return false
}

// DeleteSurvey removes an unanswered survey. ErrConflict once anybody has responded.
func (s *Store) DeleteSurvey(ctx context.Context, slug string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM surveys s USING webinars w
		 WHERE w.id = s.webinar_id AND w.slug = $1
		   AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.survey_id = s.id AND r.submitted_at IS NOT NULL)`,
		slug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.HostSurvey(ctx, slug); err != nil {
			return err
		}
		return ErrConflict
	}
	return nil
}

/* SetSurveyStatus launches (live) or closes a survey. Launching a closed one reopens it,
 * keeping its first launch time and every answer already in. */
func (s *Store) SetSurveyStatus(ctx context.Context, slug string, status types.SurveyStatus) (types.Survey, error) {
	var sql string
	switch status {
	case types.SurveyLive:
		sql = `UPDATE surveys s SET status = 'live', launched_at = coalesce(s.launched_at, now()),
		              closed_at = NULL, updated_at = now()
		         FROM webinars w WHERE w.id = s.webinar_id AND w.slug = $1`
	case types.SurveyClosed:
		sql = `UPDATE surveys s SET status = 'closed', closed_at = now(), updated_at = now()
		         FROM webinars w WHERE w.id = s.webinar_id AND w.slug = $1 AND s.status <> 'closed'`
	default:
		return types.Survey{}, ErrInvalid
	}
	if _, err := s.pool.Exec(ctx, sql, slug); err != nil {
		return types.Survey{}, err
	}
	return s.HostSurvey(ctx, slug)
}

/* LaunchSurveyOnEnd sends, as the webinar ends, a survey armed for the end — and a timed one
 * whose minute never came because the host finished early. Reports whether one went out. */
func (s *Store) LaunchSurveyOnEnd(ctx context.Context, slug string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE surveys s SET status = 'live', launched_at = now(), updated_at = now()
		  FROM webinars w
		 WHERE w.id = s.webinar_id AND w.slug = $1 AND s.status = 'draft'
		   AND s.send_at IN ('on_end', 'at_minute')`, slug)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* LaunchDueSurveys sends every timed survey whose minute has come in a live webinar, and
 * returns their webinars' slugs so the rooms can be told. Due-time driven like the rest of
 * the tick: a late pass sends what came due during the gap. */
func (s *Store) LaunchDueSurveys(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE surveys s SET status = 'live', launched_at = now(), updated_at = now()
		  FROM webinars w
		 WHERE w.id = s.webinar_id AND s.status = 'draft' AND s.send_at = 'at_minute'
		   AND w.status = 'live' AND w.started_at IS NOT NULL
		   AND w.started_at + make_interval(mins => s.send_after_min) <= now()
		RETURNING w.slug`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
