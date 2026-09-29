package engage

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* The starter templates: a set a coach can submit to Meta from here in one go, instead
 * of writing each in WhatsApp Manager. They use this app's parts — the cover as an image
 * header, the person's own link on a button, and quick replies this app acts on:
 * "Can't make it" (tagged, sent the replay later) and "Tell me more" (a hot lead).
 *
 * Link buttons point under WEB_BASE_URL, so the variable part is the rest of the person's
 * link; a deployment that moves domain has to submit them again. */

const (
	// QuickCantMakeIt and QuickTellMeMore are the starter set's quick-reply labels, and
	// what the webhook matches on (Meta sends the label back as the payload).
	QuickCantMakeIt = "Can't make it"
	QuickTellMeMore = "Tell me more"
	tagCantMakeIt   = "Can't make it"
)

func (s *Module) starterTemplates() []types.CRMStarterTemplate {
	base := s.publicBase()
	link := func(text string) types.CRMTemplateButton {
		return types.CRMTemplateButton{Type: "URL", Text: text, URL: base + "/{{1}}", Dynamic: true}
	}
	quick := func(text string) types.CRMTemplateButton {
		return types.CRMTemplateButton{Type: "QUICK_REPLY", Text: text}
	}
	return []types.CRMStarterTemplate{
		{
			Name: "wl_confirmation", Category: "UTILITY", Use: "Confirmation",
			Body:     "Hi {{1}}, you're registered for {{2}} on {{3}}. We'll remind you before it starts.",
			Params:   []string{"first_name", "topic", "when"},
			Examples: []string{"Priya", "Morning Routines That Stick", "Fri 25 Sept, 6:30 PM IST"},
			Buttons:  []types.CRMTemplateButton{link("Join"), quick(QuickCantMakeIt)},
		},
		{
			Name: "wl_reminder", Category: "UTILITY", Use: "Reminder",
			Body:     "Hi {{1}}, {{2}} starts {{3}}. Tap Join to come straight in.",
			Params:   []string{"first_name", "topic", "starts_in"},
			Examples: []string{"Priya", "Morning Routines That Stick", "in 1 hour"},
			Buttons:  []types.CRMTemplateButton{link("Join"), quick(QuickCantMakeIt)},
		},
		{
			Name: "wl_replay", Category: "UTILITY", Use: "Replay",
			Body:     "Hi {{1}}, the recording of {{2}} is ready. Watch it any time this week.",
			Params:   []string{"first_name", "topic"},
			Examples: []string{"Priya", "Morning Routines That Stick"},
			Buttons:  []types.CRMTemplateButton{link("Watch replay"), quick(QuickTellMeMore)},
		},
		{
			Name: "wl_thanks_offer", Category: "MARKETING", Use: "Follow up",
			Body:     "Hi {{1}}, thank you for joining {{2}} 🙏 If you'd like to go further, I run a small program — tap below and I'll send the details.",
			Params:   []string{"first_name", "topic"},
			Examples: []string{"Priya", "Morning Routines That Stick"},
			Buttons:  []types.CRMTemplateButton{quick(QuickTellMeMore)},
		},
	}
}

// handleCRMStarterTemplates lists the starter set, marked with those already created.
func (s *Module) handleCRMStarterTemplates(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	out := s.starterTemplates()
	have, _, err := s.store.Templates(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "crm starter templates", err)
		return
	}
	for i := range out {
		for _, t := range have {
			if t.Name == out[i].Name {
				out[i].Status = t.Status
			}
		}
	}
	httpx.JSON(w, http.StatusOK, types.CRMStarterTemplatesResponse{Templates: out})
}

/* handleCreateCRMStarterTemplates submits the starter templates the host does not have
 * yet, then re-reads the list from Meta so their status shows. One failing (a name taken
 * in WhatsApp Manager) does not stop the rest. */
