package aiwrite

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseQAAutoKeepsOnlyConfidentGroundedCitedAnswers(t *testing.T) {
	long := strings.Repeat("fee ", 300)
	excerpts := []QAExcerpt{{Title: "FAQ", Text: "Fee 499 rupees, ek baar."}, {Title: "More", Text: "The fee is paid once."}}
	out, verdicts, err := ParseQAAuto(`{"answers":[
		{"question":"n1","answer":"Fee 499 rupees hai, ek baar.","grounded":true,"confidence":0.9,"sources":["k1"]},
		{"question":"n2","answer":"Maybe, ask the coach.","grounded":false,"confidence":0.9,"sources":[]},
		{"question":"n3","answer":"Yes.","grounded":true,"confidence":0.95,"sources":["k9"]},
		{"question":"n4","answer":"Fee 499 rupees.","grounded":true,"confidence":0.8,"sources":["k1"]},
		{"question":"n5","answer":"`+long+`","grounded":true,"confidence":0.9,"sources":["k2"]},
		{"question":"n6","answer":"","grounded":true,"confidence":0.9,"sources":["k1"]},
		{"question":"n7","answer":"Fee 599 rupees.","grounded":true,"confidence":0.99,"sources":["k1"]}]}`, 7, excerpts)
	if err != nil {
		t.Fatal(err)
	}
	if a, ok := out[0]; !ok || a.Answer != "Fee 499 rupees hai, ek baar." {
		t.Fatalf("n1 = %+v", out[0])
	}
	// n4's 0.8 would make a draft, but not an answer posted without review.
	want := map[int]Verdict{0: VerdictAnswered, 1: VerdictUngrounded, 2: VerdictNoSource, 3: VerdictLowConfidence,
		4: VerdictAnswered, 5: VerdictEmpty, 6: VerdictUnverifiedNumber}
	for i, v := range want {
		if verdicts[i] != v {
			t.Errorf("n%d verdict = %s, want %s", i+1, verdicts[i], v)
		}
		if _, ok := out[i]; ok != (v == VerdictAnswered) {
			t.Errorf("n%d posted = %v", i+1, ok)
		}
	}
	if a := out[4]; utf8.RuneCountInString(a.Answer) > MaxDraftRunes {
		t.Errorf("n5 is %d runes", utf8.RuneCountInString(a.Answer))
	}
	if _, _, err := ParseQAAuto("not json", 1, excerpts); err == nil {
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
