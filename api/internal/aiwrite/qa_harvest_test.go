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
	got, err := ParseQAHarvest(`{"answers":[
		{"question":"h1","answer":"**Yes**, it is recorded."},
		{"question":"h1","answer":"a second answer"},
		{"question":"h3","answer":"out of range"},
		{"question":"h2","answer":"   "}]}`, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "Yes, it is recorded." {
		t.Fatalf("parsed = %v", got)
	}
	if _, err := ParseQAHarvest("not json", 2); err == nil {
		t.Fatal("garbage parsed")
	}
}
