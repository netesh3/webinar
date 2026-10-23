package api

import (
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func TestGlobMatch(t *testing.T) {
	for _, c := range []struct {
		pattern, s string
		want       bool
	}{
		{"*@test.dev", "a@test.dev", true},
		{"*@test.dev", "a@test.dev.in", false},
		{"*@test.dev", "a@nottest.dev", false},
		{"*@example.com", "@example.com", true},
		{"*+test@*", "coach+test@gmail.com", true},
		{"*+test@*", "coach+tests@gmail.com", false},
		{"*+test*@*", "coach+test2@gmail.com", true},
		{"qa-*@acme.dev", "qa-1@acme.dev", true},
		{"qa-*@acme.dev", "xqa-1@acme.dev", false},
		{"*", "", true},
		{"a*b*c", "aXbYbZc", true},
		{"a*b*c", "aXbYbZ", false},
	} {
		if got := globMatch(c.pattern, c.s); got != c.want {
			t.Errorf("globMatch(%q, %q) = %v, want %v", c.pattern, c.s, got, c.want)
		}
	}
}

func TestCostIgnoredBy(t *testing.T) {
	rules := []store.CostIgnoreRule{
		{ID: "r1", Kind: types.CostIgnoreEmail, Value: "boss@acme.dev"},
		{ID: "r2", Kind: types.CostIgnorePattern, Value: "*@test.dev"},
		{ID: "r3", Kind: types.CostIgnoreHost, Value: "host-9"},
	}
	for _, c := range []struct{ id, email, want string }{
		{"h1", "Boss@ACME.dev", "r1"}, // emails match whatever their case
		{"h2", "x@test.dev", "r2"},
		{"host-9", "real@customer.in", "r3"},
		{"h4", "real@customer.in", ""},
		{"h5", "", ""},
	} {
		if got := costIgnoredBy(rules, c.id, c.email); got != c.want {
			t.Errorf("costIgnoredBy(%q, %q) = %q, want %q", c.id, c.email, got, c.want)
		}
	}
}

func TestNormaliseCostIgnore(t *testing.T) {
	ok := func(kind, value, want string) {
		t.Helper()
		got, err := normaliseCostIgnore(types.CostIgnoreRuleInput{Kind: kind, Value: value})
		if err != nil || got.Value != want {
			t.Errorf("%s %q: got %q, %v; want %q", kind, value, got.Value, err, want)
		}
	}
	bad := func(kind, value string) {
		t.Helper()
		if _, err := normaliseCostIgnore(types.CostIgnoreRuleInput{Kind: kind, Value: value}); err == nil {
			t.Errorf("%s %q: accepted", kind, value)
		}
	}
	ok("email", "  QA@Acme.dev ", "qa@acme.dev")
	ok("pattern", "*@Test.dev", "*@test.dev")
	bad("email", "*@test.dev")
	bad("email", "nobody")
	bad("email", "a@b@c")
	bad("pattern", "qa@acme.dev")
	bad("pattern", "**")
	bad("pattern", "* @x")
	bad("domain", "x")
	bad("email", "")
}

func TestCostIgnoreSuggestions(t *testing.T) {
	cands := []store.CostIgnoreCandidate{
		{ID: "1", Email: "a@test.dev"},
		{ID: "2", Email: "b@test.dev"},
		{ID: "3", Email: "admin@acme.dev", Name: "Admin", IsAdmin: true},
		{ID: "4", Email: "real@customer.in"},
		{ID: "5", Email: "c@example.com"},
	}
	rules := []store.CostIgnoreRule{{ID: "r", Kind: types.CostIgnoreEmail, Value: "c@example.com"}}
	got := map[string]types.CostIgnoreSuggestion{}
	for _, s := range costIgnoreSuggestions(rules, cands) {
		got[s.Kind+":"+s.Value] = s
	}
	if s := got["pattern:*@test.dev"]; s.Matches != 2 {
		t.Errorf("*@test.dev suggestion = %+v", s)
	}
	if _, ok := got["pattern:*@example.com"]; ok {
		t.Error("suggested a pattern whose only account is already ignored")
	}
	if s := got["host:3"]; s.Reason != "Admin account" || s.Label != "Admin · admin@acme.dev" {
		t.Errorf("admin suggestion = %+v", s)
	}
	if s := got["host:1"]; s.Reason != "Test address" {
		t.Errorf("test host suggestion = %+v", s)
	}
	if _, ok := got["host:4"]; ok {
		t.Error("suggested a real customer")
	}
	if len(got) != 4 {
		t.Errorf("suggestions = %v", got)
	}
}
