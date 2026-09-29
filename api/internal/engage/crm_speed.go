package engage

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Inbox speed: snoozing a conversation, and the host's saved quick replies. See
 * migrations/0063 and docs/engage/V2.md, "Phase 3". */

const maxSnooze = 30 * 24 * time.Hour

// handleCRMInboxSnooze snoozes a conversation until a time, or wakes it.
func (s *Module) handleCRMInboxSnooze(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")
	var body types.CRMSnoozeRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if !looksLikeUUID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	}
	var until time.Time
	if raw := strings.TrimSpace(body.Until); raw != "" {
		t, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_snooze", "Pick when to be reminded.")
			return
		}
		if d := time.Until(t); d <= 0 || d > maxSnooze {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_snooze",
				"Snooze for a time in the next 30 days.")
			return
		}
		until = t
	}
	err := s.store.SetInboxSnooze(r.Context(), user.ID, id, until)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm inbox snooze", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Module) handleCRMSnippets(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	out, err := s.store.Snippets(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm snippets", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMSnippetsResponse{Snippets: out})
}

func (s *Module) handleCreateCRMSnippet(w http.ResponseWriter, r *http.Request) {
	s.saveSnippet(w, r, "")
}

func (s *Module) handleUpdateCRMSnippet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !looksLikeUUID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such quick reply.")
		return
	}
	s.saveSnippet(w, r, id)
}

func (s *Module) saveSnippet(w http.ResponseWriter, r *http.Request, id string) {
	user := authctx.User(r.Context())
	var body types.CRMSnippetRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	out, err := s.store.SaveSnippet(r.Context(), user.ID, id, body.Title, body.Body)
	switch {
	case errors.Is(err, store.ErrInvalid):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_snippet",
			"A quick reply needs a short name (up to 40 characters) and the message.")
		return
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_too_many_snippets",
			"You can keep "+strconv.Itoa(crmstore.SnippetMax)+" quick replies. Delete one first.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such quick reply.")
		return
	case err != nil:
		s.fail(w, r, "crm snippet: save", err)
		return
	}
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, out)
}

func (s *Module) handleDeleteCRMSnippet(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")
	if !looksLikeUUID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such quick reply.")
		return
	}
	err := s.store.DeleteSnippet(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such quick reply.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm snippet: delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
