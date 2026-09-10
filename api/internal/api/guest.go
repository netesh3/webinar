package api

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Guest entry: a name, and in.
 *
 * The shared link offers two doors. This is the low-friction one — somebody a colleague sent a
 * link to five minutes before it starts, who will not fill in a form for it. The other door,
 * POST /register, captures a lead and is unchanged.
 *
 * WHY THIS IS NOT A SHORTCUT PAST THE OTHER GATES. It creates a real registration and then
 * hands off to exactly the same code the registered path uses: the attendee ceiling, the
 * 15-minute door, the lock, a stage grant that survives a reconnect. The one thing it must never
 * do is walk through the APPROVAL gate, and that is checked twice — here for a readable message,
 * and again in store.RegisterGuest so a future caller cannot forget.
 *
 * A guest on a manual-approval webinar is a contradiction rather than an edge case: there is no
 * address to notify and nothing for the host to review, so the row would be a seat nobody can
 * ever approve or decline. Refused with a message that says what to do instead.
 */

// guestNameMax is generous. The name is shown on a tile and in chat, and a limit tight enough to
// be tidy turns away real names — but something has to stop a kilobyte arriving.
const guestNameMax = 60

func (s *Server) handleGuestJoin(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req types.GuestJoinRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	name := strings.Join(strings.Fields(req.Name), " ")
	switch {
	case name == "":
		httpx.Fields(w, map[string]string{"name": "Required."})
		return
	case utf8.RuneCountInString(name) > guestNameMax:
		// Counted in runes, not bytes: a 40-character name in Devanagari is not too long, and
		// len() would reject it.
		httpx.Fields(w, map[string]string{"name": "Please keep this under 60 characters."})
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "guest join: load webinar", err)
		return
	}
	if wb.Status == types.StatusDraft {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}

	/* The passcode, checked here because this is the only place a guest join key is minted.
	 *
	 * Same reasoning as the registration path: the passcode gates ENTRY, and the one gate every
	 * attendee passes through is wherever their credential is issued. Checking it on /join
	 * instead would mean anybody could mint a key and only be stopped later, which is a worse
	 * place to find out.
	 */
	if strings.TrimSpace(wb.Passcode) != "" {
		httpx.Error(w, http.StatusForbidden, "passcode_required",
			"This webinar needs a passcode, so please use Register & Join.")
		return
	}

	/* Every gate that can be answered from the record, before anything is created.
	 *
	 * The same function joinAsAttendee runs, called earlier: a guest who taps the button three
	 * weeks early, or after the host locked the room, gets the same refusal without leaving
	 * behind an emailless registration row nobody can act on. joinAsAttendee still runs it —
	 * this is not a substitute for the check, it is the same check, sooner.
	 */
	if b := s.audienceBarrier(wb); b != nil {
		httpx.Error(w, b.status, b.code, b.message)
		return
	}

	// The approval gate. Checked before anything is created, so a refused guest leaves no row.
	if !types.GuestJoinAllowedFor(wb) {
		httpx.Error(w, http.StatusConflict, "guest_join_disabled",
			"The host approves each attendee for this webinar, so please use Register & Join.")
		return
	}

	reg, err := s.store.RegisterGuest(r.Context(), slug, name)
	switch {
	case errors.Is(err, store.ErrGuestNotAllowed):
		httpx.Error(w, http.StatusConflict, "guest_join_disabled",
			"The host approves each attendee for this webinar, so please use Register & Join.")
		return
	case errors.Is(err, store.ErrFull):
		httpx.Error(w, http.StatusConflict, "webinar_full",
			"This webinar has reached its attendee limit.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar isn't open.")
		return
	case err != nil:
		s.fail(w, r, "guest join: register", err)
		return
	}

	s.log.Info("guest registration", "webinar", slug)

	/* Hand straight to the shared join path.
	 *
	 * Not a copy of it. The gates a guest still has to clear — live-or-scheduled, the lock, the
	 * 15-minute door, the attendee ceiling, an existing stage grant — are all in there, and a
	 * second implementation is how a guest ends up exempt from one of them after somebody edits
	 * only the first.
	 */
	s.joinAsAttendee(w, r, wb, reg)
}
