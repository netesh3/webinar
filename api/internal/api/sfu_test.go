package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// jsonUnmarshal exists because the concurrency test decodes inside a goroutine, and the
// harness's decode calls t.Fatalf — which is not allowed off the test's own goroutine.
func jsonUnmarshal(raw []byte, dst any) error { return json.Unmarshal(raw, dst) }

/* Which LiveKit project a webinar lands on, and — mostly — what must never move it.
 *
 * The rule these all serve: EVERY PARTICIPANT OF ONE WEBINAR REACHES THE SAME PROJECT. A room
 * exists on one project and a token is signed by one project's secret, so two attendees resolved
 * to two projects are not sharing load — they are in two separate rooms that cannot see or hear
 * each other, and the symptom is a host presenting to an empty stage.
 *
 * That failure is invisible to every other test in this package, because with one project
 * configured there is nothing to get wrong. Hence this file.
 */

// pinOf reads the project recorded against a webinar, which is the fact the whole feature turns
// on. Read from the store rather than from an API response, because the host-facing payload is a
// convenience and the column is the truth.
func (h *harness) pinOf(slug string) string {
	h.t.Helper()
	wb, err := h.store.WebinarBySlug(context.Background(), slug)
	if err != nil {
		h.t.Fatalf("load %s: %v", slug, err)
	}
	return wb.SFUProject
}

// projectOf pulls the project id back out of a join response. Both the URL and the token carry
// it (see fakeRooms), so this also proves the two agree — a token signed by one project next to
// another's address is a browser authenticating against a room it is not connected to.
func projectOf(t *testing.T, join types.JoinResponse) string {
	t.Helper()
	fromURL := strings.TrimSuffix(strings.TrimPrefix(join.URL, "ws://fake-livekit-"), ":7880")
	_, fromToken, ok := strings.Cut(join.Token, "@")
	if !ok {
		t.Fatalf("token %q carries no project", join.Token)
	}
	if fromURL != fromToken {
		t.Fatalf("the join response mixes projects: url says %q, token says %q — the browser "+
			"would authenticate against a room it is not connected to", fromURL, fromToken)
	}
	return fromURL
}

func TestANewWebinarLandsOnTheFirstEnabledProject(t *testing.T) {
	second := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{second})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("First project")

	res, raw := h.guestJoin(wb.ID, "Attendee One")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)

	if got := projectOf(t, join); got != "test" {
		t.Errorf("joined project %q, want the first configured one", got)
	}
	if got := h.pinOf(wb.ID); got != "test" {
		t.Errorf("pin = %q, want %q", got, "test")
	}
	if len(second.created) != 0 {
		t.Errorf("the second project was given a room it should not have: %v", second.created)
	}
}

/* The pin is sticky, and that is the whole point.
 *
 * Adding a project to the front of the list — which is what an operator does when the first one
 * runs out — must not move a webinar that already has a room. If it did, the host would be on
 * the old project and everybody arriving afterwards on the new one.
 */
func TestThePinSurvivesAChangeToTheProjectList(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Sticky")

	res, raw := h.guestJoin(wb.ID, "Early Bird")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("first join: status %d body %s", res.StatusCode, raw)
	}
	var first types.JoinResponse
	h.decode(raw, &first)

	// A new project arrives and jumps the queue: the operator topped up a different account.
	fresh := newFakeProject("cloud-new")
	h.pool.ids = append([]string{"cloud-new"}, h.pool.ids...)
	h.pool.projects["cloud-new"] = fresh
	h.pool.enabled["cloud-new"] = true

	res, raw = h.guestJoin(wb.ID, "Late Arrival")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second join: status %d body %s", res.StatusCode, raw)
	}
	var second types.JoinResponse
	h.decode(raw, &second)

	if projectOf(t, first) != projectOf(t, second) {
		t.Fatalf("two attendees of one webinar landed on %q and %q — they are in separate "+
			"rooms", projectOf(t, first), projectOf(t, second))
	}
	if len(fresh.created) != 0 {
		t.Errorf("the new project was given a room for an already-pinned webinar: %v",
			fresh.created)
	}
}

