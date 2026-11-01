package engage

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
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
	{Token: "name", Label: "Contact's name", Example: "Thandi Nkosi"},
	{Token: "first_name", Label: "First name", Example: "Thandi"},
	{Token: "topic", Label: "Webinar title", Example: "Scaling Postgres"},
	{Token: "when", Label: "When it starts", Example: "Tue 14 Oct, 14:00"},
	{Token: "host", Label: "Your name", Example: "Acme Coaching"},
	{Token: "webinar_link", Label: "Webinar link", Example: "https://webinarliv.com/webinars/scaling-postgres"},
	{
		Token: "join_link", Label: "Personal join link",
		Example: "https://webinarliv.com/webinars/scaling-postgres/room?k=…",
	},
	{
		Token: "starts_in", Label: "How soon it starts", Example: "in 1 hour",
		OnlyKind: types.NotifyWhatsAppReminder,
	},
	{
		Token: "watched", Label: "Minutes watched", Example: "58 minutes",
		OnlyKind: types.NotifyWhatsAppBroadcast,
	},
	{
		Token: "replay", Label: "Link to the recording",
		Example:  "https://webinarliv.com/w/scaling-postgres/recording/…",
		OnlyKind: types.NotifyWhatsAppReplay,
	},
}

// needsWebinar is a token that has nothing to resolve against unless the message names
// a webinar.
func needsWebinar(token string) bool {
	switch strings.TrimSpace(token) {
	case "topic", "when", "webinar_link", "join_link":
		return true
	}
	return false
}

/* mergeLinks are the two link fields for one recipient, worked out by the caller —
 * a join link needs the person's registration, which mergeValue cannot look up. An
 * empty Join falls back to the webinar's page (a broadcast to a contact who never
 * registered for it). */
type mergeLinks struct {
	Webinar string
	Join    string
}

/* replayLinks is mergeLinks for one replay recipient. The join link costs two lookups
 * per person, so it is only worked out when the template uses it. */
func (s *Module) replayLinks(ctx context.Context, slug, registrationID string, tokens []string) mergeLinks {
	links := mergeLinks{Webinar: s.webinarPage(slug)}
	for _, t := range tokens {
		if strings.TrimSpace(t) == "join_link" {
			links.Join = s.joinLink(ctx, slug, registrationID)
			break
		}
	}
	return links
}

