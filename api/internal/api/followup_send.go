package api

import (
	"context"
	"errors"
	"html/template"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Sending the AI follow-ups, from Results → ✨ Follow-ups. See types/followup_send.go for
 * the flow; this file is who, what and the email. The CRM (engage/followup_send.go) is how
 * a WhatsApp may go.
 *
 *   POST …/followups/plan  the review screen: for each person picked, their group's drafts
 *                          filled in for them, and what email and WhatsApp can do now.
 *   POST …/followups/send  what the host reviewed and pressed Send on. Every item is
 *                          checked again: the person must be in this session, the channel
 *                          must still reach them, and the same follow-up must not have gone
 *                          already (unless "send again"). Claimed before it is sent, so two
 *                          tabs cannot both send it.
 *
 * Host only (requireTrueOwner): the WhatsApp goes from the host's own number and the email
 * in the host's name, so a co-host cannot send them. Needs the session ended, AI allowed
 * for it (the drafts are the AI's), and drafts written.
 *
 * Within the request, a few at a time, at most followupSendBatch items per request; the
 * web sends a longer list in chunks and shows the progress. Cloud Run only gives CPU
 * during a request, and a 20-item request finishes in seconds, so nothing is left for a
 * sweeper to find. Capped per host per hour (followupSendsPerHour).
 *
 * Email: plain text, From the host's name at our address, Reply-To the host's own email
 * and their webinarliv inbox (so a reply reaches the host and threads in the inbox), an
 * unsubscribe link and one-click List-Unsubscribe; an address that unsubscribed from this
 * host is skipped. Filed in the host's email inbox, and noted on the CRM contact. */

const (
	followupSendBatch    = 20
	followupPlanMax      = 1000
	followupSendsPerHour = 1000
	followupSendWorkers  = 4
)

var (
	placeholderFirstName = regexp.MustCompile(`\{\{\s*first_name\s*\}\}`)
	placeholderReplay    = regexp.MustCompile(`\{\{\s*replay_link\s*\}\}`)
	placeholderOffer     = regexp.MustCompile(`\{\{\s*offer_link\s*\}\}`)
	doubleSpace          = regexp.MustCompile(`[ \t]{2,}`)
	spaceBeforePunct     = regexp.MustCompile(`[ \t]+([,.!?])`)
)

/* fillFollowup puts one person into a draft: {{first_name}} (or "there"), {{replay_link}}
 * (or nothing), {{offer_link}} always removed — there is no offer to link yet. */
func fillFollowup(text, first, replay string) string {
	if first == "" {
		first = "there"
	}
	text = placeholderFirstName.ReplaceAllLiteralString(text, first)
	text = placeholderReplay.ReplaceAllLiteralString(text, replay)
	text = placeholderOffer.ReplaceAllLiteralString(text, "")
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		l = doubleSpace.ReplaceAllString(l, " ")
		lines[i] = strings.TrimRight(spaceBeforePunct.ReplaceAllString(l, "$1"), " \t")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// followupDraftGroup is the group whose draft a person gets: hot leads the hot one.
func followupDraftGroup(l rankedLead, asked string) string {
	if asked == "hot" && l.Tag == "hot" {
		return "hot"
	}
	if asked != "" && asked != "hot" && asked == l.Group {
		return asked
	}
	if l.Tag == "hot" {
		return "hot"
	}
	return l.Group
}

type followupContext struct {
	wb      types.Webinar
	host    store.User
	leads   map[string]rankedLead
	drafts  map[string]types.FollowupDraft
	replay  string
	sends   map[string]map[string]store.FollowupSend
	mailOn  bool
	waState types.FollowupWAState
}

/* loadFollowupContext reads everything one plan or send needs, or writes the refusal:
 * 409 not_ended / no_drafts, 403 feature_off (account) or ai_session_off (this session). */
func (s *Server) loadFollowupContext(w http.ResponseWriter, r *http.Request, lang string, keys []string) (followupContext, bool) {
	ctx := r.Context()
	var fc followupContext
	wb, err := s.store.WebinarBySlug(ctx, slugFromContext(ctx))
	if err != nil {
		s.fail(w, r, "followup send: webinar", err)
		return fc, false
	}
	if wb.Status != types.StatusEnded {
		httpx.Error(w, http.StatusConflict, "not_ended", "Follow-ups can be sent once the session has ended.")
		return fc, false
	}
	/* The account first (ai, then followup_send, which needs ai), then the session's own
	 * switch: an account without the feature is told so, a session kept out of AI is told
	 * that instead. */
	switch s.sessionAIBlock(ctx, wb) {
	case types.RecapReasonAIOff:
		httpx.Error(w, http.StatusForbidden, "feature_off", "AI follow-ups aren't switched on for this account.")
		return fc, false
	case types.RecapReasonAISessionOff:
		httpx.Error(w, http.StatusForbidden, types.RecapReasonAISessionOff,
			"AI was off for this session, so it has no follow-up drafts to send.")
		return fc, false
	}
	if !s.hostFeature(ctx, wb.Host.ID, types.FeatureFollowupSend) {
		httpx.Error(w, http.StatusForbidden, "feature_off",
			featureLabel(types.FeatureFollowupSend)+" isn't switched on for this account.")
		return fc, false
	}
	fu, err := s.followups(ctx, wb, lang, false)
	if err != nil {
		s.fail(w, r, "followup send: drafts", err)
		return fc, false
	}
	if fu.Status != types.AIStatusReady {
		httpx.Error(w, http.StatusConflict, "no_drafts", "There are no follow-up drafts for this session yet.")
		return fc, false
	}
	ranked, _, err := s.rankSession(ctx, wb)
	if err != nil {
		s.fail(w, r, "followup send: leads", err)
		return fc, false
	}
	sends, err := s.store.FollowupSends(ctx, wb.ID)
	if err != nil {
		s.fail(w, r, "followup send: history", err)
		return fc, false
	}
	fc = followupContext{
		wb: wb, host: userFromContext(ctx), leads: make(map[string]rankedLead, len(ranked)),
		drafts: map[string]types.FollowupDraft{}, replay: fu.ReplayLink, sends: sends,
		mailOn: s.mail != nil && s.mail.Configured(),
	}
	for _, l := range ranked {
		fc.leads[l.Key] = l
	}
	for _, g := range fu.Groups {
		if g.Draft != nil {
			fc.drafts[g.Group] = *g.Draft
		}
	}
	var regIDs []string
	for _, k := range keys {
		if l, ok := fc.leads[k]; ok && l.row.RegistrationID != "" {
			regIDs = append(regIDs, l.row.RegistrationID)
		}
	}
	fc.waState = s.engage.FollowupWhatsApp(ctx, fc.host, wb.ID, regIDs)
	return fc, true
}

// emailPlan is whether email reaches this person now.
func (s *Server) emailPlan(ctx context.Context, fc followupContext, l rankedLead) types.FollowupChannelPlan {
	p := types.FollowupChannelPlan{Mode: types.FollowupModeEmail}
	switch {
	case strings.TrimSpace(l.Email) == "":
		p.Reason = types.FollowupReasonNoEmail
	case !fc.mailOn:
		p.Reason = types.FollowupReasonMailOff
	default:
		unsub, err := s.store.EmailUnsubscribed(ctx, fc.host.ID, l.Email)
		if err != nil {
			s.log.Warn("followup: unsubscribe check", "error", err)
		}
		if unsub || err != nil {
			p.Reason = types.FollowupReasonUnsubscribed
		} else {
			p.Available = true
		}
	}
	markSent(&p, fc.sends[l.Key][types.FollowupChannelEmail])
	return p
}

// waPlan is whether WhatsApp reaches this person now, and how.
func waPlan(fc followupContext, l rankedLead) types.FollowupChannelPlan {
	var p types.FollowupChannelPlan
	switch {
	case !fc.waState.Connected:
		p.Reason = types.FollowupReasonNotConnected
	case l.row.RegistrationID == "":
		p.Reason = types.FollowupReasonNoContact
	default:
		c := fc.waState.Contacts[l.row.RegistrationID]
		p.Mode, p.Reason, p.Available = c.Mode, c.Reason, c.Mode != ""
		if !p.Available && p.Reason == "" {
			p.Reason = types.FollowupReasonNoContact
		}
	}
	markSent(&p, fc.sends[l.Key][types.FollowupChannelWhatsApp])
	return p
}

func markSent(p *types.FollowupChannelPlan, f store.FollowupSend) {
	if f.Status == types.FollowupStatusSent {
		p.Sent, p.SentAt = true, f.UpdatedAt.UTC().Format(time.RFC3339)
	}
}

// handleFollowupPlan is POST /api/host/webinars/{slug}/followups/plan[?group=].
func (s *Server) handleFollowupPlan(w http.ResponseWriter, r *http.Request) {
	var req types.FollowupPlanRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Send the people as JSON.")
		return
	}
	keys := uniqueKeys(req.Keys)
	if len(keys) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "no_recipients", "Pick at least one person.")
		return
	}
	if len(keys) > followupPlanMax {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_many", "Pick at most 1,000 people at a time.")
		return
	}
	fc, ok := s.loadFollowupContext(w, r, req.Language, keys)
	if !ok {
		return
	}
	group := r.URL.Query().Get("group")
	out := types.FollowupPlanResponse{
		Recipients: []types.FollowupRecipient{}, EmailEnabled: fc.mailOn,
		WhatsAppConnected: fc.waState.Connected, TemplateStatus: fc.waState.TemplateStatus,
		MaxPerRequest: followupSendBatch,
	}
	for _, k := range keys {
		l, ok := fc.leads[k]
		if !ok {
			continue
		}
		g := followupDraftGroup(l, group)
		d := fc.drafts[g]
		first := firstName(l.Name)
		rec := types.FollowupRecipient{
			Key: l.Key, Name: l.Name, Group: g, Tag: l.Tag, Email: l.Email, Phone: l.Phone,
			EmailPlan: s.emailPlan(r.Context(), fc, l), WAPlan: waPlan(fc, l),
			Subject:  fillFollowup(d.EmailSubject, first, fc.replay),
			Body:     fillFollowup(d.EmailBody, first, fc.replay),
			WhatsApp: fillFollowup(d.WhatsApp, first, fc.replay),
		}
		if l.row.RegistrationID != "" {
			rec.ContactID = fc.waState.Contacts[l.row.RegistrationID].ContactID
		}
		out.Recipients = append(out.Recipients, rec)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

func uniqueKeys(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, k := range in {
		k = strings.TrimSpace(k)
		if k != "" && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// handleFollowupSend is POST /api/host/webinars/{slug}/followups/send[?lang=].
func (s *Server) handleFollowupSend(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req types.FollowupSendRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Send the messages as JSON.")
		return
	}
	if len(req.Items) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "no_recipients", "There is nothing to send.")
		return
	}
	if len(req.Items) > followupSendBatch {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_many", "Send at most 20 messages per request.")
		return
	}
	host := userFromContext(ctx)
	recent, err := s.store.FollowupSendsSince(ctx, host.ID, time.Now().Add(-time.Hour))
	if err != nil {
		s.fail(w, r, "followup send: rate", err)
		return
	}
	if recent+len(req.Items) > followupSendsPerHour {
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
			"That's the most follow-ups that can go in one hour. Try the rest in a little while.")
		return
	}
	keys := make([]string, 0, len(req.Items))
	for _, it := range req.Items {
		keys = append(keys, strings.TrimSpace(it.Key))
	}
	fc, ok := s.loadFollowupContext(w, r, r.URL.Query().Get("lang"), keys)
	if !ok {
		return
	}

	results := make([]types.FollowupSendResult, len(req.Items))
	jobs := make(chan int)
	var wg sync.WaitGroup
	// The sends outlive a client that hangs up: a claimed row must be finished.
	bg := context.WithoutCancel(ctx)
	seen := map[string]bool{}
	for i := 0; i < followupSendWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = s.sendOneFollowup(bg, fc, req.Items[i], req.Again)
			}
		}()
	}
	for i, it := range req.Items {
		dup := strings.TrimSpace(it.Key) + "\x00" + it.Channel
		if seen[dup] {
			results[i] = types.FollowupSendResult{Key: it.Key, Channel: it.Channel,
				Status: types.FollowupStatusSkipped, Reason: types.FollowupReasonAlreadySent}
			continue
		}
		seen[dup] = true
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	httpx.JSON(w, http.StatusOK, types.FollowupSendResponse{Results: results})
}

