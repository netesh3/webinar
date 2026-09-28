package notify

import (
	"strings"
	"testing"
)

func TestPanelistMailCarriesOnlyTheStageLink(t *testing.T) {
	in := Invite{
		Name: "Pam", Topic: "Launch", WhenText: "Tue 10:00", HostName: "Ganesh",
		StageURL: "https://example/host/launch/room", JoinURL: "https://example/room?k=SECRET",
	}
	_, invited := PanelistInvited(in)
	_, moved := PanelistRescheduled(in)
	for _, body := range []string{invited, moved} {
		if !strings.Contains(body, in.StageURL) {
			t.Errorf("expected the stage link in %q", body)
		}
		if strings.Contains(body, "SECRET") {
			t.Errorf("a panelist mail carries an attendee join key: %q", body)
		}
	}
	if !strings.Contains(moved, "Tue 10:00") {
		t.Errorf("reschedule does not say the new time: %q", moved)
	}
	_, cancelled := PanelistCancelled(in)
	if strings.Contains(cancelled, in.StageURL) || strings.Contains(cancelled, "SECRET") {
		t.Errorf("a cancellation carries a link: %q", cancelled)
	}
}
