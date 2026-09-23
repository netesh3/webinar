package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Notes: the one thing in the CRM that is never sent.
 *
 * No consent, no service window, no template, no cost — which makes the tests short and
 * makes two of them worth having anyway. A note is private: it must never leave on any
 * channel, and it must not be readable by the host whose contact it is not. Everything
 * else here is a dated observation in a list.
 */

func addNote(t *testing.T, h *harness, contactID, body string) types.CRMNote {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contactID+"/notes",
		types.CRMNoteRequest{Body: body})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("add note: status %d body %s", res.StatusCode, raw)
	}
	var note types.CRMNote
	h.decode(raw, &note)
	return note
}

func contactNotes(t *testing.T, h *harness, contactID string) []types.CRMNote {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+contactID+"/notes", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("notes: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMNotesResponse
	h.decode(raw, &out)
	return out.Notes
}

func TestCRMNotes(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureCRMNotes)

	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerOptedIn(t, h, wb.ID)

	first := addNote(t, h, thandi.ID, "  Wants a call after 5pm.  ")
	if first.Body != "Wants a call after 5pm." {
		t.Errorf("body = %q, want it trimmed", first.Body)
	}
	// The author is the host who wrote it, filled in from the caller rather than joined
	// back out of the database for a row we just wrote.
	if first.Author != "Neeraj Kumar" {
		t.Errorf("author = %q, want the host who wrote it", first.Author)
	}
	if first.CreatedAt == "" {
		t.Error("createdAt is empty; a note is a dated observation and the date is half of it")
	}

	second := addNote(t, h, thandi.ID, "Already a customer on the annual plan.")

	// Newest first, because the last thing the host learned is the thing they want.
	notes := contactNotes(t, h, thandi.ID)
	if len(notes) != 2 || notes[0].ID != second.ID || notes[1].ID != first.ID {
		t.Fatalf("notes = %+v, want the newest first", notes)
	}

	// They ride along with the thread, so the pane beside the conversation does not need
	// a request of its own.
	thread := crmThread(t, h, thandi.ID)
	if len(thread.Notes) != 2 {
		t.Errorf("thread carries %d notes, want 2", len(thread.Notes))
	}

	/* Nothing was sent. The assertion looks trivial and is the point of the feature: a
	 * note is what the host would otherwise have typed into the message box.
	 */
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d messages reached Meta from writing notes: %v", len(sends), sends)
	}
	for _, m := range thread.Messages {
		if strings.Contains(m.Body, "after 5pm") {
			t.Errorf("a note is in the conversation: %+v", m)
		}
	}

	// There is no edit: the way to correct a note is to delete it and write another.
	if res, raw := h.do(http.MethodPatch, "/api/host/crm/notes/"+first.ID,
		types.CRMNoteRequest{Body: "Actually before 5pm."}); res.StatusCode != http.StatusMethodNotAllowed &&
		res.StatusCode != http.StatusNotFound {
		t.Errorf("editing a note: status %d, want it not to be a route\n  body: %s", res.StatusCode, raw)
	}

	if res, raw := h.do(http.MethodDelete, "/api/host/crm/notes/"+first.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete note: status %d body %s", res.StatusCode, raw)
	}
	if notes := contactNotes(t, h, thandi.ID); len(notes) != 1 || notes[0].ID != second.ID {
		t.Errorf("notes = %+v after deleting the first", notes)
	}
	if res, _ := h.do(http.MethodDelete, "/api/host/crm/notes/"+first.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("deleting the same note twice: status %d, want 404", res.StatusCode)
	}

	for _, body := range []string{"", "   ", strings.Repeat("x", types.NoteMaxLength+1)} {
		res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+thandi.ID+"/notes",
			types.CRMNoteRequest{Body: body})
		if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_bad_note" {
			t.Errorf("note of %d characters: status %d code %q, want 422 crm_bad_note",
				len(body), res.StatusCode, errorCode(t, raw))
		}
	}

	// A well-formed id that is nobody: the realistic version of this is another host's
	// contact, and the answer has to be the same as for one that never existed.
	res, raw := h.do(http.MethodPost,
		"/api/host/crm/contacts/00000000-0000-0000-0000-000000000000/notes",
		types.CRMNoteRequest{Body: "About somebody who does not exist."})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("note on a contact that is not one: status %d, want 404\n  body: %s", res.StatusCode, raw)
	}
}

/* Another host's contact is a 404, not an empty list.
 *
 * The distinction is the whole security property of this file: an empty list reads as
 * "nothing written about them yet", which would confirm that the contact exists — and
 * these are the host's private words about a named person.
 */
func TestCRMNotesAreOnePerHost(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureCRMNotes)

	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerOptedIn(t, h, wb.ID)
	addNote(t, h, thandi.ID, "Already a customer.")

	h.logout()
	other := h.signup("Other Host", "other-notes@test.dev", true)
	grantFeature(t, h, other.ID, types.FeatureCRMNotes)

	for _, tc := range []struct{ name, method, path string }{
		{"read", http.MethodGet, "/api/host/crm/contacts/" + thandi.ID + "/notes"},
		{"write", http.MethodPost, "/api/host/crm/contacts/" + thandi.ID + "/notes"},
	} {
		res, raw := h.do(tc.method, tc.path, types.CRMNoteRequest{Body: "Snooping."})
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s another host's notes: status %d, want 404\n  body: %s",
				tc.name, res.StatusCode, raw)
		}
	}

	// And the original host still has what they wrote.
	h.logout()
	h.login("neeraj@acme.dev")
	if notes := contactNotes(t, h, thandi.ID); len(notes) != 1 {
		t.Errorf("notes = %+v, want the one the host wrote", notes)
	}
}

/* Switching the feature off hides notes without destroying them.
 *
 * The tables are deliberately not gated — only the endpoints are — because a switch that
 * deleted what the host wrote under it could not be switched back on. An admin turning
 * this off for an account is doing billing, not data retention.
 */
func TestCRMNotesSurviveTheSwitchGoingOff(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	me := meAccount(t, h)
	grantFeature(t, h, me.ID, types.FeatureCRMNotes)

	wb := autoWebinar(t, h, "Scaling Postgres")
	thandi := registerOptedIn(t, h, wb.ID)
	note := addNote(t, h, thandi.ID, "Wants a call after 5pm.")

	if _, err := h.store.SetFeature(t.Context(), me.ID, types.FeatureCRMNotes, false); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+thandi.ID+"/notes", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("notes with the switch off: status %d code %q", res.StatusCode, errorCode(t, raw))
	}
	if n := len(crmThread(t, h, thandi.ID).Notes); n != 0 {
		t.Errorf("the thread still carries %d notes with the switch off", n)
	}

	grantFeature(t, h, me.ID, types.FeatureCRMNotes)
	notes := contactNotes(t, h, thandi.ID)
	if len(notes) != 1 || notes[0].ID != note.ID {
		t.Errorf("notes = %+v after switching the feature back on, want the one written before", notes)
	}
}
