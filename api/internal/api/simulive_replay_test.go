package api_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* Simulive engagement replay (simulive_replay.go, internal/replay): the original session's
 * chat, Q&A, answers and polls at their offsets into the recording, privacy-shortened, behind
 * the replay_engage switch, curated by the host; and the simulive rules that hold regardless —
 * never recorded, nobody published to the audience. */

type replayFixture struct {
	h        *harness
	hostID   string
	orig     types.Webinar
	sim      types.Webinar
	guest    types.Registration // in the simulive
	priyaKey string             // in the original
}

func (h *harness) replayAsGuest(slug, joinKey string) (types.ReplayTimeline, string) {
	h.t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + slug + "/replay?joinKey=" + joinKey)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("replay: status %d body %s", res.StatusCode, raw)
	}
	var tl types.ReplayTimeline
	h.decode(raw, &tl)
	return tl, string(raw)
}

func (h *harness) exec(sql string, args ...any) {
	h.t.Helper()
	if _, err := h.store.Pool().Exec(context.Background(), sql, args...); err != nil {
		h.t.Fatalf("exec %q: %v", sql, err)
	}
}

func newReplayFixture(t *testing.T) replayFixture {
	h := newHarness(t)
	host := h.signup("Coach Asha", "replay-coach@test.dev", true)
	orig := h.liveWebinar("Original session", nil)

	priya := h.registerAsGuest(orig.ID, "priya.sharma@test.dev")
	h.exec(`UPDATE registrations SET first_name = 'Priya', last_name = 'Sharma' WHERE join_key = $1`, priya.JoinKey)

	// Before the recording started: the pre-show is not in the video.
	h.mustSayAsGuest(orig.ID, types.SendMessageRequest{JoinKey: priya.JoinKey, Kind: types.MsgChat, ID: "pre-show-001", Text: "early!"})
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+orig.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "host-welcome-1", Text: "Welcome everyone",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("host chat: %d %s", res.StatusCode, raw)
	}
	h.mustSayAsGuest(orig.ID, types.SendMessageRequest{JoinKey: priya.JoinKey, Kind: types.MsgChat, ID: "priya-phone-1",
		Text: "WhatsApp me on +91 98765 43210 or priya.sharma@example.com"})
	h.mustSayAsGuest(orig.ID, types.SendMessageRequest{JoinKey: priya.JoinKey, Kind: types.MsgChat, ID: "priya-spam-01", Text: "buy crypto"})
	if res, raw := h.do(http.MethodDelete, "/api/webinars/"+orig.ID+"/chat/priya-spam-01", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}
	h.mustSayAsGuest(orig.ID, types.SendMessageRequest{JoinKey: priya.JoinKey, Kind: types.MsgQuestion, ID: "q-slides-0001", Text: "Will you share the slides?"})
	h.mustSayAsGuest(orig.ID, types.SendMessageRequest{JoinKey: priya.JoinKey, Kind: types.MsgQuestion, ID: "q-hidden-0001", Text: "rude question"})
	yes, answer := true, "Yes, by email tonight"
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID+"/questions/q-slides-0001",
		types.QuestionPatch{Answered: &yes, Answer: &answer}); res.StatusCode != http.StatusOK {
		t.Fatalf("answer: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID+"/questions/q-hidden-0001",
		types.QuestionPatch{Dismissed: &yes}); res.StatusCode != http.StatusOK {
		t.Fatalf("dismiss: %d %s", res.StatusCode, raw)
	}
	poll := h.createPoll(orig.ID, types.PollInput{Question: "Useful so far?", Kind: types.PollOpinion, Options: []string{"Yes", "No"}})
	h.do(http.MethodPost, "/api/host/webinars/"+orig.ID+"/polls/"+poll.ID+"/open", nil)
	if res, raw := h.voteAsGuest(orig.ID, poll.ID, priya.JoinKey, 0); res.StatusCode != http.StatusOK {
		t.Fatalf("vote: %d %s", res.StatusCode, raw)
	}
	h.do(http.MethodPost, "/api/host/webinars/"+orig.ID+"/polls/"+poll.ID+"/close", nil)

	// The recording, ten minutes long, and every event placed at a known offset into it.
	start := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	var recID string
	if err := h.store.Pool().QueryRow(context.Background(), `
		INSERT INTO recordings (webinar_id, status, mime, storage_key, size_bytes, duration_ms, created_at, stopped_at)
		SELECT id, 'ready', 'video/mp4', 'aa/bb/orig.mp4', 1000, 600000, $2::timestamptz, $2::timestamptz + interval '10 minutes'
		  FROM webinars WHERE slug = $1 RETURNING id::text`, orig.ID, start).Scan(&recID); err != nil {
		t.Fatal(err)
	}
	off := func(sec int) time.Time { return start.Add(time.Duration(sec) * time.Second) }
	h.exec(`UPDATE chat_messages SET created_at = $2 WHERE id = $1`, "pre-show-001", off(-30))
	h.exec(`UPDATE chat_messages SET created_at = $2 WHERE id = $1`, "host-welcome-1", off(5))
	h.exec(`UPDATE chat_messages SET created_at = $2 WHERE id = $1`, "priya-phone-1", off(42))
	h.exec(`UPDATE chat_messages SET created_at = $2 WHERE id = $1`, "priya-spam-01", off(50))
	h.exec(`UPDATE session_questions SET created_at = $2, answered_at = $3 WHERE id = $1`, "q-slides-0001", off(60), off(120))
	h.exec(`UPDATE session_questions SET created_at = $2 WHERE id = $1`, "q-hidden-0001", off(70))
	h.exec(`UPDATE polls SET opened_at = $2, closed_at = $3 WHERE id = $1::uuid`, poll.ID, off(200), off(260))

	sim := h.newWebinar("Encore", func(in *types.WebinarInput) {
		in.Kind = types.KindSimulive
		in.SimuliveRecordingID = recID
	})
	h.goLive(sim.ID)
	guest := h.registerAsGuest(sim.ID, "new-viewer@test.dev")
	return replayFixture{h: h, hostID: host.ID, orig: orig, sim: sim, guest: guest, priyaKey: priya.JoinKey}
}

