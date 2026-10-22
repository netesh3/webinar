package api_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Captions on replays (recording_captions.go): the original session's transcript, else its
 * live captions, as a WebVTT file on the recording's own timeline — behind the recording's own
 * access rules and the host's "Show captions on replays" — and a simulive never brings in the
 * live caption agent. */

func (h *harness) anonGet(path string) (*http.Response, string) {
	h.t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + path)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, string(raw)
}

func (h *harness) insertTake(slug string, parentID string, start time.Time, dur time.Duration, public bool) string {
	h.t.Helper()
	var id string
	if err := h.store.Pool().QueryRow(context.Background(), `
		INSERT INTO recordings (webinar_id, status, mime, storage_key, size_bytes, duration_ms,
		                        created_at, stopped_at, parent_id, is_public)
		SELECT id, 'ready', 'video/mp4', 'cc/' || gen_random_uuid()::text || '.mp4', 1000, $3::bigint,
		       $2::timestamptz, $2::timestamptz + $3::bigint * interval '1 millisecond',
		       NULLIF($4, '')::uuid, $5
		  FROM webinars WHERE slug = $1 RETURNING id::text`,
		slug, start, dur.Milliseconds(), parentID, public).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func TestRecordingCaptionsVTT(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Asha Verma", "cc-replay-host@test.dev", true)
	orig := h.liveWebinar("Captioned session", nil)
	priya := h.registerAsGuest(orig.ID, "cc-priya@test.dev")
	h.exec(`UPDATE registrations SET first_name = 'Priya', last_name = 'Sharma' WHERE join_key = $1`, priya.JoinKey)
	ctx := context.Background()

	// Two takes: ten minutes, a five-minute gap, five minutes.
	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	off := func(sec int) time.Time { return start.Add(time.Duration(sec) * time.Second) }
	rec := h.insertTake(orig.ID, "", start, 10*time.Minute, true)
	take2 := h.insertTake(orig.ID, rec, off(15*60), 5*time.Minute, true)

	if err := h.store.SaveSessionTranscript(ctx, orig.ID, "large-v3", []store.TranscriptSegment{
		{Identity: "user_" + host.ID, Start: ms(off(5)), End: ms(off(8)), Text: "Namaste <sab> & welcome"},
		{Identity: "att_" + priya.JoinKey, Name: "priya.sharma@example.com", Start: ms(off(60)), End: ms(off(63)), Text: "Mera sawaal hai"},
		{Identity: "user_" + host.ID, Start: ms(off(12 * 60)), End: ms(off(12*60 + 3)), Text: "in the gap"},
		{Identity: "user_" + host.ID, Start: ms(off(16 * 60)), End: ms(off(16*60 + 3)), Text: "Take two line"},
	}); err != nil {
		t.Fatal(err)
	}
	pub := "/api/webinars/" + orig.ID + "/recordings/" + rec + "/captions.vtt"

	// Captions were never shown live: the transcript stays off the public replay by default.
	if res, body := h.anonGet(pub); res.StatusCode != http.StatusNotFound {
		t.Fatalf("default with captions never shown: %d %s", res.StatusCode, body)
	}
	var meta types.PublicRecording
	_, raw := h.anonGet("/api/webinars/" + orig.ID + "/recordings/" + rec + "/public")
	h.decode([]byte(raw), &meta)
	if meta.Captions {
		t.Fatal("public metadata offers captions the host never showed")
	}
	// The host still previews them, and the list says they exist and are off.
	res, body := h.do(http.MethodGet, "/api/host/webinars/"+orig.ID+"/recordings/"+rec+"/captions.vtt", nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(body), "Mera sawaal hai") {
		t.Fatalf("host preview: %d %s", res.StatusCode, body)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "private, no-cache" {
		t.Errorf("host preview cache = %q", cc)
	}
	res, body = h.do(http.MethodGet, "/api/host/webinars/"+orig.ID+"/recordings", nil)
	var list []types.Recording
	h.decode(body, &list)
	if len(list) != 1 || !list[0].CaptionsAvailable || list[0].ShowCaptions {
		t.Fatalf("list captions = %+v", list)
	}

	// The host turns "Show captions on replays" on.
	yes := true
	res, body = h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID+"/recordings/"+rec+"/share", types.ShareRecordingRequest{ShowCaptions: &yes})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("show captions: %d %s", res.StatusCode, body)
	}
	var shared types.Recording
	h.decode(body, &shared)
	if !shared.ShowCaptions {
		t.Fatalf("share response = %+v", shared)
	}

	res, vtt := h.anonGet(pub)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public captions: %d %s", res.StatusCode, vtt)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/vtt") {
		t.Errorf("content type = %q", ct)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "public, max-age=300" {
		t.Errorf("cache = %q", cc)
	}
	for _, want := range []string{
		"WEBVTT\n",
		"00:00:05.000 --> 00:00:08.000\nAsha: Namaste &lt;sab&gt; &amp; welcome\n",
		// The registration's name, first name only — not the email the agent saw.
		"00:01:00.000 --> 00:01:03.000\nPriya: Mera sawaal hai\n",
		// Take two plays from 10:00: one minute into it is 11:00.
		"00:11:00.000 --> 00:11:03.000\nAsha: Take two line\n",
	} {
		if !strings.Contains(vtt, want) {
			t.Errorf("vtt missing %q:\n%s", want, vtt)
		}
	}
	if strings.Contains(vtt, "in the gap") || strings.Contains(vtt, "priya.sharma") {
		t.Errorf("vtt has a line from outside the recording, or an email:\n%s", vtt)
	}
	_, raw = h.anonGet("/api/webinars/" + orig.ID + "/recordings/" + rec + "/public")
	h.decode([]byte(raw), &meta)
	if !meta.Captions {
		t.Fatal("public metadata does not offer captions")
	}

	// One take's own file, for the player's <track> on it.
	_, vtt = h.anonGet(pub + "?part=" + take2)
	if !strings.Contains(vtt, "00:01:00.000 --> 00:01:03.000\nAsha: Take two line\n") || strings.Contains(vtt, "Namaste") {
		t.Errorf("part vtt:\n%s", vtt)
	}
	if res, _ := h.anonGet(pub + "?part=00000000-0000-0000-0000-000000000000"); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown part: %d", res.StatusCode)
	}

	// No transcript: the live caption lines, stamped when each finished.
	h.exec(`DELETE FROM session_transcripts WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`, orig.ID)
	h.exec(`INSERT INTO session_captions (webinar_id, identity, body, at)
	        SELECT id, $2, 'live line', $3 FROM webinars WHERE slug = $1`, orig.ID, "att_"+priya.JoinKey, off(30))
	_, vtt = h.anonGet(pub)
	if !strings.Contains(vtt, " --> 00:00:30.000\nPriya: live line\n") {
		t.Errorf("caption fallback:\n%s", vtt)
	}

	// The recording's own access rules: a passcode, then private.
	code := "4321"
	h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID+"/recordings/"+rec+"/share", types.ShareRecordingRequest{Passcode: &code})
	if res, _ := h.anonGet(pub); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("no passcode: %d", res.StatusCode)
	}
	res, _ = h.anonGet(pub + "?passcode=4321")
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "private, max-age=300" {
		t.Errorf("with passcode: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	no := false
	h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID+"/recordings/"+rec+"/share", types.ShareRecordingRequest{IsPublic: &no})
	if res, _ := h.anonGet(pub + "?passcode=4321"); res.StatusCode != http.StatusNotFound {
		t.Errorf("private recording: %d", res.StatusCode)
	}

	// The switch off again: gone from the public replay.
	h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID+"/recordings/"+rec+"/share", types.ShareRecordingRequest{IsPublic: &yes, ShowCaptions: &no})
	if res, _ := h.anonGet(pub + "?passcode=4321"); res.StatusCode != http.StatusNotFound {
		t.Errorf("captions switched off: %d", res.StatusCode)
	}

	// Nothing at all to show: 404 even for the host.
	h.exec(`DELETE FROM session_captions WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`, orig.ID)
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+orig.ID+"/recordings/"+rec+"/captions.vtt", nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("no transcript: %d", res.StatusCode)
	}
}