// webinarPage is the public page of a webinar, the `webinar_link` value.
func (s *Module) webinarPage(slug string) string {
	if slug == "" {
		return ""
	}
	return s.publicBase() + "/webinars/" + slug
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
func (s *Module) handleCRMReminders(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	reminders, err := s.store.ReminderTemplates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm reminders", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.CRMRemindersResponse{
		Reminders:         reminders,
		Fields:            s.fieldsFor(r.Context(), user.ID),
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
func (s *Module) handleSetCRMReminders(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())

	var body types.CRMRemindersRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	in := make([]crmstore.ReminderInput, 0, len(body.Reminders))
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
		// WhatsApp reminders are sold from Professional up (1 Nov 2026).
		if !whatsAppPlanAllowed(w, user) {
			return
		}
		if user.WhatsAppToken == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
				"Connect your WhatsApp Business account before choosing templates.")
			return
		}

		tmpl, err := s.templateForSend(r.Context(), user, name, want.Language)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template", noTemplateMessage(name))
			return
		}
		if err != nil {
			s.fail(w, r, "crm reminders: template", err)
			return
		}
		if !tmpl.Sendable {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable", unusableMessage(tmpl))
			return
		}
		// No values means "follow the template's mapping", which templateDefaults keeps
		// to fields this message has.
		if len(want.Params) != 0 && len(want.Params) != tmpl.Variables {
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
					"The "+token+" field has no value on this message, so it cannot fill it in.")
				return
			}
		}

		in = append(in, crmstore.ReminderInput{
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
		Fields:            s.fieldsFor(r.Context(), user.ID),
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
func (s *Module) enqueueWhatsAppInvite(
	ctx context.Context,
	wb types.Webinar,
	contact types.CRMContact,
	registrationID string,
) {
	if registrationID == "" || !contact.WhatsAppOptIn || contact.Phone == "" {
		return
	}
	hostID, err := s.store.HostIDFor(ctx, wb.ID)
	if err != nil {
		s.log.Error("whatsapp invite: could not resolve host", "webinar", wb.ID, "error", err)
		return
	}

	slots, err := s.ResolveSlots(ctx, wb.ID)
	if err != nil {
		s.log.Error("whatsapp invite: message slots", "webinar", wb.ID, "error", err)
		return
	}
	if conf, ok := types.FindSlot(slots, types.SlotConfirmation); ok && conf.Sends(types.ChannelWhatsApp) {
		s.queueWhatsApp(ctx, hostID, wb, contact, registrationID, types.NotifyWhatsAppConfirmed, 0, &conf)
	}
	if rem, ok := types.FindSlot(slots, types.SlotReminder); ok && rem.Sends(types.ChannelWhatsApp) {
		for _, offset := range rem.BeforeMinutes() {
			s.queueWhatsApp(ctx, hostID, wb, contact, registrationID, types.NotifyWhatsAppReminder, offset, &rem)
		}
	}
}

/* queueWhatsApp writes one confirmation (offset 0, due now) or one timed reminder (due
 * offset minutes before the start) for one contact, on the template the host chose for
 * that kind. Nothing is queued for a kind with no template — a row naming none would wait
 * for ever — or for a reminder whose time has passed: a webinar starting in ten minutes
 * must not get an "in 24 hours" message.
 */
func (s *Module) queueWhatsApp(
	ctx context.Context,
	hostID string,
	wb types.Webinar,
	contact types.CRMContact,
	registrationID string,
	kind types.NotificationKind,
	offset int,
	slot *types.MessageSlot,
) {
	var due time.Time
	if kind == types.NotifyWhatsAppReminder {
		starts, err := time.Parse(time.RFC3339, wb.StartsAt)
		if err != nil {
			return
		}
		due = starts.Add(-time.Duration(offset) * time.Minute)
		if !due.After(time.Now()) {
			return
		}
	}
	var reminder types.CRMReminder
	var ok bool
	var err error
	if slot != nil && strings.TrimSpace(slot.Template) != "" {
		reminder = types.CRMReminder{
			Kind: kind, Template: slot.Template, Language: slot.Language, Params: slot.Params,
		}
		ok = true
	} else {
		reminder, ok, err = s.store.ReminderTemplate(ctx, hostID, kind)
		if err != nil {
			s.log.Error("whatsapp invite: reminder template", "kind", kind, "error", err)
			return
		}
	}
	if !ok {
		return
	}
	params := s.effectiveParams(ctx, hostID, reminder.Template, reminder.Language, tokenParams(reminder.Params), kind)
	join := s.joinLink(ctx, wb.ID, registrationID)
	links := mergeLinks{Webinar: s.webinarPage(wb.ID), Join: join}
	if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
		Kind:             kind,
		Channel:          "whatsapp",
		ContactID:        contact.ID,
		WebinarSlug:      wb.ID,
		RegistrationID:   registrationID,
		TemplateName:     reminder.Template,
		TemplateLanguage: reminder.Language,
		TemplateParams:   resolveParamValues(params, contact, wb, wb.Host.Name, "", offset, links),
		LinkURL:          join,
		DueAt:            due,
		OffsetMin:        offset,
	}); err != nil {
		s.log.Error("whatsapp invite: could not queue", "kind", kind,
			"contact", contact.ID, "offsetMin", offset, "error", err)
	}
}

/* resolveMergeFields turns the host's chosen tokens into this recipient's values.
 *
 * Done when the message is queued rather than when it is sent, so the row records
 * what was promised: a webinar renamed an hour before it starts must not silently
 * rewrite the reminder somebody is about to receive.
 */
func resolveMergeFields(tokens []string, contact types.CRMContact, wb types.Webinar, replayURL string, offsetMin int, links mergeLinks) []string {
	out := make([]string, 0, len(tokens))
	for _, token := range tokens {
		out = append(out, mergeValue(token, contact, wb, wb.Host.Name, replayURL, offsetMin, links))
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
func mergeValue(token string, contact types.CRMContact, wb types.Webinar, hostName, replayURL string, offsetMin int, links mergeLinks) string {
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
	case "first_name":
		if f := strings.Fields(contact.Name); len(f) > 0 {
			value = f[0]
		} else {
			value = "there"
		}
	case "topic":
		value = wb.Topic
	case "when":
		value = notify.WhenText(wb.StartsAt, wb.TimeZone)
	case "webinar_link":
		value = links.Webinar
	case "join_link":
		value = links.Join
		if value == "" {
			value = links.Webinar
		}
	case "host":
		value = hostName
	case "starts_in":
		// Only a timed reminder knows how far ahead it is; everywhere else this is refused
		// (OnlyKind), and would fall through to the dash below.
		if offsetMin > 0 {
			value = notify.StartsIn(offsetMin)
		}
	}
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		value = "—"
	}
	return value
}