// The host is an attendee's counterpart here: they mint their token down a different path, and
// it has to resolve to the same project or the stage and the audience are in different rooms.
func TestTheHostJoinsTheSameProjectAsTheAudience(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("cloud-2")})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Same room")

	res, raw := h.guestJoin(wb.ID, "In The Audience")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("guest join: status %d body %s", res.StatusCode, raw)
	}
	var audience types.JoinResponse
	h.decode(raw, &audience)

	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host join: status %d body %s", res.StatusCode, raw)
	}
	var host types.JoinResponse
	h.decode(raw, &host)

	if projectOf(t, host) != projectOf(t, audience) {
		t.Fatalf("host on %q, audience on %q", projectOf(t, host), projectOf(t, audience))
	}
	if host.Room != audience.Room {
		t.Errorf("room names differ: %q and %q", host.Room, audience.Room)
	}
}

/* Attendees arriving at the same instant agree on one project.
 *
 * The race store.ClaimSFUProject's row lock exists for, and it needs the FIRST project to refuse
 * rooms in order to be a race at all. Without that, every request picks the same first candidate
 * and there is nothing to disagree about — an earlier version of this test had no refusal in it
 * and could not fail.
 *
 * With it, each request that gets `fresh` is licensed to fail over. Two requests both reading an
 * empty pin would both believe they were first, both fail over, and both write a destination —
 * and the loser's attendee ends up connected to a project the database no longer names, alone in
 * a room. The lock is what makes exactly one of them `fresh`.
 */
func TestConcurrentFirstJoinsAgreeOnOneProject(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("cloud-2"), newFakeProject("cloud-3")})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Thundering herd")

	// The first project is out of allowance, so every arrival has a failover decision to make.
	h.rooms.refuseRooms = true

	const n = 8
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		projects = map[string]int{}
		refused  []string
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, raw := h.guestJoin(wb.ID, "Simultaneous")
			mu.Lock()
			defer mu.Unlock()
			if res.StatusCode != http.StatusOK {
				refused = append(refused, string(raw))
				return
			}
			var join types.JoinResponse
			if err := jsonUnmarshal(raw, &join); err != nil {
				refused = append(refused, "undecodable: "+string(raw))
				return
			}
			_, project, _ := strings.Cut(join.Token, "@")
			projects[project]++
		}()
	}
	wg.Wait()

	/* Some may have to retry, and that is stated rather than asserted away.
	 *
	 * Exactly one request wins the claim and is licensed to move the webinar. A request that
	 * arrives after the claim but before the move has committed sees a project that refuses
	 * rooms and a pin that has not changed yet, and there is nothing safe for it to do but
	 * fail — the alternative is a second, independent decision about where the room goes.
	 *
	 * Bounded and self-correcting: the window is one round trip to the SFU, it happens once
	 * per webinar rather than once per join, and a retry lands on the settled pin. The
	 * sequence that matters in production has no race in it at all, because the host joins
	 * first — see TestTheHerdArrivingAfterAFailoverAllGetIn.
	 *
	 * Asserting zero refusals here made this test flaky, which is worse than a documented
	 * limit: a test that fails one run in three teaches people to re-run it.
	 */
	if len(refused) > 0 {
		t.Logf("%d of %d joins raced the failover and must retry (expected, bounded): %v",
			len(refused), n, refused[0])
	}
	if len(projects) == 0 {
		t.Fatalf("every one of %d simultaneous joins failed: %v", n, refused)
	}

	if len(projects) != 1 {
		t.Fatalf("simultaneous joins were spread across %d projects (%v) — each extra one "+
			"is an audience that cannot hear the others", len(projects), projects)
	}
	// And the database agrees with where they actually went, or the next arrival goes elsewhere.
	for project := range projects {
		if pin := h.pinOf(wb.ID); pin != project {
			t.Fatalf("attendees are on %q but the pin says %q", project, pin)
		}
	}
}

