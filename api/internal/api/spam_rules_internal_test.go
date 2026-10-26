package api

import (
	"slices"
	"testing"
	"time"
)

/* The free rules (spam_rules.go): what each one catches, what it leaves alone, and the
 * thresholds that decide flagged, pending and nothing. */

func TestSpamScoreRules(t *testing.T) {
	none := spamPrior{Recent: 1}
	for _, c := range []struct {
		name       string
		text       string
		allowLinks bool
		prior      spamPrior
		reasons    []string
		atLeast    float64
		below      float64
	}{
		{name: "plain question", text: "What time does the session end?", prior: none, below: spamSuspectAt},
		{name: "excitement", text: "wow great session sir 👏👏", prior: none, below: spamSuspectAt},
		{name: "hinglish", text: "Sir EMI ka option hai kya?", prior: none, below: spamSuspectAt},
		{name: "price is not a phone", text: "Is it ₹4,999 for batch 12 in 2026?", prior: none, below: spamSuspectAt},
		{name: "link", text: "see my notes at www.example.com", prior: none, reasons: []string{"link"}, atLeast: spamSuspectAt, below: spamFlagAt},
		{name: "link allowed", text: "see my notes at www.example.com", allowLinks: true, prior: none, below: spamSuspectAt},
		{name: "whatsapp invite", text: "Join chat.whatsapp.com/AbCdEf for free tips and earn ₹5000 daily", allowLinks: true, prior: none,
			reasons: []string{"whatsapp", "scam_words"}, atLeast: spamFlagAt},
		{name: "phone and dm", text: "DM me or call me on +91 98765 43210", prior: none, reasons: []string{"phone", "dm_me"}, atLeast: spamFlagAt},
		{name: "crypto", text: "Best crypto trading signal group, guaranteed profit", prior: none, reasons: []string{"scam_words"}, atLeast: spamFlagAt - 0.01},
		{name: "shouting", text: "WHY IS NOBODY ANSWERING MY QUESTION", prior: none, reasons: []string{"caps"}, below: spamSuspectAt},
		{name: "emoji flood", text: "😂😂😂😂😂😂😂😂😂😂😂", prior: none, reasons: []string{"emoji"}, below: spamSuspectAt},
		{name: "repeat", text: "hello", prior: spamPrior{Same: 1, Recent: 2}, reasons: []string{"repeat"}, atLeast: spamSuspectAt},
		{name: "flood", text: "hi", prior: spamPrior{Recent: spamFloodCount}, reasons: []string{"flood"}, atLeast: spamSuspectAt},
		{name: "copy paste across people", text: "check out my channel for free notes", prior: spamPrior{Others: 2, Recent: 1},
			reasons: []string{"copy_paste"}, atLeast: spamSuspectAt},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := spamScore(c.text, c.allowLinks, c.prior)
			for _, r := range c.reasons {
				if !slices.Contains(got.Reasons, r) {
					t.Errorf("reasons = %v, want %s", got.Reasons, r)
				}
			}
			if len(c.reasons) == 0 && len(got.Reasons) != 0 {
				t.Errorf("reasons = %v, want none", got.Reasons)
			}
			if c.atLeast > 0 && got.Score < c.atLeast {
				t.Errorf("score = %v, want >= %v", got.Score, c.atLeast)
			}
			if c.below > 0 && got.Score >= c.below {
				t.Errorf("score = %v, want < %v", got.Score, c.below)
			}
			if got.Score > 1 {
				t.Errorf("score = %v > 1", got.Score)
			}
		})
	}
}

func TestSpamCategoryFor(t *testing.T) {
	for reasons, want := range map[string]string{"scam_words,link": "scam", "whatsapp": "promo", "flood,caps": "off_topic"} {
		if got := spamCategoryFor(splitComma(reasons)); got != want {
			t.Errorf("%s: %s, want %s", reasons, got, want)
		}
	}
}

func splitComma(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return out
}

func TestSpamHistoryRepeatsFloodAndCopyPaste(t *testing.T) {
	var h spamHistory
	t0 := time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC)
	if p := h.observe("a", "Buy now!", t0); p.Same != 0 || p.Recent != 1 {
		t.Fatalf("first = %+v", p)
	}
	// The same text, normalised ("buy now"), is a repeat.
	if p := h.observe("a", "BUY NOW", t0.Add(time.Second)); p.Same != 1 || p.Recent != 2 {
		t.Fatalf("second = %+v", p)
	}
	// Past the repeat window it is forgotten.
	if p := h.observe("a", "buy now", t0.Add(spamRepeatWindow+2*time.Second)); p.Same != 0 || p.Recent != 1 {
		t.Fatalf("after the window = %+v", p)
	}
	// Two other people pasting the same long line.
	line := "join my channel for free stock tips"
	h.observe("b", line, t0.Add(spamRepeatWindow+3*time.Second))
	h.observe("c", line, t0.Add(spamRepeatWindow+4*time.Second))
	if p := h.observe("d", line, t0.Add(spamRepeatWindow+5*time.Second)); p.Others != 2 {
		t.Fatalf("copy paste = %+v", p)
	}
	// Flooding: many from one person inside the flood window.
	var last spamPrior
	for i := 0; i < spamFloodCount; i++ {
		last = h.observe("e", "msg "+string(rune('a'+i)), t0.Add(spamRepeatWindow+6*time.Second+time.Duration(i)*time.Second))
	}
	if last.Recent < spamFloodCount {
		t.Fatalf("flood = %+v", last)
	}
}

func TestSpamDue(t *testing.T) {
	now := time.Now()
	if spamDue(0, now.Add(-time.Hour), now) {
		t.Error("nothing pending is never due")
	}
	if spamDue(1, now, now) {
		t.Error("one fresh message is not due")
	}
	if !spamDue(spamBatch, now, now) {
		t.Error("a full batch is due")
	}
	if !spamDue(1, now.Add(-spamEvery), now) {
		t.Error("one old enough is due")
	}
	// 2026-10-27: fewer, fuller passes for Groq's free-tier limits.
	if spamBatch != 20 || spamEvery != 30*time.Second || spamBatch > spamWindow {
		t.Errorf("batching = %d messages / %v (window %d), want 20 / 30s within the window", spamBatch, spamEvery, spamWindow)
	}
	if spamDue(spamBatch-1, now.Add(-29*time.Second), now) {
		t.Error("19 messages at 29 s are not due yet")
	}
}
