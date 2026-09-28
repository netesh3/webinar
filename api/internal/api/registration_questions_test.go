package api

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestNormalizeQuestions(t *testing.T) {
	qs, msg := normalizeQuestions([]types.CustomQuestion{
		{Label: "  Role ", Type: "select", Options: []string{" Engineer ", "", "Manager, people"}},
		{Label: "Send slides", Type: "checkbox", Options: []string{"left over"}},
		{Label: "Anything else?", Type: "essay"},
	})
	if msg != "" {
		t.Fatalf("valid questions refused: %s", msg)
	}
	if qs[0].Label != "Role" || len(qs[0].Options) != 2 || qs[0].Options[0] != "Engineer" || qs[0].Options[1] != "Manager, people" {
		t.Errorf("choose-one not trimmed, or an option with a comma was split: %+v", qs[0])
	}
	if qs[1].Options != nil {
		t.Errorf("a checkbox kept options from an earlier type: %+v", qs[1])
	}
	if qs[2].Type != "short" {
		t.Errorf("unknown type = %q, want short", qs[2].Type)
	}

	for name, opts := range map[string][]string{
		"no options":  nil,
		"one option":  {"Only"},
		"blank ones":  {" ", "Only", ""},
		"a duplicate": {"Yes", "yes"},
	} {
		if _, msg := normalizeQuestions([]types.CustomQuestion{{Label: "Pick", Type: "select", Options: opts}}); msg == "" {
			t.Errorf("%s: a choose-one question was accepted", name)
		} else if !strings.Contains(msg, "“Pick”") {
			t.Errorf("%s: message does not name the question: %q", name, msg)
		}
	}
}

func TestAnswerProblem(t *testing.T) {
	choose := types.CustomQuestion{ID: "role", Type: "select", Required: true, Options: []string{"Engineer", "Manager"}}
	tick := types.CustomQuestion{ID: "terms", Type: "checkbox", Required: true}
	optionalTick := types.CustomQuestion{ID: "slides", Type: "checkbox"}

	cases := []struct {
		name   string
		q      types.CustomQuestion
		answer string
		ok     bool
	}{
		{"choose one: a listed option", choose, "Manager", true},
		{"choose one: not an option", choose, "CEO", false},
		{"choose one: required and blank", choose, "", false},
		{"checkbox: ticked", tick, "yes", true},
		{"checkbox: required and unticked", tick, "", false},
		{"checkbox: anything but yes", tick, "true", false},
		{"checkbox: optional and unticked", optionalTick, "", true},
		{"short: too long", types.CustomQuestion{Type: "short"}, strings.Repeat("a", maxAnswerChars+1), false},
	}
	for _, c := range cases {
		if got := answerProblem(c.q, c.answer) == ""; got != c.ok {
			t.Errorf("%s: ok = %v, want %v (%q)", c.name, got, c.ok, answerProblem(c.q, c.answer))
		}
	}
}

func TestRegistrationAnswersKeepsOnlyAskedQuestions(t *testing.T) {
	got := registrationAnswers(
		map[string]string{"role": " Engineer ", "slides": "", "injected": "x"},
		[]types.CustomQuestion{{ID: "role"}, {ID: "slides"}},
	)
	if len(got) != 1 || got["role"] != "Engineer" {
		t.Errorf("answers = %v, want only the trimmed answer to an asked question", got)
	}
}
