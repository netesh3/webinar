package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* BringAllOnStage and its one-click way back.
 *
 * These endpoints had no HTTP-level test before this — the fake satisfied the
 * interface but nothing exercised it through the actual routes. Written
 * alongside the new endpoint rather than left as another gap, given this
 * session's own history of exactly this kind of thing (a RoomManager method
 * added without the interface/fake/route all kept in sync) breaking a
 * production deploy twice already.
 */

func TestBringAllOnStageGrantsTheFullSeat(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stageall@test.dev", true)
	wb := h.newWebinar("Bring Everyone", nil)

	reg := h.registerAsGuest(wb.ID, "audience1@test.dev")
	identity := "att_" + reg.JoinKey

	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_stageall_host", Role: types.RoleHost},
		types.LiveParticipant{Identity: identity, Role: types.RoleAttendee},
	)

	res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/stage-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("bring all on stage: status %d body %s", res.StatusCode, raw)
	}
	var out types.StageAllResponse
	h.decode(raw, &out)
	if out.Count != 1 {
		t.Fatalf("count = %d, want 1", out.Count)
	}

	row, ok := rosterRow(h, identity)
	if !ok {
		t.Fatal("attendee vanished from the roster")
	}
	if row.Role != types.RolePanelist {
		t.Errorf("role = %q, want panelist", row.Role)
	}
	// The whole point of this endpoint over AllowAllToSpeak: no AudioOnly
	// narrowing, so the attendee's camera is part of the grant.
	if row.AudioOnly {
		t.Error("AudioOnly = true; BringAllOnStage must grant the camera too, not just mic and screen share")
	}

	// Rejoining has to mint the same full grant, or a reconnect quietly
	// narrows everyone the host just widened.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Role != types.RolePanelist {
		t.Errorf("rejoin minted %q, want panelist", h.rooms.lastSpec.Role)
	}
	if h.rooms.lastSpec.AudioOnly {
		t.Error("rejoin minted AudioOnly=true; the persisted grant lost the camera")
	}
}

// The host and any panelist — scheduled or already promoted — must be left
// exactly as they are: this endpoint moves the audience, not the stage.
func TestBringAllOnStageLeavesTheStageAlone(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stageall2@test.dev", true)
	wb := h.newWebinar("Bring Everyone Again", nil)

	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_stageall2_host", Role: types.RoleHost},
		types.LiveParticipant{Identity: "user_panelist", Role: types.RolePanelist},
	)

	res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/stage-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("bring all on stage: status %d body %s", res.StatusCode, raw)
	}
	var out types.StageAllResponse
	h.decode(raw, &out)
	if out.Count != 0 {
		t.Errorf("count = %d, want 0 — nobody in the audience to promote", out.Count)
	}
}

// One click back — the same revoke that already undoes AllowAllToSpeak —
// takes back a full BringAllOnStage grant too, since it does not distinguish
// how someone came to be promoted.
func TestRevokeAllSpeakingUndoesBringAllOnStage(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stageall3@test.dev", true)
	wb := h.newWebinar("Bring Then Revoke", nil)

	reg := h.registerAsGuest(wb.ID, "audience2@test.dev")
	identity := "att_" + reg.JoinKey

	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_stageall3_host", Role: types.RoleHost},
		types.LiveParticipant{Identity: identity, Role: types.RoleAttendee},
	)

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/stage-all", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("bring all on stage: status %d body %s", res.StatusCode, raw)
	}

	res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/revoke-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke all: status %d body %s", res.StatusCode, raw)
	}
	var out types.StageAllResponse
	h.decode(raw, &out)
	if out.Count != 1 {
		t.Fatalf("revoked count = %d, want 1", out.Count)
	}

	row, ok := rosterRow(h, identity)
	if !ok {
		t.Fatal("attendee vanished from the roster")
	}
	if row.Role != types.RoleAttendee {
		t.Errorf("role after revoke = %q, want attendee", row.Role)
	}
}

// rosterRow copies one row out of the fake's roster under lock, so a test can
// assert on the state a host would actually see afterwards.
func rosterRow(h *harness, identity string) (types.LiveParticipant, bool) {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	for _, p := range h.rooms.roster {
		if p.Identity == identity {
			return p, true
		}
	}
	return types.LiveParticipant{}, false
}
