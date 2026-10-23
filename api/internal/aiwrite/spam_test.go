package aiwrite

import (
	"strings"
	"testing"
)

func TestSpamMessagesLabelsAndReasons(t *testing.T) {
	msgs := SpamMessages("Money basics", []SpamItem{
		{Text: "join  my\ngroup", Reasons: []string{"whatsapp", "link"}},
		{Text: "great session"},
	})
	if len(msgs) != 2 || msgs[0].Role != "system" {
		t.Fatalf("messages = %+v", msgs)
	}
	u := msgs[1].Content
	for _, want := range []string{"Session: Money basics", "m1: join my group [suspicious: whatsapp, link]", "m2: great session\n"} {
		if !strings.Contains(u, want) {
			t.Errorf("prompt missing %q: %s", want, u)
		}
	}
}

func TestParseSpamHoldsTheReplyToWhatWasAsked(t *testing.T) {
	got, err := ParseSpam(`{"items":[
		{"id":"m2","spam":true,"category":"SCAM","confidence":1.7},
		{"id":"m2","spam":false,"category":"other","confidence":0},
		{"id":"m9","spam":true,"category":"promo","confidence":0.9},
		{"id":"m1","spam":false,"category":"weird","confidence":-1}]}`, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("verdicts = %+v", got)
	}
	if v := got[0]; v.Index != 1 || !v.Spam || v.Category != "scam" || v.Confidence != 1 {
		t.Errorf("m2 = %+v", v)
	}
	if v := got[1]; v.Index != 0 || v.Spam || v.Category != "other" || v.Confidence != 0 {
		t.Errorf("m1 = %+v", v)
	}
	if _, err := ParseSpam("not json", 1); err == nil {
		t.Error("garbage parsed")
	}
}
