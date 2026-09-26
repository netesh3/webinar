package engage

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* The lead CRM, read side.
 *
 * Everything here is scoped to the caller's own account, twice: the routes sit
 * inside the host group, and every store call takes the caller's user id and
 * filters on it in SQL. That is not belt-and-braces for its own sake — these rows
 * are other people's phone numbers and the things they said in private to a
 * business, which is the most sensitive data this application holds. A contact id
 * from another host's CRM reads as 404 here rather than as anything at all.
 *
 * The writes are an opt-out, a template sync and a send. Everything that decides
 * whether a send is ALLOWED is in this file rather than in the wa package or the
 * browser: consent, the service window and the template's approval status are
 * product rules about a person, and the only place they can be enforced is the
 * one the request has to pass through.
 */

// handleCRMContacts lists the caller's contacts, most recent activity first.
func (s *Module) handleCRMContacts(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	// A bad or absent limit is not worth an error: the store clamps it to a page.
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	// webinarId, the slug — spelled the way the audience endpoint beside it spells the
	// same thing, so one name means one thing across this API.
	slug := strings.TrimSpace(r.URL.Query().Get("webinarId"))

	/* One filter chip, refused rather than ignored when it is not one of ours.
	 *
	 * Silently listing everybody for an unknown status would be the worst outcome here:
	 * the host asked to see only the people who have not replied, and a full list looks
	 * exactly like a webinar where everybody replied. The accepted values are spelled
	 * out in the message because they are a closed set this server defines.
	 */
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && !types.ValidCRMContactStatus(status) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_status",
			"Filter by one of: "+strings.Join(types.CRMContactStatuses, ", ")+".")
		return
	}

	/* The scope is resolved BEFORE the list, because it decides whether there is a list
	 * to send at all.
	 *
	 * A slug that is not this host's is refused rather than answered with the zero
	 * contacts the query would honestly find. The two look identical on screen and mean
	 * opposite things: a host following a link to a webinar they have since deleted
	 * needs to be told the webinar is gone, not left to conclude that nobody came to it.
	 *
	 * 404 rather than the 422 the write paths use for the same mistake. There, a slug is
	 * one field of a form the host can correct; here it IS the thing being read, and a
	 * request for a webinar's contacts when there is no such webinar of theirs has no
	 * field to point at.
	 */
	var scope *types.CRMContactScope
	if slug != "" {
		topic, err := s.store.HostWebinarTopic(r.Context(), user.ID, slug)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found",
				"That webinar is not one of yours.")
			return
		}
		if err != nil {
			s.fail(w, r, "crm contacts: webinar", err)
			return
		}
		scope = &types.CRMContactScope{WebinarID: slug, Topic: topic}
	}

	contacts, counts, err := s.store.Contacts(r.Context(), user.ID, store.ContactFilter{
		Query:       q,
		WebinarSlug: slug,
		Status:      status,
		Limit:       limit,
	})
	if err != nil {
		s.fail(w, r, "crm contacts", err)
		return
	}
	/* The chips are filled in for the whole page in one more query — see AttachTags.
	 * A failure is logged rather than fatal: the inbox is what the host asked for, and a
	 * list with no labels on it is still the list. */
	if user.HasFeature(types.FeatureCRMTags) {
		if err := s.store.AttachTags(r.Context(), user.ID, contacts); err != nil {
			s.log.Warn("crm contacts: tags", "error", err, "host", user.ID)
		}
	}
	httpx.JSON(w, http.StatusOK, types.CRMContactsResponse{
		Contacts: contacts,
		// The same number twice, from one query: the sentence above the list and the
		// "All" chip beside it are the same claim and must not be able to differ.
		Total:  counts.Total,
		Counts: counts,
		Status: status,
		Scope:  scope,
		Tags:   s.hostTags(r.Context(), user),
		/* Reported alongside the list rather than left to /api/config, because it is
		 * the answer to a different question. The flag in the config says WhatsApp
		 * exists on this instance; this says whether THIS host can currently send —
		 * which is what the CRM has to explain when a connection has been removed and
		 * the contacts are all still there. */
		WhatsAppConnected: user.WhatsAppToken != "",
	})
}

