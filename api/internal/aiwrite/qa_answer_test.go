package aiwrite

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseQAAnswerGroundedAndNot(t *testing.T) {
	a := ParseQAAnswer(`{"answer":"Fee **499** hai.","grounded":true,"sources":["k2","K2","k9","x1"]}`, 3, false)
	if a.Answer != "Fee 499 hai." || !a.Grounded || len(a.Sources) != 1 || a.Sources[0] != 1 {
		t.Fatalf("grounded = %+v", a)
	}
	// Claims grounded with nothing behind it and no transcript: not grounded.
	if a := ParseQAAnswer(`{"answer":"Yes.","grounded":true,"sources":["k5"]}`, 2, false); a.Grounded || a.Sources != nil {
		t.Fatalf("unbacked = %+v", a)
	}
	// From the transcript alone: grounded with no sources.
	if a := ParseQAAnswer(`{"answer":"Yes.","grounded":true,"sources":[]}`, 0, true); !a.Grounded {
		t.Fatalf("transcript = %+v", a)
	}
	// Not grounded keeps no sources even when it lists some.
	if a := ParseQAAnswer(`{"answer":"Maybe.","grounded":false,"sources":["k1"]}`, 2, true); a.Grounded || a.Sources != nil {
		t.Fatalf("general = %+v", a)
	}
	// Plain text: an answer, not grounded.
	if a := ParseQAAnswer("- Probably yes.", 2, true); a.Answer != "Probably yes." || a.Grounded {
		t.Fatalf("plain = %+v", a)
	}
}

func TestFinishQAAnswer(t *testing.T) {
	general := QAAnswer{Answer: "Not in your knowledge - general answer: Usually yes."}
	if got := FinishQAAnswer(general, true); got != NotInKnowledge+" Usually yes." {
		t.Fatalf("general with knowledge = %q", got)
	}
	if got := FinishQAAnswer(QAAnswer{Answer: "Usually yes."}, true); got != NotInKnowledge+" Usually yes." {
		t.Fatalf("prefix added = %q", got)
	}
	// No knowledge at all: no prefix, as before the knowledge base.
	if got := FinishQAAnswer(QAAnswer{Answer: "Usually yes."}, false); got != "Usually yes." {
		t.Fatalf("no knowledge = %q", got)
	}
	if got := FinishQAAnswer(QAAnswer{Answer: "499 hai.", Grounded: true}, true); got != "499 hai." {
		t.Fatalf("grounded = %q", got)
	}
	if got := FinishQAAnswer(QAAnswer{Answer: NotInKnowledge}, true); got != "" {
		t.Fatalf("only the prefix = %q", got)
	}
	long := FinishQAAnswer(QAAnswer{Answer: strings.Repeat("word ", 300), Grounded: true}, true)
	if utf8.RuneCountInString(long) > MaxDraftRunes {
		t.Fatalf("long = %d runes", utf8.RuneCountInString(long))
	}
}

func TestQAAnswerMessagesCarryTheKnowledge(t *testing.T) {
	msgs := QAAnswerMessages(QAAnswerInput{
		Topic: "Money basics", Question: "Fees kitni hai?", HasKnowledge: true,
		Knowledge: []QAExcerpt{{Title: "Course FAQ", Text: "The fee is 499 rupees."}},
	})
	if !strings.Contains(msgs[0].Content, "strictly") || !strings.Contains(msgs[0].Content, "Hinglish") {
		t.Fatalf("system = %s", msgs[0].Content)
	}
	u := msgs[1].Content
	if !strings.Contains(u, "[k1] From \"Course FAQ\":\n<<<\nThe fee is 499 rupees.\n>>>") {
		t.Fatalf("user = %s", u)
	}
	if u := QAAnswerMessages(QAAnswerInput{Question: "x", HasKnowledge: true})[1].Content; !strings.Contains(u, "Nothing in the host's knowledge documents matched") {
		t.Fatalf("no hits = %s", u)
	}
}

func TestQADraftBatch(t *testing.T) {
	msgs := QADraftBatchMessages("Money basics", "", []QAExcerpt{{Title: "FAQ", Text: "Fee 499."}, {Title: "Refunds", Text: "7 days."}},
		[]QADraftItem{{Question: "Fee?", Excerpts: []int{0}}, {Question: "Refund?", Asked: []string{"Refund?", "Money back?"}, Excerpts: []int{1, 0}}})
	u := msgs[1].Content
	for _, want := range []string{"[k2] From \"Refunds\"", "n1: Fee?\n   excerpts found: k1", "asked as: Money back?", "n2: Refund?", "excerpts found: k2, k1"} {
		if !strings.Contains(u, want) {
			t.Fatalf("batch prompt missing %q: %s", want, u)
		}
	}
	got, err := ParseQADraftBatch(`{"answers":[
		{"question":"n2","answer":"7 days.","grounded":true,"sources":["k2"]},
		{"question":"n2","answer":"again","grounded":true,"sources":[]},
		{"question":"n5","answer":"stray","grounded":true,"sources":[]},
		{"question":"n1","answer":" ","grounded":true,"sources":[]}]}`, 2, 2)
	if err != nil || len(got) != 1 || got[1].Answer != "7 days." || got[1].Sources[0] != 1 {
		t.Fatalf("parsed = %+v %v", got, err)
	}
	if _, err := ParseQADraftBatch("nope", 1, 1); err == nil {
		t.Fatal("garbage parsed")
	}
}
