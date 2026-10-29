package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The outbox sends each kind of mail with the Reply-To of the inbox that answers it:
 * the host's own inbox on mail sent for the host, invite@ when the host has none,
 * support@ on the platform's own mail, and a row's reply_to over all of them.
 * (29 Oct 2026) */
func TestOutboxReplyToByCategory(t *testing.T) {
	h := newHarness(t, withTickSecret)
	mail := &captureMail{}
	h.server.UseMail(mail)

	host := h.signup("Reply Host", "replyto-host@example.com", true)
	wb := h.newWebinar("Reply-To by category", nil)
	ctx := context.Background()
	setInbox := func(local any) {
		t.Helper()
		if _, err := h.store.Pool().Exec(ctx, `UPDATE users SET inbox_local = $2 WHERE id = $1`, host.ID, local); err != nil {
			t.Fatal(err)
		}
	}
	queue := func(n store.Notification) {
		t.Helper()
		if err := h.store.Notify(ctx, h.store.DB(), n); err != nil {
			t.Fatal(err)
		}
	}
	run := func() {
		t.Helper()
		if code, body := tick(t, h, testTickSecret); code != http.StatusOK || !strings.Contains(body, `"ran"`) {
			t.Fatalf("tick: %d %s", code, body)
		}
	}
	replyTo := func(to string) string {
		t.Helper()
		for _, m := range mail.msgs {
			if m.To == to {
				return m.ReplyTo
			}
		}
		t.Fatalf("no mail to %s in %+v", to, mail.msgs)
		return ""
	}

	setInbox("replyhost")
	queue(store.Notification{Email: "guest@example.com", Kind: types.NotifyRegistrationConfirmed, WebinarSlug: wb.ID,
		Subject: "You're in", Body: "See you there."})
	queue(store.Notification{Email: "recap@example.com", Kind: types.NotifySessionRecap, WebinarSlug: wb.ID,
		Subject: "Your AI recap", Body: "Here it is."})
	queue(store.Notification{Email: "reset@example.com", Kind: types.NotifyPasswordReset,
		Subject: "Reset your password", Body: "Use this link."})
	queue(store.Notification{Email: "review@example.com", Kind: types.NotifyHostRequest,
		Subject: "Hosting request", Body: "Please review.", ReplyTo: "applicant@example.com"})
	run()

	if got := replyTo("guest@example.com"); got != "replyhost@webinarliv.com" {
		t.Errorf("attendee mail Reply-To = %q, want the host's inbox", got)
	}
	if got := replyTo("recap@example.com"); got != types.ContactSupport {
		t.Errorf("host recap Reply-To = %q, want %s", got, types.ContactSupport)
	}
	if got := replyTo("reset@example.com"); got != types.ContactSupport {
		t.Errorf("password reset Reply-To = %q, want %s", got, types.ContactSupport)
	}
	if got := replyTo("review@example.com"); got != "applicant@example.com" {
		t.Errorf("hosting request Reply-To = %q, want the row's own", got)
	}
	if got := replyTo(host.Email); got != types.ContactSupport {
		t.Errorf("verification Reply-To = %q, want %s", got, types.ContactSupport)
	}

	// A host with no inbox of their own: the invitation's replies go to invite@.
	setInbox(nil)
	queue(store.Notification{Email: "panelist@example.com", Kind: types.NotifyPanelistInvited, WebinarSlug: wb.ID,
		Subject: "You're on the panel", Body: "Join the stage."})
	run()
	if got := replyTo("panelist@example.com"); got != types.ContactInvite {
		t.Errorf("panelist invite Reply-To = %q, want %s", got, types.ContactInvite)
	}
}
