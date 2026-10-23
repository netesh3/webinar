package api

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The Cost by host report's ignore list: test and staff accounts whose usage is not a
 * customer's. GET/POST /api/admin/costs/ignore, DELETE /api/admin/costs/ignore/{id}.
 *
 * A rule is an exact email, an email pattern (* matches any run of characters, so
 * *@test.dev, *+test@* and *@example.com), or one host by id. Rules are matched when a
 * report is served, not when it is built, so the cached usage (costCacheTTL) never holds a
 * stale list: adding a rule takes effect on the next request. The report marks each matching
 * host (AdminCostHost.IgnoredBy) and sums their session-hours (IgnoredSessionHours); the
 * browser decides what hiding them means (web/lib/host-costs.ts). */

// commonTestPatterns are the addresses suggested for the list when some account has one.
var commonTestPatterns = []string{
	"*@test.dev", "*@example.com", "*@example.org", "*@test.com", "*+test@*", "*@mailinator.com",
}

// globMatch is s against a pattern where * matches any run (none included); both lower-case.
func globMatch(pattern, s string) bool {
	p, i, star, mark := 0, 0, -1, 0
	for i < len(s) {
		switch {
		case p < len(pattern) && pattern[p] == '*':
			star, mark = p, i
			p++
		case p < len(pattern) && pattern[p] == s[i]:
			p++
			i++
		case star >= 0:
			p = star + 1
			mark++
			i = mark
		default:
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}

// costIgnoreMatches says whether one rule catches a host.
func costIgnoreMatches(r store.CostIgnoreRule, hostID, email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	switch r.Kind {
	case types.CostIgnoreHost:
		return hostID != "" && r.Value == hostID
	case types.CostIgnoreEmail:
		return email != "" && r.Value == email
	case types.CostIgnorePattern:
		return email != "" && globMatch(r.Value, email)
	}
	return false
}

// costIgnoredBy is the id of the first rule that catches a host, or "".
func costIgnoredBy(rules []store.CostIgnoreRule, hostID, email string) string {
	for _, r := range rules {
		if costIgnoreMatches(r, hostID, email) {
			return r.ID
		}
	}
	return ""
}

/* markIgnored matches every host of a report against the list: which rule ignores each, and
 * the ignored hosts' session-hours on every provider (the platform share's denominator is
 * all providers', whatever the provider filter). */
func markIgnored(rep *costReport, rules []store.CostIgnoreRule) (map[string]string, float64) {
	by := map[string]string{}
	var hours float64
	if len(rules) == 0 {
		return by, 0
	}
	for id, h := range rep.hosts {
		rule := costIgnoredBy(rules, id, h.Email)
		if rule == "" {
			continue
		}
		by[id] = rule
		for _, u := range h.ByProvider {
			hours += u.SessionHours
		}
	}
	return by, hours
}

/* normaliseCostIgnore checks a rule and puts it in the form it is stored and matched in:
 * emails and patterns lower-case. A host rule's id is checked against users by the caller. */
func normaliseCostIgnore(in types.CostIgnoreRuleInput) (types.CostIgnoreRuleInput, error) {
	in.Value = strings.TrimSpace(in.Value)
	in.Note = strings.TrimSpace(in.Note)
	if in.Value == "" {
		return in, errors.New("Enter what to ignore.")
	}
	if len(in.Value) > 320 {
		return in, errors.New("That is too long.")
	}
	if len([]rune(in.Note)) > 200 {
		return in, errors.New("Keep the note under 200 characters.")
	}
	if strings.IndexFunc(in.Value, unicode.IsSpace) >= 0 {
		return in, errors.New("No spaces, please.")
	}
	switch in.Kind {
	case types.CostIgnoreEmail:
		in.Value = strings.ToLower(in.Value)
		at := strings.Index(in.Value, "@")
		if strings.Contains(in.Value, "*") {
			return in, errors.New("An email has no *: choose Pattern for that.")
		}
		if at <= 0 || at == len(in.Value)-1 || strings.Count(in.Value, "@") != 1 {
			return in, errors.New("That is not an email address.")
		}
	case types.CostIgnorePattern:
		in.Value = strings.ToLower(in.Value)
		if !strings.Contains(in.Value, "*") {
			return in, errors.New("A pattern needs a *, like *@test.dev. For one address choose Email.")
		}
		if strings.Trim(in.Value, "*") == "" {
			return in, errors.New("That pattern would ignore everybody.")
		}
	case types.CostIgnoreHost:
		in.Value = strings.ToLower(in.Value)
	default:
		return in, errors.New("kind is email, pattern or host.")
	}
	return in, nil
}

func costIgnoreRuleOut(r store.CostIgnoreRule) types.CostIgnoreRule {
	label := r.Value
	if r.Kind == types.CostIgnoreHost {
		label = r.HostEmail
		if label == "" {
			label = "(deleted account)"
		}
	}
	return types.CostIgnoreRule{
		ID: r.ID, Kind: r.Kind, Value: r.Value, Label: label, Note: r.Note,
		CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// costIgnoreSuggestions are rules worth adding: common test patterns some account matches,
// those accounts one by one, and admins' own accounts. Nothing already ignored.
func costIgnoreSuggestions(rules []store.CostIgnoreRule, cands []store.CostIgnoreCandidate) []types.CostIgnoreSuggestion {
	out := []types.CostIgnoreSuggestion{}
	var open []store.CostIgnoreCandidate
	for _, c := range cands {
		if costIgnoredBy(rules, c.ID, c.Email) == "" {
			open = append(open, c)
		}
	}
	for _, p := range commonTestPatterns {
		n := 0
		for _, c := range open {
			if globMatch(p, strings.ToLower(c.Email)) {
				n++
			}
		}
		if n > 0 {
			out = append(out, types.CostIgnoreSuggestion{
				Kind: types.CostIgnorePattern, Value: p, Label: p, Reason: "Common test address", Matches: n,
			})
		}
	}
	hosts := 0
	for _, c := range open {
		reason := ""
		if c.IsAdmin {
			reason = "Admin account"
		}
		for _, p := range commonTestPatterns {
			if reason == "" && globMatch(p, strings.ToLower(c.Email)) {
				reason = "Test address"
			}
		}
		if reason == "" || hosts >= 30 {
			continue
		}
		hosts++
		label := c.Email
		if c.Name != "" {
			label = c.Name + " · " + c.Email
		}
		out = append(out, types.CostIgnoreSuggestion{
			Kind: types.CostIgnoreHost, Value: c.ID, Label: label, Reason: reason, Matches: 1,
		})
	}
	return out
}

// handleCostIgnoreList is GET /api/admin/costs/ignore: the list, and what it could take.
func (s *Server) handleCostIgnoreList(w http.ResponseWriter, r *http.Request) {
	rules, err := s.store.CostIgnoreRules(r.Context())
	if err != nil {
		s.fail(w, r, "cost ignore list", err)
		return
	}
	cands, err := s.store.CostIgnoreCandidates(r.Context())
	if err != nil {
		s.fail(w, r, "cost ignore candidates", err)
		return
	}
	out := types.CostIgnoreList{Rules: []types.CostIgnoreRule{}, Suggestions: costIgnoreSuggestions(rules, cands)}
	for _, x := range rules {
		out.Rules = append(out.Rules, costIgnoreRuleOut(x))
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleCostIgnoreAdd is POST /api/admin/costs/ignore.
func (s *Server) handleCostIgnoreAdd(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	var body types.CostIgnoreRuleInput
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	in, err := normaliseCostIgnore(body)
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_rule", err.Error())
		return
	}
	if in.Kind == types.CostIgnoreHost {
		ok, err := s.store.CostHostExists(r.Context(), in.Value)
		if err != nil {
			s.fail(w, r, "cost ignore host", err)
			return
		}
		if !ok {
			httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
			return
		}
	}
	rule, err := s.store.AddCostIgnoreRule(r.Context(), in.Kind, in.Value, in.Note, admin.ID)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "already_ignored", "That is already on the ignore list.")
		return
	}
	if err != nil {
		s.fail(w, r, "cost ignore add", err)
		return
	}
	s.log.Info("cost ignore rule added", "admin", admin.ID, "kind", rule.Kind, "value", rule.Value)
	httpx.JSON(w, http.StatusCreated, costIgnoreRuleOut(rule))
}

// handleCostIgnoreDelete is DELETE /api/admin/costs/ignore/{id}.
func (s *Server) handleCostIgnoreDelete(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	id := chi.URLParam(r, "id")
	err := s.store.DeleteCostIgnoreRule(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such rule.")
		return
	}
	if err != nil {
		s.fail(w, r, "cost ignore delete", err)
		return
	}
	s.log.Info("cost ignore rule removed", "admin", admin.ID, "rule", id)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}