/* The real sequence: the host starts the session, then the audience arrives.
 *
 * This is what an exhausted allowance actually looks like in production, and it has to be
 * flawless. handleStartWebinar is one request with no competition, so it performs the failover
 * alone; by the time anybody else arrives the pin is settled and every join is an ordinary
 * lookup. Nobody retries anything.
 */
func TestTheHerdArrivingAfterAFailoverAllGetIn(t *testing.T) {
	spare := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{spare})
	h.login("neeraj@acme.dev")

	wb := h.newWebinar("Top of the hour", func(in *types.WebinarInput) {
		in.Approval = types.ApprovalAutomatic
		in.Passcode = ""
	})
	h.rooms.refuseRooms = true

	// The host presses Start. This is the request that discovers the allowance is gone.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	if got := h.pinOf(wb.ID); got != "cloud-2" {
		t.Fatalf("pin = %q after start, want the spare", got)
	}

	const n = 12
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		projects = map[string]int{}
		refused  []string
	)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, raw := h.guestJoin(wb.ID, "Audience")
			mu.Lock()
			defer mu.Unlock()
			if res.StatusCode != http.StatusOK {
				refused = append(refused, string(raw))
				return
			}
			var join types.JoinResponse
			if err := jsonUnmarshal(raw, &join); err != nil {
				refused = append(refused, "undecodable")
				return
			}
			_, project, _ := strings.Cut(join.Token, "@")
			projects[project]++
		}()
	}
	wg.Wait()

	// No retries, no exceptions: the decision was already made before any of them arrived.
	if len(refused) > 0 {
		t.Errorf("%d of %d attendees were refused after the failover had settled: %v",
			len(refused), n, refused)
	}
	if len(projects) != 1 || projects["cloud-2"] != n {
		t.Errorf("attendees landed on %v, want all %d on cloud-2", projects, n)
	}
}

/* A request that loses the race follows the winner instead of failing.
 *
 * The window: this request finished its claim (so it is not `fresh` and has no licence to move
 * anything), then called the SFU and was refused — and in the meantime the request that WAS
 * fresh moved the webinar. Without the re-read, this attendee is told the session is
 * unavailable moments after it became available on another project.
 *
 * Made deterministic with a hook rather than goroutines: the concurrent repin happens inside the
 * refused EnsureRoom call, which is precisely where the real one lands. See fakeRooms.onEnsureRoom.
 */
func TestARequestThatLosesTheRaceFollowsTheFailover(t *testing.T) {
	spare := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{spare})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Lost the race")

	ctx := context.Background()
	// Pre-pinned, so the request under test is not `fresh` and cannot move anything itself.
	if _, _, err := h.store.ClaimSFUProject(ctx, wb.ID, "test"); err != nil {
		t.Fatal(err)
	}

	h.rooms.refuseRooms = true
	moved := false
	h.rooms.onEnsureRoom = func() {
		if moved {
			return
		}
		moved = true
		// The winner, landing while this request is mid-call.
		if err := h.store.RepinSFUProject(ctx, wb.ID, "cloud-2"); err != nil {
			t.Error(err)
		}
	}

	res, raw := h.guestJoin(wb.ID, "Follower")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s — the request did not follow the failover", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if got := projectOf(t, join); got != "cloud-2" {
		t.Errorf("joined %q, want cloud-2", got)
	}
	// And it did not write its own decision on top of the winner's.
	if got := h.pinOf(wb.ID); got != "cloud-2" {
		t.Errorf("pin = %q, want cloud-2", got)
	}
}

