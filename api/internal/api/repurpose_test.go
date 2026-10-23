package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Content repurposing, end to end against a fake gpt-5-nano: behind its own switch (off by
 * default, and only with AI), written from what was said, in the host's brand voice, edited and
 * reviewed by the host, regenerated on request, and inside the AI caps. */

const repurposeDraftReply = `{"markdown": "# Budgeting a first salary\n\nPay yourself first, then everything else."}`

const repurposeNotesReply = `{"summary": "Budgeting basics.", "points": ["Pay yourself first"], "examples": ["The 50-30-20 split"], "quotes": []}`

// repurposeHost is a host with AI and, when on, the repurpose switch.
func repurposeHost(t *testing.T, h *harness, on bool) types.Account {
	t.Helper()
	acct := recapHost(t, h)
	if on {
		forceFeature(t, h, acct.ID, types.FeatureRepurpose, true)
	}
	return acct
}

// spokenSession is an ended session with two caption lines and a question.
func spokenSession(t *testing.T, h *harness, host types.Account) types.Webinar {
	t.Helper()
	wb := h.newWebinar("Money basics for young earners", nil)
	h.goLive(wb.ID)
	h.caption(wb.ID, "user_"+host.ID, "Namaste everyone, today we budget a first salary.")
	h.caption(wb.ID, "user_"+host.ID, "Pehle khud ko pay karo, phir baaki sab.")
	h.question(wb.ID, "rq1", "Which SIP should I start with?", 4)
	h.endSession(wb.ID)
	return wb
}

func (h *harness) repurpose(method, slug string, body any) types.RepurposeResponse {
	h.t.Helper()
	res, raw := h.do(method, "/api/host/webinars/"+slug+"/repurpose", body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("%s repurpose: %d %s", method, res.StatusCode, raw)
	}
	var out types.RepurposeResponse
	h.decode(raw, &out)
	return out
}

func draftOf(out types.RepurposeResponse, format string) types.RepurposeDraft {
	for _, d := range out.Drafts {
		if d.Format == format {
			return d
		}
	}
	return types.RepurposeDraft{}
}

func TestRepurposeIsOffByDefaultAndNeedsAI(t *testing.T) {
	h, model := aiHarness(t, repurposeDraftReply, nil)
	host := repurposeHost(t, h, false)
	wb := spokenSession(t, h, host)

	if hasFeature(meAccount(t, h).Features, types.FeatureRepurpose) {
		t.Fatal("a new account has repurpose on")
	}
	for _, req := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/host/webinars/" + wb.ID + "/repurpose", nil},
		{http.MethodPost, "/api/host/webinars/" + wb.ID + "/repurpose", types.RepurposeRequest{Formats: []string{types.RepurposeBlog}}},
		{http.MethodPut, "/api/host/webinars/" + wb.ID + "/repurpose/blog", types.RepurposeEditRequest{Markdown: "x"}},
		{http.MethodGet, "/api/host/brand-voice", nil},
		{http.MethodPut, "/api/host/brand-voice", types.BrandVoice{Tone: "warm"}},
	} {
		res, raw := h.do(req.method, req.path, req.body)
		h.wantError(res, raw, http.StatusForbidden, "feature_off")
	}

	// Forced on without AI, it is still not in effect.
	forceFeature(t, h, host.ID, types.FeatureRepurpose, true)
	forceFeature(t, h, host.ID, types.FeatureAI, false)
	if hasFeature(meAccount(t, h).Features, types.FeatureRepurpose) {
		t.Fatal("repurpose in effect without ai")
	}
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/repurpose", nil)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	if model.callsFor("repurpose_draft") != 0 {
		t.Fatal("a draft was written without the switch")
	}
}

