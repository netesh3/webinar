package api_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* TestDemotionLosesTheStageBeforeHiding.
 *
 * LiveKit tells nobody about a participant who turns hidden. Demoting in one update, stage
 * gone and hidden at once, left every other client holding the speaker tile, mic off, for
 * the rest of the session (instant-webinar-2050, 2026-10-24). The visible update has to
 * come first.
 */
func TestDemotionLosesTheStageBeforeHiding(t *testing.T) {
	h := newHarness(t)
	h.signup("Ghost Host", "ghost@test.dev", true)
	wb := h.newWebinar("Ghost Session", nil)
	if !wb.Controls.HideAttendees {
		t.Fatal("the harness webinar should hide its audience")
	}
	reg := h.registerAsGuest(wb.ID, "ghost-panelist@test.dev")
	identity := "att_" + reg.JoinKey

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("promote: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)
	h.rooms.mu.Lock()
	before := len(h.rooms.roleChanges)
	h.rooms.mu.Unlock()

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RoleAttendee}); res.StatusCode != http.StatusOK {
		t.Fatalf("demote: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	changes := append([]lk.Spec{}, h.rooms.roleChanges[before:]...)
	h.rooms.mu.Unlock()
	if len(changes) != 2 {
		t.Fatalf("demotion made %d role changes, want 2 (visible, then hidden): %+v", len(changes), changes)
	}
	for i, c := range changes {
		if c.Role != types.RoleAttendee || c.Identity != identity {
			t.Errorf("change %d = %s %s, want attendee %s", i, c.Role, c.Identity, identity)
		}
	}
	if changes[0].Hidden || !changes[1].Hidden {
		t.Errorf("hidden = %v then %v, want false then true", changes[0].Hidden, changes[1].Hidden)
	}
}

// A webinar that shows its audience has nothing to hide: one update, as before.
func TestDemotionWithAVisibleAudienceIsOneUpdate(t *testing.T) {
	h := newHarness(t)
	h.signup("Open Host", "open@test.dev", true)
	wb := h.newWebinar("Open Session", func(in *types.WebinarInput) {
		in.Controls.HideAttendees = false
	})
	reg := h.registerAsGuest(wb.ID, "open-panelist@test.dev")
	identity := "att_" + reg.JoinKey

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("promote: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)
	h.rooms.mu.Lock()
	before := len(h.rooms.roleChanges)
	h.rooms.mu.Unlock()
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RoleAttendee}); res.StatusCode != http.StatusOK {
		t.Fatalf("demote: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	changes := append([]lk.Spec{}, h.rooms.roleChanges[before:]...)
	h.rooms.mu.Unlock()
	if len(changes) != 1 || changes[0].Hidden {
		t.Fatalf("role changes = %+v, want one visible attendee update", changes)
	}
}

// postLiveKitEvent delivers a webhook signed the way LiveKit signs one, with the fake
// pool's key (fakeKeyProvider: the secret is "secret_" + key).
func (h *harness) postLiveKitEvent(event *livekit.WebhookEvent) {
	h.t.Helper()
	body, err := protojson.Marshal(event)
	if err != nil {
		h.t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	at := lkauth.NewAccessToken("testkey", "secret_testkey")
	at.SetSha256(base64.StdEncoding.EncodeToString(sum[:]))
	token, err := at.ToJWT()
	if err != nil {
		h.t.Fatal(err)
	}
	res, raw := h.doRaw(http.MethodPost, "/api/webhooks/livekit", "application/webhook+json", body,
		map[string]string{"Authorization": token})
	if res.StatusCode >= 300 {
		h.t.Fatalf("webhook %s: status %d body %s", event.Event, res.StatusCode, raw)
	}
}

/* TestParticipantLeftIsAnnouncedToTheRoom.
 *
 * The mix kept a co-host who had left on the audience stream, while the SFU listed him gone
 * (instant-webinar-2050, 2026-10-24). The SFU's participant_left goes back out to the whole
 * room, the egress included, with the sid that left, so the mix can drop that tile and not a
 * rejoin's.
 */
func TestParticipantLeftIsAnnouncedToTheRoom(t *testing.T) {
	h := newHarness(t)
	h.signup("Left Host", "left@test.dev", true)
	wb := h.newWebinar("Left Session", nil)
	h.goLive(wb.ID)

	h.rooms.mu.Lock()
	before := len(h.rooms.sent)
	h.rooms.mu.Unlock()

	room := &livekit.Room{Name: lk.RoomName(wb.ID)}
	h.postLiveKitEvent(&livekit.WebhookEvent{
		Event: "participant_left", Id: "EV_one", Room: room,
		Participant: &livekit.ParticipantInfo{Identity: "att_GONE", Sid: "PA_gone1", Name: "Gone"},
	})
	// The mix itself leaving is not a tile on the stage.
	h.postLiveKitEvent(&livekit.WebhookEvent{
		Event: "participant_left", Id: "EV_two", Room: room,
		Participant: &livekit.ParticipantInfo{Identity: "EG_abc", Sid: "PA_eg"},
	})

	h.rooms.mu.Lock()
	sent := append([]sentPacket{}, h.rooms.sent[before:]...)
	h.rooms.mu.Unlock()
	var left []map[string]any
	for _, p := range sent {
		var msg map[string]any
		if json.Unmarshal(p.data, &msg) != nil || msg["kind"] != "participant-left" {
			continue
		}
		if len(p.to) != 0 {
			t.Errorf("participant-left went to %v, want the whole room", p.to)
		}
		if p.room != lk.RoomName(wb.ID) || p.topic != "webcast" {
			t.Errorf("packet room %q topic %q", p.room, p.topic)
		}
		left = append(left, msg)
	}
	if len(left) != 1 {
		t.Fatalf("participant-left packets = %d, want 1 (the egress skipped): %v", len(left), left)
	}
	if left[0]["identity"] != "att_GONE" || left[0]["sid"] != "PA_gone1" {
		t.Errorf("packet = %v", left[0])
	}
}
