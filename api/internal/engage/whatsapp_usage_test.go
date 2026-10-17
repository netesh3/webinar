package engage

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestSummariseWhatsAppUsage(t *testing.T) {
	got := SummariseWhatsAppUsage([]types.AdminWhatsAppHostUsage{
		{Reminders: 4, InboundReplies: 2}, // reminders only: replies arriving don't count
		{Reminders: 1, Broadcasts: 3},     // CRM
		{Drips: 2, BotSessions: 1},        // CRM, two features
		{ManualReplies: 1},                // CRM via the inbox
		{},                                // inactive
	})
	want := types.AdminWhatsAppUsageSummary{
		Hosts: 5, RemindersOnly: 1, UsedCRM: 3, Inactive: 1,
		Broadcasts: 1, Drips: 1, Chatbot: 1, Inbox: 1,
	}
	if got != want {
		t.Fatalf("summary = %+v, want %+v", got, want)
	}
}
