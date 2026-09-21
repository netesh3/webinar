package api

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/mail"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleListWebinars lists what THIS account may see, and requires a session to say so.
 *
 * This was an open catalogue: every scheduled or live webinar, to anybody who asked. That
 * is a reasonable design for a public events site and the wrong one here — a host logged
 * into their own portal could read the topic, agenda and registrant count of every other
 * host's session, which is what the access rule forbids.
 *
 * Now it is scoped to hosted-or-presenting-or-registered (see store.VisibleTo) and mounted
 * behind requireUser, so an anonymous caller gets 401 rather than an empty list. 401 is
 * the honest answer: "there is nothing here for you" and "you have not told me who you
 * are" are different facts, and a client that cannot tell them apart cannot show the
 * right screen.
 *
 * Redaction stays. A registered attendee is not the host, so the passcode is still
 * stripped — being able to see a webinar is not the same as being able to hand out
 * entry to it.
 *
 * NOT locked down, deliberately: GET /api/webinars/{slug} below. A registration link is
 * meant to be shared with people who have no account yet, so the single-webinar page has
 * to answer without a session or nobody can ever sign up.
 */
func (s *Server) handleListWebinars(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	list, err := s.store.VisibleTo(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "list webinars", err)
		return
	}
	for i := range list {
		list[i] = publicWebinar(list[i])
	}
	httpx.JSON(w, http.StatusOK, list)
}

/* publicWebinar strips what only the host may see.
 *
 * Today that is one field, and one field is enough to justify a function: the passcode
 * was reaching the browse list and the public webinar page, both unauthenticated, so a
 * host who set a passcode got no protection and did not know it. Anyone could read the
 * code out of the API and register with it.
 *
 * A function rather than a `json:"-"` tag because the host's own views legitimately show
 * the passcode — it is theirs to hand out. The distinction is the caller, not the field,
 * so it has to be made at the point of response.
 *
 * Called on every response body that can reach somebody who is not the owner: the two
 * public endpoints and an attendee's own registration list. The host-only subtree behind
 * requireOwnership is deliberately not redacted.
 *
 * The returned value shares its slices with the original, which is safe here because only
 * scalars are touched — but it is why this is not a general-purpose deep copy.
 */
func publicWebinar(wb types.Webinar) types.Webinar {
	wb.PasscodeRequired = strings.TrimSpace(wb.Passcode) != ""
	wb.Passcode = ""
	// Which LiveKit project this room is on is the operator's business. Nothing an attendee
	// can do with it, and the browser is told the URL it needs in the join response.
	wb.SFUProject = ""
	// An unlisted YouTube live is not public because the registration page loaded.
	wb.StreamWatchURL = ""
	wb.StreamConfigured = false
	wb.StreamKeySaved = false
	return wb
}

func (s *Server) handleGetWebinar(w http.ResponseWriter, r *http.Request) {
	wb, err := s.store.WebinarBySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "get webinar", err)
		return
	}
	// Drafts are not public.
	if wb.Status == types.StatusDraft {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	httpx.JSON(w, http.StatusOK, publicWebinar(wb))
}

/* handleWebinarImage streams a webinar's cover image.
 *
 * No credential to resolve, unlike handleChatMedia: a cover image is meant to be
 * seen on the registration and browse pages by someone who has not signed up yet,
 * which is the same audience handleGetWebinar already answers without a session.
 * The draft check matches it too — a webinar nobody can see yet should not leak
 * its image either.
 */