// handleCRMThread reads one contact and the conversation with them.
func (s *Module) handleCRMThread(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	contact, messages, err := s.store.Thread(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		// Also what somebody else's contact id gets. There is no distinction worth
		// drawing for a caller between "no such contact" and "not yours".
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm thread", err)
		return
	}

	res := types.CRMThreadResponse{
		Contact:           contact,
		Messages:          messages,
		WhatsAppConnected: user.WhatsAppToken != "",
		// Never nil on the wire, whether the feature is on or off.
		Notes: []types.CRMNote{},
	}
	/* Tags and notes are read here rather than fetched separately by the screen that
	 * shows them, because they are read WITH a conversation every time: a host opening a
	 * thread wants the chips and the notes pane already there. Both are logged and
	 * dropped on failure for the reason the service window below is — the messages are
	 * what the request was for. */
	if user.HasFeature(types.FeatureCRMTags) {
		if tags, err := s.store.ContactTags(r.Context(), user.ID, contact.ID); err != nil {
			s.log.Warn("crm thread: tags", "error", err, "host", user.ID)
		} else {
			res.Contact.Tags = tags
		}
	}
	if user.HasFeature(types.FeatureCRMNotes) {
		if notes, err := s.store.Notes(r.Context(), user.ID, contact.ID); err != nil {
			s.log.Warn("crm thread: notes", "error", err, "host", user.ID)
		} else {
			res.Notes = notes
		}
	}
	/* The window is computed here rather than left to the browser to work out from
	 * the message list, because the two would disagree: the list is capped at the
	 * last few hundred messages, and a clock that runs in the reader's timezone is
	 * not the clock Meta enforces. A failure to read it is not worth failing the
	 * whole thread over — the compose box falls back to templates, which is the
	 * conservative answer. */
	if until, err := s.serviceWindow(r.Context(), user.ID, contact.ID); err != nil {
		s.log.Warn("crm thread: service window", "error", err, "host", user.ID)
	} else if !until.IsZero() {
		res.ServiceWindowUntil = until.Format(time.RFC3339)
	}
	httpx.JSON(w, http.StatusOK, res)
}

/* serviceWindow is when free-form text stops being allowed to this contact, or
 * the zero time when it already is not.
 *
 * Meta's rule, restated: the 24 hours run from the contact's last inbound
 * message, and nothing the business does extends them.
 */
func (s *Module) serviceWindow(ctx context.Context, hostID, contactID string) (time.Time, error) {
	last, err := s.store.LastInboundAt(ctx, hostID, contactID)
	if err != nil || last.IsZero() {
		return time.Time{}, err
	}
	until := last.Add(wa.ServiceWindow)
	if !until.After(time.Now()) {
		return time.Time{}, nil
	}
	return until, nil
}

/* handleCRMOptOut records that a contact has asked not to be messaged.
 *
 * A host needs this because "STOP" is not the only way people say it — they say it
 * on a call, in an email, or to somebody at a stand — and a host who has been told
 * has to be able to write it down. The inbound STOP handler in whatsapp.go is the
 * automatic half of the same thing.
 *
 * There is no matching opt-IN endpoint, and that asymmetry is the point: consent
 * has to come from the person, through a form they filled in or a message they
 * sent, not from the party who benefits from having it.
 */
func (s *Module) handleCRMOptOut(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	// Read first, so an id belonging to another host is a 404 rather than an
	// UPDATE that matches nothing and reports success.
	if _, err := s.store.Contact(r.Context(), user.ID, id); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	} else if err != nil {
		s.fail(w, r, "crm opt out: load", err)
		return
	}
	if err := s.store.SetContactWhatsAppOptOut(r.Context(), user.ID, id); err != nil {
		s.fail(w, r, "crm opt out", err)
		return
	}
	contact, err := s.store.Contact(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "crm opt out: reload", err)
		return
	}
	s.log.Info("crm opt-out recorded", "host", user.ID, "contact", id)
	httpx.JSON(w, http.StatusOK, contact)
}

