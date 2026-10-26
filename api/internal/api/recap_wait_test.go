package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/types"
)

/* The recap's wait for the after-session transcript always ends (instant-webinar-0273: a
 * session whose transcript never came sat "processing" for the whole wait). */

// recapSQL runs an UPDATE on slug's recap row.
func (h *harness) recapSQL(slug, set string) {
	h.t.Helper()
	if _, err := h.store.Pool().Exec(context.Background(), `
		UPDATE session_recaps r SET `+set+`
		  FROM webinars w WHERE w.id = r.webinar_id AND w.slug = $1`, slug); err != nil {
		h.t.Fatal(err)
	}
}

// captionedSessionEnded is a session with server captions, one live caption line, ended.
func captionedSessionEnded(t *testing.T, h *harness, host types.Account, topic string) string {
	t.Helper()
	wb := h.newWebinar(topic, nil)
	h.goLive(wb.ID)
	if err := h.store.SetServerCaptions(context.Background(), wb.ID, true); err != nil {
		t.Fatal(err)
	}
	h.caption(wb.ID, "user_"+host.ID, "only the live captions have this")
	h.endSession(wb.ID)
	return wb.ID
}

func TestRecapWaitExpiryWritesFromLiveCaptionsWithANotice(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	host := recapHost(t, h)
	slug := captionedSessionEnded(t, h, host, "Transcript never came")

	h.runRecaps()
	if model.callCount() != 0 {
		t.Fatal("did not wait for the transcript")
	}
	h.recapSQL(slug, `wait_until = now() - interval '1 second', due_at = now()`)
	h.runRecaps()
	got := h.getRecap(slug)
	if got.Status != types.RecapReady || got.Source != types.RecapSourceCaptions || got.Recap == nil {
		t.Fatalf("after the wait: %+v", got)
	}
	if got.Recap.Notice != aiwrite.TranscriptMissingNotice {
		t.Errorf("notice = %q, want the transcript-unavailable one", got.Recap.Notice)
	}
}

func TestRecapStopsWaitingAtTheDeferralCapAndTheMaxWait(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	host := recapHost(t, h)

	// Deferred too often: written from what there is, though wait_until is still ahead.
	capped := captionedSessionEnded(t, h, host, "Deferred too often")
	h.runRecaps()
	h.recapSQL(capped, `defers = 6, due_at = now()`)
	h.runRecaps()
	if got := h.getRecap(capped); got.Status != types.RecapReady || got.Source != types.RecapSourceCaptions {
		t.Fatalf("at the deferral cap: %+v", got)
	}

	// A wait_until far past the end (however it got there) is not honoured past recapMaxWait.
	long := captionedSessionEnded(t, h, host, "Waited too long")
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE webinars SET started_at = now() - interval '2 hours', ended_at = now() - interval '40 minutes' WHERE slug = $1`, long); err != nil {
		t.Fatal(err)
	}
	h.recapSQL(long, `wait_until = now() + interval '3 hours', due_at = now()`)
	h.runRecaps()
	if got := h.getRecap(long); got.Status != types.RecapReady {
		t.Fatalf("past the max wait: %+v", got)
	}
	if model.callCount() != 2 {
		t.Fatalf("model calls = %d, want 2", model.callCount())
	}

	// Each deferral is counted.
	counted := captionedSessionEnded(t, h, host, "Counted")
	h.runRecaps()
	var defers int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT r.defers FROM session_recaps r JOIN webinars w ON w.id = r.webinar_id WHERE w.slug = $1`, counted).Scan(&defers); err != nil {
		t.Fatal(err)
	}
	if defers != 1 {
		t.Errorf("defers = %d, want 1", defers)
	}
}

func TestRecapGenerateNow(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	host := recapHost(t, h)
	slug := captionedSessionEnded(t, h, host, "Host is impatient")
	if got := h.getRecap(slug); got.Status != types.RecapPending || got.Reason != types.RecapReasonWaitingTranscript {
		t.Fatalf("waiting = %+v", got)
	}

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recap/generate", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("generate now: %d %s", res.StatusCode, raw)
	}
	var got types.SessionRecapResponse
	h.decode(raw, &got)
	if got.Status != types.RecapReady || got.Source != types.RecapSourceCaptions || got.Recap == nil ||
		got.Recap.Notice != aiwrite.TranscriptMissingNotice {
		t.Fatalf("generated now: %+v", got)
	}
	if model.callCount() != 1 {
		t.Fatalf("model calls = %d", model.callCount())
	}

	// Written once: a second press is refused, and nothing is written again.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recap/generate", nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("second generate: %d %s, want 409", res.StatusCode, raw)
	}
	if model.callCount() != 1 {
		t.Fatalf("model calls after a second press = %d", model.callCount())
	}

	// Nobody else's.
	h.logout()
	h.signup("Not The Host", "not-the-host-generate@test.dev", true)
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recap/generate", nil); res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Fatalf("generate by another host: %d", res.StatusCode)
	}
}