func (s *Server) handleWebinarImage(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "webinar image: load webinar", err)
		return
	}
	if wb.Status == types.StatusDraft {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}

	data, mime, err := s.store.WebinarImageMedia(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "This webinar has no image.")
		return
	}
	if err != nil {
		s.fail(w, r, "webinar image: lookup", err)
		return
	}

	w.Header().Set("Content-Type", mime)
	// Public and immutable: a fresh upload gets a fresh `?v=` (see
	// store.SetWebinarImage), so the bytes at this URL never change — a shared
	// proxy or a browser cache can hold onto this as long as it likes.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", zeroTime, bytes.NewReader(data))
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req types.RegisterRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "register: load webinar", err)
		return
	}

	// Registering while signed in prefills from the account and links the row to
	// it, so the registration follows the person to another browser instead of
	// living only in this one's localStorage.
	userID := ""
	if user, ok := s.optionalUser(r); ok {
		userID = user.ID
		if strings.TrimSpace(req.Email) == "" {
			req.Email = user.Email
		}
		if strings.TrimSpace(req.FirstName) == "" && strings.TrimSpace(req.LastName) == "" {
			first, last := splitName(user.Name)
			req.FirstName, req.LastName = first, last
		}
		if strings.TrimSpace(req.Company) == "" {
			req.Company = user.Org
		}
		if strings.TrimSpace(req.JobTitle) == "" {
			req.JobTitle = user.Title
		}
	}

	if fields := validateRegistration(req, wb); len(fields) > 0 {
		httpx.Fields(w, fields)
		return
	}

	reg, err := s.store.Register(r.Context(), slug, req, userID)
	switch {
	case errors.Is(err, store.ErrFull):
		httpx.Error(w, http.StatusConflict, "webinar_full",
			"This webinar has reached its attendee limit.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar isn't open for registration.")
		return
	case err != nil:
		s.fail(w, r, "register", err)
		return
	}

	s.log.Info("registration",
		"webinar", slug, "state", reg.State, "email_domain", domainOf(reg.Email))

	/* Tell the host somebody is waiting.
	 *
	 * Only for a PENDING registration. On an automatic-approval webinar there is no decision
	 * to make, and alerting a host once per attendee would make the bell useless on the one
	 * shape of webinar where nothing needs their attention — which is how people learn to
	 * ignore notifications.
	 *
	 * After the response is decided but before it is written: the registration is already
	 * committed, so a failure here must not turn a successful registration into an error the
	 * attendee sees. It is logged and the outbox row is what makes it recoverable.
	 */
	if reg.State == types.RegPending {
		s.alertHostOfPending(r.Context(), wb, reg)
	} else if strings.TrimSpace(reg.Email) != "" {
		s.notifyNewRegistration(r.Context(), wb, reg, true)
	}

	httpx.JSON(w, http.StatusCreated, reg)
}

/* alertHostOfPending queues the host's "somebody is waiting" notification.
 *
 * Addressed to the host's USER ID rather than their email address, which makes it an in-app
 * alert that works with no mail server configured at all — the case this deployment is
 * actually in. If SMTP is configured the same row is also delivered by mail; see
 * flushOutbox.
 *
 * The count of everybody waiting is included, because the useful message on the tenth
 * registration is "ten people are waiting", not a tenth copy of "someone is waiting".
 */
func (s *Server) alertHostOfPending(ctx context.Context, wb types.Webinar, reg types.Registration) {
	hostID, err := s.store.HostIDFor(ctx, wb.ID)
	if err != nil {
		s.log.Error("alert host: could not resolve host", "webinar", wb.ID, "err", err)
		return
	}

	waiting := 1
	if rows, err := s.store.Registrants(ctx, wb.ID, 0); err == nil {
		waiting = 0
		for _, row := range rows {
			if row.State == types.RegPending {
				waiting++
			}
		}
	}

	subject, body := notify.ApprovalRequested(notify.Invite{
		Name:     strings.TrimSpace(reg.FirstName + " " + reg.LastName),
		Topic:    wb.Topic,
		WhenText: whenText(wb.StartsAt, wb.TimeZone),
	}, waiting)

	if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
		UserID:      hostID,
		Kind:        types.NotifyApprovalRequested,
		WebinarSlug: wb.ID,
		Subject:     subject,
		Body:        body,
	}); err != nil {
		s.log.Error("alert host: could not queue", "webinar", wb.ID, "err", err)
	}
}