// ------------------------------------------------------------------ templates

/* handleCRMTemplates lists the host's WhatsApp templates.
 *
 * Served from the cache, and re-read from Meta when the host asks (`?refresh=1`)
 * or when there is nothing cached at all. Meta rate-limits template reads per
 * WABA, and the alternative — a Graph round trip every time a picker opens — is
 * how a reminder send gets throttled by a screen nobody was looking at.
 *
 * An automatic sync that fails is logged and the cache is served anyway: a host
 * opening the inbox to read a conversation should not be shown a Meta error. An
 * explicit refresh that fails is reported, because they asked.
 */
func (s *Module) handleCRMTemplates(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	templates, syncedAt, err := s.store.Templates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm templates", err)
		return
	}

	refresh := r.URL.Query().Get("refresh") != ""
	if user.WhatsAppToken != "" && (refresh || len(templates) == 0) {
		if err := s.syncTemplates(r.Context(), user); err != nil {
			if refresh {
				if whatsappAPIError(w, err) {
					s.log.Warn("crm templates sync", "error", err, "host", user.ID)
					return
				}
				s.log.Warn("crm templates sync", "error", err, "host", user.ID)
				httpx.Error(w, http.StatusBadGateway, "whatsapp_templates_failed",
					"Meta could not list your templates just now. Try again in a moment.")
				return
			}
			s.log.Warn("crm templates: background sync", "error", err, "host", user.ID)
		} else if templates, syncedAt, err = s.store.Templates(r.Context(), user.ID); err != nil {
			s.fail(w, r, "crm templates: reload", err)
			return
		}
	}

	res := types.CRMTemplatesResponse{
		Templates:         templates,
		WhatsAppConnected: user.WhatsAppToken != "",
	}
	if !syncedAt.IsZero() {
		res.SyncedAt = syncedAt.Format(time.RFC3339)
	}
	httpx.JSON(w, http.StatusOK, res)
}

/* syncTemplates replaces the host's cached templates with what Meta says now.
 *
 * Every error stops short of the write, which is the important part: an empty
 * list from a failed call would otherwise delete a host's whole template cache
 * and, with it, the reminders that name one.
 */
func (s *Module) syncTemplates(ctx context.Context, user store.User) error {
	if s.whatsapp == nil {
		return wa.ErrNotConfigured
	}
	if user.WhatsAppToken == "" || user.WhatsAppWABAID == "" {
		return wa.ErrNotConnected
	}
	found, err := s.whatsapp.Templates(ctx, user.WhatsAppToken, user.WhatsAppWABAID)
	if err != nil {
		return err
	}
	in := make([]store.TemplateInput, 0, len(found))
	for _, t := range found {
		in = append(in, store.TemplateInput{
			Name:        t.Name,
			Language:    t.Language,
			Status:      t.Status,
			Category:    t.Category,
			Header:      t.Header,
			Body:        t.Body,
			Footer:      t.Footer,
			Variables:   t.Variables,
			Unsupported: t.Unsupported,
		})
	}
	if err := s.store.ReplaceTemplates(ctx, user.ID, in); err != nil {
		return err
	}
	s.log.Info("whatsapp templates synced", "host", user.ID, "count", len(in))
	return nil
}

// ----------------------------------------------------------------------- send

/* whatsappTextMax is Meta's limit on a free-form message body.
 *
 * Checked here so an over-long message is refused while the host still has it in
 * a box they can edit, rather than after a round trip that reports it as a Graph
 * error.
 */
const whatsappTextMax = 4096

