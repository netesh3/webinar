package engage

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* The CRM's half of sending the AI follow-ups from Results (api/internal/api/followup_send.go
 * is the other half, and decides who and what; this decides how WhatsApp may carry it).
 *
 * Only to a contact who opted in — a follow-up is the host's own message, not a receipt
 * for anything, so it is held to the broadcasts' rule rather than the one-to-one inbox's.
 * Then Meta's rule:
 *
 *   inside the 24-hour window  the host's text as it is, a free-form message;
 *   outside it                 our template wl_session_followup, with the text in its
 *                              last variable. Until Meta approves the template on this
 *                              host's WABA, outside-window WhatsApp is not offered.
 *
 * Every send is checked again here at send time (consent can change between the review
 * screen and the press), and filed in the contact's thread with the webinar it is about,
 * so a reply lands under it in the inbox.
 *
 * The template is MARKETING. A utility template must be about a specific transaction the
 * person asked for, with fixed wording; a follow-up whose body is free text the host (and
 * the AI) wrote, inviting a next step, is promotional by Meta's definition, and Meta
 * re-categorises a "utility" template like it on review anyway — which on the newer rules
 * can pause it. Marketing is the honest category, and it is the one the registration
 * form's WhatsApp opt-in exists for. */

const (
	followupTemplateLanguage = "en"
	// FollowupTemplateBody is our template's wording: {{1}} first name, {{2}} the session's
	// topic, {{3}} the host's message on one line. Fixed text before and after the variables,
	// as Meta requires (a body may not start or end with one).
	FollowupTemplateBody   = "Hi {{1}}, a quick note about {{2}}:\n\n{{3}}\n\nJust reply here if you have any questions."
	followupTemplateFooter = "Reply STOP to opt out"
	// whatsappTemplateBodyMax is Meta's limit on a template body, variables filled in.
	whatsappTemplateBodyMax = 1024
	followupTopicMax        = 120
	followupNameMax         = 40
)

func followupTemplate() types.CRMStarterTemplate {
	return types.CRMStarterTemplate{
		Name: types.FollowupTemplateName, Category: "MARKETING", Use: "Session follow-up",
		Body:   FollowupTemplateBody,
		Params: []string{"first_name", "topic", "message"},
		Examples: []string{"Priya", "Morning Routines That Stick",
			"Thank you for your questions today. The replay is up if you want to revisit the morning checklist."},
	}
}

var (
	paramSpace = regexp.MustCompile(`\s+`)
	// A greeting the AI opens with, which the template already says ("Hi {{1}},").
	leadingGreeting = regexp.MustCompile(`(?i)^\s*(hi|hello|hey|hii|namaste|dear)\b[^,\n!.]{0,40}[,!.]?\s*`)
)

/* TemplateParam makes text fit a WhatsApp template variable: Meta refuses a parameter with
 * a newline or tab, or more than four spaces in a row, so all whitespace runs become one
 * space; then clipped to max runes, with an ellipsis when cut. */
func TemplateParam(text string, max int) string {
	s := strings.TrimSpace(paramSpace.ReplaceAllString(text, " "))
	if max > 0 && utf8.RuneCountInString(s) > max {
		r := []rune(s)
		cut := max - 1
		if cut < 0 {
			cut = 0
		}
		s = strings.TrimSpace(string(r[:cut])) + "…"
	}
	return s
}

/* FollowupTemplateParams fills the template for one person: their first name ("there"
 * when unknown), the topic, and the message without its own greeting, so the whole body
 * stays within Meta's 1024 characters. */
