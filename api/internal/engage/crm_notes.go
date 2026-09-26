package engage

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Notes: the one thing in the CRM that is never sent.
 *
 * No consent to check, no service window, no template — a note goes nowhere. That makes
 * this the shortest file in the CRM and it is worth saying why it exists at all: a host
 * reading a conversation knows things the messages do not say ("wants a call after 5",
 * "already a customer"), and without somewhere to write them down they go in the contact's
 * name field or nowhere.
 *
 * There is no edit endpoint. See types.CRMNote: a note is a dated observation, and the way
 * to correct one is to delete it and write another.
 */

// handleCRMNotes lists one contact's notes, newest first.
func (s *Module) handleCRMNotes(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMNotes) {
		return
	}
	contactID := chi.URLParam(r, "id")

	// Read the contact first, so another host's id is a 404 rather than an empty list
	// that reads as "nothing written about them yet".
	if _, err := s.store.Contact(r.Context(), user.ID, contactID); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	} else if err != nil {
		s.fail(w, r, "crm notes: contact", err)
		return
	}

	notes, err := s.store.Notes(r.Context(), user.ID, contactID)
	if err != nil {
		s.fail(w, r, "crm notes", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMNotesResponse{Notes: notes})
}

// handleCreateCRMNote writes one down.
func (s *Module) handleCreateCRMNote(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMNotes) {
		return
	}

	var body types.CRMNoteRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	note, err := s.store.AddNote(r.Context(), user.ID, chi.URLParam(r, "id"), user.ID,
		strings.TrimSpace(body.Body))
	switch {
	case errors.Is(err, store.ErrInvalid):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_note",
			"A note needs something in it, and at most "+strconv.Itoa(types.NoteMaxLength)+" characters.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	case err != nil:
		s.fail(w, r, "crm create note", err)
		return
	}
	// The author is the caller: filled in here rather than joined back out of the
	// database for a row we just wrote.
	note.Author = user.Name
	httpx.JSON(w, http.StatusCreated, note)
}

// handleDeleteCRMNote removes one. Addressed by note id rather than under the contact,
// because that is the whole of what identifies it and the host is looking at the note.
func (s *Module) handleDeleteCRMNote(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureCRMNotes) {
		return
	}

	err := s.store.DeleteNote(r.Context(), user.ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such note.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm delete note", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}