func TestReplayCaptionsDefaultFollowsCaptionsShownLive(t *testing.T) {
	h := newHarness(t)
	h.signup("Live Captioner", "cc-default@test.dev", true)
	ctx := context.Background()

	// Captions switched on while live: shown on replays by default.
	shown := h.liveWebinar("Shown live", nil)
	on, off := true, false
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+shown.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &on}); res.StatusCode != http.StatusOK {
		t.Fatalf("captions on: %d %s", res.StatusCode, raw)
	}
	// Switched off again before the end: the session still showed them.
	h.do(http.MethodPatch, "/api/host/webinars/"+shown.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &off})
	setting, live, err := h.store.ReplayCaptionsPolicy(ctx, shown.ID)
	if err != nil || setting != nil || !live || !store.ShowReplayCaptions(setting, live) {
		t.Fatalf("shown live: setting=%v live=%v err=%v", setting, live, err)
	}

	// Captions switched on before going live, then never: still not "shown live".
	scheduled := h.newWebinar("Only before", nil)
	h.do(http.MethodPatch, "/api/host/webinars/"+scheduled.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &on})
	h.do(http.MethodPatch, "/api/host/webinars/"+scheduled.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &off})
	if _, live, _ := h.store.ReplayCaptionsPolicy(ctx, scheduled.ID); live {
		t.Fatal("captions toggled before go-live counted as shown live")
	}
	// Going live with them on counts.
	h.do(http.MethodPatch, "/api/host/webinars/"+scheduled.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &on})
	h.goLive(scheduled.ID)
	if _, live, _ := h.store.ReplayCaptionsPolicy(ctx, scheduled.ID); !live {
		t.Fatal("going live with captions on did not count")
	}

	// The host's choice beats the default either way.
	if err := h.store.SetReplayCaptions(ctx, shown.ID, false); err != nil {
		t.Fatal(err)
	}
	if setting, live, _ := h.store.ReplayCaptionsPolicy(ctx, shown.ID); store.ShowReplayCaptions(setting, live) {
		t.Fatal("host's off ignored")
	}
}

