package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/netkumar/webcast/api/types"
)

/* Post-event surveys, through the real routes.
 *
 * What matters: an attendee is only offered a survey that is live (or armed for the end
 * while the room is live), answers exactly once however often the request is retried, a
 * closed survey takes no answers, the host's results add up, and answers — once given —
 * pin the questions they answered. */

func (h *harness) guestPost(path string, body any) (*http.Response, []byte) {
	h.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		h.t.Fatal(err)
	}
	res, err := (&http.Client{}).Post(h.srv.URL+path, "application/json", bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res, out
}

func (h *harness) audienceSurvey(slug, joinKey string) types.AudienceSurvey {
	h.t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + slug + "/survey?joinKey=" + joinKey)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("audience survey: status %d body %s", res.StatusCode, raw)
	}
	var out types.AudienceSurvey
	h.decode(raw, &out)
	return out
}

func (h *harness) putSurvey(slug string, in types.SurveyInput) (*http.Response, types.Survey, []byte) {
	h.t.Helper()
	res, raw := h.do(http.MethodPut, "/api/host/webinars/"+slug+"/survey", in)
	var sv types.Survey
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &sv)
	}
	return res, sv, raw
}

func (h *harness) mustPutSurvey(slug string, in types.SurveyInput) types.Survey {
	h.t.Helper()
	res, sv, raw := h.putSurvey(slug, in)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("put survey: status %d body %s", res.StatusCode, raw)
	}
	return sv
}

func (h *harness) surveyResults(slug string) types.SurveyResults {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/survey/results", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("results: status %d body %s", res.StatusCode, raw)
	}
	var out types.SurveyResults
	h.decode(raw, &out)
	return out
}

func (h *harness) submitSurvey(slug string, req types.SurveySubmitRequest) (*http.Response, []byte) {
	h.t.Helper()
	return h.guestPost("/api/webinars/"+slug+"/survey/responses", req)
}

func (h *harness) surveyAnnouncements() int {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	n := 0
	for _, p := range h.rooms.sent {
		if strings.Contains(string(p.data), `"survey-changed"`) {
			n++
		}
	}
	return n
}

func num(n int) *int { return &n }

func ratingSurvey() types.SurveyInput {
	return types.SurveyInput{
		Mode: types.SurveyBuiltin, Title: "How was it?", SendAt: types.SurveyOnEnd,
		Questions: []types.SurveyQuestionInput{
			{Kind: types.SurveyNPS10, Prompt: "How likely are you to recommend this session?", Required: true},
			{Kind: types.SurveySingleChoice, Prompt: "Pace", Options: []string{"Too slow", "Right", "Too fast"}},
			{Kind: types.SurveyText, Prompt: "What should we improve?"},
		},
	}
}
