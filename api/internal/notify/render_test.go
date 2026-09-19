package notify

import (
	"strings"
	"testing"
)

func TestApprovalEmailDoesNotCarryJoinLink(t *testing.T) {
	in := Invite{Name: "Asha", Topic: "Launch", JoinURL: "https://example/room?k=SECRET", HostName: "Ganesh"}
	_, body := ApprovalRequested(in, 1)
	if strings.Contains(body, "SECRET") || strings.Contains(body, in.JoinURL) {
		t.Fatal("host alert must not include the join link")
	}
}

func TestConfirmedAndApprovedCarryJoinLink(t *testing.T) {
	in := Invite{Name: "Asha", Topic: "Launch", JoinURL: "https://example/room?k=SECRET", WhenText: "Tue 10:00"}
	_, confirmed := RegistrationConfirmed(in)
	_, approved := RegistrationApproved(in)
	_, reminder := Reminder(in, "in 1 hour")
	for _, body := range []string{confirmed, approved, reminder} {
		if !strings.Contains(body, in.JoinURL) {
			t.Fatalf("expected join link in %q", body)
		}
	}
}

func TestDeclinedHasNoJoinLink(t *testing.T) {
	in := Invite{Topic: "Launch", JoinURL: "https://example/room?k=SECRET"}
	_, body := RegistrationDeclined(in)
	if strings.Contains(body, "SECRET") {
		t.Fatal("decline must not include the join link")
	}
}