func FollowupTemplateParams(firstName, topic, text string) []string {
	name := TemplateParam(firstName, followupNameMax)
	if name == "" {
		name = "there"
	}
	t := TemplateParam(topic, followupTopicMax)
	if t == "" {
		t = "the session"
	}
	msg := strings.TrimSpace(text)
	if m := leadingGreeting.FindStringIndex(msg); m != nil && m[1] < len(msg) {
		msg = msg[m[1]:]
	}
	fixed := utf8.RuneCountInString(FollowupTemplateBody) - len("{{1}}{{2}}{{3}}")
	room := whatsappTemplateBodyMax - fixed - utf8.RuneCountInString(name) - utf8.RuneCountInString(t)
	return []string{name, t, TemplateParam(msg, room)}
}

/* followupRoute is how a WhatsApp follow-up may go to somebody, or why it may not:
 * consent first (no number, opted out, never opted in), then Meta's window. */
func followupRoute(connected bool, status, contactID string, inWindow, templateApproved bool) (mode, reason string) {
	switch {
	case !connected:
		return "", types.FollowupReasonNotConnected
	case contactID == "":
		return "", types.FollowupReasonNoContact
	case status == types.CRMStatusNoNumber:
		return "", types.FollowupReasonNoNumber
	case status == types.CRMStatusOptedOut:
		return "", types.FollowupReasonOptedOut
	case status != types.CRMStatusOptedIn:
		return "", types.FollowupReasonNoOptIn
	case inWindow:
		return types.FollowupModeFreeform, ""
	case templateApproved:
		return types.FollowupModeTemplate, ""
	}
	return "", types.FollowupReasonTemplate
}

func (s *Module) whatsappReady(host store.User) bool {
	return s.whatsapp.Enabled() && host.WhatsAppToken != "" && host.WhatsAppPhoneNumberID != ""
}

// followupTemplateState is our template on the host's WABA, from the cache.
func (s *Module) followupTemplateState(ctx context.Context, host store.User) (types.CRMTemplate, bool) {
	tmpl, err := s.findTemplate(ctx, host.ID, types.FollowupTemplateName, followupTemplateLanguage)
	if err != nil {
		return types.CRMTemplate{}, false
	}
	return tmpl, true
}

func followupTemplateApproved(t types.CRMTemplate, ok bool) bool {
	return ok && strings.EqualFold(t.Status, "APPROVED") && t.Sendable && t.Variables == 3
}

/* refreshPendingTemplate re-reads the templates from Meta when ours is waiting on review,
 * so approval shows without the host finding the refresh button. Failures are logged. */
func (s *Module) refreshPendingTemplate(ctx context.Context, host store.User) {
	t, ok := s.followupTemplateState(ctx, host)
	if !ok || (!strings.EqualFold(t.Status, "PENDING") && !strings.EqualFold(t.Status, "IN_APPEAL")) {
		return
	}
	if err := s.syncTemplates(ctx, host); err != nil {
		s.log.Warn("followup template: refresh", "host", host.ID, "error", err)
	}
}

/* FollowupWhatsApp implements api.Engage: for each registration of the host's session, its
 * contact and how a WhatsApp follow-up would go now. A template still waiting on Meta is
 * re-read here, on the review screen, and never per send. */
func (s *Module) FollowupWhatsApp(ctx context.Context, host store.User, slug string, registrationIDs []string) types.FollowupWAState {
	if s.whatsappReady(host) {
		s.refreshPendingTemplate(ctx, host)
	}
	return s.followupWhatsApp(ctx, host, slug, registrationIDs)
}

func (s *Module) followupWhatsApp(ctx context.Context, host store.User, slug string, registrationIDs []string) types.FollowupWAState {
	out := types.FollowupWAState{Connected: s.whatsappReady(host), Contacts: map[string]types.FollowupWAContact{}}
	tmpl, ok := s.followupTemplateState(ctx, host)
	if ok {
		out.TemplateStatus = strings.ToUpper(tmpl.Status)
	}
	approved := followupTemplateApproved(tmpl, ok)
	rows := make([]types.RegistrantRow, 0, len(registrationIDs))
	for _, id := range registrationIDs {
		if id != "" {
			rows = append(rows, types.RegistrantRow{ID: id})
		}
	}
	if len(rows) > 0 {
		if err := s.store.AttachRegistrantWhatsApp(ctx, slug, rows); err != nil {
			s.log.Warn("followup: whatsapp state", "slug", slug, "error", err)
		}
	}
	now := time.Now()
	for _, r := range rows {
		mode, reason := followupRoute(out.Connected, r.WhatsAppStatus, r.ContactID, inWindow(r.LastInboundAt, now), approved)
		out.Contacts[r.ID] = types.FollowupWAContact{ContactID: r.ContactID, Mode: mode, Reason: reason}
	}
	return out
}