// sendOneFollowup checks, claims, sends and records one item.
func (s *Server) sendOneFollowup(ctx context.Context, fc followupContext, it types.FollowupSendItem, again bool) types.FollowupSendResult {
	key := strings.TrimSpace(it.Key)
	res := types.FollowupSendResult{Key: key, Channel: it.Channel}
	skip := func(reason string) types.FollowupSendResult {
		res.Status, res.Reason = types.FollowupStatusSkipped, reason
		return res
	}
	l, ok := fc.leads[key]
	if !ok {
		return skip(types.FollowupReasonNotInSession)
	}
	first := firstName(l.Name)
	body := fillFollowup(strings.ReplaceAll(it.Body, "\r\n", "\n"), first, fc.replay)
	if body == "" {
		return skip(types.FollowupReasonEmpty)
	}
	var plan types.FollowupChannelPlan
	switch it.Channel {
	case types.FollowupChannelEmail:
		plan = s.emailPlan(ctx, fc, l)
		subject := fillFollowup(it.Subject, first, fc.replay)
		if subject == "" {
			return skip(types.FollowupReasonEmpty)
		}
		if utf8.RuneCountInString(subject) > maxFollowupSubjectRunes || utf8.RuneCountInString(body) > maxFollowupBodyRunes {
			return skip(types.FollowupReasonTooLong)
		}
		it.Subject = subject
	case types.FollowupChannelWhatsApp:
		plan = waPlan(fc, l)
		if utf8.RuneCountInString(body) > maxFollowupWhatsAppRunes {
			return skip(types.FollowupReasonTooLong)
		}
	default:
		return skip(types.FollowupReasonBadChannel)
	}
	res.Mode = plan.Mode
	if !plan.Available {
		return skip(plan.Reason)
	}
	claim, ok, err := s.store.ClaimFollowupSend(ctx, fc.wb.ID, fc.host.ID, key, it.Channel, again)
	if err != nil {
		s.log.Error("followup send: claim", "slug", fc.wb.ID, "error", err)
		res.Status, res.Reason = types.FollowupStatusFailed, types.FollowupReasonSendFailed
		return res
	}
	if !ok {
		if plan.Sent {
			return skip(types.FollowupReasonAlreadySent)
		}
		return skip(types.FollowupReasonInProgress)
	}

	var address string
	if it.Channel == types.FollowupChannelEmail {
		address = strings.TrimSpace(l.Email)
		if err := s.sendFollowupEmail(ctx, fc, l, claim, it.Subject, body); err != nil {
			s.log.Warn("followup email: send", "slug", fc.wb.ID, "error", err)
			res.Status, res.Reason, res.Error = types.FollowupStatusFailed, types.FollowupReasonSendFailed,
				"The email could not be sent."
		} else {
			res.Status = types.FollowupStatusSent
		}
	} else {
		wr := s.engage.SendFollowupWhatsApp(ctx, fc.host, fc.wb.ID, types.FollowupWASend{
			RegistrationID: l.row.RegistrationID, FirstName: first, Topic: fc.wb.Topic, Text: body,
		})
		res.Status, res.Mode, res.Reason, res.Error, res.ContactID = wr.Status, wr.Mode, wr.Reason, wr.Error, wr.ContactID
		address = wr.Phone
		if res.Mode == "" {
			res.Mode = plan.Mode
		}
	}
	final := res.Status
	if final != types.FollowupStatusSent {
		// Skipped at the last moment counts as failed for the record: free to try again.
		final = types.FollowupStatusFailed
	}
	if err := s.store.FinishFollowupSend(ctx, claim.ID, final, res.Mode, res.Reason, address); err != nil {
		s.log.Error("followup send: record", "slug", fc.wb.ID, "error", err)
	}
	return res
}

