package api

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

func leadServer() *Server {
	return &Server{cfg: config.Config{DefaultAttendeeLimit: 50, MaxAttendees: 500}}
}

func leadInput(at time.Time, status types.WebinarStatus) types.WebinarInput {
	return types.WebinarInput{
		Topic:    "Lead time",
		StartsAt: at.UTC().Format(time.RFC3339),
		Duration: 60,
		TimeZone: "UTC",
		Status:   status,
		Kind:     types.KindLive,
		Approval: types.ApprovalAutomatic,
	}
}

func TestScheduleLead(t *testing.T) {
	s := leadServer()

	_, fields := s.normalizeWebinarInput(leadInput(time.Now().Add(30*time.Minute), types.StatusScheduled), true, "")
	if fields["startsAt"] != scheduleLeadError {
		t.Fatalf("create 30m ahead: startsAt = %q, want %q (fields %v)", fields["startsAt"], scheduleLeadError, fields)
	}

	_, fields = s.normalizeWebinarInput(leadInput(time.Now().Add(-time.Minute), types.StatusScheduled), true, "")
	if fields["startsAt"] != scheduleLeadError {
		t.Fatalf("create in the past: startsAt = %q, want %q", fields["startsAt"], scheduleLeadError)
	}

	_, fields = s.normalizeWebinarInput(leadInput(time.Now().Add(2*time.Hour), types.StatusScheduled), true, "")
	if msg := fields["startsAt"]; msg != "" {
		t.Fatalf("create 2h ahead rejected: %q (fields %v)", msg, fields)
	}

	// Instant has no time to pick. The hour lead stays on the schedule form.
	instant := leadInput(time.Now().Add(5*time.Minute), types.StatusScheduled)
	instant.Instant = true
	_, fields = s.normalizeWebinarInput(instant, true, "")
	if msg := fields["startsAt"]; msg != "" {
		t.Fatalf("instant create rejected a soon start: %q", msg)
	}

	// A draft is not a commitment to run, so a soon start is still a sketch.
	_, fields = s.normalizeWebinarInput(leadInput(time.Now().Add(10*time.Minute), types.StatusDraft), true, "")
	if msg := fields["startsAt"]; msg != "" {
		t.Fatalf("draft create rejected a soon start: %q", msg)
	}

	soon := time.Now().Add(20 * time.Minute).UTC().Truncate(time.Second)
	stored := soon.Format(time.RFC3339)

	_, fields = s.normalizeWebinarInput(leadInput(soon, types.StatusScheduled), false, stored)
	if msg := fields["startsAt"]; msg != "" {
		t.Fatalf("edit that keeps a soon start was rejected: %q", msg)
	}

	// Seconds the form cannot express are the same minute, not a new start.
	withSeconds := time.Now().Add(25 * time.Minute).UTC().Truncate(time.Minute).Add(30 * time.Second)
	_, fields = s.normalizeWebinarInput(
		leadInput(withSeconds.Truncate(time.Minute), types.StatusScheduled),
		false,
		withSeconds.Format(time.RFC3339),
	)
	if msg := fields["startsAt"]; msg != "" {
		t.Fatalf("edit that only drops seconds was rejected: %q", msg)
	}

	_, fields = s.normalizeWebinarInput(
		leadInput(time.Now().Add(15*time.Minute), types.StatusScheduled),
		false,
		time.Now().Add(3*time.Hour).UTC().Format(time.RFC3339),
	)
	if fields["startsAt"] != scheduleLeadError {
		t.Fatalf("moving a start inside the hour: startsAt = %q, want %q", fields["startsAt"], scheduleLeadError)
	}

	_, fields = s.normalizeWebinarInput(
		leadInput(time.Now().Add(3*time.Hour), types.StatusScheduled),
		false,
		time.Now().Add(20*time.Minute).UTC().Format(time.RFC3339),
	)
	if msg := fields["startsAt"]; msg != "" {
		t.Fatalf("moving a soon start out past the hour was rejected: %q", msg)
	}
}
