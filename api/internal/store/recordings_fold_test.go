package store

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestFoldRecordingSessionsMergesTakesIntoOneRow(t *testing.T) {
	first := types.Recording{
		ID: "a", Status: types.RecordingReady, SizeBytes: 10, DurationMs: 1000, CreatedAt: "2026-09-19T10:00:00Z",
	}
	second := types.Recording{
		ID: "b", Status: types.RecordingReady, SizeBytes: 20, DurationMs: 2000, CreatedAt: "2026-09-19T10:05:00Z",
	}
	got := foldRecordingSessions([]recordingRow{
		{rec: first},
		{rec: second, parentID: "a"},
	})
	if len(got) != 1 {
		t.Fatalf("sessions = %d, want 1", len(got))
	}
	if got[0].ID != "a" {
		t.Errorf("id = %s, want the original take", got[0].ID)
	}
	if len(got[0].Parts) != 2 {
		t.Fatalf("parts = %d, want 2", len(got[0].Parts))
	}
	if got[0].SizeBytes != 30 || got[0].DurationMs != 3000 {
		t.Errorf("size/duration = %d/%d, want the sum of both takes", got[0].SizeBytes, got[0].DurationMs)
	}
	if got[0].Status != types.RecordingReady {
		t.Errorf("status = %s, want ready", got[0].Status)
	}
}

func TestFoldRecordingSessionsKeepsAnInProgressTakeVisible(t *testing.T) {
	got := foldRecordingSessions([]recordingRow{
		{rec: types.Recording{ID: "a", Status: types.RecordingReady, SizeBytes: 10, CreatedAt: "2026-09-19T10:00:00Z"}},
		{rec: types.Recording{ID: "b", Status: types.RecordingActive, SizeBytes: 1, CreatedAt: "2026-09-19T10:05:00Z"}, parentID: "a"},
	})
	if got[0].Status != types.RecordingActive {
		t.Errorf("status = %s, want recording while a take is still open", got[0].Status)
	}
}