// sendFollowupEmail sends one follow-up email and files it in the host's inbox.
func (s *Server) sendFollowupEmail(ctx context.Context, fc followupContext, l rankedLead, claim store.FollowupSend, subject, body string) error {
	unsub := s.unsubscribeLink(claim.UnsubscribeToken)
	full := body + "\n\n--\n" + followupEmailFooter(fc.wb.Topic, fc.host.Name, unsub)
	replyTo := []string{}
	if e := strings.TrimSpace(fc.host.Email); e != "" {
		replyTo = append(replyTo, e)
	}
	if inbox, err := s.store.EnsureInbox(ctx, fc.host.ID, fc.host.Name); err == nil {
		if a := notify.InboxAddress(inbox.Local); a != "" {
			replyTo = append(replyTo, a)
		}
	}
	msgID := "<followup-" + claim.ID + "@webinarliv.com>"
	to := strings.TrimSpace(l.Email)
	if err := s.mail.Send(ctx, notify.Message{
		To: to, Subject: subject, Body: full, FromName: strings.TrimSpace(fc.host.Name),
		ReplyTo: strings.Join(replyTo, ", "), MessageID: msgID, ListUnsubscribe: unsub,
	}); err != nil {
		return err
	}
	if _, err := s.store.InsertHostEmail(ctx, store.HostEmail{
		UserID: fc.host.ID, Direction: "out", From: "webinar", To: to,
		Subject: subject, Body: full, MessageID: msgID,
	}); err != nil {
		s.log.Error("followup email: sent but not filed", "slug", fc.wb.ID, "error", err)
	}
	s.engage.LogFollowupEmail(ctx, fc.host, fc.wb.ID, l.row.RegistrationID, subject)
	return nil
}

