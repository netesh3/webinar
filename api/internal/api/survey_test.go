package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func TestSurveyBuiltinLifecycle(t *testing.T) {
	h := newHarness(t)
	h.signup("Survey Host", "survey-host@test.dev", true)
	wb := h.liveWebinar("Survey", nil)
	a := h.registerAsGuest(wb.ID, "survey-a@test.dev")
	b := h.registerAsGuest(wb.ID, "survey-b@test.dev")

	// Nothing set up: nothing offered.
	if got := h.audienceSurvey(wb.ID, a.JoinKey); got.Survey != nil {
		t.Fatalf("offered a survey that doesn't exist: %+v", got)
	}

	sv := h.mustPutSurvey(wb.ID, ratingSurvey())
	if sv.Status != types.SurveyDraft || !sv.AskRating || len(sv.Questions) != 3 {
		t.Fatalf("saved survey = %+v", sv)
	}

	// Armed for the end while the room is live: offered (for early leavers) but not live.
	got := h.audienceSurvey(wb.ID, a.JoinKey)
	if got.Survey == nil || got.Live {
		t.Fatalf("an on_end draft in a live room should be offered, not live: %+v", got)
	}
	if got.Survey.Responses != 0 || got.Survey.Locked {
		t.Fatal("the audience copy must carry no counts")
	}

	// A manual draft is not offered at all.
	manual := ratingSurvey()
	manual.SendAt = types.SurveyManual
	h.mustPutSurvey(wb.ID, manual)
	if got := h.audienceSurvey(wb.ID, a.JoinKey); got.Survey != nil {
		t.Fatal("a manual draft must not be offered")
	}
	if res, raw := h.submitSurvey(wb.ID, types.SurveySubmitRequest{JoinKey: a.JoinKey, Rating: num(5)}); res.StatusCode != http.StatusConflict {
		t.Fatalf("answering an unsent survey: status %d body %s", res.StatusCode, raw)
	}

	before := h.surveyAnnouncements()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/survey/launch", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("launch: %d %s", res.StatusCode, raw)
	}
	if h.surveyAnnouncements() != before+1 {
		t.Fatal("launching must nudge the room")
	}
	got = h.audienceSurvey(wb.ID, a.JoinKey)
	if !got.Live || got.Mine.Submitted {
		t.Fatalf("after launch: %+v", got)
	}
	qs := got.Survey.Questions

	// Validation reaches the attendee as a 422 with a sentence.
	res, raw = h.submitSurvey(wb.ID, types.SurveySubmitRequest{JoinKey: a.JoinKey, Rating: num(4)})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "recommend") {
		t.Fatalf("missing required NPS: %d %s", res.StatusCode, raw)
	}

	answer := types.SurveySubmitRequest{JoinKey: a.JoinKey, Rating: num(4), Answers: []types.SurveyAnswerInput{
		{QuestionID: qs[0].ID, Number: num(10)},
		{QuestionID: qs[1].ID, Number: num(1)},
		{QuestionID: qs[2].ID, Text: "More demos please"},
	}}
	for i := 0; i < 2; i++ { // the retry is a no-op
		res, raw = h.submitSurvey(wb.ID, answer)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("submit #%d: %d %s", i, res.StatusCode, raw)
		}
	}
	res, _ = h.submitSurvey(wb.ID, types.SurveySubmitRequest{JoinKey: b.JoinKey, Rating: num(2), Answers: []types.SurveyAnswerInput{
		{QuestionID: qs[0].ID, Number: num(3)},
	}})
	if res.StatusCode != http.StatusOK {
		t.Fatal("second attendee could not submit")
	}
	if got := h.audienceSurvey(wb.ID, a.JoinKey); !got.Mine.Submitted || got.Mine.Rating != 4 {
		t.Fatalf("own response not reported back: %+v", got.Mine)
	}

	// Questions are pinned once answered; presentation is not.
	edit := ratingSurvey()
	edit.Questions = edit.Questions[:1]
	if res, _, raw := h.putSurvey(wb.ID, edit); res.StatusCode != http.StatusConflict {
		t.Fatalf("editing answered questions: %d %s", res.StatusCode, raw)
	}
	keep := manual
	keep.Title = "Thanks for coming!"
	for i := range keep.Questions {
		keep.Questions[i].ID = qs[i].ID
	}
	if sv := h.mustPutSurvey(wb.ID, keep); sv.Title != "Thanks for coming!" || !sv.Locked || sv.Responses != 2 {
		t.Fatalf("presentation edit: %+v", sv)
	}
	if res, _ := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/survey", nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("deleting an answered survey: %d", res.StatusCode)
	}

	r := h.surveyResults(wb.ID)
	if r.Responses != 2 || r.Ratings != 2 || r.AverageRating != 3 || r.RatingDistribution[3] != 1 {
		t.Fatalf("results headline: %+v", r)
	}
	if r.NPS == nil || r.NPS.Promoters != 1 || r.NPS.Detractors != 1 || r.NPS.Score != 0 {
		t.Fatalf("nps: %+v", r.NPS)
	}
	if r.Questions[1].Choices[1].Count != 1 || len(r.Comments) != 1 || r.Comments[0].Text != "More demos please" {
		t.Fatalf("questions/comments: %+v %+v", r.Questions, r.Comments)
	}
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/survey/answers?question="+qs[2].ID+"&limit=1", nil)
	var page types.SurveyTextPage
	h.decode(raw, &page)
	if res.StatusCode != http.StatusOK || page.Total != 1 || len(page.Answers) != 1 || page.NextCursor != "" {
		t.Fatalf("text page: %d %+v", res.StatusCode, page)
	}

	// Closed means closed, for a client holding an old copy too.
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/survey/close", nil); res.StatusCode != http.StatusOK {
		t.Fatal("close failed")
	}
	c := h.registerAsGuest(wb.ID, "survey-c@test.dev")
	res, _ = h.submitSurvey(wb.ID, types.SurveySubmitRequest{JoinKey: c.JoinKey, Rating: num(5),
		Answers: []types.SurveyAnswerInput{{QuestionID: qs[0].ID, Number: num(9)}}})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("answering a closed survey: %d", res.StatusCode)
	}
}

