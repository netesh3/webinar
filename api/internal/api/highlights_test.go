package api_test

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Suggested highlights on a recording (highlights.go), against a fake gpt-5-nano: behind the
 * clips switch (off by default, needing ai and cloud_recording), picked once from the
 * transcript with the counted engagement beside it, snapped to sentences inside one take,
 * and found again on request. */

const highlightsReply = `{"moments": [
  {"startSec": 122, "endSec": 150, "title": "Pay yourself first", "why": "A clear rule the room reacted to.", "hook": "The one money rule that works", "interest": 8},
  {"startSec": 700, "endSec": 730, "title": "The emergency fund", "why": "A short story with a number.", "hook": "How big should your fund be?", "interest": 6},
  {"startSec": 5000, "endSec": 5030, "title": "Not in the recording", "why": "Out of range.", "hook": "", "interest": 9}
]}`

type highlightFixture struct {
	h      *harness
	model  *fakeOpenAI
	host   types.Account
	wb     types.Webinar
	rec    string
	take2  string
	path   string
	ctx    context.Context
	starts time.Time
}

// highlightSession is an ended session with a ten-minute take and a five-minute take, a line
// said every eight seconds through both, and a burst of reactions at two minutes in.
func highlightSession(t *testing.T, clips bool) highlightFixture {
	t.Helper()
	h, model := aiHarness(t, highlightsReply, nil)
	host := recapHost(t, h)
	forceFeature(t, h, host.ID, types.FeatureCloudRecording, true)
	if clips {
		forceFeature(t, h, host.ID, types.FeatureClips, true)
	}
	wb := h.liveWebinar("Money basics", nil)
	h.endSession(wb.ID)
	ctx := context.Background()
	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	off := func(sec int) time.Time { return start.Add(time.Duration(sec) * time.Second) }
	rec := h.insertTake(wb.ID, "", start, 10*time.Minute, false)
	take2 := h.insertTake(wb.ID, rec, off(15*60), 5*time.Minute, false)

	var segs []store.TranscriptSegment
	for s := 0; s < 20*60; s += 8 {
		if s >= 10*60 && s < 15*60 {
			continue // the break between the takes
		}
		segs = append(segs, store.TranscriptSegment{
			Identity: "user_" + host.ID, Start: ms(off(s)), End: ms(off(s + 7)),
			Text: "Sentence at " + strconv.Itoa(s) + " seconds. And another one here.",
		})
	}
	if err := h.store.SaveSessionTranscript(ctx, wb.ID, "large-v3", segs); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		h.exec(`INSERT INTO reaction_buckets (webinar_id, at, emoji, n)
		        SELECT id, $2, '👏', 5 FROM webinars WHERE slug = $1`, wb.ID, off(125+i))
	}
	return highlightFixture{h: h, model: model, host: host, wb: wb, rec: rec, take2: take2, ctx: ctx, starts: start,
		path: "/api/host/webinars/" + wb.ID + "/recordings/" + rec + "/highlights"}
}

func (f highlightFixture) get() types.HighlightsResponse {
	f.h.t.Helper()
	res, raw := f.h.do(http.MethodGet, f.path, nil)
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("get highlights: %d %s", res.StatusCode, raw)
	}
	var out types.HighlightsResponse
	f.h.decode(raw, &out)
	return out
}

// find is the host's "Find highlights" (and "Find them again"): the POST that makes the calls.
func (f highlightFixture) find() types.HighlightsResponse {
	f.h.t.Helper()
	res, raw := f.h.do(http.MethodPost, f.path, nil)
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("find highlights: %d %s", res.StatusCode, raw)
	}
	var out types.HighlightsResponse
	f.h.decode(raw, &out)
	return out
}

func TestHighlightsAreOffByDefaultAndNeedTheirParents(t *testing.T) {
	f := highlightSession(t, false)
	if hasFeature(meAccount(t, f.h).Features, types.FeatureClips) {
		t.Fatal("a new account has clips on")
	}
	res, raw := f.h.do(http.MethodGet, f.path, nil)
	f.h.wantError(res, raw, http.StatusForbidden, "feature_off")

	// On, but without cloud recording: not in effect.
	forceFeature(t, f.h, f.host.ID, types.FeatureClips, true)
	forceFeature(t, f.h, f.host.ID, types.FeatureCloudRecording, false)
	res, raw = f.h.do(http.MethodGet, f.path, nil)
	f.h.wantError(res, raw, http.StatusForbidden, "feature_off")
	if f.model.callCount() != 0 {
		t.Fatalf("model calls = %d", f.model.callCount())
	}
}

