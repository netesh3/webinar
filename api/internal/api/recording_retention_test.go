package api

import "testing"

func TestRecordingExpiresAt(t *testing.T) {
	got := recordingExpiresAt("2026-09-19T12:00:00Z", 30)
	if got != "2026-10-19T12:00:00Z" {
		t.Fatalf("expiresAt = %q, want 2026-10-19T12:00:00Z", got)
	}
	if recordingExpiresAt("2026-09-19T12:00:00Z", 0) != "" {
		t.Fatal("retention 0 should not set an expiry")
	}
	if recordingExpiresAt("", 30) != "" {
		t.Fatal("empty createdAt should not set an expiry")
	}
}
