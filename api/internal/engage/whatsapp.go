package engage

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* Connect WhatsApp: the host's own WhatsApp Business Account, not ours.
 *
 * Meta bills every conversation to the WABA that sent it, so the token stored
 * here is the whole commercial arrangement in one column — a host's messages are
 * charged to a payment method they control, on an account they own, and this
 * server never fronts anybody's fees. It also means a host who has connected
 * successfully can still be unable to send, because their WABA has no payment
 * method yet. That is Meta's message to deliver when a send fails, not something
 * to guess at here.
 *
 * Three endpoints and a webhook, mirroring the YouTube shape in youtube.go with
 * one structural difference: Embedded Signup is a JS SDK popup rather than an
 * OAuth redirect, so /connect answers with a payload the browser opens the dialog
 * with, and the code comes back through /callback as a POST from our own page —
 * never as a redirect from Meta. There is consequently no state cookie to sign:
 * the caller's session cookie is what proves who is connecting, on both requests.
 */

// handleWhatsAppConnect hands the browser what it needs to open the dialog.
func (s *Module) handleWhatsAppConnect(w http.ResponseWriter, r *http.Request) {
	if !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance. Ask whoever runs this to set META_APP_ID, META_APP_SECRET and META_WHATSAPP_CONFIG_ID.")
		return
	}
	httpx.JSON(w, http.StatusOK, types.WhatsAppSignup{
		AppID:        s.whatsapp.AppID,
		ConfigID:     s.whatsapp.ConfigID,
		GraphVersion: s.whatsapp.Version(),
	})
}

/* handleWhatsAppCallback finishes the connection the dialog started.
 *
 * Order matters and is not the obvious one. The token is bought first, then the
 * number is read, then the WABA is subscribed to our webhook, and only then is
 * anything written. But a failure in the middle two steps does NOT throw the
 * grant away: the code is single-use, so discarding a valid token because Meta
 * was slow to answer a cosmetic lookup would make the host walk through the whole
 * dialog again for no reason. The one exception is a rejected token, which means
 * the thing we would be storing is already useless.
 */
