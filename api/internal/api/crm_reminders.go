package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* Automatic WhatsApp messages: the settings, the queueing and the sending.
 *
 * A registrant who gave a phone number and ticked the box gets a confirmation and
 * then reminders on WhatsApp, which is the whole commercial point of the feature:
 * it is the channel people actually read, and each message is billed to the host's
 * own Meta account.
 *
 * Three things have to be true before any of it happens, and they are deliberately
 * separate:
 *
 *   - the HOST has chosen an approved template for that kind of message. There is
 *     no default. Meta only delivers templates it has approved, so a name this
 *     application invented would be a rejection rather than a message.
 *   - the WEBINAR has WhatsApp reminders switched on. Unlike the email toggle this
 *     defaults to off, because it spends the host's money.
 *   - the CONTACT opted in. Required even though a webinar reminder is
 *     transactional by Meta's categories: this is an automatic message to somebody
 *     who filled in a form, and the tick box beside the phone field is the only
 *     thing that makes it a conversation they agreed to.
 *
 * The first is checked when the message is queued; the second and third are checked
 * again when it is sent, because a 24-hour reminder sits in the outbox for a day and
 * any of them can change in that time.
 */

/* mergeFields are the facts a reminder template can be filled in with.
 *
 * A fixed, small set rather than an expression language. A template's {{1}} has to
 * be filled with something for every recipient, and the values that exist at send
 * time are the contact, the webinar and the host — so those are the options, and a
 * host picking from four of them cannot compose one that fails for the eleventh
 * person in the list.
 *
 * Sent to the browser (see handleCRMReminders) so the picker cannot offer a token
 * this file would reject.
 */
var mergeFields = []types.CRMMergeField{
	{Token: "name", Label: "Contact's name", Example: "Thandi"},
	{Token: "topic", Label: "Webinar title", Example: "Scaling Postgres"},
	{Token: "when", Label: "When it starts", Example: "Tue 14 Oct, 14:00"},
	{Token: "host", Label: "Your name", Example: "Acme Coaching"},
	{
		Token: "replay", Label: "Link to the recording",
		Example:  "https://webinarliv.com/w/scaling-postgres/recording/…",
		OnlyKind: types.NotifyWhatsAppReplay,
	},
}

func knownMergeField(token string) bool {
	for _, f := range mergeFields {
		if f.Token == token {
			return true
		}
	}
	return false
}

/* mergeFieldOnlyKind is the one message kind a token works in, or empty for the tokens
 * that work everywhere.
 *
 * Checked server-side in three places rather than trusted to the picker, because the
 * failure it prevents is silent: a broadcast whose {{2}} is the replay link would be
 * accepted, queued, billed and delivered with an em dash where the link should be.
 */
func mergeFieldOnlyKind(token string) types.NotificationKind {
	for _, f := range mergeFields {
		if f.Token == token {
			return f.OnlyKind
		}
	}
	return ""
}

// handleCRMReminders lists the host's automatic-message settings, all kinds, set or not.
func (s *Server) handleCRMReminders(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	reminders, err := s.store.ReminderTemplates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm reminders", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMRemindersResponse{
		Reminders:         reminders,
		Fields:            mergeFields,
		WhatsAppConnected: user.WhatsAppToken != "",
	})
}

/* handleSetCRMReminders replaces the whole set.
 *
 * Every named template is checked against the host's own cache here rather than at
 * send time, because this is the only moment a person is present to be told: a
 * reminder that turns out to name an unapproved template discovers it at 9am the
 * day before a webinar, with nobody watching.
 */
func (s *Server) handleSetCRMReminders(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	var body types.CRMRemindersRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	in := make([]store.ReminderInput, 0, len(body.Reminders))
	for _, want := range body.Reminders {
		kind := types.NotificationKind(strings.TrimSpace(string(want.Kind)))
		if !isWhatsAppReminderKind(kind) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_kind",
				"There is no automatic message called "+string(want.Kind)+".")
			return
		}
		name := strings.TrimSpace(want.Template)
		if name == "" {
			// Off. Recorded by being absent, so "not configured" is one state.
			continue
		}
		if user.WhatsAppToken == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
				"Connect your WhatsApp Business account before choosing templates.")
			return
		}

		tmpl, err := s.templateForSend(r.Context(), user, name, want.Language)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template",
				"That template is not in your WhatsApp account. Refresh your templates and try again.")
			return
		}
		if err != nil {
			s.fail(w, r, "crm reminders: template", err)
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
		if len(want.Params) != tmpl.Variables {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
				"That template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
			return
		}
		for _, token := range want.Params {
			if !knownMergeField(token) {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_merge_field",
					"There is nothing called "+token+" to fill a template with.")
				return
			}
			if only := mergeFieldOnlyKind(token); only != "" && only != kind {
				httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_merge_field",
					"The "+token+" field only has a value on the replay message, so it cannot fill in this one.")
				return
			}
		}

		in = append(in, store.ReminderInput{
			Kind: string(kind), Name: tmpl.Name, Language: tmpl.Language, Params: want.Params,
		})
	}

	if err := s.store.SetReminderTemplates(r.Context(), user.ID, in); err != nil {
		s.fail(w, r, "crm reminders: save", err)
		return
	}
	reminders, err := s.store.ReminderTemplates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm reminders: reload", err)
		return
	}
	s.log.Info("whatsapp reminder templates set", "host", user.ID, "kinds", len(in))
	httpx.JSON(w, http.StatusOK, types.CRMRemindersResponse{
		Reminders:         reminders,
		Fields:            mergeFields,
		WhatsAppConnected: user.WhatsAppToken != "",
	})
}

