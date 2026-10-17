package engage

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* A template's default field mapping.
 *
 * Each template carries what fills its body's {{n}} unless one use says otherwise. The
 * host's saved mapping wins; with none saved, a suggestion read off the wording.
 *
 * Uses come in two kinds:
 *   - follow-the-template: a reminder, webinar message slot or sequence step saved with
 *     NO params. It follows the template's mapping, resolved when each message is queued,
 *     so editing the mapping later reaches it.
 *   - its own: a use saved with params keeps them, whatever the template's mapping
 *     becomes. Broadcasts and one-off sends are always this kind — they are prefilled
 *     from the mapping and then saved as they were sent.
 */

var placeholderRe = regexp.MustCompile(`\{\{\s*[^}]+\s*\}\}`)

// What the words just before a blank suggest it holds.
var (
	cueGreeting = regexp.MustCompile(`(hi|hello|hey|dear)\s*$`)
	cueStarts   = regexp.MustCompile(`(starts|starting|begins)\s*$`)
	cueWhen     = regexp.MustCompile(`(on|at)\s*$`)
	cueReplay   = regexp.MustCompile(`(link|here|ready|watch|recording)[:\s]*$`)
	cueJoin     = regexp.MustCompile(`(join|joining link|room)[:\s]*$`)
	cueTopic    = regexp.MustCompile(`(of|for|joining|attending|to)\s*$`)
)

// fieldWorksIn reports whether token has a value on a message of this kind.
func fieldWorksIn(token string, kind types.NotificationKind) bool {
	if !knownMergeField(token) {
		return false
	}
	only := mergeFieldOnlyKind(token)
	return only == "" || only == kind
}

/* guessParams suggests what fills each {{n}} from the words just before it — "Hi {{1}}"
 * is a first name, "starts {{2}}" how soon, "…link: {{3}}" the replay — falling back to
 * the usual order. The same reading as the browser's guessParams, so a suggestion looks
 * the same wherever it is shown. */
func guessParams(body string, variables int, kind types.NotificationKind) []types.CRMParam {
	has := func(tok string) bool { return fieldWorksIn(tok, kind) }
	order := []string{}
	for _, tok := range []string{"first_name", "topic", "replay", "when", "host"} {
		if has(tok) {
			order = append(order, tok)
		}
	}
	if len(order) == 0 {
		order = []string{"first_name"}
	}
	used := map[string]bool{}
	next := func() string {
		for _, o := range order {
			if !used[o] {
				return o
			}
		}
		return order[0]
	}
	out := make([]types.CRMParam, 0, variables)
	for _, loc := range placeholderRe.FindAllStringIndex(body, -1) {
		if len(out) >= variables {
			break
		}
		start := loc[0] - 24
		if start < 0 {
			start = 0
		}
		before := strings.ToLower(body[start:loc[0]])
		tok := ""
		switch {
		case cueGreeting.MatchString(before):
			tok = "first_name"
		case cueStarts.MatchString(before) && has("starts_in"):
			tok = "starts_in"
		case cueWhen.MatchString(before) && has("when"):
			tok = "when"
		case cueReplay.MatchString(before) && has("replay"):
			tok = "replay"
		case cueJoin.MatchString(before) && has("join_link"):
			tok = "join_link"
		case cueTopic.MatchString(before) && has("topic"):
			tok = "topic"
		}
		if tok == "" || used[tok] {
			tok = next()
		}
		used[tok] = true
		out = append(out, types.CRMParam{Field: tok})
	}
	for len(out) < variables {
		out = append(out, types.CRMParam{Field: order[len(out)%len(order)]})
	}
	return out
}

// templateDefaults is the template's mapping for a message of this kind: the saved one,
// with any field that has no value here replaced by the suggestion for that blank.
func templateDefaults(t types.CRMTemplate, kind types.NotificationKind) []types.CRMParam {
	guess := guessParams(t.Body, t.Variables, kind)
	if !t.DefaultParamsSaved || len(t.DefaultParams) != t.Variables {
		return guess
	}
	out := make([]types.CRMParam, len(t.DefaultParams))
	for i, p := range t.DefaultParams {
		if f := strings.TrimSpace(p.Field); f != "" && !fieldWorksIn(f, kind) {
			out[i] = guess[i]
			continue
		}
		out[i] = p
	}
	return out
}

// withDefaultParams fills DefaultParams on templates sent to the browser. A saved
// mapping is passed through as saved; the browser decides per screen what fits.
func withDefaultParams(ts []types.CRMTemplate) []types.CRMTemplate {
	for i := range ts {
		if !ts[i].DefaultParamsSaved {
			ts[i].DefaultParams = guessParams(ts[i].Body, ts[i].Variables, "")
		}
		if ts[i].DefaultParams == nil {
			ts[i].DefaultParams = []types.CRMParam{}
		}
	}
	return ts
}

