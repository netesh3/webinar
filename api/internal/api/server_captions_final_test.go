package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/* The after-session pass is skipped for load tests and for webinars that are gone
 * (captionAgentMeta, handleInternalTranscriptWanted; 2026-10-27). */

func TestTranscriptWantedAnswersForRealLoadTestAndGone(t *testing.T) {
	h := newHarness(t, captionsConfig)
	ctx := context.Background()
	h.signup("Wanted Host", "srvcap-wanted@test.dev", true)
	real := h.liveWebinar("A real session", nil)
	h.signup("Wanted LT Host", "srvcap-wanted-lt@loadtest.invalid", true)
	test := h.liveWebinar("A load test", nil)
	if err := h.store.SetLoadTest(ctx, test.ID, 5, ""); err != nil {
		t.Fatalf("mark load test: %v", err)
	}

	want := func(room string, status int, body map[string]any) {
		t.Helper()
		res, raw := h.agentPost("/api/internal/transcripts/wanted", testCaptionsSecret, map[string]string{"room": room})
		if res.StatusCode != status {
			t.Fatalf("%s: status %d %s, want %d", room, res.StatusCode, raw, status)
		}
		var got map[string]any
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("%s: body %s: %v", room, raw, err)
		}
		for k, v := range body {
			if got[k] != v {
				t.Fatalf("%s: %s = %v, want %v (body %s)", room, k, got[k], v, raw)
			}
		}
	}
	want("webinar_"+real.ID, http.StatusOK, map[string]any{"wanted": true})
	want("webinar_"+test.ID, http.StatusOK, map[string]any{"wanted": false, "reason": "load_test"})
	want("webinar_no-such-webinar-anywhere", http.StatusNotFound, map[string]any{"wanted": false, "gone": true})

	// The secret is required, as for the other agent endpoints.
	if res, raw := h.agentPost("/api/internal/transcripts/wanted", "wrong-secret", map[string]string{"room": "webinar_" + real.ID}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong secret: %d %s", res.StatusCode, raw)
	}
}

func TestCaptionDispatchMarksLoadTestsToSkipTheFinalPass(t *testing.T) {
	h := newHarness(t, captionsConfig)
	ctx := context.Background()
	// One live session per host: each webinar has its own, and each host turns captions on.
	h.signup("Dispatch Host", "srvcap-skip@test.dev", true)
	real := h.liveWebinar("Real captions", nil)
	if res, _, raw := h.setServerCaptions(real.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("captions on (real): %d %s", res.StatusCode, raw)
	}
	h.signup("Dispatch LT Host", "srvcap-skip-lt@loadtest.invalid", true)
	test := h.liveWebinar("Load test captions", nil)
	if err := h.store.SetLoadTest(ctx, test.ID, 5, ""); err != nil {
		t.Fatalf("mark load test: %v", err)
	}
	if res, _, raw := h.setServerCaptions(test.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("captions on (load test): %d %s", res.StatusCode, raw)
	}
	meta := func(slug string) map[string]string {
		t.Helper()
		h.rooms.mu.Lock()
		raw := h.rooms.dispatchMeta["webinar_"+slug]
		h.rooms.mu.Unlock()
		var md map[string]string
		if err := json.Unmarshal([]byte(raw), &md); err != nil {
			t.Fatalf("meta %q: %v", raw, err)
		}
		return md
	}
	if md := meta(real.ID); md["final"] != "" || md["slug"] != real.ID || !strings.HasPrefix(md["room"], "webinar_") {
		t.Fatalf("real session meta = %v, want no final flag", md)
	}
	if md := meta(test.ID); md["final"] != "skip" || md["slug"] != test.ID {
		t.Fatalf("load test meta = %v, want final=skip", md)
	}
}