func inWindow(lastInbound string, now time.Time) bool {
	if lastInbound == "" {
		return false
	}
	at, err := time.Parse(time.RFC3339, lastInbound)
	return err == nil && at.Add(wa.ServiceWindow).After(now)
}

/* SendFollowupWhatsApp implements api.Engage: one follow-up, decided again from what is
 * true now, sent, and filed in the contact's thread under the webinar. */
func (s *Module) SendFollowupWhatsApp(ctx context.Context, host store.User, slug string, in types.FollowupWASend) types.FollowupWAResult {
	skip := func(reason string) types.FollowupWAResult {
		return types.FollowupWAResult{Status: types.FollowupStatusSkipped, Reason: reason}
	}
	// WhatsApp is sold from Professional up (1 Nov 2026), whatever else is switched on.
	if !host.HasFeature(types.FeatureWhatsAppCRM) {
		return skip(types.FollowupReasonPlan)
	}
	text := strings.TrimSpace(in.Text)
	if text == "" {
		return skip(types.FollowupReasonEmpty)
	}
	if utf8.RuneCountInString(text) > whatsappTextMax {
		return skip(types.FollowupReasonTooLong)
	}
	state := s.followupWhatsApp(ctx, host, slug, []string{in.RegistrationID})
	c := state.Contacts[in.RegistrationID]
	if in.RegistrationID == "" {
		c.Reason = types.FollowupReasonNoContact
	}
	if c.Mode == "" {
		r := skip(c.Reason)
		r.ContactID = c.ContactID
		return r
	}
	contact, err := s.store.Contact(ctx, host.ID, c.ContactID)
	if err != nil {
		return types.FollowupWAResult{Status: types.FollowupStatusFailed, Reason: types.FollowupReasonSendFailed,
			Error: "Could not read the contact.", ContactID: c.ContactID}
	}
	res := types.FollowupWAResult{Mode: c.Mode, ContactID: contact.ID, Phone: contact.Phone}
	recorded := crmstore.MessageInput{Direction: "out", Status: "sent", Manual: true, WebinarID: slug}
	var wamid string
	if c.Mode == types.FollowupModeFreeform {
		wamid, err = s.whatsapp.SendText(ctx, host.WhatsAppToken, host.WhatsAppPhoneNumberID, contact.Phone, text)
		recorded.Body = text
	} else {
		tmpl, _ := s.followupTemplateState(ctx, host)
		params := FollowupTemplateParams(in.FirstName, in.Topic, text)
		wamid, err = s.whatsapp.SendTemplate(ctx, host.WhatsAppToken, host.WhatsAppPhoneNumberID, wa.OutgoingTemplate{
			To: contact.Phone, Name: tmpl.Name, Language: tmpl.Language, BodyParams: params,
		})
		recorded.TemplateName = tmpl.Name
		recorded.Body = wa.Render(tmpl.Body, params)
	}
	if err != nil {
		s.noteWhatsAppError(ctx, host.ID, host.WhatsAppToken, err)
		s.log.Warn("followup whatsapp: send", "host", host.ID, "contact", contact.ID, "error", err)
		res.Status, res.Reason, res.Error = types.FollowupStatusFailed, types.FollowupReasonSendFailed, err.Error()
		return res
	}
	recorded.WAMID = wamid
	if _, err := s.store.AppendMessage(ctx, host.ID, contact.ID, recorded); err != nil {
		// Sent and paid for: reported as sent, so nobody presses it again.
		s.log.Error("followup whatsapp: sent but not recorded", "host", host.ID, "contact", contact.ID,
			"wamid", wamid, "error", err)
	}
	s.log.Info("followup whatsapp sent", "host", host.ID, "contact", contact.ID, "mode", c.Mode, "wamid", wamid)
	res.Status = types.FollowupStatusSent
	return res
}