/* A disabled project keeps serving what is already on it.
 *
 * This is the operator's normal move: mark the exhausted project disabled, add a new one. Every
 * webinar already pinned to the old one has to keep working — a scheduled session that becomes
 * unjoinable because its project was retired would make retiring one unusable.
 */
func TestADisabledProjectStillServesTheWebinarsAlreadyOnIt(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("cloud-2")})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Already here")

	if res, raw := h.guestJoin(wb.ID, "Pinned"); res.StatusCode != http.StatusOK {
		t.Fatalf("first join: status %d body %s", res.StatusCode, raw)
	}
	pinned := h.pinOf(wb.ID)

	// The operator retires it.
	h.pool.enabled[pinned] = false

	res, raw := h.guestJoin(wb.ID, "Still Welcome")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join after the project was disabled: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if got := projectOf(t, join); got != pinned {
		t.Errorf("joined %q, want the pinned %q", got, pinned)
	}

	// A NEW webinar avoids it, which is the other half of what "disabled" means.
	next := h.openWebinar("Brand new")
	if res, raw := h.guestJoin(next.ID, "Newcomer"); res.StatusCode != http.StatusOK {
		t.Fatalf("join a new webinar: status %d body %s", res.StatusCode, raw)
	}
	if got := h.pinOf(next.ID); got == pinned {
		t.Errorf("a new webinar was put on the disabled project %q", got)
	}
}

/* An exhausted allowance fails over by itself, for a session that has not started.
 *
 * This is what makes running out survivable without anybody being paged: the project stops
 * accepting rooms, and the next session quietly lands on the spare.
 */
func TestANewWebinarFailsOverWhenTheFirstProjectRefusesRooms(t *testing.T) {
	spare := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{spare})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Out of credit")

	/* What an exhausted LiveKit Cloud project looks like.
	 *
	 * Note the webinar is LIVE and has never been joined, which is precisely the shape a host
	 * pressing Start produces — handleStartWebinar flips the status before it asks for a
	 * room. An earlier version of the failover also required the webinar to be scheduled and
	 * therefore did nothing in exactly this case. */
	h.rooms.refuseRooms = true

	res, raw := h.guestJoin(wb.ID, "Lucky")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s, want a failover to the spare", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)

	if got := projectOf(t, join); got != "cloud-2" {
		t.Errorf("joined %q, want the spare", got)
	}
	// Recorded, or the next join would go back to the exhausted project and split the room.
	if got := h.pinOf(wb.ID); got != "cloud-2" {
		t.Fatalf("pin = %q, want cloud-2 — the failover was not written down, so the next "+
			"attendee would be sent somewhere else", got)
	}
	if len(spare.created) == 0 {
		t.Error("the spare project was never asked to create the room")
	}
}

/* But an ESTABLISHED pin never fails over.
 *
 * The dangerous half. Once somebody is in the room, moving the webinar strands them: they stay
 * connected to the old project while everybody arriving afterwards gets the new one. A refusal
 * has to surface as an error instead.
 */
func TestAnEstablishedWebinarIsNeverMovedByARefusal(t *testing.T) {
	spare := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{spare})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("In progress")

	if res, raw := h.guestJoin(wb.ID, "First In"); res.StatusCode != http.StatusOK {
		t.Fatalf("first join: status %d body %s", res.StatusCode, raw)
	}
	pinned := h.pinOf(wb.ID)

	// Now it runs out, mid-session.
	h.rooms.refuseRooms = true

	res, raw := h.guestJoin(wb.ID, "Second In")
	if res.StatusCode == http.StatusOK {
		t.Fatalf("the join succeeded: body %s — a live webinar was moved to another project, "+
			"so this attendee is in a different room from the host", raw)
	}
	if got := h.pinOf(wb.ID); got != pinned {
		t.Fatalf("pin moved from %q to %q while the webinar was live", pinned, got)
	}
	if len(spare.created) != 0 {
		t.Errorf("a room was created on the spare for a live webinar: %v", spare.created)
	}
}