// ----------------------------------------------------------------- sending

/* flushWhatsAppOutbox sends what is owed on WhatsApp, for as long as its budget allows.
 *
 * Alongside flushOutbox rather than inside it: the two share the table and nothing
 * else. Mail goes through one transport this application owns, and every row here
 * goes out through a different host's Meta account, under their token, against
 * their bill.
 *
 * Reminders and broadcast recipients come through here identically. One flush reads at
 * most 100 rows and sends for at most whatsappFlushBudget; what it does not reach stays
 * pending, untouched, and the next pass sends it. On 1 Nov 2026 a 658-person broadcast
 * ran a send a second inside the tick's request with no deadline of its own: each pass
 * spent the whole 90 s lane, outlived the server's 60 s write timeout, and Cloud Run
 * took every instance it answered on out of service (docs/observability.md).
 *
 * Sends run on a few workers, one contact's rows on one worker in order, so a contact's
 * 24-hour and 1-hour reminders cannot overtake each other.
 *
 * At most once. Each row is claimed 'sent' (store.ClaimSend) immediately before it goes
 * to Meta, and the send and its bookkeeping run on a context the flush's deadline cannot
 * cut short: a timed-out pass can no longer leave a delivered message pending to be sent
 * again. A refusal Meta answered is retried with backoff; a send with no answer is
 * retired as failed, because it may have been delivered.
 *
 * Each row is re-checked against the template cache immediately before it is sent,
 * which is not belt-and-braces: a template can be paused or deleted by Meta, or
 * edited to take a different number of values, in the day between a reminder being
 * queued and being due. A send that names it then fails and the cost is a message
 * nobody receives, so the row is skipped with the reason instead.
 */
// FlushWhatsAppOutbox sends what is due now, unless another sender holds the
// outbox. It reports whether this call was the sender. The tick does this every
// pass; registrations start one after responding.
func (s *Module) FlushWhatsAppOutbox(ctx context.Context) bool { return s.flushWhatsAppOutbox(ctx) }

const (
	// whatsappFlushBudget bounds one flush, well inside the tick's request (api.tickRequestBudget).
	whatsappFlushBudget = 20 * time.Second
	// whatsappSendTimeout bounds one send. A send starts only with this much budget left.
	whatsappSendTimeout = 10 * time.Second
	// whatsappRecordTimeout bounds the writes after a send, which run past the flush's deadline.
	whatsappRecordTimeout = 10 * time.Second
	// whatsappSendWorkers is how many sends are in flight at once. Meta takes 80 a second per
	// number; this is about the database pool and one host's bill per pass.
	whatsappSendWorkers = 4
)

// SetWhatsAppFlushTiming changes one flush's budget and one send's timeout, for tests.
func (s *Module) SetWhatsAppFlushTiming(budget, send time.Duration) {
	s.waFlushBudget, s.waSendTimeout = budget, send
}

func (s *Module) whatsappTiming() (budget, send time.Duration) {
	budget, send = whatsappFlushBudget, whatsappSendTimeout
	if s.waFlushBudget > 0 {
		budget = s.waFlushBudget
	}
	if s.waSendTimeout > 0 {
		send = s.waSendTimeout
	}
	return budget, send
}

