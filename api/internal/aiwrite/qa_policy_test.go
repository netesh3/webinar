package aiwrite

import (
	"strings"
	"testing"
	"unicode/utf8"
)

var faq = []QAExcerpt{
	{Title: "Course FAQ", Text: "The fee for the Money Basics course is 499 rupees, paid once. EMI on cards over 3,000 rupees only."},
	{Title: "Refunds", Text: "A full refund is given within 7 days of purchase."},
}

func TestParseQAAnswer(t *testing.T) {
	a := ParseQAAnswer(`{"answer":"Fee **499** hai.","grounded":true,"confidence":0.92,"sources":["k2","K2","k9","x1","t1"],"missing":""}`, 3, false)
	if a.Answer != "Fee 499 hai." || !a.Grounded || a.Confidence != 0.92 || len(a.Sources) != 1 || a.Sources[0] != 1 || a.Transcript {
		t.Fatalf("grounded = %+v", a)
	}
	// t1 counts only when a transcript was given.
	if a := ParseQAAnswer(`{"answer":"Yes.","grounded":true,"confidence":0.9,"sources":["t1"]}`, 0, true); !a.Transcript {
		t.Fatalf("transcript = %+v", a)
	}
	// Not grounded keeps nothing, whatever it says.
	if a := ParseQAAnswer(`{"answer":"Maybe.","grounded":false,"confidence":0.9,"sources":["k1"]}`, 2, true); a.Grounded || a.Answer != "" || a.Sources != nil {
		t.Fatalf("ungrounded = %+v", a)
	}
	// Plain text is no answer at all.
	if a := ParseQAAnswer("- Probably yes.", 2, true); a.Answer != "" || a.Grounded {
		t.Fatalf("plain = %+v", a)
	}
	// Confidence is clamped to 0–1.
	if a := ParseQAAnswer(`{"answer":"Yes.","grounded":true,"confidence":7,"sources":["k1"]}`, 1, false); a.Confidence != 1 {
		t.Fatalf("clamped = %+v", a)
	}
}

func TestFinishQAAnswer(t *testing.T) {
	if got := FinishQAAnswer(QAAnswer{Answer: " 499 hai. ", Grounded: true}); got != "499 hai." {
		t.Fatalf("finished = %q", got)
	}
	long := FinishQAAnswer(QAAnswer{Answer: strings.Repeat("word ", 300), Grounded: true})
	if utf8.RuneCountInString(long) > MaxDraftRunes {
		t.Fatalf("long = %d runes", utf8.RuneCountInString(long))
	}
}

func TestPolicyDecide(t *testing.T) {
	ok := QAAnswer{Answer: "The fee is 499 rupees, paid once.", Grounded: true, Confidence: 0.9, Sources: []int{0}}
	cases := []struct {
		name   string
		a      QAAnswer
		policy Policy
		want   Verdict
	}{
		{"grounded and confident", ok, DraftPolicy, VerdictAnswered},
		{"ungrounded", QAAnswer{}, DraftPolicy, VerdictUngrounded},
		{"no text", QAAnswer{Grounded: true, Confidence: 1, Sources: []int{0}}, DraftPolicy, VerdictEmpty},
		{"low confidence", QAAnswer{Answer: ok.Answer, Grounded: true, Confidence: 0.6, Sources: []int{0}}, DraftPolicy, VerdictLowConfidence},
		{"enough for a draft, not for Auto mode", QAAnswer{Answer: ok.Answer, Grounded: true, Confidence: 0.8, Sources: []int{0}}, AutoPolicy, VerdictLowConfidence},
		{"draft bar", QAAnswer{Answer: ok.Answer, Grounded: true, Confidence: 0.8, Sources: []int{0}}, DraftPolicy, VerdictAnswered},
		{"no source", QAAnswer{Answer: ok.Answer, Grounded: true, Confidence: 0.95}, DraftPolicy, VerdictNoSource},
		{"source not given", QAAnswer{Answer: ok.Answer, Grounded: true, Confidence: 0.95, Sources: []int{7}}, DraftPolicy, VerdictNoSource},
		{"number not in the excerpt", QAAnswer{Answer: "The fee is 999 rupees.", Grounded: true, Confidence: 0.99, Sources: []int{0}}, AutoPolicy, VerdictUnverifiedNumber},
		{"number in an uncited excerpt", QAAnswer{Answer: "Refunds within 7 days.", Grounded: true, Confidence: 0.99, Sources: []int{0}}, DraftPolicy, VerdictUnverifiedNumber},
		{"thousands separators", QAAnswer{Answer: "EMI only on cards over ₹3000.", Grounded: true, Confidence: 0.9, Sources: []int{0}}, DraftPolicy, VerdictAnswered},
		{"transcript cited but none given", QAAnswer{Answer: "Yes.", Grounded: true, Confidence: 0.9, Transcript: true}, DraftPolicy, VerdictNoSource},
	}
	for _, c := range cases {
		if got := c.policy.Decide(c.a, faq, ""); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	// From what the host said: its numbers are checked against the transcript.
	said := QAAnswer{Answer: "Early birds get 20 percent off.", Grounded: true, Confidence: 0.9, Transcript: true}
	if got := DraftPolicy.Decide(said, nil, "Asha: early birds get 20 percent off"); got != VerdictAnswered {
		t.Errorf("transcript = %s", got)
	}
	if got := DraftPolicy.Decide(said, nil, "Asha: early birds get a discount"); got != VerdictUnverifiedNumber {
		t.Errorf("transcript without the number = %s", got)
	}
}

func TestPolicyRetrieved(t *testing.T) {
	if DraftPolicy.Retrieved(Evidence{}) || AutoPolicy.Retrieved(Evidence{}) {
		t.Fatal("no evidence passed")
	}
	if !DraftPolicy.Retrieved(Evidence{TopSimilarity: 0.4}) || AutoPolicy.Retrieved(Evidence{TopSimilarity: 0.4}) {
		t.Fatal("similarity 0.4: a draft, not Auto mode")
	}
	if !AutoPolicy.Retrieved(Evidence{TopSimilarity: 0.5}) || !AutoPolicy.Retrieved(Evidence{TopCoverage: 1}) {
		t.Fatal("strong evidence refused")
	}
	if !DraftPolicy.Retrieved(Evidence{TopCoverage: 0.4}) || AutoPolicy.Retrieved(Evidence{TopCoverage: 0.4}) {
		t.Fatal("coverage 0.4: a draft, not Auto mode")
	}
	if DraftPolicy.Retrieved(Evidence{TopCoverage: 0.25, TopSimilarity: 0.3}) {
		t.Fatal("weak evidence passed for a draft")
	}
}

func TestCitedNumbersOK(t *testing.T) {
	for _, c := range []struct {
		answer string
		ok     bool
	}{
		{"No numbers here.", true},
		{"It is 499 rupees.", true},
		{"Shared within 24 hours, 1st week only.", false},
		{"EMI over 3,000.", true},
		{"EMI over 3000.", true},
		{"EMI over 30,000.", false},
		{"It is 499.00 rupees.", false},
		{"It costs 500.", false},
	} {
		if got := CitedNumbersOK(c.answer, "Fee 499, EMI over 3,000 rupees. Shared within 24 hours."); got != c.ok {
			t.Errorf("%q: %v, want %v", c.answer, got, c.ok)
		}
	}
}