func TestSimuliveCaptionsReuseTheOriginal(t *testing.T) {
	f := newReplayFixture(t)
	h := f.h
	ctx := context.Background()
	src := h.hostWebinar(f.sim.ID).SimuliveRecordingID
	var start time.Time
	if err := h.store.Pool().QueryRow(ctx, `SELECT created_at FROM recordings WHERE id = $1::uuid`, src).Scan(&start); err != nil {
		t.Fatal(err)
	}
	h.exec(`UPDATE registrations SET first_name = 'Priya', last_name = 'Sharma' WHERE join_key = $1`, f.priyaKey)
	if err := h.store.SaveSessionTranscript(ctx, f.orig.ID, "large-v3", []store.TranscriptSegment{
		{Identity: "att_" + f.priyaKey, Start: ms(start.Add(42 * time.Second)), End: ms(start.Add(45 * time.Second)), Text: "Slides milenge?"},
	}); err != nil {
		t.Fatal(err)
	}
	path := "/api/webinars/" + f.sim.ID + "/captions.vtt?joinKey=" + f.guest.JoinKey

	// The original never showed captions: none on the simulive either.
	if res, body := h.anonGet(path); res.StatusCode != http.StatusNotFound {
		t.Fatalf("default: %d %s", res.StatusCode, body)
	}
	if err := h.store.SetReplayCaptions(ctx, f.orig.ID, true); err != nil {
		t.Fatal(err)
	}
	res, vtt := h.anonGet(path)
	if res.StatusCode != http.StatusOK || !strings.Contains(vtt, "00:00:42.000 --> 00:00:45.000\nPriya: Slides milenge?\n") {
		t.Fatalf("simulive captions: %d\n%s", res.StatusCode, vtt)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "private, max-age=300" {
		t.Errorf("cache = %q", cc)
	}
	// Behind the session's credential.
	if res, _ := h.anonGet("/api/webinars/" + f.sim.ID + "/captions.vtt?joinKey=not-a-key"); res.StatusCode == http.StatusOK {
		t.Error("captions served without a credential")
	}
	// A guest of the original is not in the simulive.
	if res, _ := h.anonGet("/api/webinars/" + f.sim.ID + "/captions.vtt?joinKey=" + f.priyaKey); res.StatusCode == http.StatusOK {
		t.Error("captions served to someone outside the simulive")
	}
	// The join tells the room to offer CC.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/join", nil)
	var join types.JoinResponse
	h.decode(raw, &join)
	if res.StatusCode != http.StatusOK || !join.SimuliveCaptions {
		t.Fatalf("join: %d simuliveCaptions=%v", res.StatusCode, join.SimuliveCaptions)
	}
	// Not a simulive: nothing at that path.
	if res, _ := h.anonGet("/api/webinars/" + f.orig.ID + "/captions.vtt?joinKey=" + f.priyaKey); res.StatusCode != http.StatusNotFound {
		t.Errorf("original session's simulive path: %d", res.StatusCode)
	}
}

func TestSimuliveNeverDispatchesTheCaptionAgent(t *testing.T) {
	h := newHarness(t, captionsConfig)
	email := "cc-sim-dispatch@test.dev"
	h.signup("Coach Dispatch", email, true)
	enableAI(t, h, email)

	orig := h.liveWebinar("Original with AI", nil)
	// The control: a live session with AI on does bring the agent in for the transcript.
	if _, ok := h.rooms.dispatched("webinar_" + orig.ID); !ok {
		t.Fatal("the ordinary live session did not dispatch the agent; this test proves nothing")
	}
	rec := h.insertTake(orig.ID, "", time.Now().Add(-time.Hour).UTC(), 10*time.Minute, false)

	sim := h.newWebinar("Encore", func(in *types.WebinarInput) {
		in.Kind = types.KindSimulive
		in.SimuliveRecordingID = rec
	})
	room := "webinar_" + sim.ID
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+sim.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start simulive: %d %s", res.StatusCode, raw)
	}
	if !h.hostWebinar(sim.ID).Controls.AIEnabled {
		t.Fatal("simulive has AI off; the switch below would not be exercised")
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("going live dispatched the caption agent into a simulive")
	}

	// The AI switch toggled while live.
	h.patchAI(sim.ID, false)
	h.patchAI(sim.ID, true)
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("the AI switch dispatched the caption agent into a simulive")
	}

	// The host asking for server captions outright.
	res, _, raw := h.setServerCaptions(sim.ID, true)
	h.wantError(res, raw, http.StatusConflict, "simulive_captions")
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("server captions dispatched into a simulive")
	}
	if on, err := h.store.ServerCaptionsRequested(context.Background(), sim.ID); err != nil || on {
		t.Fatalf("server captions requested for a simulive: %v %v", on, err)
	}

	// Nor is anything said in its room stored as a caption.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+sim.ID+"/captions", map[string]string{"text": "hello"}); res.StatusCode != http.StatusOK {
		t.Fatalf("caption post: %d %s", res.StatusCode, raw)
	}
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM session_captions c JOIN webinars w ON w.id = c.webinar_id WHERE w.slug = $1`, sim.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d captions stored for a simulive", n)
	}
}
