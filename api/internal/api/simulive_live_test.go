package api_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* A simulive running itself (simulive_live.go): the replayed polls and quizzes opening and
 * closing at the original's moments with this audience voting, the reactions, the curation
 * pages, and starting and ending with no host and no scheduler — each transition once. */

// startedAgo moves a live simulive's clock so the shared position is `ago` into the video.
func (h *harness) startedAgo(slug string, ago time.Duration) {
	h.t.Helper()
	h.exec(`UPDATE webinars SET started_at = date_trunc('second', now()) - $2::interval WHERE slug = $1`,
		slug, ago.String())
}

func replayedPolls(polls []types.Poll) []types.Poll {
	var out []types.Poll
	for _, p := range polls {
		if p.Replayed {
			out = append(out, p)
		}
	}
	return out
}

func TestSimuliveReplayPollsOpenAndCloseOnTheOriginalClock(t *testing.T) {
	f := newReplayFixture(t)
	h := f.h
	f.enable(true)
	// A quiz in the original too, launched at 5:00 and closed at 5:30 with B right.
	correct := 1
	quiz := h.createPoll(f.orig.ID, types.PollInput{Question: "2 + 2?", Kind: types.PollQuizKind,
		Options: []string{"3", "4"}, CorrectOption: &correct})
	h.do(http.MethodPost, "/api/host/webinars/"+f.orig.ID+"/polls/"+quiz.ID+"/open", nil)
	if res, raw := h.voteAsGuest(f.orig.ID, quiz.ID, f.priyaKey, 1); res.StatusCode != http.StatusOK {
		t.Fatalf("original quiz vote: %d %s", res.StatusCode, raw)
	}
	h.do(http.MethodPost, "/api/host/webinars/"+f.orig.ID+"/polls/"+quiz.ID+"/close", nil)
	var recStart time.Time
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT created_at FROM recordings WHERE id = (SELECT simulive_recording_id FROM webinars WHERE slug = $1)`,
		f.sim.ID).Scan(&recStart); err != nil {
		t.Fatal(err)
	}
	h.exec(`UPDATE polls SET opened_at = $2, closed_at = $3 WHERE id = $1::uuid`, quiz.ID,
		recStart.Add(300*time.Second), recStart.Add(330*time.Second))

	// 1:40 in: nothing launched yet.
	h.startedAgo(f.sim.ID, 100*time.Second)
	if got := replayedPolls(h.pollsAsGuest(f.sim.ID, f.guest.JoinKey)); len(got) != 0 {
		t.Fatalf("before the poll's moment: %+v", got)
	}

	// 3:30 in (opened at 3:20 in the original): open, for this audience, with nothing counted.
	h.startedAgo(f.sim.ID, 210*time.Second)
	got := replayedPolls(h.pollsAsGuest(f.sim.ID, f.guest.JoinKey))
	if len(got) != 1 || got[0].State != types.PollOpen || got[0].Question != "Useful so far?" ||
		len(got[0].Votes) != 0 || got[0].TotalVotes != 0 {
		t.Fatalf("at the poll's moment: %+v", got)
	}
	pollID := got[0].ID
	if res, raw := h.voteAsGuest(f.sim.ID, pollID, f.guest.JoinKey, 1); res.StatusCode != http.StatusOK {
		t.Fatalf("new audience vote: %d %s", res.StatusCode, raw)
	}
	// The host's Results: this simulive's one vote, never the original's.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/polls", nil)
	var hostPolls []types.Poll
	h.decode(raw, &hostPolls)
	if res.StatusCode != http.StatusOK || len(hostPolls) != 1 || hostPolls[0].TotalVotes != 1 || hostPolls[0].Votes[1] != 1 {
		t.Fatalf("host results: %d %s", res.StatusCode, raw)
	}
	// The room was told, so every player re-reads.
	if !h.rooms.sentKind(lk.RoomName(f.sim.ID), "polls-changed") {
		t.Error("the room was not told the poll opened")
	}

	// 4:30 in (closed at 4:20): closed, and since the original shared its results, the
	// audience now sees this audience's tally.
	h.startedAgo(f.sim.ID, 270*time.Second)
	got = replayedPolls(h.pollsAsGuest(f.sim.ID, f.guest.JoinKey))
	if len(got) != 1 || got[0].State != types.PollClosed || got[0].TotalVotes != 1 || got[0].Votes[1] != 1 || got[0].Votes[0] != 0 {
		t.Fatalf("after the poll's close: %+v", got)
	}
	other := h.registerAsGuest(f.sim.ID, "late-viewer@test.dev")
	if res, raw := h.voteAsGuest(f.sim.ID, pollID, other.JoinKey, 0); res.StatusCode != http.StatusConflict {
		t.Fatalf("vote after the close: %d %s", res.StatusCode, raw)
	}

	// 5:10 in: the quiz is open, its answer withheld.
	h.startedAgo(f.sim.ID, 310*time.Second)
	got = replayedPolls(h.pollsAsGuest(f.sim.ID, f.guest.JoinKey))
	if len(got) != 2 || got[1].Kind != types.PollQuizKind || got[1].State != types.PollOpen || got[1].CorrectOption != -1 {
		t.Fatalf("quiz open: %+v", got)
	}
	// 5:40 in: closed, and the answer revealed at the original's moment.
	h.startedAgo(f.sim.ID, 340*time.Second)
	got = replayedPolls(h.pollsAsGuest(f.sim.ID, f.guest.JoinKey))
	if len(got) != 2 || got[1].State != types.PollClosed || got[1].CorrectOption != 1 || got[1].TotalVotes != 0 {
		t.Fatalf("quiz closed: %+v", got)
	}

	var copies int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM polls p JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1 AND p.replay_key IS NOT NULL`, f.sim.ID).Scan(&copies); err != nil {
		t.Fatal(err)
	}
	if copies != 2 {
		t.Errorf("%d copies, want one per original poll", copies)
	}
}