// effectiveParams is what fills a use's {{n}}: its own params, or — when it saved none
// and the template has variables — the template's defaults for this kind of message.
func (s *Module) effectiveParams(ctx context.Context, hostID, name, language string,
	params []types.CRMParam, kind types.NotificationKind) []types.CRMParam {
	if len(params) > 0 {
		return params
	}
	tmpl, err := s.store.Template(ctx, hostID, name, language)
	if err != nil || tmpl.Variables == 0 {
		return params
	}
	return templateDefaults(tmpl, kind)
}

// tokenParams is a reminder's or slot's tokens as params.
func tokenParams(tokens []string) []types.CRMParam {
	out := make([]types.CRMParam, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, types.CRMParam{Field: t})
	}
	return out
}

// resolveParamValues fills params for one recipient: a field's value, or the words.
func resolveParamValues(params []types.CRMParam, contact types.CRMContact, wb types.Webinar,
	hostName, replayURL string, offsetMin int, links mergeLinks) []string {
	out := make([]string, 0, len(params))
	for _, p := range params {
		if token := strings.TrimSpace(p.Field); token != "" {
			out = append(out, mergeValue(token, contact, wb, hostName, replayURL, offsetMin, links))
			continue
		}
		out = append(out, strings.Join(strings.Fields(p.Text), " "))
	}
	return out
}

/* mappingProblem checks a template-level mapping: one entry per variable, each a known
 * field or some words. Fields that only have a value on some messages (how soon it
 * starts, the replay link) are allowed: each use checks what fits it. */
func mappingProblem(params []types.CRMParam, variables int) string {
	if len(params) != variables {
		return "That template has " + strconv.Itoa(variables) + " blank(s); map each one."
	}
	for i, p := range params {
		at := strconv.Itoa(i + 1)
		if f := strings.TrimSpace(p.Field); f != "" {
			if !knownMergeField(f) {
				return "There is nothing called " + f + " to fill {{" + at + "}} with."
			}
			continue
		}
		if strings.Join(strings.Fields(p.Text), " ") == "" {
			return "{{" + at + "}} is empty — pick a field or type the words."
		}
	}
	return ""
}

// handleSetCRMTemplateMapping is PUT /api/host/crm/templates/mapping.
func (s *Module) handleSetCRMTemplateMapping(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body types.CRMTemplateMappingRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Could not read that request.")
		return
	}
	tmpl, err := s.store.Template(r.Context(), user.ID, body.Name, body.Language)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such template.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm template mapping: load", err)
		return
	}
	if msg := mappingProblem(body.Params, tmpl.Variables); msg != "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_mapping", msg)
		return
	}
	if err := s.store.SetTemplateParams(r.Context(), user.ID, tmpl.Name, tmpl.Language, body.Params); err != nil {
		s.fail(w, r, "crm template mapping: save", err)
		return
	}
	saved, err := s.store.TemplateWithFile(r.Context(), user.ID, tmpl.Name, tmpl.Language)
	if err != nil {
		s.fail(w, r, "crm template mapping: reload", err)
		return
	}
	s.log.Info("crm template mapping saved", "host", user.ID, "template", tmpl.Name, "language", tmpl.Language)
	httpx.JSON(w, http.StatusOK, s.templateJSON(saved))
}

// paramFields is the field tokens among params, for code that only cares which fields.
func paramFields(params []types.CRMParam) []string {
	out := []string{}
	for _, p := range params {
		if f := strings.TrimSpace(p.Field); f != "" {
			out = append(out, f)
		}
	}
	return out
}

/* wordingParams is the mapping a template is written with: what the host chose for each
 * blank, with the suggestion for any they left open. None when the host chose nothing,
 * so a template written without the field picker keeps being suggested as before. */
func wordingParams(body string, blanks int, chosen []types.CRMParam) []types.CRMParam {
	if blanks == 0 || len(chosen) == 0 {
		return nil
	}
	guess := guessParams(body, blanks, "")
	out := make([]types.CRMParam, blanks)
	for i := range out {
		out[i] = guess[i]
		if i >= len(chosen) {
			continue
		}
		if f := strings.TrimSpace(chosen[i].Field); f != "" && knownMergeField(f) {
			out[i] = types.CRMParam{Field: f}
		} else if t := strings.Join(strings.Fields(chosen[i].Text), " "); t != "" && f == "" {
			out[i] = types.CRMParam{Text: t}
		}
	}
	return out
}

// paramExample is what Meta's reviewer sees in a blank: the field's example, or the words.
func paramExample(p types.CRMParam) string {
	if f := strings.TrimSpace(p.Field); f != "" {
		for _, m := range mergeFields {
			if m.Token == f {
				return m.Example
			}
		}
		return ""
	}
	return strings.Join(strings.Fields(p.Text), " ")
}
