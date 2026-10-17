package engage

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// whatsAppUsageLimit caps the host list; the summary counts the same rows.
const whatsAppUsageLimit = 200

// WhatsAppUsage is the admin dashboard's WhatsApp usage report for the last days days.
func (s *Module) WhatsAppUsage(ctx context.Context, days int) (types.AdminWhatsAppUsage, error) {
	since := time.Now().UTC().AddDate(0, 0, -days)
	hosts, err := s.store.WhatsAppUsage(ctx, since, whatsAppUsageLimit)
	if err != nil {
		return types.AdminWhatsAppUsage{}, err
	}
	return types.AdminWhatsAppUsage{
		Days:    days,
		Since:   since.Format(time.RFC3339),
		Hosts:   hosts,
		Summary: SummariseWhatsAppUsage(hosts),
	}, nil
}

// SummariseWhatsAppUsage counts hosts by what they used (see AdminWhatsAppUsageSummary).
func SummariseWhatsAppUsage(hosts []types.AdminWhatsAppHostUsage) types.AdminWhatsAppUsageSummary {
	sum := types.AdminWhatsAppUsageSummary{Hosts: len(hosts)}
	for _, h := range hosts {
		broadcasts := h.Broadcasts > 0
		drips := h.Drips > 0
		chatbot := h.BotSessions > 0 || h.BotMessages > 0
		inbox := h.ManualReplies > 0
		if broadcasts {
			sum.Broadcasts++
		}
		if drips {
			sum.Drips++
		}
		if chatbot {
			sum.Chatbot++
		}
		if inbox {
			sum.Inbox++
		}
		switch {
		case broadcasts || drips || chatbot || inbox:
			sum.UsedCRM++
		case h.Reminders > 0:
			sum.RemindersOnly++
		default:
			sum.Inactive++
		}
	}
	return sum
}