func isWhatsAppReminderKind(kind types.NotificationKind) bool {
	for _, k := range types.WhatsAppReminderKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- queueing

/* enqueueWhatsAppInvite queues the WhatsApp confirmation and reminders for one
 * registrant.
 *
 * Mirrors enqueueApprovedInvite in mail.go and stops short of it in one way: the
 * webinar's toggle gates the confirmation as well as the timed reminders. Email is
 * free and a confirmation is the receipt for an action somebody just took; a
 * WhatsApp message costs the host money, and a host who switched WhatsApp off for
 * this webinar did not mean "except for one of them".
 *
 * Failures are logged and dropped. The registration is already committed and the
 * seat is what the attendee came for — a CRM message that could not be queued must
 * not turn their registration into an error.
 */
func (s *Server) enqueueWhatsAppInvite(
	ctx context.Context,
	wb types.Webinar,
	contact types.CRMContact,
	registrationID string,
) {
	if !wb.Options.WhatsAppReminders || registrationID == "" {
		return
	}
	// Checked again by the outbox sweep, which is where it counts; here it saves
	// writing rows for the majority of registrants who never ticked the box.
	if !contact.WhatsAppOptIn || contact.Phone == "" {
		return
	}
	hostID, err := s.store.HostIDFor(ctx, wb.ID)
	if err != nil {
		s.log.Error("whatsapp invite: could not resolve host", "webinar", wb.ID, "error", err)
		return
	}

	starts, _ := time.Parse(time.RFC3339, wb.StartsAt)
	type job struct {
		kind types.NotificationKind
		due  time.Time
	}
	jobs := []job{
		{types.NotifyWhatsAppConfirmed, time.Time{}}, // now
		{types.NotifyWhatsAppReminder24h, starts.Add(-24 * time.Hour)},
		{types.NotifyWhatsAppReminder1h, starts.Add(-1 * time.Hour)},
	}
	now := time.Now()
	for _, j := range jobs {
		// A webinar starting in ten minutes must not send a "in 24 hours" message,
		// and one with no start time has no reminders to place.
		if j.kind != types.NotifyWhatsAppConfirmed && (starts.IsZero() || !j.due.After(now)) {
			continue
		}
		reminder, ok, err := s.store.ReminderTemplate(ctx, hostID, j.kind)
		if err != nil {
			s.log.Error("whatsapp invite: reminder template", "kind", j.kind, "error", err)
			continue
		}
		if !ok {
			// The host has not chosen a template for this one. Nothing to send, and
			// nothing queued: a row naming no template would wait for ever.
			continue
		}
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Kind:             j.kind,
			Channel:          "whatsapp",
			ContactID:        contact.ID,
			WebinarSlug:      wb.ID,
			RegistrationID:   registrationID,
			TemplateName:     reminder.Template,
			TemplateLanguage: reminder.Language,
			TemplateParams:   resolveMergeFields(reminder.Params, contact, wb, ""),
			DueAt:            j.due,
		}); err != nil {
			s.log.Error("whatsapp invite: could not queue", "kind", j.kind,
				"contact", contact.ID, "error", err)
		}
	}
}

/* resolveMergeFields turns the host's chosen tokens into this recipient's values.
 *
 * Done when the message is queued rather than when it is sent, so the row records
 * what was promised: a webinar renamed an hour before it starts must not silently
 * rewrite the reminder somebody is about to receive.
 */
func resolveMergeFields(tokens []string, contact types.CRMContact, wb types.Webinar, replayURL string) []string {
	out := make([]string, 0, len(tokens))
	for _, token := range tokens {
		out = append(out, mergeValue(token, contact, wb, wb.Host.Name, replayURL))
	}
	return out
}

/* mergeValue is one token filled in for one recipient.
 *
 * hostName is passed rather than read from the webinar because a broadcast need not
 * be about a webinar at all, and "your name" still means something to the host who
 * is sending it.
 *
 * Every value comes back non-empty and single-spaced, because Meta rejects a
 * template parameter that is blank or contains a newline, a tab or a run of spaces —
 * and it rejects the whole send, so one missing surname would lose the message.
 */
