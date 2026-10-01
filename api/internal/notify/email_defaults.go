package notify

import (
	"regexp"
	"strings"
)

/* Default email templates.
 *
 * These are the messages the product sends on a host's behalf. The subject and
 * body are the current wording, with {{tokens}} where a webinar fills in a
 * name, a time, or a link. Follow-ups and no-shows go out on WhatsApp, not as
 * email, so they are not in this list.
 *
 * An uncustomized row is not what the sender reads: the sender keeps using the
 * functions in this package. FillEmail is for a row the host has edited, and
 * for checking that these defaults still say the same thing.
 */

const (
	TplRegistrationConfirmed = "registration_confirmed"
	TplRegistrationApproved  = "registration_approved"
	TplRegistrationDeclined  = "registration_declined"
	TplReminder              = "reminder"
	TplReplayReady           = "replay_ready"
	TplPanelistInvited       = "panelist_invited"
	TplPanelistRescheduled   = "panelist_rescheduled"
	TplPanelistCancelled     = "panelist_cancelled"
)

// EmailDefault is one required template.
type EmailDefault struct {
	Key     string
	Name    string
	Subject string
	Body    string
}

// DefaultEmailTemplates is the required set, in the order a host should see them.
func DefaultEmailTemplates() []EmailDefault {
	return []EmailDefault{
		{
			Key: TplRegistrationConfirmed, Name: "Registration confirmation",
			Subject: "You're registered: {{topic}}",
			Body: "{{greeting}}\n\n" +
				"You're registered for {{quoted_topic}}.\n\n" +
				"When: {{when}}\n\n" +
				"Your personal join link:\n" +
				"{{join_url}}\n\n" +
				"A calendar file is attached so you can add this to your calendar.\n" +
				"This link is yours alone — anyone who has it can take your place, so please don't forward it.\n\n" +
				"See you there,\n" +
				"{{host}}\n",
		},
		{
			Key: TplRegistrationApproved, Name: "Registration approved",
			Subject: "You're in: {{topic}}",
			Body: "{{greeting}}\n\n" +
				"Your registration for {{quoted_topic}} has been approved.\n\n" +
				"When: {{when}}\n\n" +
				"Your personal join link:\n" +
				"{{join_url}}\n\n" +
				"This link is yours alone — anyone who has it can take your place, so please don't forward it.\n\n" +
				"See you there,\n" +
				"{{host}}\n",
		},
		{
			Key: TplRegistrationDeclined, Name: "Registration declined",
			Subject: "About your registration for {{topic}}",
			Body: "{{greeting}}\n\n" +
				"Your registration for {{quoted_topic}} wasn't approved, so you won't be able to join this session.\n\n" +
				"If you think that's a mistake, reply to this message and the host can take another look.\n",
		},
		{
			Key: TplReminder, Name: "Reminder",
			Subject: "Starting {{window}}: {{topic}}",
			Body: "{{greeting}}\n\n" +
				"{{quoted_topic}} starts {{window}}.\n\n" +
				"When: {{when}}\n\n" +
				"Your personal join link:\n" +
				"{{join_url}}\n\n" +
				"This link is yours alone — anyone who has it can take your place, so please don't forward it.\n",
		},
		{
			Key: TplReplayReady, Name: "Replay",
			Subject: "The recording is ready: {{topic}}",
			Body: "{{greeting}}\n\n" +
				"The recording of {{quoted_topic}} is now available to watch.\n\n" +
				"Watch it here:\n" +
				"{{replay_url}}\n\n" +
				"Passcode: {{passcode}}\n\n" +
				"{{survey}}\n\n" +
				"Thanks for joining,\n" +
				"{{host}}\n",
		},
		{
			Key: TplPanelistInvited, Name: "Panelist invitation",
			Subject: "You're a panelist: {{topic}}",
			Body: "{{panelist_greeting}}\n\n" +
				"{{invite_lead}}\n\n" +
				"When: {{when}}\n\n" +
				"Join the stage here:\n" +
				"{{stage_url}}\n\n" +
				"{{sign_in_note}}\n\n" +
				"{{invite_calendar}}\n\n" +
				"Thanks,\n" +
				"{{signer}}\n",
		},
		{
			Key: TplPanelistRescheduled, Name: "Panelist reschedule",
			Subject: "New time: {{topic}}",
			Body: "{{panelist_greeting}}\n\n" +
				"{{quoted_topic}} has moved to a new time. You're still on the panel.\n\n" +
				"New time: {{when}}\n" +
				"Was: {{was}}\n\n" +
				"Your stage link hasn't changed:\n" +
				"{{stage_url}}\n\n" +
				"{{sign_in_note}}\n\n" +
				"{{reschedule_calendar}}\n\n" +
				"Thanks,\n" +
				"{{signer}}\n",
		},
		{
			Key: TplPanelistCancelled, Name: "Panelist cancellation",
			Subject: "Cancelled: {{topic}}",
			Body: "{{panelist_greeting}}\n\n" +
				"{{cancel_lead}}\n\n" +
				"{{cancel_note}}\n\n" +
				"Thanks,\n" +
				"{{signer}}\n",
		},
	}
}