/* A silent session: the caption agent posts an empty transcript, and that ends the wait at
 * once. Without that post, after the wait it says the transcript was unavailable rather than
 * that nothing was said. */
func TestRecapSilentSessionDoesNotWaitOutTheTranscript(t *testing.T) {
	h, model := aiHarness(t, recapReply, captionsConfig)
	ctx := context.Background()
	recapHost(t, h)

	quiet := h.newWebinar("Silent", nil)
	h.goLive(quiet.ID)
	_ = h.store.SetServerCaptions(ctx, quiet.ID, true)
	h.endSession(quiet.ID)
	if got := h.getRecap(quiet.ID); got.Status != types.RecapPending {
		t.Fatalf("before the transcript: %+v", got)
	}
	res, raw := h.agentPost("/api/internal/transcripts", testCaptionsSecret, map[string]any{
		"room": "webinar_" + quiet.ID, "model": "large-v3-turbo", "segments": []map[string]any{},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("empty transcript: %d %s", res.StatusCode, raw)
	}
	if got := h.getRecap(quiet.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonEmpty {
		t.Fatalf("after an empty transcript: %+v", got)
	}

	lost := h.newWebinar("Transcript lost, nothing else", nil)
	h.goLive(lost.ID)
	_ = h.store.SetServerCaptions(ctx, lost.ID, true)
	h.endSession(lost.ID)
	h.runRecaps()
	h.recapSQL(lost.ID, `wait_until = now() - interval '1 second', due_at = now()`)
	h.runRecaps()
	if got := h.getRecap(lost.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonTranscriptUnavailable {
		t.Fatalf("transcript lost: %+v", got)
	}
	if model.callCount() != 0 {
		t.Fatalf("model calls = %d, want none", model.callCount())
	}
}

/* CAPTIONS_PROVIDER=deepgram: the live finals are the session transcript. The worker on the
 * video box posts them when the room ends (deploy/captions/webcaptions/stage.py), and that one
 * post completes the session: the recap is written at once from it, with no after-session pass
 * to wait for and the session no longer finalizing. */
func TestRecapFromTheDeepgramFinalsPostedAtRoomEnd(t *testing.T) {
	h, model := aiHarness(t, recapReply, captionsConfig)
	host := recapHost(t, h)
	slug := captionedSessionEnded(t, h, host, "Deepgram session")
	if got := h.getRecap(slug); got.Status != types.RecapPending {
		t.Fatalf("before the room's transcript: %+v", got)
	}
	start := time.Now().Add(-2 * time.Minute).UnixMilli()
	res, raw := h.agentPost("/api/internal/transcripts", testCaptionsSecret, map[string]any{
		"room": "webinar_" + slug, "model": "deepgram/nova-3", "segments": []map[string]any{
			{"identity": "user_" + host.ID, "name": "Priya", "start": start, "end": start + 3000, "text": "Deepgram heard this live."},
			{"identity": "user_" + host.ID, "name": "Priya", "start": start + 4000, "end": start + 6000, "text": "And this."},
		},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("transcript: %d %s", res.StatusCode, raw)
	}
	got := h.getRecap(slug)
	if got.Status != types.RecapReady || got.Source != types.RecapSourceServerTranscript || model.callCount() != 1 {
		t.Fatalf("after the room's transcript: %+v (model calls %d)", got, model.callCount())
	}
	if msg := userMessage(model.lastBody()); !strings.Contains(msg, "Deepgram heard this live.") {
		t.Errorf("the recap did not use the finals: %s", msg)
	}
	fin, err := h.store.FinalizingSessions(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range fin {
		if f.Slug == slug {
			t.Fatalf("still finalizing after the transcript: %+v", f)
		}
	}
}