func TestSurveyValidationAndPermissions(t *testing.T) {
	h := newHarness(t)
	h.signup("Survey Host", "survey-val@test.dev", true)
	wb := h.liveWebinar("Survey validation", nil)
	for _, u := range []string{"http://forms.gle/x", "javascript:alert(1)", "https://user:pw@forms.gle/x"} {
		res, _, raw := h.putSurvey(wb.ID, types.SurveyInput{Mode: types.SurveyLink, ExternalURL: u})
		if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "externalUrl") {
			t.Errorf("%q: %d %s", u, res.StatusCode, raw)
		}
	}
	six := ratingSurvey()
	for len(six.Questions) <= types.MaxSurveyQuestions {
		six.Questions = append(six.Questions, types.SurveyQuestionInput{Kind: types.SurveyText, Prompt: "More?"})
	}
	if res, _, _ := h.putSurvey(wb.ID, six); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("six questions: %d", res.StatusCode)
	}

	// The host is not their own audience, and a stranger cannot configure it.
	h.mustPutSurvey(wb.ID, types.SurveyInput{Mode: types.SurveyLink, ExternalURL: "https://forms.gle/abc"})
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/survey/responses", types.SurveySubmitRequest{Rating: num(5)}); res.StatusCode != http.StatusForbidden {
		t.Errorf("host answering: %d %s", res.StatusCode, raw)
	}
	h.logout()
	h.signup("Other Host", "survey-other@test.dev", true)
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/survey", nil); res.StatusCode == http.StatusOK {
		t.Error("another host can read this survey")
	}
}

