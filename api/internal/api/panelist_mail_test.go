package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

/* Panelist mail, through the real routes and the real outbox.
 *
 * What matters: a panelist entered on the schedule form is emailed once, with the STAGE link
 * (/host/<slug>/room) and never an attendee join link; a draft emails nobody; moving the start
 * tells the panel; somebody taken off and put back is invited again; deleting a scheduled
 * webinar tells the panel it is cancelled. */

func (f *fakeMail) to(email, subjectPrefix string) []notify.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []notify.Message
	for _, m := range f.sent {
		if m.To == email && strings.HasPrefix(m.Subject, subjectPrefix) {
			out = append(out, m)
		}
	}
	return out
}

func TestPanelistsAreEmailedTheirStageLink(t *testing.T) {
	h := newHarness(t)
	mail := &fakeMail{}
	h.server.UseMail(mail)

	h.signup("Pam Panel", "pam.panel@test.dev", false)
	h.signup("Pia Panel", "pia.panel@test.dev", false)
	h.signup("Mail Host", "mailhost@test.dev", true)

	// A draft is not a commitment: nobody is emailed yet.
	wb := h.newWebinar("Panel Mail", func(in *types.WebinarInput) {
		in.Status = types.StatusDraft
		in.PanelistEmails = []string{"Pam.Panel@test.dev", "nobody-yet@test.dev"}
	})
	h.server.WaitBackground()
	if got := mail.to("pam.panel@test.dev", "You're a panelist"); len(got) != 0 {
		t.Fatalf("a draft sent %d invitations", len(got))
	}

	update := func(mutate func(*types.WebinarInput)) types.Webinar {
		t.Helper()
		in := types.WebinarInput{
			Topic: wb.Topic, StartsAt: wb.StartsAt, Duration: 60, TimeZone: "UTC",
			Kind: types.KindLive, Status: types.StatusScheduled, RegistrationRequired: true,
			Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
			PanelistEmails: []string{"pam.panel@test.dev"},
		}
		mutate(&in)
		res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/", in)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("update webinar: status %d body %s", res.StatusCode, raw)
		}
		var out types.Webinar
		h.decode(raw, &out)
		h.server.WaitBackground()
		return out
	}

	// Scheduling it invites the panel.
	wb = update(func(*types.WebinarInput) {})
	invites := mail.to("pam.panel@test.dev", "You're a panelist")
	if len(invites) != 1 {
		t.Fatalf("invitations to pam = %d, want 1", len(invites))
	}
	inv := invites[0]
	stage := "/host/" + wb.ID + "/room"
	if !strings.Contains(inv.Body, stage) {
		t.Errorf("invitation has no stage link %q:\n%s", stage, inv.Body)
	}
	if strings.Contains(inv.Body, "/webinars/"+wb.ID) || strings.Contains(inv.Body, "?k=") {
		t.Errorf("invitation carries an attendee link:\n%s", inv.Body)
	}
	if !strings.Contains(inv.Body, "Mail Host") || !strings.Contains(inv.ICS, "BEGIN:VCALENDAR") {
		t.Errorf("invitation missing host name or calendar file")
	}
	if got := mail.to("nobody-yet@test.dev", ""); len(got) != 0 {
		t.Errorf("an address with no account was emailed")
	}

	// Saving again without changes does not invite twice.
	wb = update(func(*types.WebinarInput) {})
	if got := mail.to("pam.panel@test.dev", "You're a panelist"); len(got) != 1 {
		t.Fatalf("after a second save, invitations = %d, want 1", len(got))
	}

	// Adding a second panelist invites only them; moving the start tells the one already invited.
	newStart := time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	wb = update(func(in *types.WebinarInput) {
		in.StartsAt = newStart
		in.PanelistEmails = []string{"pam.panel@test.dev", "pia.panel@test.dev"}
	})
	if got := mail.to("pia.panel@test.dev", "You're a panelist"); len(got) != 1 {
		t.Errorf("invitations to pia = %d, want 1", len(got))
	}
	if got := mail.to("pia.panel@test.dev", "New time"); len(got) != 0 {
		t.Errorf("a new panelist was sent a reschedule too")
	}
	moved := mail.to("pam.panel@test.dev", "New time")
	if len(moved) != 1 || !strings.Contains(moved[0].Body, stage) {
		t.Fatalf("reschedule to pam = %+v, want one with the stage link", moved)
	}

	// Taken off and put back: invited again.
	wb = update(func(in *types.WebinarInput) { in.StartsAt = newStart; in.PanelistEmails = nil })
	wb = update(func(in *types.WebinarInput) {
		in.StartsAt = newStart
		in.PanelistEmails = []string{"pam.panel@test.dev", "pia.panel@test.dev"}
	})
	if got := mail.to("pam.panel@test.dev", "You're a panelist"); len(got) != 2 {
		t.Errorf("after being re-added, invitations to pam = %d, want 2", len(got))
	}

	// Deleting the scheduled webinar tells the panel.
	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()
	for _, who := range []string{"pam.panel@test.dev", "pia.panel@test.dev"} {
		got := mail.to(who, "Cancelled")
		if len(got) != 1 {
			t.Errorf("cancellations to %s = %d, want 1", who, len(got))
		} else if strings.Contains(got[0].Body, "/room") {
			t.Errorf("a cancellation carries a link:\n%s", got[0].Body)
		}
	}
}

func TestAddingAPanelistFromTheWebinarPageInvitesThem(t *testing.T) {
	h := newHarness(t)
	mail := &fakeMail{}
	h.server.UseMail(mail)

	h.signup("Solo Panel", "solo.panel@test.dev", false)
	h.signup("Page Host", "pagehost@test.dev", true)
	wb := h.newWebinar("Panel Page", nil)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "solo.panel@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()
	got := mail.to("solo.panel@test.dev", "You're a panelist")
	if len(got) != 1 || !strings.Contains(got[0].Body, "/host/"+wb.ID+"/room") {
		t.Fatalf("invitations = %+v, want one with the stage link", got)
	}
}
