package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* A host runs one webinar or meeting at a time: starting another while one is live
 * is refused with the live one's name, until that one is ended. A rejoin of the live
 * one is not a second start. */

func TestHostRunsOneLiveSessionAtATime(t *testing.T) {
	h := newHarness(t)
	h.signup("One Live", "one-live@test.dev", true)
	first := h.newWebinar("First session", nil)
	second := h.newWebinar("Second session", nil)

	start := func(slug string) (*http.Response, []byte) {
		return h.do(http.MethodPost, "/api/host/webinars/"+slug+"/start", nil)
	}
	if res, raw := start(first.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("start first: %d %s", res.StatusCode, raw)
	}

	res, raw := start(second.ID)
	h.wantError(res, raw, http.StatusConflict, "already_live")
	if !strings.Contains(string(raw), "First session") {
		t.Fatalf("refusal should name the live session: %s", raw)
	}
	if got := h.webinarStatus(second.ID); got != string(types.StatusScheduled) {
		t.Fatalf("second status = %q after the refusal, want scheduled", got)
	}

	// Rejoining the live one is still fine.
	if res, raw := start(first.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin first: %d %s", res.StatusCode, raw)
	}

	// An instant meeting is refused before it is created, so no row is left behind.
	forceFeature(t, h, meAccount(t, h).ID, types.FeatureInstantWebinar, true)
	res, raw = h.do(http.MethodPost, "/api/host/webinars",
		types.WebinarInput{Topic: "Meet now", Kind: types.KindMeeting, Instant: true, TimeZone: "UTC"})
	h.wantError(res, raw, http.StatusConflict, "already_live")
	if !strings.Contains(string(raw), "webinar") {
		t.Fatalf("refusal should say the live one is a webinar: %s", raw)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+first.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end first: %d %s", res.StatusCode, raw)
	}
	if res, raw := start(second.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("start second after ending the first: %d %s", res.StatusCode, raw)
	}

	// Another host's live session is theirs: it does not hold this one back.
	h.logout()
	h.signup("Other Host", "one-live-other@test.dev", true)
	other := h.newWebinar("Other host's session", nil)
	if res, raw := start(other.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("other host start: %d %s", res.StatusCode, raw)
	}
}