func TestHighlightsArePickedSnappedAndKept(t *testing.T) {
	f := highlightSession(t, true)
	// Looking never starts the pick: it spends the host's AI allowance, so the host asks.
	for range 2 {
		if got := f.get(); got.Status != types.HighlightsNotStarted || len(got.Highlights) != 0 || got.GeneratedAt != "" {
			t.Fatalf("before asking = %+v", got)
		}
	}
	if f.model.callCount() != 0 {
		t.Fatalf("a look called the model %d times", f.model.callCount())
	}
	got := f.find()
	if got.Status != types.AIStatusReady || len(got.Highlights) != 2 || got.GeneratedAt == "" {
		t.Fatalf("highlights = %+v", got)
	}
	first := got.Highlights[0]
	if first.Title != "Pay yourself first" || first.ID != "h1" || first.PartID != f.rec || first.Hook != "The one money rule that works" {
		t.Fatalf("first = %+v", first)
	}
	if d := first.EndSec - first.StartSec; d < types.HighlightMinSec || d > types.HighlightMaxSec {
		t.Fatalf("first lasts %v s", d)
	}
	// On a sentence boundary (lines every 8 s, split in two), a breath early.
	if first.StartSec > 122 || first.StartSec < 115 || first.Signals.Reactions != 50 || first.Quote == "" {
		t.Fatalf("first = %+v", first)
	}
	// 700 s on the player is 100 s into the second take's own file.
	second := got.Highlights[1]
	if second.PartID != f.take2 || second.PartStartSec < 95 || second.PartStartSec > 100.5 || second.Signals.Reactions != 0 {
		t.Fatalf("second = %+v", second)
	}
	if f.model.callsFor("highlights") != 1 {
		t.Fatalf("calls = %d", f.model.callsFor("highlights"))
	}
	prompt := userMessage(f.model.lastBodyFor("highlights"))
	for _, want := range []string{"Money basics", "Sentence at 120 seconds.", "50 reactions"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt lacks %q: %.500s", want, prompt)
		}
	}
	var n int
	if err := f.h.store.Pool().QueryRow(f.ctx, `SELECT count(*) FROM ai_usage WHERE feature = 'highlights' AND host_id = $1`, f.host.ID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("usage rows = %d, %v", n, err)
	}

	// Kept: looking again (by either take's id) asks nobody.
	if again := f.get(); again.Status != types.AIStatusReady || len(again.Highlights) != 2 || again.GeneratedAt != got.GeneratedAt {
		t.Fatalf("looked at again = %+v", again)
	}
	res, raw := f.h.do(http.MethodGet, "/api/host/webinars/"+f.wb.ID+"/recordings/"+f.take2+"/highlights", nil)
	if res.StatusCode != http.StatusOK || f.model.callsFor("highlights") != 1 {
		t.Fatalf("by the second take: %d %s, calls %d", res.StatusCode, raw, f.model.callsFor("highlights"))
	}

	// "Find them again" writes them once more.
	res, raw = f.h.do(http.MethodPost, f.path, nil)
	if res.StatusCode != http.StatusOK || f.model.callsFor("highlights") != 2 {
		t.Fatalf("again: %d %s, calls %d", res.StatusCode, raw, f.model.callsFor("highlights"))
	}
}

func TestHighlightsNeedWhatWasSaid(t *testing.T) {
	f := highlightSession(t, true)
	f.h.exec(`DELETE FROM session_transcripts WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`, f.wb.ID)
	if got := f.get(); got.Status != types.HighlightsNoTranscript || len(got.Highlights) != 0 {
		t.Fatalf("no transcript = %+v", got)
	}
	res, raw := f.h.do(http.MethodPost, f.path, nil)
	f.h.wantError(res, raw, http.StatusConflict, types.HighlightsNoTranscript)
	if f.model.callCount() != 0 {
		t.Fatalf("model calls = %d", f.model.callCount())
	}
}

func TestHighlightsFailInPlainWords(t *testing.T) {
	defer api.SetHighlightsRetryAfter(0)()
	f := highlightSession(t, true)
	f.model.mu.Lock()
	f.model.reply = `not json`
	f.model.mu.Unlock()
	if got := f.find(); got.Status != types.RecapReasonAIUnavailable {
		t.Fatalf("failed = %+v", got)
	}
	// The failure is kept for the page to say, and a look does not retry it.
	calls := f.model.callCount()
	if got := f.get(); got.Status != types.RecapReasonAIUnavailable || f.model.callCount() != calls {
		t.Fatalf("looked at after failing = %+v, calls %d → %d", got, calls, f.model.callCount())
	}
	f.model.mu.Lock()
	f.model.reply = highlightsReply
	f.model.mu.Unlock()
	if got := f.find(); got.Status != types.AIStatusReady || len(got.Highlights) != 2 {
		t.Fatalf("after the retry = %+v", got)
	}
}

// A pick whose claim ran out with no outcome (its instance went away) reads as failed, so the
// page offers the button again rather than polling a pick nobody is making.
func TestHighlightsAbandonedPickReadsAsFailed(t *testing.T) {
	f := highlightSession(t, true)
	f.h.exec(`INSERT INTO recording_highlights (recording_id, status, claimed_until)
	          VALUES ($1::uuid, 'pending', now() - interval '1 minute')`, f.rec)
	if got := f.get(); got.Status != types.RecapReasonFailed {
		t.Fatalf("abandoned = %+v", got)
	}
	f.h.exec(`UPDATE recording_highlights SET claimed_until = now() + interval '1 minute' WHERE recording_id = $1::uuid`, f.rec)
	if got := f.get(); got.Status != types.RecapReasonProcessing {
		t.Fatalf("being picked = %+v", got)
	}
	if f.model.callCount() != 0 {
		t.Fatalf("model calls = %d", f.model.callCount())
	}
}