func followupEmailFooter(topic, host, unsubscribe string) string {
	who := strings.TrimSpace(host)
	if who == "" {
		who = "the host"
	}
	line := "You're getting this because you signed up for \"" + strings.TrimSpace(topic) + "\" with " + who + "."
	if unsubscribe != "" {
		line += "\nTo stop these emails: " + unsubscribe
	}
	return line
}

func (s *Server) unsubscribeLink(token string) string {
	if token == "" {
		return ""
	}
	return strings.TrimRight(s.cfg.WebBaseURL, "/") + "/api/email/unsubscribe/" + token
}

var unsubscribePage = template.Must(template.New("unsub").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Unsubscribe</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2328}
button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #888;background:#fff;cursor:pointer}</style></head>
<body>{{if .Done}}<h1>You're unsubscribed</h1><p>{{.Email}} won't get follow-up emails from {{.Host}} again.</p>
{{else if .Missing}}<h1>Link not found</h1><p>This unsubscribe link isn't valid any more.</p>
{{else}}<h1>Unsubscribe</h1><p>Stop follow-up emails from {{.Host}} to {{.Email}}?</p>
<form method="post"><button type="submit">Unsubscribe</button></form>{{end}}</body></html>`))

/* handleUnsubscribe is GET and POST /api/email/unsubscribe/{token}, public: the link in a
 * follow-up email. GET asks (a link scanner opening it must not unsubscribe anybody); POST
 * records it — the button, and a mail client's one-click List-Unsubscribe-Post. */
func (s *Server) handleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := chi.URLParam(r, "token")
	var (
		hostID, email string
		err           error
	)
	if r.Method == http.MethodPost {
		hostID, email, err = s.store.UnsubscribeByToken(ctx, token)
	} else {
		hostID, email, err = s.store.UnsubscribeTokenInfo(ctx, token)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	data := struct {
		Done, Missing bool
		Email, Host   string
	}{Done: r.Method == http.MethodPost, Email: email, Host: "this host"}
	switch {
	case errors.Is(err, store.ErrNotFound):
		data.Done, data.Missing = false, true
		w.WriteHeader(http.StatusNotFound)
	case err != nil:
		s.fail(w, r, "unsubscribe", err)
		return
	default:
		if u, err := s.store.UserByID(ctx, hostID); err == nil && strings.TrimSpace(u.Name) != "" {
			data.Host = u.Name
		}
	}
	_ = unsubscribePage.Execute(w, data)
}
