package integrations

import "github.com/netkumar/webcast/api/types"

func telegramProvider() Provider {
	return staticProvider{
		interest: true,
		card: types.IntegrationCard{
			ID:       "telegram",
			Name:     "Telegram",
			Tagline:  "Reminders and follow-ups",
			Category: types.IntegrationCategoryMessaging,
			Status:   types.IntegrationStatusSoon,
			Detail:   "Send reminders and follow-ups on Telegram, for attendees who prefer it to WhatsApp.",
			Mark:     "send",
			Tone:     "tg",
		},
	}
}

func comingSoon() []Provider {
	type row struct {
		id, name, detail, mark, text, tone string
	}
	rows := []row{
		{"google-calendar", "Google Calendar", "Your webinars on your calendar, time blocked", "calendar_month", "", "gc"},
		{"instagram", "Instagram", "Reminders by Instagram message", "photo_camera", "", "ig"},
		{"mailchimp", "Mailchimp", "Add everyone who registers to your email list", "", "M", "mc"},
		{"zapier", "Zapier", "Send new registrations to thousands of other apps", "bolt", "", "zp"},
	}
	out := make([]Provider, 0, len(rows))
	for _, r := range rows {
		out = append(out, staticProvider{card: types.IntegrationCard{
			ID:       r.id,
			Name:     r.name,
			Tagline:  r.detail,
			Category: types.IntegrationCategorySoon,
			Status:   types.IntegrationStatusSoon,
			Detail:   r.detail,
			Mark:     r.mark,
			Text:     r.text,
			Tone:     r.tone,
		}})
	}
	return out
}