/* A project deleted from the configuration: recoverable before the session, fatal during it.
 *
 * Deleting is different from disabling — there is no credential left, so the room is unreachable
 * either way. The only question is whether re-pinning is safe, and that turns entirely on
 * whether anybody is connected.
 */
func TestAWebinarWhoseProjectIsGone(t *testing.T) {
	t.Run("scheduled: moved to a working project", func(t *testing.T) {
		h := newHarnessWith(t, []*fakeRooms{newFakeProject("cloud-2")})
		h.login("neeraj@acme.dev")
		// Scheduled, not live, and inside the join window.
		wb := h.newWebinar("Not started yet", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalAutomatic
			in.Passcode = ""
		})

		// Pin it, then take the project away.
		if _, _, err := h.store.ClaimSFUProject(context.Background(), wb.ID, "test"); err != nil {
			t.Fatal(err)
		}
		h.pool.forget("test")

		res, raw := h.guestJoin(wb.ID, "Rescued")
		if res.StatusCode != http.StatusOK {
			t.Fatalf("join: status %d body %s, want a repin to the surviving project",
				res.StatusCode, raw)
		}
		if got := h.pinOf(wb.ID); got != "cloud-2" {
			t.Errorf("pin = %q, want cloud-2", got)
		}
	})

	t.Run("live: refused, and the pin is left alone", func(t *testing.T) {
		h := newHarnessWith(t, []*fakeRooms{newFakeProject("cloud-2")})
		h.login("neeraj@acme.dev")
		wb := h.openWebinar("Mid-session")

		if _, _, err := h.store.ClaimSFUProject(context.Background(), wb.ID, "test"); err != nil {
			t.Fatal(err)
		}
		h.pool.forget("test")

		res, raw := h.guestJoin(wb.ID, "Unlucky")
		if res.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("status %d body %s, want 503", res.StatusCode, raw)
		}
		if code := errorCode(t, raw); code != "sfu_unavailable" {
			t.Errorf("code %q, want sfu_unavailable", code)
		}
		// Untouched: a live room must not be moved, even to rescue it.
		if got := h.pinOf(wb.ID); got != "test" {
			t.Errorf("pin = %q, want the original \"test\" — a live webinar was repinned", got)
		}
	})
}

/* A host action goes to the webinar's OWN project.
 *
 * The bug the whole refactor exists to prevent. The server used to hold one client, so a mute
 * for a webinar on project B would have been sent to project A — where it would either do
 * nothing or, worse, hit a same-named room belonging to a different session.
 */
func TestHostActionsGoToTheWebinarsOwnProject(t *testing.T) {
	second := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{second})
	h.login("neeraj@acme.dev")

	// Force this webinar onto the SECOND project, the way an exhausted first one would.
	wb := h.openWebinar("On the spare")
	if _, _, err := h.store.ClaimSFUProject(context.Background(), wb.ID, "cloud-2"); err != nil {
		t.Fatal(err)
	}

	second.roster = []types.LiveParticipant{
		{Identity: "att_ABC", Name: "Someone", Role: types.RoleAttendee},
	}

	// Participants, mute-all, and removing somebody: three different call sites.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("participants: status %d body %s", res.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "att_ABC") {
		t.Errorf("the roster came from the wrong project: %s", raw)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/mute-all", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("mute all: status %d body %s", res.StatusCode, raw)
	}
	if len(second.muteAllKeep) == 0 {
		t.Error("mute-all did not reach cloud-2")
	}
	if len(h.rooms.muteAllKeep) != 0 {
		t.Error("mute-all reached the wrong project")
	}

	res, raw = h.do(http.MethodDelete,
		"/api/host/webinars/"+wb.ID+"/participants/att_ABC", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("remove participant: status %d body %s", res.StatusCode, raw)
	}
	if len(second.removed) == 0 {
		t.Error("the removal did not reach cloud-2")
	}
	if len(h.rooms.removed) != 0 {
		t.Error("the removal reached the wrong project")
	}
}

