package api_test

import (
	"encoding/csv"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Registration questions end to end: the host saves a "Choose one" and a checkbox, an
 * attendee answers them, and the host reads the answers back in the roster and the export.
 *
 * Each step used to fail quietly — a "Choose one" saved with no options, any string
 * accepted as its answer, and the answers stored but shown to the host nowhere. */
func TestRegistrationQuestionsEndToEnd(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	// A "Choose one" needs two options to be a choice.
	res, raw := h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "One option", StartsAt: "2030-01-01T10:00:00Z", Duration: 60, TimeZone: "UTC",
		Kind: types.KindLive, Status: types.StatusScheduled, RegistrationRequired: true,
		CustomQuestions: []types.CustomQuestion{{Label: "Role", Type: "select", Options: []string{"Engineer", " "}}},
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("one-option choose-one: status %d body %s, want 422", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if !strings.Contains(apiErr.Fields["customQuestions"], "Role") {
		t.Errorf("error does not name the question: %v", apiErr.Fields)
	}

	wb := h.newWebinar("Question types", func(in *types.WebinarInput) {
		in.CustomQuestions = []types.CustomQuestion{
			{Label: "Role", Type: "select", Required: true, Options: []string{" Engineer ", "Manager, people", ""}},
			{Label: "I agree to the terms", Type: "checkbox", Required: true, Options: []string{"stale"}},
			{Label: "Send me the slides", Type: "checkbox"},
		}
	})
	if len(wb.CustomQuestions) != 3 {
		t.Fatalf("questions not saved: %+v", wb.CustomQuestions)
	}
	role, terms := wb.CustomQuestions[0], wb.CustomQuestions[1]
	if role.Type != "select" || strings.Join(role.Options, "|") != "Engineer|Manager, people" {
		t.Errorf("choose-one saved as %+v, want trimmed options with the comma kept", role)
	}
	if terms.Type != "checkbox" || len(terms.Options) != 0 {
		t.Errorf("checkbox saved as %+v, want no options", terms)
	}

	register := func(answers map[string]string) (*http.Response, []byte) {
		return h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
			FirstName: "Asha", Email: "asha@test.dev", Consent: true, Answers: answers,
		})
	}

	for name, answers := range map[string]map[string]string{
		"not an option":       {role.ID: "CEO", terms.ID: "yes"},
		"required unticked":   {role.ID: "Engineer"},
		"checkbox not yes/no": {role.ID: "Engineer", terms.ID: "sure"},
	} {
		res, raw := register(answers)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d body %s, want 422", name, res.StatusCode, raw)
		}
	}

	res, raw = register(map[string]string{role.ID: "Manager, people", terms.ID: "yes", "injected": "x"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("valid registration: status %d body %s", res.StatusCode, raw)
	}

	// The host sees the answers in the roster...
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("registrants: status %d body %s", res.StatusCode, raw)
	}
	var page types.RegistrantPage
	h.decode(raw, &page)
	rows := page.Items
	if len(rows) != 1 {
		t.Fatalf("registrants = %d, want 1", len(rows))
	}
	got := rows[0].Answers
	if got[role.ID] != "Manager, people" || got[terms.ID] != "yes" || got["injected"] != "" {
		t.Errorf("roster answers = %v", got)
	}

	// ...and in the export, one column per question after the existing ones.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/registrants.csv", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("csv: status %d body %s", res.StatusCode, raw)
	}
	records, err := csv.NewReader(strings.NewReader(string(raw))).ReadAll()
	if err != nil || len(records) != 2 {
		t.Fatalf("csv: %v, %d records", err, len(records))
	}
	header, row := records[0], records[1]
	if header[0] != "name" || header[len(header)-3] != "Role" || header[len(header)-1] != "Send me the slides" {
		t.Errorf("csv header = %v", header)
	}
	if row[len(row)-3] != "Manager, people" || row[len(row)-2] != "yes" || row[len(row)-1] != "" {
		t.Errorf("csv row = %v", row)
	}
}
