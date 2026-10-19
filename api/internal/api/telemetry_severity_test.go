package api

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// Severity is what makes a line stand out in Cloud Logging during a webinar, so the events
// that mean somebody may be hearing silence must not land as INFO among thousands of
// quality samples — and the ones that mean it has cleared must not look like a problem.
func TestTelemetrySeverity(t *testing.T) {
	ev := func(name string, payload map[string]any) types.TelemetryEvent {
		return types.TelemetryEvent{Event: name, Payload: payload}
	}
	cases := []struct {
		what string
		ev   types.TelemetryEvent
		want string
	}{
		{"a join is routine", ev("join_success", nil), "INFO"},
		{"a failure is an error", ev("track_subscription_failed", nil), "ERROR"},
		{"reconnecting is a warning", ev("reconnecting", nil), "WARNING"},
		{"a stalled microphone is a warning", ev("speaker_audio_stalled", nil), "WARNING"},
		{"a silent microphone is a warning", ev("speaker_audio_silent", nil), "WARNING"},
		{"nothing arriving from a speaker is a warning", ev("remote_audio_stalled", nil), "WARNING"},
		{"sound flowing again is routine", ev("speaker_audio_flowing", nil), "INFO"},
		{"noise suppression bypassed is a warning",
			ev("noise_suppression_state", map[string]any{"phase": "bypassed"}), "WARNING"},
		{"noise suppression broken is a warning",
			ev("noise_suppression_state", map[string]any{"phase": "broken"}), "WARNING"},
		{"noise suppression running is routine",
			ev("noise_suppression_state", map[string]any{"phase": "running"}), "INFO"},
		{"heavy packet loss is a warning",
			ev("quality_sample", map[string]any{"packetsLost": 5.0, "packetsReceived": 95.0}), "WARNING"},
		{"light packet loss is routine",
			ev("quality_sample", map[string]any{"packetsLost": 1.0, "packetsReceived": 99.0}), "INFO"},
	}
	for _, c := range cases {
		if got := severityFor(c.ev); got != c.want {
			t.Errorf("%s: severity %q, want %q", c.what, got, c.want)
		}
	}
}