func TestRepurposeWritesEditsAndRegeneratesDrafts(t *testing.T) {
	h, model := aiHarness(t, repurposeDraftReply, nil)
	host := repurposeHost(t, h, true)

	// The brand voice: saved on the account and read back.
	res, raw := h.do(http.MethodPut, "/api/host/brand-voice", types.BrandVoice{
		Tone: "Warm and direct", Audience: "First-time earners", DontWords: "guaranteed, hustle",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("save voice: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPut, "/api/host/brand-voice", types.BrandVoice{Sample: strings.Repeat("x", 3001)})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "too_long")

	// Not ended yet: refused in words.
	live := h.newWebinar("Still on", nil)
	h.goLive(live.ID)
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+live.ID+"/repurpose", types.RepurposeRequest{Formats: []string{types.RepurposeBlog}})
	h.wantError(res, raw, http.StatusConflict, types.RecapReasonNotEnded)

	wb := spokenSession(t, h, host)
	got := h.repurpose(http.MethodGet, wb.ID, nil)
	if got.Status != types.AIStatusReady || len(got.Drafts) != 0 || !got.BrandVoiceSet || got.Source != types.RecapSourceCaptions {
		t.Fatalf("before any draft: %+v", got)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/repurpose", types.RepurposeRequest{Formats: []string{"tiktok"}})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "bad_format")

	got = h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeLinkedIn, types.RepurposeBlog, types.RepurposeBlog}})
	if len(got.Drafts) != 2 || got.Drafts[0].Format != types.RepurposeBlog {
		t.Fatalf("drafts = %+v", got.Drafts)
	}
	for _, d := range got.Drafts {
		if d.Status != types.RepurposeReady || !strings.HasPrefix(d.Markdown, "# Budgeting") || d.Edited || d.Reviewed {
			t.Fatalf("draft = %+v", d)
		}
	}
	if n := model.callsFor("repurpose_draft"); n != 2 {
		t.Fatalf("draft calls = %d, want one per format", n)
	}
	prompt := userMessage(model.lastBodyFor("repurpose_draft"))
	for _, want := range []string{"budget a first salary", "Which SIP should I start with?", "Warm and direct", "guaranteed, hustle"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt lacks %q: %.600s", want, prompt)
		}
	}
	// Counted against the host's AI budget, under its own feature name.
	var calls int
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM ai_usage WHERE feature = 'repurpose' AND host_id = $1`, host.ID).Scan(&calls); err != nil || calls != 2 {
		t.Fatalf("ai_usage rows = %d, %v", calls, err)
	}

	// Polling again writes nothing more.
	h.repurpose(http.MethodGet, wb.ID, nil)
	if n := model.callsFor("repurpose_draft"); n != 2 {
		t.Fatalf("a poll wrote again: %d calls", n)
	}

	// The host's edit and review mark.
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/repurpose/blog",
		types.RepurposeEditRequest{Markdown: "# My own title\r\n\r\nPay yourself first.", Reviewed: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("edit: %d %s", res.StatusCode, raw)
	}
	var edited types.RepurposeResponse
	h.decode(raw, &edited)
	if d := draftOf(edited, types.RepurposeBlog); !d.Edited || !d.Reviewed || d.Markdown != "# My own title\n\nPay yourself first." {
		t.Fatalf("edited = %+v", d)
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/repurpose/newsletter", types.RepurposeEditRequest{Markdown: "x"})
	h.wantError(res, raw, http.StatusConflict, "no_draft")

	// Regenerate: a new draft, and the edit and review mark go with the old one.
	got = h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeBlog}})
	if d := draftOf(got, types.RepurposeBlog); d.Status != types.RepurposeReady || d.Edited || d.Reviewed || !strings.HasPrefix(d.Markdown, "# Budgeting") {
		t.Fatalf("regenerated = %+v", d)
	}
	if n := model.callsFor("repurpose_draft"); n != 3 {
		t.Fatalf("draft calls = %d after regenerate", n)
	}

	// Another host cannot reach it at all.
	h.signup("Other Host", "other-repurpose@test.dev", true)
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/repurpose", nil)
	if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusNotFound {
		t.Fatalf("another host: %d %s", res.StatusCode, raw)
	}
}

func TestRepurposeNeedsWhatWasSaid(t *testing.T) {
	h, model := aiHarness(t, repurposeDraftReply, nil)
	repurposeHost(t, h, true)
	wb := h.newWebinar("Silent", nil)
	h.goLive(wb.ID)
	h.question(wb.ID, "sq1", "Anyone there?", 0)
	h.endSession(wb.ID)

	if got := h.repurpose(http.MethodGet, wb.ID, nil); got.Status != types.RepurposeReasonNoTranscript {
		t.Fatalf("status = %q", got.Status)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/repurpose", types.RepurposeRequest{Formats: []string{types.RepurposeBlog}})
	h.wantError(res, raw, http.StatusConflict, types.RepurposeReasonNoTranscript)
	if model.callCount() != 0 {
		t.Fatalf("model calls = %d", model.callCount())
	}
}

func TestRepurposeRespectsTheAICap(t *testing.T) {
	h, model := aiHarness(t, repurposeDraftReply, func(c *config.Config) { c.AIHostMonthlyUSD = 0.05 })
	host := repurposeHost(t, h, true)
	wb := spokenSession(t, h, host)

	// The first call is allowed and crosses the cap ($0.045 each); the second is refused.
	got := h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeBlog}})
	if d := draftOf(got, types.RepurposeBlog); d.Status != types.RepurposeReady {
		t.Fatalf("first = %+v", d)
	}
	if _, err := api.AIComplete(h.server, context.Background(), types.AIFeatureRepurpose, host.ID, aiHello); err != nil {
		t.Fatal(err)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/repurpose", types.RepurposeRequest{Formats: []string{types.RepurposeLinkedIn}})
	h.wantError(res, raw, http.StatusTooManyRequests, "ai_limit")
	if n := model.callsFor("repurpose_draft"); n != 1 {
		t.Fatalf("draft calls = %d", n)
	}
}

func TestRepurposeFailsInPlainWordsAfterRetries(t *testing.T) {
	defer api.SetRepurposeRetryAfter(0)()
	h, model := aiHarness(t, `{"markdown": "   "}`, nil)
	host := repurposeHost(t, h, true)
	wb := spokenSession(t, h, host)

	got := h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeXThread}})
	if d := draftOf(got, types.RepurposeXThread); d.Status != types.RepurposeQueued {
		t.Fatalf("after one failed try = %+v", d)
	}
	for range 3 {
		got = h.repurpose(http.MethodGet, wb.ID, nil)
	}
	if d := draftOf(got, types.RepurposeXThread); d.Status != types.RepurposeFailed || d.Reason != types.RecapReasonFailed {
		t.Fatalf("after the retries = %+v", d)
	}
	if n := model.callsFor("repurpose_draft"); n != 3 {
		t.Fatalf("draft calls = %d, want three tries", n)
	}
	// Asking again starts over.
	model.mu.Lock()
	model.reply = repurposeDraftReply
	model.mu.Unlock()
	got = h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeXThread}})
	if d := draftOf(got, types.RepurposeXThread); d.Status != types.RepurposeReady {
		t.Fatalf("asked again = %+v", d)
	}
}

func TestRepurposeSummarisesALongTranscriptOnce(t *testing.T) {
	h, model := aiHarness(t, repurposeDraftReply, nil)
	model.bySchema = map[string]string{"repurpose_notes": repurposeNotesReply}
	host := repurposeHost(t, h, true)
	wb := h.newWebinar("A very long workshop", nil)
	h.goLive(wb.ID)
	// ~300k runes of captions: three parts at 100k.
	if _, err := h.store.Pool().Exec(context.Background(), `
		INSERT INTO session_captions (webinar_id, identity, body, at)
		SELECT w.id, 'user_' || $2, 'line ' || i || ' ' || repeat('padding words ', 10), now() + make_interval(secs => i)
		  FROM webinars w, generate_series(1, 2000) i WHERE w.slug = $1`, wb.ID, host.ID); err != nil {
		t.Fatal(err)
	}
	h.endSession(wb.ID)

	got := h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeBlog, types.RepurposeNewsletter}})
	if got.Source != "notes" {
		t.Fatalf("source = %q", got.Source)
	}
	for _, d := range got.Drafts {
		if d.Status != types.RepurposeReady {
			t.Fatalf("draft = %+v", d)
		}
	}
	notes := model.callsFor("repurpose_notes")
	if notes < 2 || model.callsFor("repurpose_draft") != 2 {
		t.Fatalf("notes calls = %d, draft calls = %d", notes, model.callsFor("repurpose_draft"))
	}
	if msg := userMessage(model.lastBodyFor("repurpose_draft")); !strings.Contains(msg, "Part 1 notes") || strings.Contains(msg, "padding words") {
		t.Errorf("draft prompt = %.300s", msg)
	}
	// Another format reads the same notes.
	h.repurpose(http.MethodPost, wb.ID, types.RepurposeRequest{Formats: []string{types.RepurposeInstagram}})
	if model.callsFor("repurpose_notes") != notes || model.callsFor("repurpose_draft") != 3 {
		t.Fatalf("notes calls = %d (was %d), draft calls = %d", model.callsFor("repurpose_notes"), notes, model.callsFor("repurpose_draft"))
	}
}