func (f replayFixture) enable(on bool) {
	f.h.t.Helper()
	if _, err := f.h.store.SetFeatureOverride(context.Background(), f.hostID, types.FeatureReplayEngage, &on); err != nil {
		f.h.t.Fatal(err)
	}
}

func TestSimuliveReplayTimeline(t *testing.T) {
	f := newReplayFixture(t)
	h := f.h

	// The switch is off by default: the simulive is video only.
	tl, _ := h.replayAsGuest(f.sim.ID, f.guest.JoinKey)
	if tl.Enabled || len(tl.Items) != 0 {
		t.Fatalf("replay without the feature: %+v", tl)
	}
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/replay", nil)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	_, join, raw := h.joinAsGuestKey(f.sim.ID, f.guest.JoinKey)
	if !join.Simulive || join.ReplayEngage {
		t.Fatalf("join without the feature: simulive=%v replayEngage=%v %s", join.Simulive, join.ReplayEngage, raw)
	}

	f.enable(true)
	_, join, _ = h.joinAsGuestKey(f.sim.ID, f.guest.JoinKey)
	if !join.ReplayEngage {
		t.Fatal("join with the feature should say replayEngage")
	}

	tl, body := h.replayAsGuest(f.sim.ID, f.guest.JoinKey)
	if !tl.Enabled || tl.DurationMs != 600000 {
		t.Fatalf("timeline header: %+v", tl)
	}
	var got []string
	for _, it := range tl.Items {
		got = append(got, it.Kind+"@"+time.Duration(it.AtMs*int64(time.Millisecond)).String())
	}
	want := "chat@5s chat@42s question@1m0s answer@2m0s poll@3m20s poll_results@4m20s"
	if strings.Join(got, " ") != want {
		t.Fatalf("timeline\n got %s\nwant %s", strings.Join(got, " "), want)
	}
	if tl.Items[0].Name != "Coach Asha" || tl.Items[0].Role != types.RoleHost {
		t.Errorf("host line: %+v", tl.Items[0])
	}
	if tl.Items[1].Name != "Priya S." || tl.Items[1].Role != types.RoleAttendee {
		t.Errorf("attendee name: %+v", tl.Items[1])
	}
	if !strings.Contains(tl.Items[1].Text, "[phone removed]") || !strings.Contains(tl.Items[1].Text, "[email removed]") {
		t.Errorf("PII not scrubbed: %q", tl.Items[1].Text)
	}
	if tl.Items[3].Ref != tl.Items[2].ID || tl.Items[3].Text != "Yes, by email tonight" {
		t.Errorf("answer: %+v", tl.Items[3])
	}
	if p := tl.Items[5].Poll; p == nil || p.Total != 1 || p.Counts[0] != 1 {
		t.Errorf("poll results: %+v", tl.Items[5].Poll)
	}
	if tl.Items[1].Key != "" || tl.Items[1].Hidden {
		t.Error("audience timeline carries curation keys")
	}
	// Nothing that identifies anybody, or names a source row.
	for _, leak := range []string{"Sharma", "example.com", "98765", f.priyaKey, "att_", "user_", "priya-phone-1",
		"q-slides-0001", "host-welcome-1", "buy crypto", "rude question", "early!"} {
		if strings.Contains(body, leak) {
			t.Errorf("audience timeline leaks %q", leak)
		}
	}

	// The host previews with keys, hides Priya's line, and the audience no longer gets it.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/replay", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("preview: %d %s", res.StatusCode, raw)
	}
	var pre types.ReplayTimeline
	h.decode(raw, &pre)
	if len(pre.Items) != 6 || pre.Items[1].Key != "chat:priya-phone-1" {
		t.Fatalf("preview: %+v", pre.Items)
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden",
		types.ReplayHideRequest{Key: pre.Items[1].Key, Hidden: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("hide: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &pre)
	if len(pre.Items) != 6 || !pre.Items[1].Hidden {
		t.Fatalf("preview after hiding: %+v", pre.Items)
	}
	// Hiding the question takes its answer with it.
	h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden", types.ReplayHideRequest{Key: "question:q-slides-0001", Hidden: true})
	tl, _ = h.replayAsGuest(f.sim.ID, f.guest.JoinKey)
	got = got[:0]
	for _, it := range tl.Items {
		got = append(got, it.Kind)
	}
	if strings.Join(got, " ") != "chat poll poll_results" || tl.Items[0].ID != "r1" {
		t.Fatalf("after hiding: %v", got)
	}
	// And showing it again brings it back.
	h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden", types.ReplayHideRequest{Key: "question:q-slides-0001", Hidden: false})
	if tl, _ = h.replayAsGuest(f.sim.ID, f.guest.JoinKey); len(tl.Items) != 5 {
		t.Fatalf("after showing again: %d items", len(tl.Items))
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden", types.ReplayHideRequest{Key: "nonsense", Hidden: true})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "bad_key")

	// The audience cannot reach the host's routes, and a stranger cannot read the timeline.
	res2, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + f.sim.ID + "/replay?joinKey=not-a-key")
	if err != nil {
		t.Fatal(err)
	}
	res2.Body.Close()
	if res2.StatusCode == http.StatusOK {
		t.Error("a bad join key read the timeline")
	}

	// Another host cannot curate (or preview) this webinar.
	h.signup("Other Host", "replay-other@test.dev", true)
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/replay", nil)
	if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Errorf("another host previewed: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden", types.ReplayHideRequest{Key: "poll:x", Hidden: true})
	if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Errorf("another host curated: %d %s", res.StatusCode, raw)
	}

	// The original (not a simulive) has no replay to curate.
	h.login("replay-coach@test.dev")
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+f.orig.ID+"/replay", nil)
	h.wantError(res, raw, http.StatusConflict, "not_simulive")
}

