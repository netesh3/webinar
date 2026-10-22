package aiwrite

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseQAAutoKeepsOnlyGroundedCitedAnswers(t *testing.T) {
	long := strings.Repeat("fee ", 300)
	out, err := ParseQAAuto(`{"answers":[
		{"question":"n1","answer":"Fee 499 rupees hai, ek baar.","grounded":true,"sources":["k1"]},
		{"question":"n2","answer":"Maybe, ask the coach.","grounded":false,"sources":[]},
		{"question":"n3","answer":"Yes.","grounded":true,"sources":["k9"]},
		{"question":"n4","answer":"Not in your knowledge — general answer: yes","grounded":true,"sources":["k1"]},
		{"question":"n5","answer":"`+long+`","grounded":true,"sources":["k2"]},
		{"question":"n6","answer":"","grounded":true,"sources":["k1"]}]}`, 6, 2)
	if err != nil {
		t.Fatal(err)
	}
	if a, ok := out[0]; !ok || a.Answer != "Fee 499 rupees hai, ek baar." {
		t.Fatalf("n1 = %+v", out[0])
	}
	for _, i := range []int{1, 2, 3, 5} {
		if _, ok := out[i]; ok {
			t.Errorf("n%d should not be posted: %+v", i+1, out[i])
		}
	}
	if a := out[4]; utf8.RuneCountInString(a.Answer) > MaxDraftRunes {
		t.Errorf("n5 is %d runes", utf8.RuneCountInString(a.Answer))
	}
	if _, err := ParseQAAuto("not json", 1, 1); err == nil {
		t.Error("garbage parsed")
	}
}

func TestQAAutoMessagesSpeakAsTheAssistant(t *testing.T) {
	msgs := QAAutoMessages("Asha", "Money basics", "", []QAExcerpt{{Title: "FAQ", Text: "The fee is 499."}},
		[]AutoAnswerItem{{Question: "Fee kitni hai?", Excerpts: []int{0}}})
	sys, user := msgs[0].Content, msgs[1].Content
	for _, want := range []string{"Asha's assistant", "Never claim to be Asha", "refund, discount", "Hinglish", "Roman script"} {
		if !strings.Contains(sys, want) {
			t.Errorf("system prompt lacks %q", want)
		}
	}
	if strings.Contains(sys, "COACH") {
		t.Error("placeholder left in the prompt")
	}
	if !strings.Contains(user, "n1: Fee kitni hai?") || !strings.Contains(user, "excerpts found: k1") || !strings.Contains(user, "[k1]") {
		t.Errorf("user prompt = %s", user)
	}
	if !strings.Contains(QAAutoMessages("", "t", "", nil, nil)[0].Content, "the host's assistant") {
		t.Error("no coach name")
	}
}