/* handleCRMSend sends one WhatsApp message to one contact.
 *
 * The refusals are the feature. In order, because each one has different words
 * and a host can only act on the specific one:
 *
 *   - WhatsApp not connected — nothing can be sent by anyone.
 *   - No number on the contact — an email-only lead.
 *   - Opted out — the refusal they gave is the whole point of recording it, and it
 *     outranks every category: a person who said stop does not get a "utility"
 *     message about a webinar either.
 *   - Free-form text outside the 24-hour window — Meta's rule, and refused here
 *     rather than sent and bounced, so the host is told to pick a template while
 *     they still have what they typed.
 *   - A template that is not approved, not fully supported, or given the wrong
 *     number of values — all three of which Meta would reject after being paid a
 *     round trip for the privilege.
 *   - A MARKETING template to somebody who never opted in. This is ours, not
 *     Meta's, and it is the line the whole consent model exists to draw.
 *
 * The send happens before the row is written, which is the only honest order:
 * Meta's message id is what every later delivery status is keyed by, and a row
 * invented before the send would either carry no id or claim an outcome that had
 * not happened yet.
 */
func (s *Module) handleCRMSend(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")

	var body types.CRMSendRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	text := strings.TrimSpace(body.Body)
	name := strings.TrimSpace(body.Template)

	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset",
			"WhatsApp is not set up on this instance.")
		return
	}
	/* Whose contact this is comes before whether the caller can send.
	 *
	 * Ownership is the only check whose answer is allowed to depend on the id, so it
	 * goes first: otherwise a host with no WhatsApp connection would be told
	 * "connect first" for an id belonging to somebody else, which is a slower way of
	 * confirming that the id exists.
	 */
	contact, err := s.store.Contact(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such contact.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm send: load contact", err)
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account in Account settings before sending.")
		return
	}
	if contact.Phone == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_number",
			"This contact has no WhatsApp number — only an email address.")
		return
	}
	// Opted out unless a later opt-in overrode it, which is exactly what the
	// computed WhatsAppOptIn already answers.
	if contact.WhatsAppOptOutAt != "" && !contact.WhatsAppOptIn {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_opted_out",
			"This contact has asked not to receive WhatsApp messages.")
		return
	}

	// Exactly one of the two, and saying so plainly: a request with both is a
	// client bug, and guessing which was meant would send the wrong thing.
	if (text == "") == (name == "") {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_send_empty",
			"Send either a message or a template, not both and not neither.")
		return
	}

	var (
		wamid    string
		recorded = store.MessageInput{Direction: "out", Status: "sent"}
	)
	if text != "" {
		if len(text) > whatsappTextMax {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_text_too_long",
				"WhatsApp messages are limited to 4096 characters.")
			return
		}
		until, err := s.serviceWindow(r.Context(), user.ID, contact.ID)
		if err != nil {
			s.fail(w, r, "crm send: service window", err)
			return
		}
		if until.IsZero() {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_window_closed",
				"WhatsApp only allows a typed reply within 24 hours of this contact's last message. Send an approved template instead.")
			return
		}
		wamid, err = s.whatsapp.SendText(r.Context(), user.WhatsAppToken,
			user.WhatsAppPhoneNumberID, contact.Phone, text)
		if err != nil {
			s.reportSendError(w, r, user.ID, err)
			return
		}
		recorded.Body = text
	} else {
		tmpl, err := s.templateForSend(r.Context(), user, name, body.Language)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template",
				"That template is not in your WhatsApp account. Refresh your templates and try again.")
			return
		}
		if err != nil {
			s.fail(w, r, "crm send: template", err)
			return
		}
		if !tmpl.Sendable {
			msg := tmpl.Unsupported
			if msg == "" {
				msg = "Meta has not approved that template yet — it is " + strings.ToLower(tmpl.Status) + "."
			}
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable", msg)
			return
		}
		if len(body.Params) != tmpl.Variables {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
				"That template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
			return
		}
		/* Marketing needs consent, the other categories do not.
		 *
		 * A utility template is the confirmation of something the person asked for —
		 * they registered for the webinar it is about — and requiring a separate
		 * marketing opt-in before confirming a registration would be consent theatre.
		 * Marketing is the opposite: it is the message they did not ask for, and it is
		 * the one the opt-in box on the registration form exists for. */
		if tmpl.Category == "MARKETING" && !contact.WhatsAppOptIn {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_opt_in",
				"This contact has not opted in to marketing messages, so only a utility template can be sent to them.")
			return
		}
		wamid, err = s.whatsapp.SendTemplate(r.Context(), user.WhatsAppToken, user.WhatsAppPhoneNumberID,
			wa.OutgoingTemplate{
				To:         contact.Phone,
				Name:       tmpl.Name,
				Language:   tmpl.Language,
				BodyParams: body.Params,
			})
		if err != nil {
			s.reportSendError(w, r, user.ID, err)
			return
		}
		recorded.TemplateName = tmpl.Name
		// The rendered text, not the template with its placeholders: the thread is a
		// record of what this person actually read.
		recorded.Body = wa.Render(tmpl.Body, body.Params)
	}
	recorded.WAMID = wamid

	msg, err := s.store.AppendMessage(r.Context(), user.ID, contact.ID, recorded)
	if err != nil {
		/* Sent and not filed. Told as it happened, because the obvious reaction to a
		 * generic 500 here is to press send again — and Meta has already delivered
		 * this one and already charged for it. */
		s.log.Error("crm send: sent but not recorded", "error", err,
			"host", user.ID, "contact", contact.ID, "wamid", wamid)
		httpx.Error(w, http.StatusInternalServerError, "crm_send_unrecorded",
			"Your message was delivered, but could not be saved to this conversation. Don't send it again.")
		return
	}
	s.log.Info("whatsapp message sent", "host", user.ID, "contact", contact.ID,
		"template", recorded.TemplateName, "wamid", wamid)
	httpx.JSON(w, http.StatusOK, msg)
}

