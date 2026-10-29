package notify

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// One mail per category, and the two addresses that outrank the category. (29 Oct 2026)
func TestReplyToForPicksTheInboxThatAnswers(t *testing.T) {
	cases := []struct {
		name              string
		kind              types.NotificationKind
		rowReplyTo, inbox string
		want              string
	}{
		{"panelist invite goes to invite@", types.NotifyPanelistInvited, "", "", types.ContactInvite},
		{"panelist reschedule goes to invite@", types.NotifyPanelistRescheduled, "", "", types.ContactInvite},
		{"panelist cancel goes to invite@", types.NotifyPanelistCancelled, "", "", types.ContactInvite},
		{"attendee confirmation without a host inbox goes to invite@", types.NotifyRegistrationConfirmed, "", "", types.ContactInvite},
		{"attendee reminder without a host inbox goes to invite@", types.NotifyReminder, "", "", types.ContactInvite},
		{"replay without a host inbox goes to invite@", types.NotifyReplayReady, "", "", types.ContactInvite},
		{"password reset goes to support@", types.NotifyPasswordReset, "", "", types.ContactSupport},
		{"welcome goes to support@", types.NotifyWelcome, "", "", types.ContactSupport},
		{"verification goes to support@", types.NotifyEmailVerify, "", "", types.ContactSupport},
		{"host's recap goes to support@, not their own inbox", types.NotifySessionRecap, "", "coach", types.ContactSupport},
		{"host's approval request goes to support@", types.NotifyApprovalRequested, "", "coach", types.ContactSupport},
		{"recording expiry goes to support@", types.NotifyRecordingExpiring, "", "coach", types.ContactSupport},
		{"the host's inbox wins on attendee mail", types.NotifyReminder, "", "coach", "coach@webinarliv.com"},
		{"the host's inbox wins on a panelist invite", types.NotifyPanelistInvited, "", "coach", "coach@webinarliv.com"},
		{"a row's own reply_to wins over everything", types.NotifyHostRequest, "ada@example.com", "coach", "ada@example.com"},
		{"a row's reply_to wins on attendee mail too", types.NotifyReminder, " host@example.com ", "coach", "host@example.com"},
		{"a malformed host inbox falls back to the category", types.NotifyReminder, "", "Not A Local!", types.ContactInvite},
	}
	for _, c := range cases {
		if got := ReplyToFor(c.kind, c.rowReplyTo, c.inbox); got != c.want {
			t.Errorf("%s: ReplyToFor(%s) = %q, want %q", c.name, c.kind, got, c.want)
		}
	}
}

// The addresses are the company's, at its domain, and never the From address.
func TestContactAddressesAreTheCompanys(t *testing.T) {
	for _, a := range []string{types.ContactSupport, types.ContactHello, types.ContactBilling, types.ContactInvite,
		types.ContactSecurity, types.ContactPrivacy, types.ContactLegal, types.ContactAbuse, types.ContactPartners} {
		if len(a) < len("@webinarliv.com") || a[len(a)-len("@webinarliv.com"):] != "@webinarliv.com" || a == "noreply@webinarliv.com" {
			t.Errorf("contact address %q", a)
		}
	}
}
