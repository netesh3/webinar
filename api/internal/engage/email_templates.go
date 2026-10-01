package engage

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
)

type emailTemplateBody struct {
	Name    string `json:"name"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

type emailTemplateView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Module) mountEmailTemplates(host chi.Router) {
	host.Get("/email-templates", s.handleListEmailTemplates)
	host.Post("/email-templates", s.handleCreateEmailTemplate)
	host.Put("/email-templates/{id}", s.handleUpdateEmailTemplate)
}

func (s *Module) handleListEmailTemplates(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	rows, err := s.store.ListEmailTemplates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "email templates", err)
		return
	}
	out := make([]emailTemplateView, 0, len(rows))
	for _, row := range rows {
		out = append(out, templateView(row))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"templates": out})
}

func (s *Module) handleCreateEmailTemplate(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body emailTemplateBody
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Could not read that request.")
		return
	}
	name, subject, text, msg := cleanEmailTemplate(body)
	if msg != "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", msg)
		return
	}
	row, err := s.store.CreateEmailTemplate(r.Context(), user.ID, name, subject, text)
	if err == store.ErrTemplateTaken {
		httpx.Error(w, http.StatusConflict, "name_taken", "You already have a template with that name.")
		return
	}
	if err != nil {
		s.fail(w, r, "create email template", err)
		return
	}
	httpx.JSON(w, http.StatusCreated, templateView(row))
}

func (s *Module) handleUpdateEmailTemplate(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "That template is not in your library.")
		return
	}
	var body emailTemplateBody
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Could not read that request.")
		return
	}
	name, subject, text, msg := cleanEmailTemplate(body)
	if msg != "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", msg)
		return
	}
	row, err := s.store.UpdateEmailTemplate(r.Context(), user.ID, id, name, subject, text)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That template is not in your library.")
		return
	}
	if err == store.ErrTemplateTaken {
		httpx.Error(w, http.StatusConflict, "name_taken", "You already have a template with that name.")
		return
	}
	if err != nil {
		s.fail(w, r, "update email template", err)
		return
	}
	httpx.JSON(w, http.StatusOK, templateView(row))
}

func cleanEmailTemplate(body emailTemplateBody) (name, subject, text, msg string) {
	name = strings.TrimSpace(body.Name)
	subject = strings.TrimSpace(body.Subject)
	text = strings.TrimSpace(body.Body)
	switch {
	case name == "" || utf8.RuneCountInString(name) > 80:
		return "", "", "", "Give the template a name, up to 80 characters."
	case subject == "" || utf8.RuneCountInString(subject) > 200:
		return "", "", "", "Add a subject, up to 200 characters."
	case text == "" || utf8.RuneCountInString(text) > 8000:
		return "", "", "", "Write the email, up to 8000 characters."
	}
	return name, subject, text, ""
}

func templateView(row store.EmailTemplate) emailTemplateView {
	return emailTemplateView{
		ID:        row.ID,
		Name:      row.Name,
		Subject:   row.Subject,
		Body:      row.Body,
		UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}
