package notify

import (
	"strings"
	"testing"
)

func TestDefaultEmailsMatchTheBuiltInWording(t *testing.T) {
	full := Invite{
		Name: "Ada Lovelace", Topic: "Fund Basics", WhenText: "18:00 on 2 October 2026 IST",
		JoinURL: "https://webinarliv.com/join", HostName: "Meera Shah",
		ReplayURL: "https://webinarliv.com/replay", Passcode: "1234",
		SurveyURL: "https://webinarliv.com/survey", SurveyTitle: "How was it?",
		StageURL: "https://webinarliv.com/stage", Email: "ada@example.com",
		WasText: "17:00 on 1 October 2026 IST", Product: "Webinar Liv", Calendar: true,
	}
	checks := []struct {
		key    string
		window string
		want   func(Invite) (string, string)
	}{
		{TplRegistrationConfirmed, "", func(in Invite) (string, string) { return RegistrationConfirmed(in) }},
		{TplRegistrationApproved, "", func(in Invite) (string, string) { return RegistrationApproved(in) }},
		{TplRegistrationDeclined, "", func(in Invite) (string, string) { return RegistrationDeclined(in) }},
		{TplReminder, "in 1 hour", func(in Invite) (string, string) { return Reminder(in, "in 1 hour") }},
		{TplReplayReady, "", func(in Invite) (string, string) { return ReplayReady(in) }},
		{TplPanelistInvited, "", func(in Invite) (string, string) {
			s, b, _ := PanelistInvited(in)
			return s, b
		}},
		{TplPanelistRescheduled, "", func(in Invite) (string, string) {
			s, b, _ := PanelistRescheduled(in)
			return s, b
		}},
		{TplPanelistCancelled, "", func(in Invite) (string, string) {
			s, b, _ := PanelistCancelled(in)
			return s, b
		}},
	}
	if len(checks) != len(DefaultEmailTemplates()) {
		t.Fatalf("defaults = %d, checks = %d", len(DefaultEmailTemplates()), len(checks))
	}
	for _, check := range checks {
		d, ok := EmailDefaultByKey(check.key)
		if !ok {
			t.Fatalf("missing %s", check.key)
		}
		gotS, gotB := FillEmail(d.Subject, d.Body, full, check.window)
		wantS, wantB := check.want(full)
		if gotS != wantS || strings.TrimRight(gotB, "\n") != strings.TrimRight(wantB, "\n") {
			t.Fatalf("%s\nsubject got %q\nwant %q\nbody got:\n%s\nwant:\n%s", check.key, gotS, wantS, gotB, wantB)
		}
	}

	bare := Invite{Topic: "Fund Basics", JoinURL: "https://webinarliv.com/join"}
	for _, key := range []string{TplRegistrationConfirmed, TplRegistrationApproved, TplReminder} {
		d, _ := EmailDefaultByKey(key)
		window := ""
		if key == TplReminder {
			window = "in 1 day"
		}
		gotS, gotB := FillEmail(d.Subject, d.Body, bare, window)
		var wantS, wantB string
		switch key {
		case TplRegistrationConfirmed:
			wantS, wantB = RegistrationConfirmed(bare)
		case TplRegistrationApproved:
			wantS, wantB = RegistrationApproved(bare)
		case TplReminder:
			wantS, wantB = Reminder(bare, window)
		}
		if gotS != wantS || strings.TrimRight(gotB, "\n") != strings.TrimRight(wantB, "\n") {
			t.Fatalf("bare %s\nsubject got %q want %q\nbody got:\n%s\nwant:\n%s", key, gotS, wantS, gotB, wantB)
		}
	}

	replay := Invite{Topic: "Fund Basics", ReplayURL: "https://webinarliv.com/replay"}
	d, _ := EmailDefaultByKey(TplReplayReady)
	gotS, gotB := FillEmail(d.Subject, d.Body, replay, "")
	wantS, wantB := ReplayReady(replay)
	if gotS != wantS || strings.TrimRight(gotB, "\n") != strings.TrimRight(wantB, "\n") {
		t.Fatalf("replay without extras\nsubject got %q want %q\nbody got:\n%s\nwant:\n%s", gotS, wantS, gotB, wantB)
	}
}