func (s *Module) flushWhatsAppOutbox(ctx context.Context) bool {
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		return true
	}
	budget, sendTimeout := s.whatsappTiming()
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	/* One sender at a time, across instances and between the sweep and the flush a
	 * registration or approval triggers. A held lease means another runner is sending;
	 * whatever it missed is due on the next pass. The claim on each row is what makes a
	 * second copy impossible; the lease is what keeps two senders from racing for it. */
	release, ok, err := s.store.TryLease(ctx, "outbox:whatsapp", 2*time.Minute)
	if err != nil || !ok {
		if err != nil {
			s.log.Error("whatsapp outbox: could not take lease", "error", err)
		}
		return false
	}
	defer release()

	owed, err := s.store.PendingWhatsApp(ctx, 100)
	if err != nil {
		s.log.Error("whatsapp outbox: could not read", "error", err)
		return true
	}

	// One contact's rows together, in the order they came due.
	var order []string
	byContact := map[string][]crmstore.WhatsAppOutbound{}
	for _, m := range owed {
		if _, ok := byContact[m.ContactID]; !ok {
			order = append(order, m.ContactID)
		}
		byContact[m.ContactID] = append(byContact[m.ContactID], m)
	}
	work := make(chan []crmstore.WhatsAppOutbound)
	var wg sync.WaitGroup
	for range min(whatsappSendWorkers, len(order)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Per worker, so neither needs a lock: webinars for the cover image and page
			// link, templates for the re-check.
			f := waFlush{webinars: map[string]*types.Webinar{}, templates: map[string]waTemplate{}}
			for rows := range work {
				for _, m := range rows {
					if !s.sendOneWhatsApp(ctx, &f, m, sendTimeout) {
						break
					}
				}
			}
		}()
	}
	unsent := 0
	for i, c := range order {
		if !sendable(ctx, sendTimeout) {
			for _, rest := range order[i:] {
				unsent += len(byContact[rest])
			}
			break
		}
		select {
		case work <- byContact[c]:
		case <-ctx.Done():
		}
	}
	close(work)
	wg.Wait()
	if unsent > 0 || ctx.Err() != nil {
		s.log.Info("whatsapp outbox: budget spent; the rest goes next pass", "unstarted", unsent)
	}
	return true
}

// sendable reports whether a send started now would finish inside the flush's budget.
func sendable(ctx context.Context, sendTimeout time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	deadline, ok := ctx.Deadline()
	return !ok || time.Until(deadline) >= sendTimeout
}

type waTemplate struct {
	tmpl types.CRMTemplate
	err  error
}

// waFlush is one worker's caches for one flush.
type waFlush struct {
	webinars  map[string]*types.Webinar
	templates map[string]waTemplate
}

/* sendOneWhatsApp checks, claims, sends and records one row. It reports false when the
 * flush is out of time, and the rest of this contact's rows wait for the next pass,
 * still pending. */