func TestSimuliveReplayPollHiddenAndConcurrentSync(t *testing.T) {
	f := newReplayFixture(t)
	h := f.h
	f.enable(true)

	// Twenty viewers reaching the poll's moment together make one copy, opened once.
	h.startedAgo(f.sim.ID, 205*time.Second)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + f.sim.ID + "/polls?joinKey=" + f.guest.JoinKey)
			if err == nil {
				res.Body.Close()
			}
		}()
	}
	wg.Wait()
	var copies int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM polls p JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1 AND p.replay_key IS NOT NULL AND p.state = 'open'`, f.sim.ID).Scan(&copies); err != nil {
		t.Fatal(err)
	}
	if copies != 1 {
		t.Fatalf("%d open copies after concurrent syncs", copies)
	}

	// The host hides it mid-window: it closes, and a hidden poll never opens.
	if res, raw := h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden",
		types.ReplayHideRequest{Filter: types.ReplayFilterPolls, All: true, Hidden: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("hide polls: %d %s", res.StatusCode, raw)
	}
	got := replayedPolls(h.pollsAsGuest(f.sim.ID, f.guest.JoinKey))
	if len(got) != 1 || got[0].State != types.PollClosed {
		t.Fatalf("hidden poll still open: %+v", got)
	}
}

func TestSimuliveReplaysReactionsAndPagesTheCuration(t *testing.T) {
	f := newReplayFixture(t)
	h := f.h
	f.enable(true)

	// Reactions in the original: stored as counts per emoji per second, no identity.
	for _, e := range []string{"👏", "👏", "❤️"} {
		h.mustSayAsGuest(f.orig.ID, types.SendMessageRequest{JoinKey: f.priyaKey, Kind: types.MsgReaction, Emoji: e})
	}
	if err := h.server.FlushEngagement(context.Background()); err != nil {
		t.Fatal(err)
	}
	var buckets, total int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*), coalesce(sum(n), 0) FROM reaction_buckets b JOIN webinars w ON w.id = b.webinar_id
		 WHERE w.slug = $1`, f.orig.ID).Scan(&buckets, &total); err != nil {
		t.Fatal(err)
	}
	if total != 3 || buckets < 2 {
		t.Fatalf("reaction buckets: %d rows, %d reactions", buckets, total)
	}
	// Place them 30s into the recording.
	h.exec(`UPDATE reaction_buckets b SET at = r.created_at + interval '30 seconds'
	          FROM webinars w, recordings r
	         WHERE w.id = b.webinar_id AND w.slug = $1 AND r.webinar_id = w.id`, f.orig.ID)

	tl, body := h.replayAsGuest(f.sim.ID, f.guest.JoinKey)
	var burst *types.ReplayItem
	for i := range tl.Items {
		if tl.Items[i].Kind == "reaction" {
			burst = &tl.Items[i]
		}
	}
	if burst == nil || burst.AtMs != 30000 || len(burst.Reactions) != 2 || burst.Reactions[0] != (types.ReplayReaction{Emoji: "👏", Count: 2}) {
		t.Fatalf("reaction burst: %+v", burst)
	}
	if strings.Contains(body, f.priyaKey) || strings.Contains(body, "att_") {
		t.Error("a reaction burst names somebody")
	}

	// The curation, a page at a time.
	page := func(q string) types.ReplayPage {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/replay"+q, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("page %s: %d %s", q, res.StatusCode, raw)
		}
		var p types.ReplayPage
		h.decode(raw, &p)
		return p
	}
	all := page("")
	if all.Total != 7 || all.Counts != (types.ReplayCounts{All: 7, Chat: 2, QA: 2, Polls: 2, Reactions: 1}) {
		t.Fatalf("all: total %d counts %+v", all.Total, all.Counts)
	}
	p := page("?limit=2")
	if len(p.Items) != 2 || p.NextCursor != "2" || p.Items[1].Kind != "reaction" {
		t.Fatalf("limit: %+v", p)
	}
	if p = page("?limit=2&cursor=" + p.NextCursor); p.Offset != 2 || p.Items[0].Kind != "chat" || p.PrevCursor != "0" {
		t.Fatalf("next page: %+v", p.Items)
	}
	if p = page("?filter=polls"); p.Total != 2 || p.Items[0].Kind != "poll" || p.Items[1].Kind != "poll_close" {
		t.Fatalf("polls filter: %+v", p.Items)
	}
	if p = page("?q=SLIDES"); p.Total != 1 || p.Items[0].Kind != "question" {
		t.Fatalf("search: %+v", p.Items)
	}
	if p = page("?at=100000"); p.Items[0].AtMs != 120000 {
		t.Fatalf("jump: %+v", p.Items[0])
	}
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/replay?filter=nope", nil)
	h.wantError(res, raw, http.StatusBadRequest, "bad_filter")

	// Hide everything in a filter at once, and a page's worth by keys.
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden",
		types.ReplayHideRequest{All: true, Filter: types.ReplayFilterChat, Hidden: true})
	var hid types.ReplayHideResponse
	h.decode(raw, &hid)
	if res.StatusCode != http.StatusOK || hid.Changed != 2 || hid.Counts.Hidden != 2 {
		t.Fatalf("hide chat: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/hidden",
		types.ReplayHideRequest{Keys: []string{burst.Key, "reaction:" + "6"}, Hidden: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("hide keys: %d %s", res.StatusCode, raw)
	}
	if tl, _ = h.replayAsGuest(f.sim.ID, f.guest.JoinKey); len(tl.Items) != 4 {
		t.Fatalf("audience after hiding chat and reactions: %+v", tl.Items)
	}
}

// lazySimulive is a simulive of a ten-minute recording whose original session ended five
// minutes into it, starting `startsIn` from now (negative: already due), with no host in it.
func lazySimulive(t *testing.T, h *harness, startsIn time.Duration, mutate func(*types.WebinarInput)) types.Webinar {
	t.Helper()
	orig := h.newWebinar("Original", nil)
	rec := h.insertRecording(orig.ID, "ready", 1000)
	h.exec(`UPDATE recordings SET duration_ms = 600000, created_at = now() - interval '3 hours' WHERE id = $1::uuid`, rec)
	h.exec(`UPDATE webinars SET status = 'ended', started_at = now() - interval '3 hours',
	               ended_at = now() - interval '3 hours' + interval '300 seconds' WHERE slug = $1`, orig.ID)
	sim := h.newWebinar("Encore", func(in *types.WebinarInput) {
		in.Kind = types.KindSimulive
		in.SimuliveRecordingID = rec
		in.Duration = 60
		if mutate != nil {
			mutate(in)
		}
	})
	h.exec(`UPDATE webinars SET starts_at = date_trunc('second', now()) + $2::interval WHERE slug = $1`, sim.ID, startsIn.String())
	return sim
}

func (h *harness) publicWebinar(slug string) types.Webinar {
	h.t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + slug)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("public webinar: %d %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}

// sentKind reports whether a packet of this kind went to the room.
func (f *fakeRooms) sentKind(room, kind string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.sent {
		if p.room == room && strings.Contains(string(p.data), `"kind":"`+kind+`"`) {
			return true
		}
	}
	return false
}

func TestSimuliveStartsItselfOnceWithNoHostAndTakesChat(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Lazy", "lazy-coach@test.dev", true)
	sim := lazySimulive(t, h, -90*time.Second, nil)
	guest := h.registerAsGuest(sim.ID, "lazy-viewer@test.dev")

	var ensured atomic.Int32
	h.rooms.mu.Lock()
	h.rooms.onEnsureRoom = func() { ensured.Add(1) }
	h.rooms.mu.Unlock()

	// Twenty page views at once, nobody hosting and no tick: it goes live once.
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + sim.ID)
			if err == nil {
				res.Body.Close()
			}
		}()
	}
	wg.Wait()
	wb := h.publicWebinar(sim.ID)
	if wb.Status != types.StatusLive {
		t.Fatalf("status %s, want live", wb.Status)
	}
	if n := ensured.Load(); n != 1 {
		t.Errorf("the room was made %d times on start, want once", n)
	}
	// The clock is the scheduled start, not the first request's arrival.
	var drift float64
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT abs(extract(epoch FROM started_at - starts_at)) FROM webinars WHERE slug = $1`, sim.ID).Scan(&drift); err != nil {
		t.Fatal(err)
	}
	if drift != 0 {
		t.Errorf("started_at is %vs off starts_at", drift)
	}
	// And the room was told, so waiting players begin at the shared position.
	h.rooms.mu.Lock()
	meta := h.rooms.metadata[lk.RoomName(sim.ID)]
	h.rooms.mu.Unlock()
	if !strings.Contains(meta, `"live"`) {
		t.Errorf("room metadata after start: %s", meta)
	}

	// The attendee joins and chats in a simulive no host ever joined.
	res, join, raw := h.joinAsGuestKey(sim.ID, guest.JoinKey)
	if res.StatusCode != http.StatusOK || !join.Simulive || join.StartedAt == "" {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	for _, kind := range []types.RoomMessageKind{types.MsgChat, types.MsgQuestion, types.MsgReaction} {
		body := types.SendMessageRequest{JoinKey: guest.JoinKey, Kind: kind, ID: "lazy-" + string(kind), Text: "hello from the encore", Emoji: "👏"}
		if res, raw := h.sayAsGuest(sim.ID, body); res.StatusCode != http.StatusOK {
			t.Fatalf("%s in a server-started simulive: %d %s", kind, res.StatusCode, raw)
		}
	}
}

func TestSimuliveEndsAtTheOriginalEndUnlessTheHostIsThere(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Coach End", "end-coach@test.dev", true)
	sim := lazySimulive(t, h, -90*time.Second, nil)
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusLive {
		t.Fatalf("not started: %s", wb.Status)
	}

	// 4 minutes in: the original ran 5, so it is still on.
	h.startedAgo(sim.ID, 4*time.Minute)
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusLive {
		t.Fatalf("ended early: %s", wb.Status)
	}

	// 6 minutes in, the host is in the room: it stays live, on a page view and on a tick.
	h.startedAgo(sim.ID, 6*time.Minute)
	h.rooms.mu.Lock()
	h.rooms.roster = []types.LiveParticipant{{Identity: "user_" + host.ID, Role: types.RoleHost}}
	h.rooms.mu.Unlock()
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusLive {
		t.Fatalf("ended with the host in the room: %s", wb.Status)
	}
	h.server.RunTick(context.Background())
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusLive {
		t.Fatalf("the tick ended it with the host in the room: %s", wb.Status)
	}

	// The host leaves: the next tick ends it.
	h.rooms.mu.Lock()
	h.rooms.roster = nil
	h.rooms.mu.Unlock()
	h.server.RunTick(context.Background())
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusEnded {
		t.Fatalf("after the host left: %s", wb.Status)
	}
}

func TestSimuliveEndsOnTimeOnceUnderConcurrency(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Once", "once-coach@test.dev", true)
	sim := lazySimulive(t, h, -90*time.Second, nil)
	h.publicWebinar(sim.ID)
	h.startedAgo(sim.ID, 6*time.Minute)

	var wg sync.WaitGroup
	for range 15 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + sim.ID)
			if err == nil {
				res.Body.Close()
			}
		}()
	}
	wg.Wait()
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusEnded {
		t.Fatalf("status %s, want ended", wb.Status)
	}
	h.rooms.mu.Lock()
	deleted := 0
	for _, r := range h.rooms.deleted {
		if r == lk.RoomName(sim.ID) {
			deleted++
		}
	}
	h.rooms.mu.Unlock()
	if deleted != 1 {
		t.Errorf("the session was torn down %d times, want once", deleted)
	}
	// And a request after the end does nothing more.
	h.publicWebinar(sim.ID)
	h.server.RunTick(context.Background())
	h.rooms.mu.Lock()
	n := len(h.rooms.deleted)
	h.rooms.mu.Unlock()
	if n != deleted {
		t.Errorf("ended again: %v", h.rooms.deleted)
	}
}

func TestSimuliveStartModesAndDoors(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Modes", "modes-coach@test.dev", true)

	// "I'll start it": due, but never started by a request or a tick.
	manual := lazySimulive(t, h, -2*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})
	h.publicWebinar(manual.ID)
	h.server.RunTick(context.Background())
	if wb := h.publicWebinar(manual.ID); wb.Status != types.StatusScheduled {
		t.Fatalf("a manual simulive started itself: %s", wb.Status)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+manual.ID+"/start", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host start: %d %s", res.StatusCode, raw)
	}
	if wb := h.publicWebinar(manual.ID); wb.Status != types.StatusLive || wb.StartedAt == "" {
		t.Fatalf("after Start Simulive: %+v", wb.Status)
	}

	// Doors open 10 minutes before by default: in, waiting, chatting — and not started.
	soon := lazySimulive(t, h, 5*time.Minute, nil)
	guest := h.registerAsGuest(soon.ID, "early-viewer@test.dev")
	res, join, raw := h.joinAsGuestKey(soon.ID, guest.JoinKey)
	if res.StatusCode != http.StatusOK || join.StartedAt != "" {
		t.Fatalf("join with the doors open: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.sayAsGuest(soon.ID, types.SendMessageRequest{JoinKey: guest.JoinKey, Kind: types.MsgChat, ID: "early-hello-1", Text: "hi all"}); res.StatusCode != http.StatusOK {
		t.Fatalf("chat while waiting: %d %s", res.StatusCode, raw)
	}
	if wb := h.publicWebinar(soon.ID); wb.Status != types.StatusScheduled {
		t.Fatalf("started before its time: %s", wb.Status)
	}

	// Doors at the start: too early five minutes out.
	zero := 0
	shut := lazySimulive(t, h, 5*time.Minute, func(in *types.WebinarInput) { in.Options.SimuliveDoorsOpenMin = &zero })
	g2 := h.registerAsGuest(shut.ID, "too-early@test.dev")
	res, _, raw = h.joinAsGuestKey(shut.ID, g2.JoinKey)
	h.wantError(res, raw, http.StatusConflict, "too_early")

	// The Setup tab changes the mode before the start, and not after.
	five := 5
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+soon.ID+"/simulive-start",
		types.SimuliveStartRequest{SimuliveStart: types.SimuliveStartManual, DoorsOpenMin: &five})
	var changed types.Webinar
	h.decode(raw, &changed)
	if res.StatusCode != http.StatusOK || changed.Options.SimuliveStart != types.SimuliveStartManual ||
		changed.Options.SimuliveDoorsOpenMin == nil || *changed.Options.SimuliveDoorsOpenMin != 5 {
		t.Fatalf("set start mode: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+manual.ID+"/simulive-start",
		types.SimuliveStartRequest{SimuliveStart: types.SimuliveStartAuto})
	h.wantError(res, raw, http.StatusConflict, "started")

	// A bad mode is refused on save.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+shut.ID, func() types.WebinarInput {
		in := simuliveInput(shut.SimuliveRecordingID)
		in.Options.SimuliveStart = "whenever"
		return in
	}())
	h.wantField(res, raw, "options.simuliveStart")
}
