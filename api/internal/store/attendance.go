package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func (s *Store) TouchAttendance(ctx context.Context, slug, identity, registrationID string) error {
	if identity == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO attendance (webinar_id, identity, registration_id)
		SELECT w.id, $2, NULLIF($3,'')::uuid
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE
		   SET last_seen_at = now()`,
		slug, identity, registrationID)
	return err
}

func (s *Store) TouchAttendanceMany(ctx context.Context, slug string, identities []string) error {
	for _, id := range identities {
		if err := s.TouchAttendance(ctx, slug, id, ""); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) UpsertSessionQuestion(ctx context.Context, slug string, q types.SessionQuestion) error {
	if q.ID == "" || q.Text == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_questions (id, webinar_id, identity, name, body, anonymous)
		SELECT $1, w.id, $3, $4, $5, $6
		  FROM webinars w WHERE w.slug = $2
		ON CONFLICT (id) DO NOTHING`,
		q.ID, slug, q.Identity, q.Name, q.Text, q.Anonymous)
	return err
}

func (s *Store) AddQuestionUpvote(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_questions SET upvotes = upvotes + 1 WHERE id = $1`, id)
	return err
}

func (s *Store) UpdateSessionQuestion(ctx context.Context, slug, id string, patch types.QuestionPatch) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_questions q
		   SET answered = COALESCE($3, q.answered),
		       answer = COALESCE($4, q.answer),
		       pinned = COALESCE($5, q.pinned),
		       dismissed = COALESCE($6, q.dismissed)
		  FROM webinars w
		 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = $2`,
		slug, id, patch.Answered, patch.Answer, patch.Pinned, patch.Dismissed)
	return err
}

func (s *Store) SessionQuestions(ctx context.Context, slug string) ([]types.SessionQuestion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.id, q.identity, q.name, q.body, q.anonymous, q.answered, q.answer,
		       q.pinned, q.dismissed, q.upvotes, q.created_at
		  FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1
		 ORDER BY q.pinned DESC, q.dismissed, q.answered, q.upvotes DESC, q.created_at`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.SessionQuestion{}
	for rows.Next() {
		var q types.SessionQuestion
		var at time.Time
		if err := rows.Scan(&q.ID, &q.Identity, &q.Name, &q.Text, &q.Anonymous, &q.Answered,
			&q.Answer, &q.Pinned, &q.Dismissed, &q.Upvotes, &at); err != nil {
			return nil, err
		}
		q.CreatedAt = at.Format(time.RFC3339)
		out = append(out, q)
	}
	return out, rows.Err()
}

func (s *Store) ComputeAndSaveReport(ctx context.Context, slug string) (types.SessionReport, error) {
	rep, err := s.SessionReport(ctx, slug)
	if err != nil {
		return types.SessionReport{}, err
	}
	summary := types.WebinarReport{
		Attended:    rep.Attended,
		AvgWatchMin: rep.AvgWatchMin,
		Questions:   rep.Questions,
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		return types.SessionReport{}, err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE webinars SET report = $2 WHERE slug = $1`, slug, raw)
	return rep, err
}

func (s *Store) SessionReport(ctx context.Context, slug string) (types.SessionReport, error) {
	var rep types.SessionReport
	err := s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM registrations r JOIN webinars w ON w.id = r.webinar_id
		    WHERE w.slug = $1) AS registered,
		  (SELECT count(*) FROM registrations r JOIN webinars w ON w.id = r.webinar_id
		    WHERE w.slug = $1 AND r.state = 'approved') AS approved,
		  (SELECT count(*) FROM attendance a JOIN webinars w ON w.id = a.webinar_id
		    WHERE w.slug = $1) AS attended,
		  COALESCE((SELECT (EXTRACT(EPOCH FROM avg(a.last_seen_at - a.first_joined_at))/60)::int
		              FROM attendance a JOIN webinars w ON w.id = a.webinar_id
		             WHERE w.slug = $1), 0) AS avg_watch,
		  (SELECT count(*) FROM session_questions q JOIN webinars w ON w.id = q.webinar_id
		    WHERE w.slug = $1 AND NOT q.dismissed) AS questions,
		  (SELECT count(DISTINCT v.identity) FROM poll_votes v
		     JOIN polls p ON p.id = v.poll_id
		     JOIN webinars w ON w.id = p.webinar_id
		    WHERE w.slug = $1) AS poll_voters`,
		slug).Scan(&rep.Registered, &rep.Approved, &rep.Attended, &rep.AvgWatchMin,
		&rep.Questions, &rep.PollVoters)
	if err != nil {
		return types.SessionReport{}, err
	}

	qrows, err := s.SessionQuestions(ctx, slug)
	if err != nil {
		return types.SessionReport{}, err
	}
	rep.QuestionRows = qrows

	attRows, err := s.pool.Query(ctx, `
		SELECT a.identity,
		       COALESCE(NULLIF(trim(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')), ''), a.identity),
		       COALESCE(r.email, ''),
		       GREATEST(0, (EXTRACT(EPOCH FROM (a.last_seen_at - a.first_joined_at))/60)::int)
		  FROM attendance a
		  JOIN webinars w ON w.id = a.webinar_id
		  LEFT JOIN registrations r ON r.id = a.registration_id
		 WHERE w.slug = $1
		 ORDER BY a.first_joined_at`, slug)
	if err != nil {
		return types.SessionReport{}, err
	}
	defer attRows.Close()
	for attRows.Next() {
		var row types.AttendanceRow
		if err := attRows.Scan(&row.Identity, &row.Name, &row.Email, &row.WatchMin); err != nil {
			return types.SessionReport{}, err
		}
		rep.Attendees = append(rep.Attendees, row)
	}
	if err := attRows.Err(); err != nil {
		return types.SessionReport{}, err
	}
	if rep.Attendees == nil {
		rep.Attendees = []types.AttendanceRow{}
	}
	return rep, nil
}

func (s *Store) AppendCaption(ctx context.Context, slug, identity, body string) error {
	if body == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_captions (webinar_id, identity, body)
		SELECT w.id, $2, $3 FROM webinars w WHERE w.slug = $1`,
		slug, identity, body)
	return err
}

func (s *Store) CaptionTranscript(ctx context.Context, slug string) (string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(c.at, 'HH24:MI:SS'), c.identity, c.body
		  FROM session_captions c
		  JOIN webinars w ON w.id = c.webinar_id
		 WHERE w.slug = $1
		 ORDER BY c.at`, slug)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var at, identity, body string
		if err := rows.Scan(&at, &identity, &body); err != nil {
			return "", err
		}
		b.WriteString(at)
		b.WriteString(" ")
		b.WriteString(identity)
		b.WriteString(": ")
		b.WriteString(body)
		b.WriteByte('\n')
	}
	return b.String(), rows.Err()
}
