package api_test

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/types"
)

/* Somebody who can chat and raise a hand but is not on the video server (their LiveKit
 * connection is down, or they watch the edge feed) has to be on the host's Participants panel
 * and reachable by "Bring on stage". See presence.go. */

func (h *harness) presence(slug, joinKey string) (*http.Response, types.PresenceResponse, []byte) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/presence", types.PresenceRequest{JoinKey: joinKey})
	var out types.PresenceResponse
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res, out, raw
}

func (h *harness) roster(slug string) types.LiveRoom {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/participants", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("participants: %d %s", res.StatusCode, raw)
	}
	var live types.LiveRoom
	h.decode(raw, &live)
	return live
}

func rosterRows(live types.LiveRoom) map[string][]types.LiveParticipant {
	out := map[string][]types.LiveParticipant{}
	for _, p := range live.Participants {
		out[p.Identity] = append(out[p.Identity], p)
	}
	return out
}

// agePresence moves an attendee's last poll into the past.
func agePresence(t *testing.T, slug, identity string, ago time.Duration) {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `
		UPDATE attendance a SET api_seen_at = now() - $3::interval
		  FROM webinars w WHERE a.webinar_id = w.id AND w.slug = $1 AND a.identity = $2`,
		slug, identity, ago); err != nil {
		t.Fatal(err)
	}
}

func TestPresenceUnionDedupeAndStaleness(t *testing.T) {
	h := newHarness(t)
	h.signup("Presence Host", "presence-host@test.dev", true)
	wb := h.liveWebinar("Presence roster", nil)
	alice := h.registerAsGuest(wb.ID, "presence-alice@test.dev")
	bob := h.registerAsGuest(wb.ID, "presence-bob@test.dev")
	_, aj, raw := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	if aj.Token == "" {
		t.Fatalf("alice join: %s", raw)
	}
	_, bj, _ := h.joinAsGuestKey(wb.ID, bob.JoinKey)

	// Bob is on the video server; Alice's connection never landed.
	h.rooms.mu.Lock()
	h.rooms.roster = []types.LiveParticipant{{Identity: bj.Identity, Name: "Bob", Role: types.RoleAttendee, Publishing: []string{}}}
	h.rooms.mu.Unlock()

	// Before she polls, the panel cannot know about her.
	if rows := rosterRows(h.roster(wb.ID)); len(rows[aj.Identity]) != 0 {
		t.Fatalf("alice listed before any presence: %+v", rows)
	}

	// Both poll (Bob's browser might be mid-reconnect): one row each, the video server's wins.
	for _, key := range []string{alice.JoinKey, bob.JoinKey} {
		if res, _, raw := h.presence(wb.ID, key); res.StatusCode != http.StatusOK {
			t.Fatalf("presence: %d %s", res.StatusCode, raw)
		}
	}
	live := h.roster(wb.ID)
	rows := rosterRows(live)
	if len(rows[aj.Identity]) != 1 || len(rows[bj.Identity]) != 1 || len(live.Participants) != 2 {
		t.Fatalf("roster = %+v, want alice and bob once each", live.Participants)
	}
	if a := rows[aj.Identity][0]; a.Via != "limited" || a.Role != types.RoleAttendee || a.Name == "" {
		t.Fatalf("alice row = %+v, want an attendee marked limited", a)
	}
	if b := rows[bj.Identity][0]; b.Via != "" || b.Name != "Bob" {
		t.Fatalf("bob row = %+v, want the video server's row", b)
	}
	if live.Attendees != 2 || live.Partial {
		t.Fatalf("attendees = %d partial = %v, want 2 and false", live.Attendees, live.Partial)
	}

	// A minute without a poll and she is gone again.
	agePresence(t, wb.ID, aj.Identity, 2*time.Minute)
	if rows := rosterRows(h.roster(wb.ID)); len(rows[aj.Identity]) != 0 {
		t.Fatalf("stale alice still listed: %+v", rows)
	}

	// A standard webinar whose video server cannot be read still fails: there is no audience
	// to list without it.
	h.rooms.mu.Lock()
	h.rooms.participantsErr = errors.New("deadline exceeded")
	h.rooms.mu.Unlock()
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil); res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("unreadable video server on standard: %d, want 500", res.StatusCode)
	}
}

