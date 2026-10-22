package api

import (
	"context"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// Auto mode stops answering once the host team is live after the recording: a human is.
func TestQAAutoOffLiveAfterTheRecording(t *testing.T) {
	wb := types.Webinar{Kind: types.KindSimulive, Status: types.StatusLive,
		SimuliveLiveAt: time.Now().UTC().Format(time.RFC3339)}
	wb.Options.SimuliveAutoAnswer = true
	if (&Server{}).qaAutoOn(context.Background(), wb) {
		t.Fatal("Auto mode on in live after")
	}
}

func TestSimulivePendingStartRules(t *testing.T) {
	now := time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	wb := types.Webinar{Kind: types.KindSimulive, Status: types.StatusScheduled,
		StartsAt: now.Add(10 * time.Minute).Format(time.RFC3339), Duration: 60}
	at, msg := simulivePendingStart(wb, types.SimuliveScheduleRequest{DelayMin: 5}, now)
	if msg != "" || !at.Equal(now.Add(15*time.Minute)) {
		t.Fatalf("auto delay: %s %q", at, msg)
	}
	wb.Options.SimuliveStart = types.SimuliveStartManual
	at, msg = simulivePendingStart(wb, types.SimuliveScheduleRequest{DelayMin: 5}, now)
	if msg != "" || !at.Equal(now.Add(5*time.Minute)) {
		t.Fatalf("manual delay with nothing pending: from now, got %s %q", at, msg)
	}
	if _, msg := simulivePendingStart(wb, types.SimuliveScheduleRequest{InMin: 75}, now); msg == "" {
		t.Fatal("a start past the scheduled end was allowed")
	}
	// Doors come forward with an earlier pending start.
	wb.SimuliveStartAt = now.Add(2 * time.Minute).Format(time.RFC3339)
	if opens, _ := simuliveDoorsOpenAt(wb); !opens.Equal(now.Add(-8 * time.Minute)) {
		t.Fatalf("doors open at %s", opens)
	}
	if target, ok := simuliveTarget(wb); !ok || !target.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("target %s %v", target, ok)
	}
}
