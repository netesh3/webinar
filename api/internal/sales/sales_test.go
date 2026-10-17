package sales

import (
	"strconv"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/billing"
)

func TestPromptQuotesTheChargedPricesAndEnforcedCaps(t *testing.T) {
	p := SystemPrompt(18)
	for _, plan := range billing.Plans {
		inr, _ := plan.Price(billing.INR, billing.Monthly)
		if !strings.Contains(p, rupees(inr)+"/month") {
			t.Errorf("%s: prompt does not quote %s/month", plan.Name, rupees(inr))
		}
		if !strings.Contains(p, plan.Name) || !strings.Contains(p, "up to "+itoa(plan.Attendees())+" live attendees") {
			t.Errorf("%s: prompt does not state its cap of %d", plan.Name, plan.Attendees())
		}
	}
	if !strings.Contains(p, "18% GST") {
		t.Error("GST rate missing")
	}
	if strings.Contains(SystemPrompt(0), "GST is added") {
		t.Error("0% GST should not mention GST being added")
	}
}

func TestRupeesUsesIndianGrouping(t *testing.T) {
	for paise, want := range map[int64]string{
		99_00: "₹99", 3_999_00: "₹3,999", 14_999_00: "₹14,999",
		1_49_990_00: "₹1,49,990", 39_99_900_00: "₹39,99,900",
	} {
		if got := rupees(paise); got != want {
			t.Errorf("rupees(%d) = %s, want %s", paise, got, want)
		}
	}
}

func TestParseReply(t *testing.T) {
	cases := []struct {
		raw, text, reason string
		handoff           bool
	}{
		{"Business fits 250 attendees.", "Business fits 250 attendees.", "", false},
		{"[HANDOFF] wants custom pricing for 1,200 students", "", "wants custom pricing for 1,200 students", true},
		{"  [handoff]: refund request ", "", "refund request", true},
		{"Sure. [HANDOFF] asked for a dedicated server", "", "asked for a dedicated server", true},
	}
	for _, c := range cases {
		text, handoff, reason := ParseReply(c.raw)
		if text != c.text || handoff != c.handoff || reason != c.reason {
			t.Errorf("ParseReply(%q) = %q, %v, %q", c.raw, text, handoff, reason)
		}
	}
}

func TestAsksForPerson(t *testing.T) {
	for _, s := range []string{"Can I talk to a human?", "speak with someone from sales", "real person please", "human"} {
		if !AsksForPerson(s) {
			t.Errorf("%q should ask for a person", s)
		}
	}
	for _, s := range []string{"Which plan for 250 people?", "How do humans join on mobile?", "Do you have a team plan?"} {
		if AsksForPerson(s) {
			t.Errorf("%q should not ask for a person", s)
		}
	}
}

func TestMessagesKeepsRecentHistoryOnly(t *testing.T) {
	var h []Turn
	for i := 0; i < 30; i++ {
		h = append(h, Turn{FromVisitor: i%2 == 0, Text: itoa(i)})
	}
	m := Messages(18, h)
	if len(m) != MaxHistory+1 || m[0].Role != "system" || m[len(m)-1].Content != "29" {
		t.Fatalf("got %d messages, last %q", len(m), m[len(m)-1].Content)
	}
	if m[1].Role != "user" && m[1].Role != "assistant" {
		t.Fatalf("roles: %+v", m[1])
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