func TestPresenceInviteAcceptGivesAStageToken(t *testing.T) {
	h := newHarness(t)
	h.signup("Presence Stage Host", "presence-stage@test.dev", true)
	h.rooms.mu.Lock()
	h.rooms.strictRoster = true
	h.rooms.mu.Unlock()
	wb := h.liveWebinar("Presence stage", nil)
	alice := h.registerAsGuest(wb.ID, "presence-stage-alice@test.dev")
	carol := h.registerAsGuest(wb.ID, "presence-stage-carol@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	_, cj, _ := h.joinAsGuestKey(wb.ID, carol.JoinKey)
	if _, _, raw := h.presence(wb.ID, alice.JoinKey); raw == nil {
		t.Fatal("presence")
	}

	// The host brings her on (from the roster row or her raised hand: the same request).
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity+"/stage",
		types.StageRequest{Role: types.RolePanelist})
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "invited") {
		t.Fatalf("invite: %d %s", res.StatusCode, raw)
	}

	// The data channel cannot reach her; her poll does. Carol's does not see Alice's invite.
	_, got, raw := h.presence(wb.ID, alice.JoinKey)
	if got.Invite == nil || got.OnStage {
		t.Fatalf("alice's poll = %s, want the invite", raw)
	}
	if _, other, raw := h.presence(wb.ID, carol.JoinKey); other.Invite != nil {
		t.Fatalf("carol's poll = %s, want no invite", raw)
	}

	// Accepting records the grant although she is not in the room, the poll says so, and her
	// next join is a stage token.
	h.acceptStage(wb.ID, alice.JoinKey)
	if _, got, raw := h.presence(wb.ID, alice.JoinKey); got.Invite != nil || !got.OnStage {
		t.Fatalf("after accept = %s, want onStage and no invite", raw)
	}
	res2, staged, raw := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	if res2.StatusCode != http.StatusOK || staged.Role != types.RolePanelist || !staged.CanPublish {
		t.Fatalf("promoted join: %d %+v %s", res2.StatusCode, staged, raw)
	}

	// Her one poll above is long gone.
	agePresence(t, wb.ID, cj.Identity, 2*time.Minute)
	// Carol is not reachable: a grant for her (a reconnect promotion the
	// host re-applies) is still "has left", as before.
	if err := h.store.GrantStage(context.Background(), wb.ID, cj.Identity, "", false); err != nil {
		t.Fatal(err)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+cj.Identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("grant to an unreachable attendee: %d %s, want 404", res.StatusCode, raw)
	}
}

func TestPresenceAccessControl(t *testing.T) {
	h := newHarness(t)
	h.signup("Presence Guard Host", "presence-guard@test.dev", true)
	wb := h.liveWebinar("Presence guard", nil)
	alice := h.registerAsGuest(wb.ID, "presence-guard-alice@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)

	// A made-up join key is nobody.
	if res, _, raw := h.presence(wb.ID, "NOTAREALKEY1"); res.StatusCode == http.StatusOK {
		t.Fatalf("unknown key: %d %s, want a refusal", res.StatusCode, raw)
	}
	// The host's own session (no join key) is on the stage roster: nothing to stand in for,
	// and no row is added for them.
	if res, got, raw := h.presence(wb.ID, ""); res.StatusCode != http.StatusOK || got.Invite != nil || got.OnStage {
		t.Fatalf("host presence: %d %s", res.StatusCode, raw)
	}

	// Removed: refused, and off the roster even though she was present a moment ago.
	if res, _, raw := h.presence(wb.ID, alice.JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("presence: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("remove: %d %s", res.StatusCode, raw)
	}
	if res, _, _ := h.presence(wb.ID, alice.JoinKey); res.StatusCode != http.StatusForbidden {
		t.Fatalf("removed presence: %d, want 403", res.StatusCode)
	}
	if rows := rosterRows(h.roster(wb.ID)); len(rows[aj.Identity]) != 0 {
		t.Fatalf("removed attendee still listed: %+v", rows)
	}

	// The roster itself is the host's: an anonymous caller cannot read it.
	if res, _ := h.anonGet("/api/host/webinars/" + wb.ID + "/participants"); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous roster: %d, want 401", res.StatusCode)
	}
}

func TestEdgeRosterSurvivesAnUnreadableVideoServer(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-partial@test.dev")
	wb := edgeWebinar(h, "Edge partial")
	alice := h.registerAsGuest(wb.ID, "edge-partial-alice@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	ev, _, cancel := h.openEvents(wb.ID, aj.EventsToken)
	defer cancel()
	waitFor(t, ev, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })

	h.rooms.mu.Lock()
	h.rooms.participantsErr = errors.New("ListParticipants: context deadline exceeded")
	h.rooms.mu.Unlock()

	live := h.roster(wb.ID)
	rows := rosterRows(live)
	if !live.Partial || len(rows[aj.Identity]) != 1 || rows[aj.Identity][0].Via != "stream" || live.Attendees != 1 {
		t.Fatalf("roster with the video server down = %+v, want alice via stream, partial", live)
	}

	// And the invite still reaches her over the stream.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("invite: %d %s", res.StatusCode, raw)
	}
	waitFor(t, ev, 3*time.Second, func(e sseEvent) bool {
		return e.kind == "packet" && strings.Contains(e.data, `"stage-invite"`)
	})
}