func (s *Module) handleWhatsAppCallback(w http.ResponseWriter, r *http.Request) {
	if !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return
	}
	user := authctx.User(r.Context())

	var body types.WhatsAppCallbackRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	code := strings.TrimSpace(body.Code)
	wabaID := strings.TrimSpace(body.WABAID)
	phoneID := strings.TrimSpace(body.PhoneNumberID)
	if code == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_no_code",
			"Meta did not send an authorization code. Try connecting again.")
		return
	}
	/* Both ids, or nothing to send from.
	 *
	 * They come from the dialog's postMessage rather than from the code, and the
	 * message is missed if the host closes the popup at exactly the wrong moment.
	 * Rejecting that here is what stops a row that claims to be connected and
	 * cannot send a single message.
	 */
	if wabaID == "" || phoneID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_no_number",
			"Meta did not say which WhatsApp number was connected. Try connecting again, and let the dialog finish before closing it.")
		return
	}

	tok, err := s.whatsapp.Exchange(r.Context(), code)
	if err != nil {
		if whatsappAPIError(w, err) {
			s.log.Warn("whatsapp exchange", "error", err, "user", user.ID)
			return
		}
		s.log.Warn("whatsapp exchange", "error", err, "user", user.ID)
		httpx.Error(w, http.StatusBadGateway, "whatsapp_exchange_failed",
			"Meta could not complete the connection. Try again in a moment.")
		return
	}

	// Cosmetic, and non-fatal for it: these two strings are what Account settings
	// shows a host so they can see which of their numbers is connected. A rejected
	// token is the exception — nothing further would work either.
	num, err := s.whatsapp.Number(r.Context(), tok.AccessToken, phoneID)
	if err != nil {
		if errors.Is(err, wa.ErrTokenRejected) {
			s.log.Warn("whatsapp number: token rejected", "error", err, "user", user.ID)
			whatsappAPIError(w, err)
			return
		}
		s.log.Warn("whatsapp number lookup", "error", err, "user", user.ID, "phone_number_id", phoneID)
	}

	/* Subscribing is best-effort, and its failure is logged loudly rather than
	 * returned. Without it sends still work and nothing inbound ever arrives, which
	 * is a real degradation — but it is a smaller one than refusing a connection
	 * the host has already granted, and Phase 1b re-subscribes on ingest. */
	if err := s.whatsapp.SubscribeApp(r.Context(), tok.AccessToken, wabaID); err != nil {
		s.log.Warn("whatsapp subscribe app: inbound messages will not arrive until this succeeds",
			"error", err, "user", user.ID, "waba", wabaID)
	}

	var expires *time.Time
	if !tok.ExpiresAt.IsZero() {
		at := tok.ExpiresAt.UTC()
		expires = &at
	}
	if err := s.store.SetUserWhatsApp(r.Context(), user.ID,
		tok.AccessToken, wabaID, num.ID, num.DisplayPhone, num.VerifiedName, expires); err != nil {
		s.fail(w, r, "whatsapp connect: save", err)
		return
	}
	updated, err := s.store.UserByID(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "whatsapp connect: reload", err)
		return
	}
	s.log.Info("whatsapp connected", "user", user.ID, "waba", wabaID, "number", num.DisplayPhone)
	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleWhatsAppRegister registers the connected number with Cloud API.
 *
 * The last step of creating a brand-new number inside Embedded Signup, and the one
 * nothing else can do for the host: Meta requires a two-step verification PIN on the
 * number, and only the person who owns the number may choose it. A number that skips
 * this is connected, verified, and silently unable to send — every message fails with
 * Meta's "number not registered", which reads like a fault here.
 *
 * The PIN is the host's, typed in the connect flow, and this is everything that happens
 * to it: it is validated for shape, handed to Meta, and dropped when the request ends.
 *
 *   - never stored. There is no column for it, and 0048 says why: a PIN this server
 *     kept would be a credential for somebody else's WhatsApp number sitting in our
 *     database for the benefit of a button nobody needs.
 *   - never logged, at any level. The success line below names the number, not the PIN.
 *   - never returned. The response is the account, which has never carried it.
 *
 * A host who has forgotten theirs resets it in WhatsApp Manager, which is the same
 * place they set it — this endpoint cannot help with that and does not pretend to.
 */
func (s *Module) handleWhatsAppRegister(w http.ResponseWriter, r *http.Request) {
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return
	}
	user := authctx.User(r.Context())
	if !s.featureAllowed(w, user, types.FeatureWhatsAppRegister) {
		return
	}

	var body types.WhatsAppRegisterRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account before registering a number.")
		return
	}
	pin := strings.TrimSpace(body.Pin)
	if !sixDigits(pin) {
		/* Checked here rather than left to Meta, and this is the one validation worth
		 * doing in two places: the Graph error for a malformed PIN is about parameter
		 * shapes, and a host who typed five digits should be told that in the field
		 * they typed it in. */
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_bad_pin",
			"The two-step PIN is exactly six digits.")
		return
	}

	if err := s.whatsapp.Register(r.Context(), user.WhatsAppToken, user.WhatsAppPhoneNumberID, pin); err != nil {
		// Meta's own sentence, because the causes are all the host's to act on: a PIN
		// that does not match the one set on the number, a number already registered
		// elsewhere, a WABA still waiting on verification.
		s.log.Warn("whatsapp register failed", "error", err, "user", user.ID,
			"phone_number_id", user.WhatsAppPhoneNumberID)
		if whatsappAPIError(w, err) {
			return
		}
		httpx.Error(w, http.StatusBadGateway, "whatsapp_register_failed", err.Error())
		return
	}

	if err := s.store.SetUserWhatsAppRegistered(r.Context(), user.ID); err != nil {
		/* Registered at Meta and not recorded here. Reported as a success, because it
		 * was one: the number can send now, and the timestamp is a note about who did
		 * it — refusing would invite the host to press it again in search of a green
		 * tick that is only cosmetic. */
		s.log.Error("whatsapp register: registered but not recorded", "error", err, "user", user.ID)
	}
	updated, err := s.store.UserByID(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "whatsapp register: reload", err)
		return
	}
	s.log.Info("whatsapp number registered", "user", user.ID, "number", updated.WhatsAppDisplayPhone)
	httpx.JSON(w, http.StatusOK, updated.Public())
}