// EmailDefaultByKey returns one required template.
func EmailDefaultByKey(key string) (EmailDefault, bool) {
	for _, d := range DefaultEmailTemplates() {
		if d.Key == key {
			return d, true
		}
	}
	return EmailDefault{}, false
}

var tokenPattern = regexp.MustCompile(`\{\{([a-z_]+)\}\}`)

// FillEmail applies a host's edited wording. Empty optional lines (no time, no
// passcode, no host sign-off) are removed so a template still reads like the
// built-in message.
func FillEmail(subject, body string, in Invite, window string) (string, string) {
	vars := emailVars(in, window)
	subject = replaceTokens(subject, vars)
	body = replaceTokens(body, vars)
	return strings.TrimRight(subject, "\n"), cleanupFilled(body, in)
}

func emailVars(in Invite, window string) map[string]string {
	survey := ""
	if u := strings.TrimSpace(in.SurveyURL); u != "" {
		title := strings.TrimSpace(in.SurveyTitle)
		if title == "" {
			title = "How was the session?"
		}
		survey = title + " The host would love your feedback in a short survey:\n" + u
	}
	inviteCalendar := ""
	if in.Calendar {
		inviteCalendar = "The attached calendar file adds the session to your calendar."
	}
	rescheduleCalendar := ""
	if in.Calendar {
		rescheduleCalendar = "The attached calendar file moves the event already in your calendar."
	}
	cancelNote := "You don't need to do anything. If you added it to your calendar, you can remove it."
	if in.Calendar {
		cancelNote = "You don't need to do anything. The attached calendar file removes the event from your calendar."
	}
	cancelLead := quoted(in.Topic) + " has been cancelled."
	if strings.TrimSpace(in.WhenText) != "" {
		cancelLead = quoted(in.Topic) + ", scheduled for " + in.WhenText + ", has been cancelled."
	}
	inviteLead := "You've been added as a panelist for " + quoted(in.Topic) + "."
	if h := strings.TrimSpace(in.HostName); h != "" {
		inviteLead = h + " has added you as a panelist for " + quoted(in.Topic) + "."
	}
	return map[string]string{
		"greeting":            greeting(in.Name),
		"panelist_greeting":   panelistGreeting(in.Name),
		"topic":               strings.TrimSpace(in.Topic),
		"quoted_topic":        quoted(in.Topic),
		"when":                in.WhenText,
		"window":              window,
		"join_url":            in.JoinURL,
		"replay_url":          in.ReplayURL,
		"passcode":            strings.TrimSpace(in.Passcode),
		"survey":              survey,
		"host":                strings.TrimSpace(in.HostName),
		"signer":              signer(in),
		"stage_url":           in.StageURL,
		"was":                 in.WasText,
		"sign_in_note":        signInNote(in),
		"invite_lead":         inviteLead,
		"invite_calendar":     inviteCalendar,
		"reschedule_calendar": rescheduleCalendar,
		"cancel_lead":         cancelLead,
		"cancel_note":         cancelNote,
	}
}

func replaceTokens(s string, vars map[string]string) string {
	return tokenPattern.ReplaceAllStringFunc(s, func(match string) string {
		key := tokenPattern.FindStringSubmatch(match)
		if len(key) != 2 {
			return match
		}
		if v, ok := vars[key[1]]; ok {
			return v
		}
		return match
	})
}

func cleanupFilled(body string, in Invite) string {
	host := strings.TrimSpace(in.HostName)
	stage := strings.TrimSpace(in.StageURL)
	lines := strings.Split(body, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		trim := strings.TrimRight(line, " \t")
		switch strings.TrimSpace(trim) {
		case "When:", "New time:", "Was:", "Passcode:":
			continue
		case "See you there,", "Thanks for joining,":
			if host == "" {
				continue
			}
		case "Join the stage here:", "Your stage link hasn't changed:":
			if stage == "" {
				continue
			}
		}
		kept = append(kept, trim)
	}
	var b strings.Builder
	blank := false
	for _, line := range kept {
		if strings.TrimSpace(line) == "" {
			if blank {
				continue
			}
			blank = true
			b.WriteByte('\n')
			continue
		}
		blank = false
		b.WriteString(line)
		b.WriteByte('\n')
	}
	out := strings.Trim(b.String(), "\n")
	if out == "" {
		return ""
	}
	return out + "\n"
}