func TestSurveyLinkModeClickAndEngagement(t *testing.T) {
	h := newHarness(t)
	wb, regs := engagedWebinar(t, h) // ended; regs[0..2] attended
	sv := h.mustPutSurvey(wb.ID, types.SurveyInput{
		Mode: types.SurveyLink, ExternalURL: "https://forms.gle/abc", AskRating: true, SendAt: types.SurveyManual,
	})
	if sv.Status != types.SurveyDraft {
		t.Fatal("new survey should be a draft")
	}
	// Ended room: an on_end draft would never go out now, so nothing is offered until sent.
	if got := h.audienceSurvey(wb.ID, regs[0].JoinKey); got.Survey != nil {
		t.Fatal("unsent survey offered after the end")
	}
	before := h.engagementSummary(wb.ID)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/survey/launch", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("launch after end: %d %s", res.StatusCode, raw)
	}

	click := func(key string) int {
		res, _ := h.guestPost("/api/webinars/"+wb.ID+"/survey/click", types.SurveyClickRequest{JoinKey: key})
		return res.StatusCode
	}
	if click(regs[0].JoinKey) != http.StatusOK || click(regs[0].JoinKey) != http.StatusOK || click(regs[1].JoinKey) != http.StatusOK {
		t.Fatal("click not recorded")
	}
	if res, raw := h.submitSurvey(wb.ID, types.SurveySubmitRequest{JoinKey: regs[0].JoinKey}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("ask_rating requires the rating: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.submitSurvey(wb.ID, types.SurveySubmitRequest{JoinKey: regs[0].JoinKey, Rating: num(5)}); res.StatusCode != http.StatusOK {
		t.Fatalf("link rating: %d %s", res.StatusCode, raw)
	}

	r := h.surveyResults(wb.ID)
	if r.Attended != 3 || r.LinkClicks != 2 || r.ClickThroughPct != 67 || r.Responses != 1 || r.AverageRating != 5 {
		t.Fatalf("link results: %+v", r)
	}

	// The snapshot computed before the survey is stale now; v2 scores the survey term.
	time.Sleep(10 * time.Millisecond)
	after := h.engagementSummary(wb.ID)
	if after.FormulaVersion != 2 {
		t.Fatalf("formula v%d", after.FormulaVersion)
	}
	weight := func(s types.EngagementSummary) float64 {
		for _, w := range s.Weights {
			if w.Key == "survey" {
				return w.Weight
			}
		}
		return -1
	}
	if weight(before) != 0 || weight(after) <= 0 {
		t.Fatalf("survey weight before %.1f after %.1f", weight(before), weight(after))
	}
	page := h.engagementPage(wb.ID, "sort=name&dir=asc&limit=10")
	byName := map[string]types.EngagementAttendeeRow{}
	for _, row := range page.Rows {
		byName[row.Email] = row
	}
	if k := byName["keen@test.dev"].Counts; !k.SurveyDone || k.Rating != 5 {
		t.Fatalf("Keen counts %+v (rows %+v)", k, page.Rows)
	}
	if k := byName["quiet@test.dev"].Counts; k.SurveyDone || !k.SurveyClicked {
		t.Fatalf("Quiet counts %+v", k)
	}

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement.csv", nil)
	csv := string(raw)
	if res.StatusCode != http.StatusOK || !strings.Contains(csv, "survey,survey_rating,survey_nps") ||
		!strings.Contains(csv, ",completed,5,") || !strings.Contains(csv, ",clicked,,") {
		t.Fatalf("csv: %d\n%s", res.StatusCode, csv)
	}
}

func TestSurveyLaunchesWhenTheWebinarEnds(t *testing.T) {
	h := newHarness(t)
	h.signup("Survey Host", "survey-end@test.dev", true)
	wb := h.liveWebinar("Survey on end", nil)
	a := h.registerAsGuest(wb.ID, "survey-end-a@test.dev")
	h.mustPutSurvey(wb.ID, ratingSurvey())
	before := h.surveyAnnouncements()
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: %d %s", res.StatusCode, raw)
	}
	if h.surveyAnnouncements() != before+1 {
		t.Fatal("ending should announce the survey")
	}
	got := h.audienceSurvey(wb.ID, a.JoinKey)
	if got.Survey == nil || !got.Live || got.Survey.LaunchedAt == "" {
		t.Fatalf("after end: %+v", got)
	}
}