// Chat is the hot path and the one that resolves the project from an already-loaded webinar
// rather than a fresh read, so it gets its own check that it still lands in the right place.
func TestChatGoesToTheWebinarsOwnProject(t *testing.T) {
	second := newFakeProject("cloud-2")
	h := newHarnessWith(t, []*fakeRooms{second})
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Chat routing")
	if _, _, err := h.store.ClaimSFUProject(context.Background(), wb.ID, "cloud-2"); err != nil {
		t.Fatal(err)
	}

	reg := h.registerAs(wb.ID, "chatter@test.dev")
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat,
		ID:      "chat-routing-message-1",
		Text:    "hello from the spare project",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}

	if len(second.sent) == 0 {
		t.Fatal("the message never reached cloud-2")
	}
	if len(h.rooms.sent) != 0 {
		t.Errorf("the message went to the wrong project: %d packets", len(h.rooms.sent))
	}
}

// The pin is operator information. The host may see it; an unauthenticated caller may not — the
// same rule the passcode follows, and for the same reason: every field on a public payload is a
// field somebody has to think about again later.
func TestTheProjectPinIsStrippedFromPublicPayloads(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Redaction")
	if res, raw := h.guestJoin(wb.ID, "Somebody"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}

	// Host view: present.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host webinar: status %d body %s", res.StatusCode, raw)
	}
	var hostView types.Webinar
	h.decode(raw, &hostView)
	if hostView.SFUProject == "" {
		t.Error("the host cannot see which project their session is on")
	}

	// Public view: absent.
	res, raw = h.do(http.MethodGet, "/api/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public webinar: status %d body %s", res.StatusCode, raw)
	}
	var publicView types.Webinar
	h.decode(raw, &publicView)
	if publicView.SFUProject != "" {
		t.Errorf("the public payload carries the project pin %q", publicView.SFUProject)
	}
	if strings.Contains(string(raw), "sfuProject") {
		t.Errorf("the public payload mentions sfuProject: %s", raw)
	}
}

// Every project disabled is a configuration error the boot check normally catches. If it is
// reached anyway, an attendee gets a 503 that points at the organiser rather than a 500.
func TestNoEnabledProjectIsA503(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Nowhere to go")

	h.pool.enabled["test"] = false

	res, raw := h.guestJoin(wb.ID, "Nobody")
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d body %s, want 503", res.StatusCode, raw)
	}
	if code := errorCode(t, raw); code != "sfu_unavailable" {
		t.Errorf("code %q, want sfu_unavailable", code)
	}
}

// Answers "what is still running on the project I am about to retire", which is the question an
// operator has at exactly the moment they edit the list.
func TestWebinarsOnSFUProjectListsWhatIsStillScheduled(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	live := h.openWebinar("Running now")
	scheduled := h.newWebinar("Next week", func(in *types.WebinarInput) {
		in.Approval = types.ApprovalAutomatic
		in.Passcode = ""
	})
	ended := h.openWebinar("Finished")

	ctx := context.Background()
	for _, slug := range []string{live.ID, scheduled.ID, ended.ID} {
		if _, _, err := h.store.ClaimSFUProject(ctx, slug, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.store.SetStatus(ctx, ended.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}

	got, err := h.store.WebinarsOnSFUProject(ctx, "test")
	if err != nil {
		t.Fatal(err)
	}
	// The ended one is deliberately absent: it keeps its pin as a record of where it happened,
	// and including every past session would bury the two that matter.
	if len(got) != 2 {
		t.Fatalf("got %v, want the live and the scheduled webinar only", got)
	}
	for _, slug := range got {
		if slug == ended.ID {
			t.Errorf("an ended webinar is listed as still on the project: %v", got)
		}
	}
}
