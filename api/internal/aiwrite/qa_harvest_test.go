package aiwrite

import (
	"strings"
	"testing"
)

func TestQAHarvestMessagesKeepTheEndOfALongTranscript(t *testing.T) {
	var lines []string
	for i := 0; i < 5000; i++ {
		lines = append(lines, "Host: filler line number "+strings.Repeat("x", 20))
	}
	lines = append(lines, "Host: the fee is 499 rupees")
	msgs := QAHarvestMessages("Money basics", []string{"What is the fee?", "Recording?"}, lines)
	user := msgs[1].Content
	if !strings.Contains(user, "h1: What is the fee?") || !strings.Contains(user, "h2: Recording?") {
		t.Fatalf("questions missing: %.300s", user)
	}
	if !strings.Contains(user, "the fee is 499 rupees") || len([]rune(user)) > MaxHarvestTranscriptRunes+2000 {
		t.Fatalf("transcript not clipped from the start: %d runes", len([]rune(user)))
	}
}

func TestParseQAHarvest(t *testing.T) {
	said := []string{"Host: yes, every class is recorded", "Host: the fee is 499 rupees"}
	got, err := ParseQAHarvest(`{"answers":[
		{"question":"h1","answer":"**Yes**, it is recorded.","confidence":0.9},
		{"question":"h1","answer":"a second answer","confidence":0.9},
		{"question":"h9","answer":"out of range","confidence":0.9},
		{"question":"h2","answer":"   ","confidence":0.9},
		{"question":"h4","answer":"The fee is 999 rupees.","confidence":0.95},
		{"question":"h5","answer":"Probably on weekends.","confidence":0.5},
		{"question":"h6","answer":"The fee is 499 rupees.","confidence":0.8}]}`, 6, said)
	if err != nil {
		t.Fatal(err)
	}
	// h4's number is not in the transcript; h5 is not confident enough.
	if len(got) != 2 || got[0] != "Yes, it is recorded." || got[5] != "The fee is 499 rupees." {
		t.Fatalf("parsed = %v", got)
	}
	if _, err := ParseQAHarvest("not json", 2, said); err == nil {
		t.Fatal("garbage parsed")
	}
}