func mergeValue(token string, contact types.CRMContact, wb types.Webinar, hostName, replayURL string) string {
	var value string
	switch token {
	case "replay":
		/* Empty on every path except the replay message, which is the only caller that
		 * has a recording in hand. It falls through to the em dash below rather than
		 * being special-cased, and the validations that keep this token out of a
		 * broadcast mean nobody should ever read that dash. */
		value = replayURL
	case "name":
		value = contact.Name
		if value == "" {
			// A greeting has to greet somebody. "Hi there" is the answer for the
			// registrant who gave a number and no name.
			value = "there"
		}
	case "topic":
		value = wb.Topic
	case "when":
		value = whenText(wb.StartsAt, wb.TimeZone)
	case "host":
		value = hostName
	}
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		value = "—"
	}
	return value
}

// ----------------------------------------------------------------- sending

/* flushWhatsAppOutbox sends everything owed on WhatsApp, once.
 *
 * Alongside flushOutbox rather than inside it: the two share the table and nothing
 * else. Mail goes through one transport this application owns, and every row here
 * goes out through a different host's Meta account, under their token, against
 * their bill.
 *
 * Reminders and broadcast recipients come through here identically, and the 100-row
 * limit is the only chunking a broadcast gets: at one sweep every 30 seconds that is
 * comfortably inside Cloud API's throughput while still being a bound on how much of
 * somebody's bill one tick can spend.
 *
 * Each row is re-checked against the template cache immediately before it is sent,
 * which is not belt-and-braces: a template can be paused or deleted by Meta, or
 * edited to take a different number of values, in the day between a reminder being
 * queued and being due. A send that names it then fails and the cost is a message
 * nobody receives, so the row is skipped with the reason instead.
 */
func (s *Server) flushWhatsAppOutbox(ctx context.Context) {
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		return
	}
	owed, err := s.store.PendingWhatsApp(ctx, 100)
	if err != nil {
		s.log.Error("whatsapp outbox: could not read", "error", err)
		return
	}
	for _, m := range owed {
		tmpl, err := s.store.Template(ctx, m.HostID, m.TemplateName, m.TemplateLanguage)
		if errors.Is(err, store.ErrNotFound) {
			s.skipWhatsApp(ctx, m, "template "+m.TemplateName+" is no longer in this WhatsApp account")
			continue
		}
		if err != nil {
			s.log.Error("whatsapp outbox: template lookup", "error", err, "host", m.HostID)
			continue
		}
		if !tmpl.Sendable {
			reason := tmpl.Unsupported
			if reason == "" {
				reason = "template " + tmpl.Name + " is " + strings.ToLower(tmpl.Status) + " at Meta"
			}
			s.skipWhatsApp(ctx, m, reason)
			continue
		}
		if len(m.Params) != tmpl.Variables {
			s.skipWhatsApp(ctx, m, "template "+tmpl.Name+" now takes "+
				strconv.Itoa(tmpl.Variables)+" value(s), not "+strconv.Itoa(len(m.Params)))
			continue
		}

		wamid, err := s.whatsapp.SendTemplate(ctx, m.Token, m.PhoneNumberID, wa.OutgoingTemplate{
			To:         m.Phone,
			Name:       tmpl.Name,
			Language:   tmpl.Language,
			BodyParams: m.Params,
		})
		if err != nil {
			// Retried with backoff by RecordSendAttempt until the attempts run out.
			// Meta's own sentence is kept as the reason: it is usually the only
			// actionable thing, and usually about the host's account.
			s.log.Error("whatsapp outbox: send failed", "kind", m.Kind,
				"host", m.HostID, "contact", m.ContactID, "error", err)
			_ = s.store.MarkDelivered(ctx, m.ID, "failed", err.Error())
			continue
		}
		/* Marked sent BEFORE the conversation row is written. Meta has delivered and
		 * charged for this message; if the thread write fails, the honest outcome is a
		 * message missing from the inbox, not one sent twice. */
		_ = s.store.MarkDelivered(ctx, m.ID, "sent", "")

		if _, err := s.store.AppendMessage(ctx, m.HostID, m.ContactID, store.MessageInput{
			Direction:    "out",
			Status:       "sent",
			WAMID:        wamid,
			Body:         wa.Render(tmpl.Body, m.Params),
			TemplateName: tmpl.Name,
			BroadcastID:  m.BroadcastID,
		}); err != nil {
			s.log.Error("whatsapp outbox: sent but not recorded", "error", err,
				"host", m.HostID, "contact", m.ContactID, "wamid", wamid)
		}
		s.log.Info("whatsapp message sent", "kind", m.Kind, "host", m.HostID,
			"contact", m.ContactID, "template", tmpl.Name, "wamid", wamid)
	}
}

// skipWhatsApp retires a message that can no longer be sent, keeping the reason:
// 'skipped' rather than 'failed' because nothing went wrong here, and a host asking
// why their reminder never arrived deserves the sentence rather than a silence.
func (s *Server) skipWhatsApp(ctx context.Context, m store.WhatsAppOutbound, reason string) {
	s.log.Warn("whatsapp outbox: skipped", "kind", m.Kind, "host", m.HostID,
		"contact", m.ContactID, "reason", reason)
	_ = s.store.MarkDelivered(ctx, m.ID, "skipped", reason)
}