func TestSimuliveIsNeverRecordedAndHostNeverPublished(t *testing.T) {
	f := newReplayFixture(t)
	h := f.h

	// Record: refused, whatever the account's switches.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/recordings", types.StartRecordingRequest{Mime: "video/webm"})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "simulive_not_recordable")
	var n int
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM recordings r JOIN webinars w ON w.id = r.webinar_id WHERE w.slug = $1`, f.sim.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("a simulive has %d recordings", n)
	}

	// Record automatically: refused on save.
	wb := h.hostWebinar(f.sim.ID)
	res, raw = h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "Auto-recorded encore", StartsAt: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		Duration: 30, TimeZone: "UTC", Kind: types.KindSimulive, Status: types.StatusScheduled,
		SimuliveRecordingID: wb.SimuliveRecordingID, RegistrationRequired: true, AttendeeLimit: 50,
		Options: types.WebinarOptions{AutoRecord: true},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "options.autoRecord") {
		t.Errorf("auto-record simulive: %d %s", res.StatusCode, raw)
	}

	// The host dropping in: the recording to watch, no camera or microphone, no record.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host join: %d %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if join.CanPublish || join.CanRecord || join.CloudRecording || !join.Simulive || !join.CdnBroadcast || join.CdnStreamURL == "" || join.Whiteboard {
		t.Errorf("host join in a simulive: %+v", join)
	}
	spec := h.rooms.lastSpec
	if !spec.NoMedia || spec.Role != types.RoleHost {
		t.Fatalf("host spec: %+v", spec)
	}
	grant, err := lk.GrantFor(spec)
	if err != nil {
		t.Fatal(err)
	}
	if grant.CanPublish == nil || *grant.CanPublish || grant.CanPublishData == nil || !*grant.CanPublishData || !grant.RoomAdmin {
		t.Errorf("host grant in a simulive: publish=%v data=%v admin=%v", grant.CanPublish, grant.CanPublishData, grant.RoomAdmin)
	}

	// Nobody from the audience is brought onto a stage the audience cannot see.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/participants/att_"+f.guest.JoinKey+"/stage",
		types.StageRequest{Role: types.RolePanelist})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "simulive_no_stage")
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/participants/stage-all", nil)
	h.wantError(res, raw, http.StatusUnprocessableEntity, "simulive_no_stage")

	// The ordinary live session still records and publishes as before.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+f.orig.ID+"/join", nil)
	var live types.JoinResponse
	h.decode(raw, &live)
	if res.StatusCode != http.StatusOK || !live.CanPublish || !live.CanRecord || live.Simulive || h.rooms.lastSpec.NoMedia {
		t.Errorf("live host join changed: %d %+v", res.StatusCode, live)
	}
}

func TestNoMediaSurvivesInGrantsAndPermissions(t *testing.T) {
	for _, spec := range []lk.Spec{
		{Role: types.RoleHost, Room: "r", Identity: "user_1", NoMedia: true},
		{Role: types.RolePanelist, Room: "r", Identity: "user_2", CoHost: true, NoMedia: true},
		{Role: types.RolePanelist, Room: "r", Identity: "user_3", NoMedia: true},
	} {
		g, err := lk.GrantFor(spec)
		if err != nil {
			t.Fatal(err)
		}
		if g.CanPublish == nil || *g.CanPublish || len(g.CanPublishSources) != 0 {
			t.Errorf("%+v: grant publishes", spec)
		}
	}
}