/* templateForSend finds the named template, syncing once if it is not cached.
 *
 * The retry exists because a host who has just created a template in WhatsApp
 * Manager and come straight here would otherwise be told it does not exist. One
 * sync and one re-read, never a loop: a name that is genuinely not theirs must not
 * cost a Graph call on every attempt.
 */
func (s *Module) templateForSend(ctx context.Context, user store.User, name, language string) (types.CRMTemplate, error) {
	tmpl, err := s.store.Template(ctx, user.ID, name, language)
	if !errors.Is(err, store.ErrNotFound) {
		return tmpl, err
	}
	if serr := s.syncTemplates(ctx, user); serr != nil {
		s.log.Warn("crm send: template sync", "error", serr, "host", user.ID)
		return types.CRMTemplate{}, err
	}
	return s.store.Template(ctx, user.ID, name, language)
}

/* reportSendError turns a Graph failure into something the host can act on.
 *
 * Meta's own message is repeated verbatim where there is one, because the common
 * causes are all things only the host can fix — no payment method on the WABA, a
 * number that is not registered, a template paused an hour ago — and paraphrasing
 * any of those into "sending failed" removes the only useful part.
 */
func (s *Module) reportSendError(w http.ResponseWriter, r *http.Request, hostID string, err error) {
	s.log.Warn("whatsapp send failed", "error", err, "host", hostID)
	if whatsappAPIError(w, err) {
		return
	}
	switch {
	case errors.Is(err, wa.ErrNoRecipient), errors.Is(err, wa.ErrEmptyMessage), errors.Is(err, wa.ErrNoTemplate):
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_send_empty", err.Error())
	default:
		// Meta's text, which is the actionable part. Not s.fail: this is not a bug
		// here, and a generic "something went wrong" would hide the remedy.
		httpx.Error(w, http.StatusBadGateway, "whatsapp_send_failed", err.Error())
	}
}
