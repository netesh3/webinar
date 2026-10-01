package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	// ErrTemplateTaken means this host already has a template with that name.
	ErrTemplateTaken = errors.New("email template name taken")
	// ErrTemplateRequired means the row is a product default and cannot be deleted.
	ErrTemplateRequired = errors.New("required email template")
)

// EmailTemplate is one wording the host owns. It is not shared across hosts.
// Key is set for a product default. Customized means the host edited that default.
type EmailTemplate struct {
	ID         string
	UserID     string
	Name       string
	Subject    string
	Body       string
	Key        string
	Customized bool
	UpdatedAt  time.Time
}

// EmailTemplateSeed is one required template to insert if this host does not have it.
type EmailTemplateSeed struct {
	Key     string
	Name    string
	Subject string
	Body    string
}

// ListEmailTemplates returns that host's templates, most recently edited first.
func (s *Store) ListEmailTemplates(ctx context.Context, userID string) ([]EmailTemplate, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id::text, user_id::text, name, subject, body, template_key, customized, updated_at
		   FROM email_templates
		  WHERE user_id = $1
		  ORDER BY (template_key = ''), name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EmailTemplate
	for rows.Next() {
		var t EmailTemplate
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.Key, &t.Customized, &t.UpdatedAt); err != nil {
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
		 RETURNING id::text, user_id::text, name, subject, body, template_key, customized, updated_at`,
		uuid.NewString(), userID, name, subject, body,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.Key, &t.Customized, &t.UpdatedAt)
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
		    SET name = CASE WHEN template_key <> '' THEN name ELSE $3 END,
		        subject = $4,
		        body = $5,
		        customized = CASE WHEN template_key <> '' THEN true ELSE customized END,
		        updated_at = now()
		  WHERE id = $1 AND user_id = $2
		  RETURNING id::text, user_id::text, name, subject, body, template_key, customized, updated_at`,
		id, userID, name, subject, body,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.Key, &t.Customized, &t.UpdatedAt)
	if isUniqueViolation(err) {
		return EmailTemplate{}, ErrTemplateTaken
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailTemplate{}, ErrNotFound
	}
	return t, err
}

// EnsureDefaultEmailTemplates inserts any required template this host does not
// already have. A name they already used for their own template is left alone.
func (s *Store) EnsureDefaultEmailTemplates(ctx context.Context, userID string, seeds []EmailTemplateSeed) error {
	for _, seed := range seeds {
		if seed.Key == "" {
			continue
		}
		_, err := s.pool.Exec(ctx,
			`INSERT INTO email_templates (id, user_id, name, subject, body, template_key, customized)
			 VALUES ($1, $2, $3, $4, $5, $6, false)
			 ON CONFLICT (user_id, template_key) WHERE template_key <> '' DO NOTHING`,
			uuid.NewString(), userID, seed.Name, seed.Subject, seed.Body, seed.Key)
		if err != nil && !isUniqueViolation(err) {
			return err
		}
	}
	return nil
}

// EmailTemplateForUser loads one template only when it belongs to that host.
func (s *Store) EmailTemplateForUser(ctx context.Context, userID, id string) (EmailTemplate, error) {
	var t EmailTemplate
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, user_id::text, name, subject, body, template_key, customized, updated_at
		   FROM email_templates
		  WHERE user_id = $1 AND id = $2`, userID, id,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.Key, &t.Customized, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailTemplate{}, ErrNotFound
	}
	return t, err
}

// EmailTemplateByKey loads one required template for that host.
func (s *Store) EmailTemplateByKey(ctx context.Context, userID, key string) (EmailTemplate, error) {
	var t EmailTemplate
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, user_id::text, name, subject, body, template_key, customized, updated_at
		   FROM email_templates
		  WHERE user_id = $1 AND template_key = $2`, userID, key,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.Key, &t.Customized, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailTemplate{}, ErrNotFound
	}
	return t, err
}

// RevertEmailTemplate puts a required template's subject and body back.
func (s *Store) RevertEmailTemplate(ctx context.Context, userID, id, subject, body string) (EmailTemplate, error) {
	var t EmailTemplate
	err := s.pool.QueryRow(ctx,
		`UPDATE email_templates
		    SET subject = $3, body = $4, customized = false, updated_at = now()
		  WHERE id = $1 AND user_id = $2 AND template_key <> ''
		  RETURNING id::text, user_id::text, name, subject, body, template_key, customized, updated_at`,
		id, userID, subject, body,
	).Scan(&t.ID, &t.UserID, &t.Name, &t.Subject, &t.Body, &t.Key, &t.Customized, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var key string
		err = s.pool.QueryRow(ctx,
			`SELECT template_key FROM email_templates WHERE id = $1 AND user_id = $2`, id, userID).Scan(&key)
		if errors.Is(err, pgx.ErrNoRows) {
			return EmailTemplate{}, ErrNotFound
		}
		if err != nil {
			return EmailTemplate{}, err
		}
		return EmailTemplate{}, ErrTemplateRequired
	}
	return t, err
}

// DeleteEmailTemplate removes a template the host created. A required default stays.
func (s *Store) DeleteEmailTemplate(ctx context.Context, userID, id string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM email_templates WHERE id = $1 AND user_id = $2 AND template_key = ''`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var key string
	err = s.pool.QueryRow(ctx,
		`SELECT template_key FROM email_templates WHERE id = $1 AND user_id = $2`, id, userID).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return ErrTemplateRequired
}