// sixDigits is the PIN's shape, and the only thing this server ever knows about one.
func sixDigits(pin string) bool {
	if len(pin) != 6 {
		return false
	}
	for _, c := range pin {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// handleWhatsAppDisconnect drops the grant and stops the webhook traffic it
// turned on. Unsubscribing first, because after the token is cleared there is
// nothing left to unsubscribe with.
func (s *Module) handleWhatsAppDisconnect(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.whatsapp != nil && user.WhatsAppToken != "" && user.WhatsAppWABAID != "" {
		if err := s.whatsapp.UnsubscribeApp(r.Context(), user.WhatsAppToken, user.WhatsAppWABAID); err != nil {
			// A host who removed our app on Meta's side first lands here, and their
			// disconnect must still complete.
			s.log.Warn("whatsapp unsubscribe", "error", err, "user", user.ID, "waba", user.WhatsAppWABAID)
		}
	}
	if err := s.store.SetUserWhatsApp(r.Context(), user.ID, "", "", "", "", "", nil); err != nil {
		s.fail(w, r, "whatsapp disconnect", err)
		return
	}
	updated, err := s.store.UserByID(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "whatsapp disconnect: reload", err)
		return
	}
	s.log.Info("whatsapp disconnected", "user", user.ID)
	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* whatsappWebhookMaxBytes caps what a stranger can make this endpoint read.
 *
 * The endpoint is public — it has to be, Meta calls it — and the signature can
 * only be checked once the whole body is in memory, so the cap is the only thing
 * bounding an unauthenticated read. Meta's own batches are a few KB; a megabyte
 * is generous for a legitimate one.
 */
const whatsappWebhookMaxBytes = 1 << 20

/* handleWhatsAppWebhookVerify answers Meta's subscription handshake.
 *
 * Meta GETs the callback URL once, when somebody saves the webhook configuration
 * in the app dashboard, and expects the hub.challenge echoed back as plain text.
 * Getting this wrong is not subtle: the dashboard simply refuses to save the URL.
 */
func (s *Module) handleWhatsAppWebhookVerify(w http.ResponseWriter, r *http.Request) {
	want := strings.TrimSpace(s.cfg.MetaWebhookVerifyToken)
	if want == "" {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_webhook_unset",
			"This instance has no WhatsApp webhook verify token. Set META_WEBHOOK_VERIFY_TOKEN.")
		return
	}
	q := r.URL.Query()
	got := strings.TrimSpace(q.Get("hub.verify_token"))
	// Constant time: this is a shared secret, and a public endpoint that leaks how
	// much of one was right is a public endpoint that hands it over eventually.
	if q.Get("hub.mode") != "subscribe" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		s.log.Warn("whatsapp webhook verify refused", "mode", q.Get("hub.mode"), "ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusForbidden, "forbidden", "Verification failed.")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(q.Get("hub.challenge")))
}

/* handleWhatsAppWebhook takes what Meta posts and files it under the right host.
 *
 * The signature check is the load-bearing part. This URL is public — it has to be,
 * Meta calls it — and what is written from it becomes messages in a host's inbox
 * and contacts in their CRM. Proving the bytes came from Meta is the only thing
 * separating those rows from anybody who knows the address.
 *
 * Answered 200 whatever happens next, and that is deliberate rather than sloppy.
 * Meta retries a non-2xx for hours and eventually disables the subscription
 * outright, which would take a host's WhatsApp inbox offline until somebody
 * noticed in a dashboard. A body we cannot parse or a store that is briefly
 * unavailable is our problem to see in the logs, not a reason to have Meta switch
 * a customer's integration off. The exceptions are the two refusals above — an
 * unsigned request is not a delivery, and there is nothing to retry.
 */
func (s *Module) handleWhatsAppWebhook(w http.ResponseWriter, r *http.Request) {
	if s.whatsapp == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return
	}
	// The exact bytes, unparsed: the HMAC is over the raw payload, so decoding
	// first and re-encoding to verify would reject every genuine delivery.
	raw, err := io.ReadAll(io.LimitReader(r.Body, whatsappWebhookMaxBytes+1))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if len(raw) > whatsappWebhookMaxBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large", "That payload is too large.")
		return
	}
	if !s.whatsapp.VerifySignature(raw, r.Header.Get(wa.SignatureHeader)) {
		s.log.Warn("whatsapp webhook: bad signature", "ip", httpx.ClientIP(r), "bytes", len(raw))
		httpx.Error(w, http.StatusForbidden, "forbidden", "Invalid webhook signature.")
		return
	}
	delivery, err := wa.ParseWebhook(raw)
	if err != nil {
		// Signed by Meta and still not JSON: a change on their side we have not seen.
		// Byte count only, never the body — see ingestWhatsApp.
		s.log.Warn("whatsapp webhook: unreadable payload", "error", err, "bytes", len(raw))
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
		return
	}
	s.ingestWhatsApp(r.Context(), delivery)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

/* ingestWhatsApp writes one delivery into the CRM.
 *
 * Nothing here returns an error, because there is nobody to return one to: the
 * caller has to answer Meta 200 either way, and a single message it cannot place
 * must not stop the four beside it in the same batch. So every failure is logged
 * with enough to find it again and the loop continues.
 *
 * Message CONTENT is never logged. The body is somebody's customer writing to
 * their business — an order, a complaint, a medical question — and a log file is
 * read by people who have no business reading any of it. Ids, counts and the host
 * are enough to debug with.
 *
 * Routing is by phone-number id, and an unknown one is dropped silently at Info.
 * It is the ordinary consequence of a host disconnecting: Meta keeps delivering
 * for a while, and there is no longer an account those messages belong to.
 */
func (s *Module) ingestWhatsApp(ctx context.Context, d wa.Delivery) {
	// One lookup per number per delivery, not per message: a batch is usually
	// several messages for the same host.
	hosts := make(map[string]*store.User, 2)
	host := func(phoneNumberID string) (*store.User, bool) {
		if u, seen := hosts[phoneNumberID]; seen {
			return u, u != nil
		}
		u, err := s.store.UserByWhatsAppPhoneNumberID(ctx, phoneNumberID)
		if errors.Is(err, store.ErrNotFound) {
			hosts[phoneNumberID] = nil
			s.log.Info("whatsapp webhook: no host for that number", "phone_number_id", phoneNumberID)
			return nil, false
		}
		if err != nil {
			s.log.Error("whatsapp webhook: host lookup", "error", err, "phone_number_id", phoneNumberID)
			hosts[phoneNumberID] = nil
			return nil, false
		}
		hosts[phoneNumberID] = &u
		return &u, true
	}

	for _, m := range d.Messages {
		// A message with no sender or no id cannot be stored idempotently or
		// replied to, which leaves nothing worth keeping.
		if m.From == "" || m.WAMID == "" {
			continue
		}
		h, ok := host(m.PhoneNumberID)
		if !ok {
			continue
		}
		/* Someone writing to the business is a contact, whether or not they ever
		 * registered for anything — and they are matched to the registrant they
		 * already are by phone number, which is why the number is normalised the
		 * same way in both paths.
		 *
		 * Weak, because a WhatsApp profile name is whatever they set on their phone.
		 * NOT an opt-in either: replying to a business opens Meta's 24-hour service
		 * window and this server will honour that when it sends, but it is not
		 * permission to put somebody in a marketing broadcast next month.
		 */
		contact, err := s.store.UpsertContact(ctx, h.ID, store.ContactInput{
			Phone:  m.From,
			Name:   m.ProfileName,
			Source: "whatsapp",
			Weak:   true,
		})
		if err != nil {
			s.log.Error("whatsapp webhook: contact", "error", err, "host", h.ID)
			continue
		}
		if _, err := s.store.AppendMessage(ctx, h.ID, contact.ID, store.MessageInput{
			Direction: "in",
			Body:      m.Body,
			Kind:      m.Kind,
			WAMID:     m.WAMID,
			At:        m.At,
		}); err != nil {
			s.log.Error("whatsapp webhook: append", "error", err, "host", h.ID, "wamid", m.WAMID)
			continue
		}
		/* "STOP" is honoured here rather than left to a later phase.
		 *
		 * It is the word people use, Meta's own guidance is that it must work, and
		 * the cost of ignoring it until the broadcast feature exists is that a host
		 * keeps messaging somebody who asked them not to. Recorded as an opt-out
		 * and nothing else — no automatic reply, since sending one would need a
		 * template we do not have yet.
		 *
		 * Before the bots, and ending the message: somebody who wrote "stop" gets no
		 * reply of any kind, least of all a cheerful flowchart asking which department
		 * they need.
		 */
		if isWhatsAppStop(m.Body) {
			if err := s.store.SetContactWhatsAppOptOut(ctx, h.ID, contact.ID); err != nil {
				s.log.Error("whatsapp webhook: opt out", "error", err, "host", h.ID, "contact", contact.ID)
				continue
			}
			s.log.Info("whatsapp opt-out", "host", h.ID, "contact", contact.ID)
			continue
		}
		/* And then a bot may answer, inline, on this request.
		 *
		 * Last, so the message is already in the thread before anything replies to it,
		 * and inline rather than queued because a reply that arrives when the next
		 * sweep happens to run is not a conversation. Silent when no bot matches,
		 * which is most messages — see runBot.
		 */
		s.runBot(ctx, *h, contact, m)
	}

	for _, st := range d.Statuses {
		h, ok := host(st.PhoneNumberID)
		if !ok {
			continue
		}
		matched, err := s.store.SetMessageStatus(ctx, h.ID, st.WAMID, st.Status, st.Error)
		if err != nil {
			s.log.Error("whatsapp webhook: status", "error", err, "host", h.ID, "wamid", st.WAMID)
			continue
		}
		// A status for a message we never stored is not an error — a send from
		// before this table existed, or from an account that has since
		// reconnected — so it is noted and dropped.
		if !matched {
			s.log.Info("whatsapp status for an unknown message", "host", h.ID, "status", st.Status)
			continue
		}
		if st.Status == "failed" {
			// The one status a host has to act on, and usually about their own Meta
			// account: an unapproved template, or a WABA with no payment method.
			s.log.Warn("whatsapp send failed", "host", h.ID, "wamid", st.WAMID, "meta_error", st.Error)
		}
	}
}

/* isWhatsAppStop recognises an unsubscribe.
 *
 * Only the bare word, in the few spellings a keypad produces. Deliberately not a
 * substring match: "stop sending me the 9am one, the 5pm is fine" is a request to
 * a human, and silently unsubscribing that person — then having the host wonder
 * why their replies stopped arriving — would be worse than not matching it at all.
 */
func isWhatsAppStop(body string) bool {
	switch strings.ToUpper(strings.Trim(strings.TrimSpace(body), ".!")) {
	case "STOP", "UNSUBSCRIBE", "STOP ALL", "OPT OUT", "OPTOUT":
		return true
	}
	return false
}

// whatsappAPIError maps the wa package's named failures onto statuses, so a host
// is told which of "not set up here", "connect first" and "your connection is
// gone" applies. Reports whether it handled the error, like youtubeAPIError.
func whatsappAPIError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, wa.ErrNotConfigured):
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset", err.Error())
	case errors.Is(err, wa.ErrNeedCode):
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_no_code", err.Error())
	case errors.Is(err, wa.ErrNotConnected):
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected", err.Error())
	case errors.Is(err, wa.ErrTokenRejected):
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_token_rejected", err.Error())
	default:
		return false
	}
	return true
}