// validateRegistration checks the standard fields plus any required custom
// questions the host configured.
func validateRegistration(req types.RegisterRequest, wb types.Webinar) map[string]string {
	fields := map[string]string{}

	/* One name is required, not two.
	 *
	 * The form asks for a full name in a single field and splits it, because a surname is not
	 * a universal concept and a required "Last name" box turns away anybody with a mononym.
	 * FirstName therefore holds "Asha Menon" for most people and the split is a convenience
	 * for addressing them, not a claim about their name.
	 */
	if strings.TrimSpace(req.FirstName) == "" {
		fields["firstName"] = "Required."
	}
	email := strings.TrimSpace(req.Email)
	if email == "" {
		fields["email"] = "Required."
	} else if _, err := mail.ParseAddress(email); err != nil {
		fields["email"] = "That doesn't look like an email address."
	} else if len(email) > 320 {
		fields["email"] = "That address is too long."
	}
	if !req.Consent {
		fields["consent"] = "We need this to send you the join link."
	}

	/* The mobile number: OPTIONAL, and shape-checked when it is there.
	 *
	 * It used to be required, and that was the wrong trade for this door. The registration
	 * form is the one that captures a lead, and a required number on it costs registrations
	 * from people who will give a name and an email and no more — which is most of them.
	 * The number is worth having when it is offered and is not worth the drop-off.
	 *
	 * Validated on shape rather than by a phone-number library, and that is a deliberate
	 * limit: knowing that +91 98765 43210 is a real Indian mobile and +91 12345 67890 is not
	 * needs a per-country numbering plan that goes stale, and getting it wrong turns away a
	 * real attendee. E.164 bounds are the part that is stable — a country code is 1 to 3
	 * digits and the whole number is at most 15 — so that is what is checked. A wrong number
	 * that passes is a wrong number the host can see and correct; a right number that fails
	 * is an attendee who cannot register.
	 *
	 * A number that IS supplied and is malformed is still refused. Storing "9876543210" with
	 * no country code gives the host something nobody can dial, which is worse than a blank.
	 * The actual shape check is phoneFieldError (auth.go) — shared with signup's identical
	 * field, extracted there so the two forms can't quietly disagree about what's valid.
	 */
	if msg := phoneFieldError(req.Phone); msg != "" {
		fields["phone"] = msg
	}
	for _, q := range wb.CustomQuestions {
		if q.Required && strings.TrimSpace(req.Answers[q.ID]) == "" {
			fields[q.ID] = "Required."
		}
	}

	/* The passcode, checked here and only here.
	 *
	 * Registration is the single gate: a join key is minted nowhere else, and the join
	 * endpoint accepts that key as the credential. So checking once at registration covers
	 * every way into a room, and checking again at join would ask somebody who already
	 * proved it to prove it twice.
	 *
	 * It was previously not checked ANYWHERE. The field was stored, length-validated,
	 * returned to the client and never compared to anything, so a passcode was decoration.
	 *
	 * Case-insensitive after trimming, deliberately. This is a short code a host reads out
	 * on a call or pastes into an invite, and the join-key alphabet in the store makes the
	 * same trade for the same reason. The entropy given up is not the thing protecting a
	 * webinar — the rate limiter on this endpoint is.
	 *
	 * Constant-time compare because it costs nothing. It is not load-bearing over HTTP,
	 * but a comparison that returns early on the first wrong byte is a habit worth not
	 * having in an auth path. */
	if want := normalisePasscode(wb.Passcode); want != "" {
		got := normalisePasscode(req.Passcode)
		if subtle.ConstantTimeCompare([]byte(want), []byte(got)) != 1 {
			if got == "" {
				fields["passcode"] = "This webinar needs a passcode."
			} else {
				fields["passcode"] = "That passcode isn't right."
			}
		}
	}
	return fields
}

func normalisePasscode(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

func (s *Server) handleLookup(w http.ResponseWriter, r *http.Request) {
	var req types.LookupRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	regs, err := s.store.ByJoinKeys(r.Context(), req.JoinKeys)
	if err != nil {
		s.fail(w, r, "lookup registrations", err)
		return
	}
	/* Redact the attached webinar.
	 *
	 * This became necessary the moment the response started carrying the webinar at all —
	 * before that there was nothing here to redact, and adding the field quietly opened a
	 * passcode leak. A test caught it, which is the only reason this line exists.
	 *
	 * Holding a join key proves somebody registered. It does not make them the host, and
	 * the passcode is the host's to hand out.
	 */
	for i := range regs {
		regs[i].Webinar = publicWebinar(regs[i].Webinar)
	}
	httpx.JSON(w, http.StatusOK, regs)
}

// splitName turns an account's single name field into the first/last pair the
// registration form asks for. Everything before the last space is the first
// name, which is wrong for some naming conventions but is at least never
// truncating: nothing is dropped, only grouped.
func splitName(name string) (first, last string) {
	name = strings.Join(strings.Fields(name), " ")
	if i := strings.LastIndex(name, " "); i > 0 {
		return name[:i], name[i+1:]
	}
	return name, ""
}

// domainOf keeps logs useful without recording personal data.
func domainOf(email string) string {
	if _, dom, ok := strings.Cut(email, "@"); ok {
		return dom
	}
	return "unknown"
}

// fail logs the real error and returns a generic message. Internal errors never
// reach the client — they leak schema and dependency details.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, op string, err error) {
	s.log.Error(op, "error", err, "path", r.URL.Path)
	httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
}