func (s *Module) handleCreateCRMStarterTemplates(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset", "WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppWABAID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account first.")
		return
	}
	ctx := r.Context()
	have, _, err := s.store.Templates(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "crm starter templates", err)
		return
	}
	exists := map[string]bool{}
	for _, t := range have {
		exists[t.Name] = true
	}
	out := types.CRMStarterTemplatesResponse{Templates: s.starterTemplates()}
	for i, t := range out.Templates {
		if exists[t.Name] {
			continue
		}
		status, err := s.whatsapp.CreateTemplate(ctx, user.WhatsAppToken, user.WhatsAppWABAID, newTemplate(t, s.publicBase()))
		if err != nil {
			out.Templates[i].Error = err.Error()
			s.log.Warn("crm starter template", "host", user.ID, "name", t.Name, "error", err)
			continue
		}
		out.Templates[i].Status = status
	}
	if err := s.syncTemplates(ctx, user); err != nil {
		s.log.Warn("crm starter templates: resync", "host", user.ID, "error", err)
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* handleCreateCRMWording submits wording the host typed, for Meta to approve.
 * An approved starter is chosen in the dialog instead; this is the blank page under it. */
func (s *Module) handleCreateCRMWording(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset", "WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppWABAID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account first.")
		return
	}
	var req struct {
		Body     string `json:"body"`
		Category string `json:"category"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" || utf8.RuneCountInString(body) > 1024 {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_body", "Write the message, up to 1024 characters.")
		return
	}
	category := strings.ToUpper(strings.TrimSpace(req.Category))
	if category == "" {
		category = "UTILITY"
	}
	if category != "UTILITY" && category != "MARKETING" {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_category", "Choose Utility or Marketing.")
		return
	}
	examples, err := bodyExamples(body)
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_body", err.Error())
		return
	}
	name, err := customTemplateName()
	if err != nil {
		s.fail(w, r, "crm wording name", err)
		return
	}
	status, err := s.whatsapp.CreateTemplate(r.Context(), user.WhatsAppToken, user.WhatsAppWABAID, wa.NewTemplate{
		Name: name, Language: "en", Category: category, Body: body,
		Examples: examples, Footer: "Reply STOP to opt out",
	})
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "template_refused", err.Error())
		return
	}
	if status == "" {
		status = "PENDING"
	}
	if err := s.syncTemplates(r.Context(), user); err != nil {
		s.log.Warn("crm wording: resync", "host", user.ID, "error", err)
	}
	httpx.JSON(w, http.StatusOK, struct {
		Name     string `json:"name"`
		Language string `json:"language"`
		Status   string `json:"status"`
		Category string `json:"category"`
		Body     string `json:"body"`
	}{Name: name, Language: "en", Status: status, Category: category, Body: body})
}

var (
	anyPlaceholder      = regexp.MustCompile(`\{\{[^}]*\}\}`)
	numberedPlaceholder = regexp.MustCompile(`\{\{\s*(\d+)\s*\}\}`)
)

/* bodyExamples checks {{1}}, {{2}}… and returns one sample value per blank.
 * Meta refuses a template whose blanks skip a number or aren't numbered. */
func bodyExamples(body string) ([]string, error) {
	if len(anyPlaceholder.FindAllString(body, -1)) != len(numberedPlaceholder.FindAllString(body, -1)) {
		return nil, fmt.Errorf("use {{1}}, {{2}} for the parts that change, like a name or the webinar")
	}
	matches := numberedPlaceholder.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return nil, nil
	}
	seen := map[int]bool{}
	max := 0
	for _, m := range matches {
		n, _ := strconv.Atoi(m[1])
		if n < 1 {
			return nil, fmt.Errorf("number the blanks {{1}}, {{2}}, and so on")
		}
		seen[n] = true
		if n > max {
			max = n
		}
	}
	if len(seen) != max || max > 10 {
		return nil, fmt.Errorf("number the blanks {{1}}, {{2}}, in order, with none skipped")
	}
	samples := []string{"Priya", "Morning Routines That Stick", "Friday at 6:30 PM", "the host", "the link"}
	out := make([]string, max)
	for i := range out {
		if i < len(samples) {
			out[i] = samples[i]
			continue
		}
		out[i] = "example"
	}
	return out, nil
}

func customTemplateName() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("wl_own_%x", b), nil
}

func newTemplate(t types.CRMStarterTemplate, base string) wa.NewTemplate {
	nt := wa.NewTemplate{Name: t.Name, Language: "en", Category: t.Category, Body: t.Body,
		Examples: t.Examples, Footer: "Reply STOP to opt out"}
	for _, b := range t.Buttons {
		nb := wa.NewButton{Type: b.Type, Text: b.Text}
		if b.Type == "URL" {
			nb.URL = b.URL
			nb.Example = base + "/webinars/morning-routines/room?k=example"
		}
		nt.Buttons = append(nt.Buttons, nb)
	}
	return nt
}

/* onQuickReply acts on a tapped starter-template button. "Can't make it" tags them, so
 * the replay (sent to everyone registered when it is published) is the thing they get;
 * "Tell me more" makes them a hot lead. Failures are logged; the message is in the thread. */
func (s *Module) onQuickReply(ctx context.Context, host store.User, contactID, kind, text string) {
	if kind != "button" {
		return
	}
	var tagName string
	switch strings.TrimSpace(text) {
	case QuickCantMakeIt:
		tagName = tagCantMakeIt
	case QuickTellMeMore:
		tagName = hotLeadTagName
		if rule, err := s.store.HotLeadRule(ctx, host.ID); err == nil && rule.TagName != "" {
			tagName = rule.TagName
		}
	default:
		return
	}
	if !host.HasFeature(types.FeatureWhatsAppCRM) {
		return
	}
	tag, err := s.store.CreateTag(ctx, host.ID, tagName)
	if err != nil {
		s.log.Warn("crm: quick reply tag", "host", host.ID, "tag", tagName, "error", err)
		return
	}
	if err := s.applyTag(ctx, host, contactID, tag.ID); err != nil {
		s.log.Warn("crm: quick reply apply", "host", host.ID, "contact", contactID, "error", err)
	}
}