func (s *Module) sendOneWhatsApp(ctx context.Context, f *waFlush, m crmstore.WhatsAppOutbound, sendTimeout time.Duration) bool {
	if !sendable(ctx, sendTimeout) {
		return false
	}
	key := m.HostID + "\x00" + m.TemplateName + "\x00" + m.TemplateLanguage
	cached, ok := f.templates[key]
	if !ok {
		cached.tmpl, cached.err = s.store.Template(ctx, m.HostID, m.TemplateName, m.TemplateLanguage)
		if cached.err == nil || errors.Is(cached.err, store.ErrNotFound) {
			f.templates[key] = cached
		}
	}
	tmpl, err := cached.tmpl, cached.err
	if errors.Is(err, store.ErrNotFound) {
		s.skipWhatsApp(ctx, m, "template "+m.TemplateName+" is no longer in this WhatsApp account")
		return true
	}
	if err != nil {
		if ctx.Err() != nil {
			return false
		}
		s.log.Error("whatsapp outbox: template lookup", "error", err, "host", m.HostID)
		return true
	}
	/* Not Sendable only for want of a file (a video or document header, a carousel's
	 * card pictures) is settled by fillRich: a broadcast can bring its own, and
	 * fillRich says what is missing when it did not. */
	missingFile := tmpl.Status == "APPROVED" && tmpl.Unsupported == "" && (tmpl.NeedsHeaderFile || tmpl.NeedsCardFiles)
	if !tmpl.Sendable && !missingFile {
		reason := tmpl.Unsupported
		if reason == "" {
			reason = "template " + tmpl.Name + " is " + strings.ToLower(tmpl.Status) + " at Meta"
		}
		s.skipWhatsApp(ctx, m, reason)
		return true
	}
	if len(m.Params) != tmpl.Variables {
		s.skipWhatsApp(ctx, m, "template "+tmpl.Name+" now takes "+
			strconv.Itoa(tmpl.Variables)+" value(s), not "+strconv.Itoa(len(m.Params)))
		return true
	}

	out := wa.OutgoingTemplate{
		To:         m.Phone,
		Name:       tmpl.Name,
		Language:   tmpl.Language,
		BodyParams: m.Params,
	}
	if reason := s.fillRich(ctx, &out, tmpl, m.HostID, m, f.webinars); reason != "" {
		if ctx.Err() != nil {
			return false
		}
		s.skipWhatsApp(ctx, m, reason)
		return true
	}
	if !sendable(ctx, sendTimeout) {
		return false
	}
	claimed, err := s.store.ClaimSend(ctx, m.ID)
	if err != nil {
		if ctx.Err() == nil {
			s.log.Error("whatsapp outbox: could not claim", "error", err, "notification", m.ID)
		}
		return ctx.Err() == nil
	}
	if !claimed {
		// Another sender has it, or it stopped being pending since the read.
		return true
	}

	// From here the row says sent. Neither the send nor what records it is cut short by
	// the flush's deadline: a send abandoned half-way is one whose outcome nobody knows.
	detached := context.WithoutCancel(ctx)
	sendCtx, cancelSend := context.WithTimeout(detached, sendTimeout)
	wamid, err := s.whatsapp.SendTemplate(sendCtx, m.Token, m.PhoneNumberID, out)
	cancelSend()
	rec, cancelRec := context.WithTimeout(detached, whatsappRecordTimeout)
	defer cancelRec()
	if err != nil {
		s.log.Error("whatsapp outbox: send failed", "kind", m.Kind,
			"host", m.HostID, "contact", m.ContactID, "notification", m.ID, "error", err)
		if wa.NoAnswer(err) {
			/* Meta may have delivered it: retired, not retried. A message somebody
			 * did not get is a failure the host can see; a second copy is a fee and an
			 * annoyed contact nobody can take back. */
			if err := s.store.GiveUpDelivery(rec, m.ID, "no answer from WhatsApp, so it may have been delivered; "+
				"not sent again so nobody gets it twice ("+err.Error()+")"); err != nil {
				s.log.Error("whatsapp outbox: could not record a send with no answer",
					"error", err, "notification", m.ID)
			}
			return true
		}
		// Meta answered with a refusal: nothing was sent. Retried with backoff by
		// RecordSendAttempt until the attempts run out. Meta's own sentence is kept as
		// the reason: it is usually the only actionable thing, and usually about the
		// host's account.
		s.noteWhatsAppError(rec, m.HostID, m.Token, err)
		if err := s.store.MarkDelivered(rec, m.ID, "failed", err.Error()); err != nil {
			s.log.Error("whatsapp outbox: could not record a refused send", "error", err, "notification", m.ID)
		}
		return true
	}

	/* The wamid is what every delivered, read and failed webhook is matched by, so the
	 * conversation row is written straight after the send, on its own deadline. If the
	 * write fails the message is missing from the inbox, never sent twice. */
	if _, err := s.store.AppendMessage(rec, m.HostID, m.ContactID, crmstore.MessageInput{
		Direction:      "out",
		Status:         "sent",
		WAMID:          wamid,
		Body:           wa.Render(tmpl.Body, m.Params),
		TemplateName:   tmpl.Name,
		Attachment:     headerAttachment(out.HeaderMedia),
		BroadcastID:    m.BroadcastID,
		NotificationID: m.ID,
		WebinarID:      m.WebinarSlug,
	}); err != nil {
		s.log.Error("whatsapp outbox: sent but not recorded", "error", err,
			"host", m.HostID, "contact", m.ContactID, "wamid", wamid)
	}
	s.log.Info("whatsapp message sent", "kind", m.Kind, "host", m.HostID,
		"contact", m.ContactID, "template", tmpl.Name, "wamid", wamid)
	return true
}

// skipWhatsApp retires a message that can no longer be sent, keeping the reason:
// 'skipped' rather than 'failed' because nothing went wrong here, and a host asking
// why their reminder never arrived deserves the sentence rather than a silence.
func (s *Module) skipWhatsApp(ctx context.Context, m crmstore.WhatsAppOutbound, reason string) {
	s.log.Warn("whatsapp outbox: skipped", "kind", m.Kind, "host", m.HostID,
		"contact", m.ContactID, "reason", reason)
	_ = s.store.MarkDelivered(ctx, m.ID, "skipped", reason)
}
