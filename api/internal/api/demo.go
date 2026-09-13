package api

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The "Launch a webinar" demo door.
 *
 * Everywhere else on this server, hosting a webinar requires two things an
 * admin controls: an account, and that account's CanHost flag. This endpoint
 * exists to skip both, on purpose, for a specific narrow use: a visitor who
 * wants to see the product run without signing up for anything. It is off by
 * default — see config.Config.DemoMode — and every account and webinar it
 * creates is flagged is_demo so an operator can always tell them apart from
 * the real thing.
 *
 * Everything downstream of account creation is the ORDINARY path: the webinar
 * this mints is a real row, started the same way handleStartWebinar starts
 * one, and the shared link works through the same guest-join door every other
 * no-registration-required webinar already offers. The only genuinely new
 * code here is minting the account and picking sane defaults for the fields a
 * name and an email cannot answer.
 */

// demoTopicMax mirrors normalizeWebinarInput's own topic limit, so a very long
// name cannot produce a topic normalizeWebinarInput then rejects — the one
// field this handler derives rather than takes verbatim should never itself
// be the reason a demo launch fails.
const demoTopicMax = 200

// demoDurationMin is both how long the webinar is scheduled for and the
// window expireDemo enforces. The two are the same number on purpose: a demo
// that lets people keep meeting for longer than the webinar itself claims to
// run is a confusing thing to demo.
const demoDurationMin = 2 * 60

func (s *Server) handleLaunchDemo(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.DemoMode {
		httpx.Error(w, http.StatusNotFound, "not_found", "Not found.")
		return
	}

	var req types.DemoLaunchRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	name := strings.Join(strings.Fields(req.Name), " ")
	fields := map[string]string{}
	switch {
	case name == "":
		fields["name"] = "Required."
	case utf8.RuneCountInString(name) > guestNameMax:
		fields["name"] = "Please keep this under 60 characters."
	}

	email := strings.TrimSpace(req.Email)
	switch {
	case email == "":
		fields["email"] = "Required."
	case len(email) > 320:
		fields["email"] = "That address is too long."
	default:
		if _, err := mail.ParseAddress(email); err != nil {
			fields["email"] = "That doesn't look like an email address."
		}
	}
	if len(fields) > 0 {
		httpx.Fields(w, fields)
		return
	}

	user, err := s.store.CreateDemoUser(r.Context(), email, name)
	if errors.Is(err, store.ErrConflict) {
		// Refusing rather than signing them into the existing account: this door
		// must never become a way to hand hosting rights to an account that did
		// not already have them, real or an earlier demo left signed out.
		httpx.Fields(w, map[string]string{
			"email": "That email already has an account. Sign in to host for real.",
		})
		return
	}
	if err != nil {
		s.fail(w, r, "demo launch: create user", err)
		return
	}

	topic := name + "'s demo webinar"
	if utf8.RuneCountInString(topic) > demoTopicMax {
		topic = topic[:demoTopicMax]
	}

	in, fields := s.normalizeWebinarInput(types.WebinarInput{
		Topic:    topic,
		StartsAt: time.Now().Add(time.Minute).Format(time.RFC3339),
		Duration: demoDurationMin,
	}, true)
	if len(fields) > 0 {
		// Every field above is one this handler picked itself, not something the
		// caller supplied — a validation failure here is this handler's own bug,
		// not a bad request.
		s.log.Error("demo launch: derived webinar input failed validation", "fields", fields)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}

	wb, err := s.store.CreateWebinar(r.Context(), user.ID, in)
	if err != nil {
		s.fail(w, r, "demo launch: create webinar", err)
		return
	}

	expiresAt := time.Now().Add(demoDurationMin * time.Minute)
	if err := s.store.SetDemo(r.Context(), wb.ID, expiresAt); err != nil {
		s.fail(w, r, "demo launch: mark demo", err)
		return
	}

	wb, err = s.store.SetStatus(r.Context(), wb.ID, types.StatusLive)
	if err != nil {
		s.fail(w, r, "demo launch: start webinar", err)
		return
	}

	room := lk.RoomName(wb.ID)
	sfu, _, _, err := s.ensureRoom(r.Context(), wb, room)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	s.pushRoomMetadata(r, sfu, wb)

	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "demo launch: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)

	s.log.Info("demo webinar launched", "slug", wb.ID, "host", user.ID,
		"expires_at", expiresAt, "ip", httpx.ClientIP(r))
	httpx.JSON(w, http.StatusCreated, wb)
}
