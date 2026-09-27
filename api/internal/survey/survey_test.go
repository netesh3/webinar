package survey

import (
	"errors"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func ptr(n int) *int { return &n }

func TestNormalizeLinkMode(t *testing.T) {
	c, err := Normalize(types.SurveyInput{
		Mode: types.SurveyLink, ExternalURL: "  https://forms.gle/abc123  ", AskRating: false,
		Title: "  Tell   us\nmore ", Questions: []types.SurveyQuestionInput{{Kind: types.SurveyText, Prompt: "ignored"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.ExternalURL != "https://forms.gle/abc123" || c.Title != "Tell us more" || c.AskRating {
		t.Fatalf("normalised wrong: %+v", c)
	}
	if len(c.Questions) != 0 {
		t.Fatal("a link survey must not keep built-in questions")
	}
	if c.SendAt != types.SurveyOnEnd {
		t.Fatalf("send_at defaults to on_end, got %q", c.SendAt)
	}
}

func TestValidateURL(t *testing.T) {
	good := []string{
		"https://forms.gle/x", "https://docs.google.com/forms/d/e/1FAIpQ/viewform?usp=sf_link",
		"HTTPS://example.typeform.com/to/abc#frag",
	}
	for _, u := range good {
		if _, err := ValidateURL(u); err != nil {
			t.Errorf("%q refused: %v", u, err)
		}
	}
	bad := []string{
		"", "http://forms.gle/x", "javascript:alert(1)", "https://", "forms.gle/x",
		"https://user:pw@forms.gle/x", "https://forms.gle/a b", "https://localhost/x",
		"https://forms.gle/\u0000", "data:text/html,hi", "//forms.gle/x",
		"https://forms.gle/" + strings.Repeat("a", types.MaxSurveyURLChars),
	}
	for _, u := range bad {
		if _, err := ValidateURL(u); err == nil {
			t.Errorf("%q accepted", u)
		}
	}
	if got, _ := ValidateURL("HTTPS://Forms.gle/x"); !strings.HasPrefix(got, "https://") {
		t.Errorf("scheme not lower-cased: %q", got)
	}
}

func TestNormalizeBuiltinQuestions(t *testing.T) {
	in := types.SurveyInput{Mode: types.SurveyBuiltin, AskRating: false, SendAt: types.SurveyManual,
		Questions: []types.SurveyQuestionInput{
			{Kind: types.SurveyNPS10, Prompt: "Recommend?", Required: true, Options: []string{"x"}},
			{Kind: types.SurveySingleChoice, Prompt: "Pace", Options: []string{" Too slow ", "", "Right", "Too fast"}},
			{Kind: types.SurveyText, Prompt: " Anything else? "},
		}}
	c, err := Normalize(in)
	if err != nil {
		t.Fatal(err)
	}
	if !c.AskRating {
		t.Fatal("the built-in survey always asks the rating")
	}
	if len(c.Questions[0].Options) != 0 {
		t.Fatal("options on a non-choice question must be dropped")
	}
	if got := c.Questions[1].Options; len(got) != 3 || got[0] != "Too slow" {
		t.Fatalf("options not cleaned: %q", got)
	}
	if c.Questions[2].Prompt != "Anything else?" {
		t.Fatalf("prompt not trimmed: %q", c.Questions[2].Prompt)
	}
}

func TestNormalizeRefuses(t *testing.T) {
	six := make([]types.SurveyQuestionInput, types.MaxSurveyQuestions+1)
	for i := range six {
		six[i] = types.SurveyQuestionInput{Kind: types.SurveyText, Prompt: "Q"}
	}
	cases := map[string]types.SurveyInput{
		"no mode":          {},
		"bad send_at":      {Mode: types.SurveyBuiltin, SendAt: "later"},
		"too many":         {Mode: types.SurveyBuiltin, Questions: six},
		"blank prompt":     {Mode: types.SurveyBuiltin, Questions: []types.SurveyQuestionInput{{Kind: types.SurveyText, Prompt: "  "}}},
		"long prompt":      {Mode: types.SurveyBuiltin, Questions: []types.SurveyQuestionInput{{Kind: types.SurveyText, Prompt: strings.Repeat("é", types.MaxSurveyPromptChars+1)}}},
		"one option":       {Mode: types.SurveyBuiltin, Questions: []types.SurveyQuestionInput{{Kind: types.SurveySingleChoice, Prompt: "Q", Options: []string{"a", " "}}}},
		"seven options":    {Mode: types.SurveyBuiltin, Questions: []types.SurveyQuestionInput{{Kind: types.SurveySingleChoice, Prompt: "Q", Options: []string{"1", "2", "3", "4", "5", "6", "7"}}}},
		"unknown kind":     {Mode: types.SurveyBuiltin, Questions: []types.SurveyQuestionInput{{Kind: "slider", Prompt: "Q"}}},
		"duplicate id":     {Mode: types.SurveyBuiltin, Questions: []types.SurveyQuestionInput{{ID: "a", Kind: types.SurveyText, Prompt: "Q"}, {ID: "a", Kind: types.SurveyText, Prompt: "R"}}},
		"long title":       {Mode: types.SurveyLink, ExternalURL: "https://a.co", Title: strings.Repeat("t", types.MaxSurveyTitleChars+1)},
		"long button":      {Mode: types.SurveyLink, ExternalURL: "https://a.co", ButtonLabel: strings.Repeat("b", types.MaxSurveyButtonChars+1)},
		"link without url": {Mode: types.SurveyLink},
	}
	for name, in := range cases {
		_, err := Normalize(in)
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("%s: want a ValidationError, got %v", name, err)
		}
	}
}

func builtin() types.Survey {
	return types.Survey{Mode: types.SurveyBuiltin, AskRating: true, Questions: []types.SurveyQuestion{
		{ID: "nps", Kind: types.SurveyNPS10, Prompt: "Recommend?", Required: true},
		{ID: "pace", Kind: types.SurveySingleChoice, Prompt: "Pace", Options: []string{"Slow", "Right", "Fast"}},
		{ID: "more", Kind: types.SurveyText, Prompt: "Anything else?"},
	}}
}

func TestValidateSubmission(t *testing.T) {
	s := builtin()
	rating, answers, err := ValidateSubmission(s, types.SurveySubmitRequest{Rating: ptr(4), Answers: []types.SurveyAnswerInput{
		{QuestionID: "more", Text: "  Great pacing  "},
		{QuestionID: "nps", Number: ptr(9)},
		{QuestionID: "pace", Number: nil},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if *rating != 4 || len(answers) != 2 {
		t.Fatalf("rating %v answers %+v", rating, answers)
	}
	if answers[0].QuestionID != "nps" || answers[1].Text != "Great pacing" {
		t.Fatalf("answers not in survey order or not trimmed: %+v", answers)
	}

	refuse := map[string]types.SurveySubmitRequest{
		"no rating":        {Answers: []types.SurveyAnswerInput{{QuestionID: "nps", Number: ptr(9)}}},
		"rating 0":         {Rating: ptr(0)},
		"rating 6":         {Rating: ptr(6)},
		"required missing": {Rating: ptr(3)},
		"nps 11":           {Rating: ptr(3), Answers: []types.SurveyAnswerInput{{QuestionID: "nps", Number: ptr(11)}}},
		"choice out":       {Rating: ptr(3), Answers: []types.SurveyAnswerInput{{QuestionID: "nps", Number: ptr(1)}, {QuestionID: "pace", Number: ptr(3)}}},
		"unknown":          {Rating: ptr(3), Answers: []types.SurveyAnswerInput{{QuestionID: "nps", Number: ptr(1)}, {QuestionID: "gone", Text: "x"}}},
		"duplicate":        {Rating: ptr(3), Answers: []types.SurveyAnswerInput{{QuestionID: "nps", Number: ptr(1)}, {QuestionID: "nps", Number: ptr(2)}}},
		"long text":        {Rating: ptr(3), Answers: []types.SurveyAnswerInput{{QuestionID: "nps", Number: ptr(1)}, {QuestionID: "more", Text: strings.Repeat("x", types.MaxSurveyTextAnswerChars+1)}}},
	}
	for name, req := range refuse {
		if _, _, err := ValidateSubmission(s, req); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestValidateSubmissionLinkMode(t *testing.T) {
	link := types.Survey{Mode: types.SurveyLink, AskRating: true}
	if _, _, err := ValidateSubmission(link, types.SurveySubmitRequest{}); err == nil {
		t.Fatal("link mode with ask_rating must require the rating")
	}
	link.AskRating = false
	rating, answers, err := ValidateSubmission(link, types.SurveySubmitRequest{Rating: ptr(5)})
	if err != nil || rating != nil || len(answers) != 0 {
		t.Fatalf("link mode without rating: %v %v %v", rating, answers, err)
	}
}

func TestNPS(t *testing.T) {
	dist := make([]int, 11)
	dist[10], dist[9] = 3, 2 // 5 promoters
	dist[8], dist[7] = 1, 1  // 2 passives
	dist[6], dist[0] = 2, 1  // 3 detractors
	n := NPS(dist)
	if n.Promoters != 5 || n.Passives != 2 || n.Detractors != 3 || n.Responses != 10 || n.Score != 20 {
		t.Fatalf("NPS = %+v", n)
	}
	if got := NPS(make([]int, 11)); got.Score != 0 || got.Responses != 0 {
		t.Fatalf("empty NPS = %+v", got)
	}
	all := make([]int, 11)
	all[3] = 4
	if got := NPS(all).Score; got != -100 {
		t.Fatalf("all detractors = %d", got)
	}
}

func TestAggregate(t *testing.T) {
	s := builtin()
	s.Status = types.SurveyLive
	res := Aggregate(Tally{
		Survey: s, Attended: 8, Responses: 4,
		RatingCounts: [5]int{0, 1, 0, 2, 1},
		Numbers: []Bucket{
			{"nps", 10, 2}, {"nps", 6, 1}, {"nps", 8, 1},
			{"pace", 1, 3}, {"pace", 2, 1}, {"pace", 9, 5}, // out of range: ignored
		},
		TextCounts: map[string]int{"more": 2},
	})
	if res.ResponseRatePct != 50 || res.Ratings != 4 || res.AverageRating != 3.8 {
		t.Fatalf("headline wrong: %+v", res)
	}
	if res.ClickThroughPct != -1 || res.LinkClicks != 0 {
		t.Fatal("click-through is link mode only")
	}
	if res.NPS == nil || res.NPS.Score != 25 || res.NPS.Responses != 4 {
		t.Fatalf("NPS = %+v", res.NPS)
	}
	nps, pace, more := res.Questions[0], res.Questions[1], res.Questions[2]
	if nps.Average != 8.5 || len(nps.Distribution) != 11 || nps.Distribution[10] != 2 {
		t.Fatalf("nps question = %+v", nps)
	}
	if pace.Answered != 4 || pace.Choices[1].Count != 3 || pace.Choices[1].Label != "Right" || pace.Average != -1 {
		t.Fatalf("pace = %+v", pace)
	}
	if more.Answered != 2 {
		t.Fatalf("text answered = %d", more.Answered)
	}
	if res.Comments == nil {
		t.Fatal("comments must be an empty list, not null")
	}
}

func TestAggregateEmptyAndLink(t *testing.T) {
	res := Aggregate(Tally{Survey: types.Survey{Mode: types.SurveyLink, AskRating: true}, Attended: 0, LinkClicks: 0})
	if res.AverageRating != -1 || res.ResponseRatePct != -1 || res.ClickThroughPct != -1 || res.NPS != nil {
		t.Fatalf("empty results = %+v", res)
	}
	res = Aggregate(Tally{Survey: types.Survey{Mode: types.SurveyLink}, Attended: 4, LinkClicks: 3})
	if res.ClickThroughPct != 75 || res.LinkClicks != 3 {
		t.Fatalf("click-through = %+v", res)
	}
}
