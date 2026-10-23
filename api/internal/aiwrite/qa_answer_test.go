package aiwrite

import (
	"strings"
	"testing"
)

func TestQAAnswerMessagesCarryTheKnowledge(t *testing.T) {
	msgs := QAAnswerMessages(QAAnswerInput{
		Topic: "Money basics", Question: "Fees kitni hai?", HasKnowledge: true,
		Knowledge: []QAExcerpt{{Title: "Course FAQ", Text: "The fee is 499 rupees."}},
	})
	if !strings.Contains(msgs[0].Content, "Answer ONLY from the excerpts") || !strings.Contains(msgs[0].Content, "Never give a general answer") || !strings.Contains(msgs[0].Content, "Hinglish") {
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
		{"question":"n2","answer":"7 days.","grounded":true,"confidence":0.9,"sources":["k2"]},
		{"question":"n2","answer":"again","grounded":true,"sources":[]},
		{"question":"n5","answer":"stray","grounded":true,"sources":[]},
		{"question":"n1","answer":" ","grounded":true,"sources":[]}]}`, 2, 2)
	if err != nil || len(got) != 2 || got[1].Answer != "7 days." || got[1].Sources[0] != 1 || got[1].Confidence != 0.9 {
		t.Fatalf("parsed = %+v %v", got, err)
	}
	// The empty one is kept, for the gate to name.
	if v := DraftPolicy.Decide(got[0], nil, ""); v != VerdictEmpty {
		t.Fatalf("empty answer verdict = %s", v)
	}
	if _, err := ParseQADraftBatch("nope", 1, 1); err == nil {
		t.Fatal("garbage parsed")
	}
}
