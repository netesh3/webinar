package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrTemplateTaken means this host already has a template with that name.
var ErrTemplateTaken = errors.New("email template name taken")

// EmailTemplate is one wording the host owns. It is not shared across hosts.
type EmailTemplate struct {
	ID        string
	UserID    string
	Name      string
	Subject   string
	Body      string
	UpdatedAt time.Time
}

// ListEmailTemplates returns that host's templates, most recently edited first.
func (s *Store) ListEmailTemplates(ctx context.Context, userID string) ([]EmailTemplate, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id::text, user_id::text, name, subject, body, updated_at
		   FROM email_templates
		  WHERE user_id = $1
		  ORDER BY updated_at DESC, name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EmailTemplate
	for rows.Next() {
		var t EmailTemplate
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// CreateEmailTemplate stores a new wording for that host only.
func (s *Store) CreateEmailTemplate(ctx context.Context, userID, name, subject, body string) (EmailTemplate, error) {
	var t EmailTemplate
	err := s.pool.QueryRow(ctx,
		`INSERT INTO email_templates (id, user_id, name, subject, body)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id::text, user_id::text, name, subject, body, updated_at`,
		uuid.NewString(), userID, name, subject, body,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.UpdatedAt)
	if isUniqueViolation(err) {
		return EmailTemplate{}, ErrTemplateTaken
	}
	return t, err
}

// UpdateEmailTemplate rewrites one template when it belongs to that host.
func (s *Store) UpdateEmailTemplate(ctx context.Context, userID, id, name, subject, body string) (EmailTemplate, error) {
	var t EmailTemplate
	err := s.pool.QueryRow(ctx,
		`UPDATE email_templates
		    SET name = $3, subject = $4, body = $5, updated_at = now()
		  WHERE id = $1 AND user_id = $2
		  RETURNING id::text, user_id::text, name, subject, body, updated_at`,
		id, userID, name, subject, body,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.UpdatedAt)
	if isUniqueViolation(err) {
		return EmailTemplate{}, ErrTemplateTaken
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailTemplate{}, ErrNotFound
	}
	return t, err
}