/* LogFollowupEmail implements api.Engage: a note on the person's contact saying a
 * follow-up email went, so the contact's history shows both channels. Nothing for somebody
 * with no contact; a failure is logged. */
func (s *Module) LogFollowupEmail(ctx context.Context, host store.User, slug, registrationID, subject string) {
	if registrationID == "" {
		return
	}
	rows := []types.RegistrantRow{{ID: registrationID}}
	if err := s.store.AttachRegistrantWhatsApp(ctx, slug, rows); err != nil || rows[0].ContactID == "" {
		return
	}
	body := "Follow-up email sent: " + strings.TrimSpace(subject)
	if _, err := s.store.AddNote(ctx, host.ID, rows[0].ContactID, host.ID, body); err != nil {
		s.log.Warn("followup email: note", "host", host.ID, "contact", rows[0].ContactID, "error", err)
	}
}

func (s *Module) followupTemplateResponse(ctx context.Context, host store.User) types.FollowupTemplateResponse {
	t := followupTemplate()
	out := types.FollowupTemplateResponse{
		Connected: s.whatsappReady(host) && host.WhatsAppWABAID != "",
		Name:      t.Name, Language: followupTemplateLanguage, Category: t.Category,
		Body: t.Body, Footer: followupTemplateFooter, Examples: t.Examples,
	}
	if tmpl, ok := s.followupTemplateState(ctx, host); ok {
		out.Status = strings.ToUpper(tmpl.Status)
	}
	return out
}

// handleFollowupTemplate is GET /api/host/crm/followup-template.
func (s *Module) handleFollowupTemplate(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.whatsappReady(user) {
		s.refreshPendingTemplate(r.Context(), user)
	}
	httpx.JSON(w, http.StatusOK, s.followupTemplateResponse(r.Context(), user))
}

/* handleSubmitFollowupTemplate is POST /api/host/crm/followup-template: submits our
 * follow-up template to Meta for this host's WABA (the starter templates' path), unless it
 * is already there, then re-reads the list so its status shows. */
func (s *Module) handleSubmitFollowupTemplate(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	ctx := r.Context()
	if !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset", "WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppWABAID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account first.")
		return
	}
	if _, ok := s.followupTemplateState(ctx, user); ok {
		httpx.JSON(w, http.StatusOK, s.followupTemplateResponse(ctx, user))
		return
	}
	nt := newTemplate(followupTemplate(), s.publicBase())
	nt.Language, nt.Footer = followupTemplateLanguage, followupTemplateFooter
	status, err := s.whatsapp.CreateTemplate(ctx, user.WhatsAppToken, user.WhatsAppWABAID, nt)
	if err != nil {
		s.noteWhatsAppError(ctx, user.ID, user.WhatsAppToken, err)
		s.log.Warn("followup template: submit", "host", user.ID, "error", err)
		if whatsappAPIError(w, err) {
			return
		}
		httpx.Error(w, http.StatusBadGateway, "whatsapp_template_failed", "Meta refused the template: "+err.Error())
		return
	}
	if err := s.syncTemplates(ctx, user); err != nil {
		s.log.Warn("followup template: resync", "host", user.ID, "error", err)
	}
	out := s.followupTemplateResponse(ctx, user)
	if out.Status == "" {
		out.Status = strings.ToUpper(status)
	}
	httpx.JSON(w, http.StatusOK, out)
}
