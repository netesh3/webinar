package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Meetings (meeting.go): everyone admitted is on the stage, the door is a lobby the host
 * answers, and the size is the meeting cap. Most of what is pinned here is what a meeting must
 * NOT do — skip the lobby, reach an edge or CDN path, hand out an attendee token, grow past
 * its cap — because each of those is one edit to a webinar path away. */

// meetingHost signs up a host and returns their account. No feature switches: meetings are
// open to every host.
func meetingHost(t *testing.T, h *harness) types.Account {
	t.Helper()
	return h.signup("Meeting Host", fmt.Sprintf("meet-host-%d@test.dev", time.Now().UnixNano()), true)
}

// instantMeeting creates a "meet now" meeting as the signed-in host.
func (h *harness) instantMeeting(topic string, mutate func(*types.WebinarInput)) types.Webinar {
	h.t.Helper()
	in := types.WebinarInput{Topic: topic, Kind: types.KindMeeting, Instant: true, TimeZone: "UTC"}
	if mutate != nil {
		mutate(&in)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("create meeting: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}

// knock is the lobby's front door, with no cookies: somebody who was sent the link.
func (h *harness) knock(slug, name, joinKey string) (*http.Response, types.MeetingKnockResponse, []byte) {
	h.t.Helper()
	body, _ := json.Marshal(types.MeetingKnockRequest{Name: name, JoinKey: joinKey})
	res, err := (&http.Client{}).Post(h.srv.URL+"/api/webinars/"+slug+"/meeting/knock",
		"application/json", bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out types.MeetingKnockResponse
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res, out, raw
}

func (h *harness) mustKnock(slug, name string) types.MeetingKnockResponse {
	h.t.Helper()
	res, out, raw := h.knock(slug, name, "")
	if res.StatusCode != http.StatusOK || out.State != types.LobbyWaiting || out.JoinKey == "" {
		h.t.Fatalf("knock %q: status %d body %s", name, res.StatusCode, raw)
	}
	return out
}

func (h *harness) lobby(slug string) []types.LobbyEntry {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/lobby", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("lobby: status %d body %s", res.StatusCode, raw)
	}
	var out []types.LobbyEntry
	h.decode(raw, &out)
	return out
}

// lobbyID finds a waiting guest's id by name.
func (h *harness) lobbyID(slug, name string) string {
	h.t.Helper()
	for _, e := range h.lobby(slug) {
		if e.Name == name {
			return e.ID
		}
	}
	h.t.Fatalf("%q is not waiting in %s", name, slug)
	return ""
}

func wantCode(t *testing.T, res *http.Response, raw []byte, status int, code string) {
	t.Helper()
	if res.StatusCode != status || errorCode(t, raw) != code {
		t.Fatalf("status %d body %s, want %d %s", res.StatusCode, raw, status, code)
	}
}

// roomOf fills the fake room with n people: the host and n-1 admitted guests.
func roomOf(hostID string, n int) []types.LiveParticipant {
	out := []types.LiveParticipant{{Identity: "user_" + hostID, Role: types.RoleHost}}
	for i := 1; i < n; i++ {
		out = append(out, types.LiveParticipant{Identity: fmt.Sprintf("att_FILL%02d", i), Role: types.RolePanelist})
	}
	return out
}

/* Both ways a meeting starts, and the shape the server forces on it whatever the form sent:
 * standard delivery, no registration, approval, passcode or hidden audience. A recurring
 * meeting, and a webinar edited into a meeting, are refused. */
func TestMeetingCreateInstantAndScheduled(t *testing.T) {
	h := newHarness(t)
	meetingHost(t, h)

	instant := h.instantMeeting("Stand-up", func(in *types.WebinarInput) {
		// A webinar form's defaults, all of which a meeting overrides.
		in.RegistrationRequired = true
		in.Approval = types.ApprovalManual
		in.Passcode = "123456"
		in.Controls.HideAttendees = true
	})
	scheduledAt := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "Weekly review", Kind: types.KindMeeting, StartsAt: scheduledAt, Duration: 30, TimeZone: "UTC",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("scheduled meeting: status %d body %s", res.StatusCode, raw)
	}
	var scheduled types.Webinar
	h.decode(raw, &scheduled)

	for _, wb := range []types.Webinar{instant, scheduled} {
		if wb.Kind != types.KindMeeting || wb.Status != types.StatusScheduled {
			t.Errorf("%s: kind %q status %q, want meeting/scheduled", wb.Topic, wb.Kind, wb.Status)
		}
		if wb.Delivery != types.DeliveryStandard || wb.RegistrationRequired || wb.Approval != types.ApprovalAutomatic ||
			wb.Passcode != "" || wb.PasscodeRequired || wb.Controls.HideAttendees {
			t.Errorf("%s: not a meeting's shape: delivery %q reg %v approval %q passcode %q hide %v", wb.Topic,
				wb.Delivery, wb.RegistrationRequired, wb.Approval, wb.Passcode, wb.Controls.HideAttendees)
		}
	}
	if scheduled.Duration != 30 || instant.Duration != 60 {
		t.Errorf("durations %d/%d, want 30 and the instant default 60", scheduled.Duration, instant.Duration)
	}

	res, raw = h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "Repeating", Kind: types.KindMeeting, StartsAt: scheduledAt, Duration: 30, TimeZone: "UTC",
		Recurrence: &types.RecurrenceInput{Pattern: "weekly", Interval: 1},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "recurrence") {
		t.Errorf("recurring meeting: status %d body %s, want 422 on recurrence", res.StatusCode, raw)
	}

	// A webinar cannot become a meeting in place; a meeting edited without a kind stays one.
	wb := h.newWebinar("A webinar", nil)
	in := types.WebinarInput{Topic: wb.Topic, Kind: types.KindMeeting, StartsAt: wb.StartsAt, Duration: 60, TimeZone: "UTC"}
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("webinar to meeting: status %d body %s, want 422", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+scheduled.ID, types.WebinarInput{
		Topic: "Weekly review, renamed", StartsAt: scheduledAt, Duration: 30, TimeZone: "UTC",
		RegistrationRequired: true, Approval: types.ApprovalManual,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("edit meeting: status %d body %s", res.StatusCode, raw)
	}
	var edited types.Webinar
	h.decode(raw, &edited)
	if edited.Kind != types.KindMeeting || edited.RegistrationRequired || edited.Approval != types.ApprovalAutomatic {
		t.Errorf("edited meeting lost its shape: kind %q reg %v approval %q", edited.Kind, edited.RegistrationRequired, edited.Approval)
	}
}

/* A meeting is never edge, even for a host with the edge switch who asks for it, and never
 * starts a mix — the panelist token is the only thing anyone gets. */
func TestMeetingIsNeverEdge(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-meet@test.dev")

	wb := h.instantMeeting("Edge-proof", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })
	if wb.Delivery != types.DeliveryStandard {
		t.Fatalf("meeting delivery %q, want standard", wb.Delivery)
	}
	// Even a row that somehow says edge does not hand anyone the feed.
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE webinars SET delivery = 'edge' WHERE slug = $1`, wb.ID); err != nil {
		t.Fatal(err)
	}
	h.goLive(wb.ID)

	k := h.mustKnock(wb.ID, "Ravi")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+h.lobbyID(wb.ID, "Ravi")+"/admit", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("admit: status %d body %s", res.StatusCode, raw)
	}
	res, join, raw := h.joinAsGuestKey(wb.ID, k.JoinKey)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}
	if join.Delivery != "" || join.PlaybackURL != "" || join.Token == "" || join.Role != types.RolePanelist {
		t.Errorf("meeting join went to the feed: delivery %q playback %q role %q", join.Delivery, join.PlaybackURL, join.Role)
	}

	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host join: status %d body %s", res.StatusCode, raw)
	}
	var host types.JoinResponse
	h.decode(raw, &host)
	if !host.Meeting || host.EdgeWebinar {
		t.Errorf("host join: meeting %v edge %v, want true/false", host.Meeting, host.EdgeWebinar)
	}
	h.server.WaitBackground()
	h.rooms.mu.Lock()
	calls := len(h.rooms.egressCalls)
	h.rooms.mu.Unlock()
	if calls != 0 {
		t.Errorf("a meeting started %d egress jobs, want none", calls)
	}
}

/* The whole door: knock, wait, admitted, a panelist token. A reload keeps its place; a denial
 * is final for that key; the other two doors are shut. */
func TestMeetingLobbyKnockAdmitJoin(t *testing.T) {
	h := newHarness(t)
	acct := meetingHost(t, h)
	wb := h.instantMeeting("Lobby", nil)
	// Knocking does not wait for the start; the host does. Live here so chat runs below.
	k := h.mustKnock(wb.ID, "  Asha   Menon ")
	h.goLive(wb.ID)
	res, _, raw := h.joinAsGuestKey(wb.ID, k.JoinKey)
	wantCode(t, res, raw, http.StatusConflict, "waiting_for_host")

	// A reload sends the key back and keeps the same place.
	res, again, raw := h.knock(wb.ID, "", k.JoinKey)
	if res.StatusCode != http.StatusOK || again.JoinKey != k.JoinKey || again.State != types.LobbyWaiting {
		t.Fatalf("re-knock: status %d body %s", res.StatusCode, raw)
	}
	waiting := h.lobby(wb.ID)
	if len(waiting) != 1 || waiting[0].Name != "Asha Menon" || waiting[0].RequestedAt == "" || strings.Contains(fmt.Sprint(waiting), k.JoinKey) {
		t.Fatalf("lobby = %+v, want one Asha Menon without her key", waiting)
	}
	// The host, once in the room, is told someone is at the door.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("host join: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.setRoster(types.LiveParticipant{Identity: "user_" + acct.ID, Role: types.RoleHost})
	h.mustKnock(wb.ID, "Second")
	packet, to := h.rooms.lastSent(t)
	if packet["kind"] != "lobby" || packet["waiting"] != float64(2) || len(to) != 1 || to[0] != "user_"+acct.ID {
		t.Errorf("lobby packet %v to %v, want waiting 2 to the host", packet, to)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+waiting[0].ID+"/admit", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("admit: status %d body %s", res.StatusCode, raw)
	}
	if _, st, _ := h.knock(wb.ID, "", k.JoinKey); st.State != types.LobbyAdmitted {
		t.Errorf("re-knock after admit: state %q, want admitted", st.State)
	}
	res, join, raw := h.joinAsGuestKey(wb.ID, k.JoinKey)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}
	if join.Role != types.RolePanelist || !join.CanPublish || !join.Meeting || join.Hidden || join.Whiteboard {
		t.Errorf("join = role %q publish %v meeting %v hidden %v whiteboard %v",
			join.Role, join.CanPublish, join.Meeting, join.Hidden, join.Whiteboard)
	}
	if spec := h.rooms.lastSpec; spec.Promoted || spec.DataOnly || spec.Role != types.RolePanelist || spec.Name != "Asha Menon" {
		t.Errorf("token spec = %+v, want an unpromoted panelist named Asha Menon", spec)
	}

	// Admitted guests chat as the stage, not as an audience.
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_" + acct.ID, Role: types.RoleHost},
		types.LiveParticipant{Identity: "att_" + k.JoinKey, Role: types.RolePanelist},
	)
	if res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{JoinKey: k.JoinKey, Kind: types.MsgChat, ID: "m-meet-0001", Text: "hello"}); res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}
	packet, _ = h.rooms.lastSent(t)
	if from, _ := packet["from"].(map[string]any); from["role"] != string(types.RolePanelist) {
		t.Errorf("meeting chat from %v, want role panelist", packet["from"])
	}

	// Deny is final for that key.
	second := h.lobbyID(wb.ID, "Second")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+second+"/deny", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("deny: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+second+"/admit", nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("admit after deny: status %d body %s, want 404", res.StatusCode, raw)
	}
	var secondKey string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT join_key FROM registrations WHERE id = $1`, second).Scan(&secondKey); err != nil {
		t.Fatal(err)
	}
	res, _, raw = h.joinAsGuestKey(wb.ID, secondKey)
	wantCode(t, res, raw, http.StatusForbidden, "lobby_denied")
	res, _, raw = h.knock(wb.ID, "Second", secondKey)
	wantCode(t, res, raw, http.StatusForbidden, "lobby_denied")

	// The lobby is the only door.
	h.allowOpenJoin()
	res, raw = h.guestJoin(wb.ID, "Skipper")
	wantCode(t, res, raw, http.StatusConflict, "meeting_knock")
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Reg", Email: "reg-meet@test.dev", Consent: true, Phone: testPhone,
	})
	wantCode(t, res, raw, http.StatusConflict, "meeting_knock")

	// Bad names, a webinar's slug and an ended meeting.
	if res, _, _ := h.knock(wb.ID, strings.Repeat("x", 61), ""); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("long name: status %d, want 422", res.StatusCode)
	}
	webinar := h.newWebinar("Not a meeting", nil)
	res, _, raw = h.knock(webinar.ID, "Lost", "")
	wantCode(t, res, raw, http.StatusNotFound, "not_found")
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+webinar.ID+"/lobby", nil)
	wantCode(t, res, raw, http.StatusUnprocessableEntity, "not_a_meeting")
	if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	res, _, raw = h.knock(wb.ID, "Late", "")
	wantCode(t, res, raw, http.StatusConflict, "meeting_ended")
	res, _, raw = h.joinAsGuestKey(wb.ID, k.JoinKey)
	wantCode(t, res, raw, http.StatusConflict, "meeting_ended")
}

/* The cap is the whole room, host included: ten by default, an admin's number when set. Admit
 * stops at it, admit-all lets in only what fits (oldest first), and the join checks again. */
func TestMeetingCap(t *testing.T) {
	h := newHarness(t)
	acct := meetingHost(t, h)
	wb := h.instantMeeting("Capped", nil)
	h.goLive(wb.ID)
	// Pin the meeting to the fake project, as the host joining does.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("host join: status %d body %s", res.StatusCode, raw)
	}

	var keys []string
	for i := range 12 {
		keys = append(keys, h.mustKnock(wb.ID, fmt.Sprintf("Guest %02d", i)).JoinKey)
	}

	// Host plus eight: room for one more under the default 10.
	h.rooms.setRoster(roomOf(acct.ID, 9)...)
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/admit-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admit all: status %d body %s", res.StatusCode, raw)
	}
	var all types.LobbyAdmitAllResponse
	h.decode(raw, &all)
	if all.Admitted != 1 || all.Left != 11 {
		t.Fatalf("admit all = %+v, want 1 admitted, 11 left", all)
	}
	if _, st, _ := h.knock(wb.ID, "", keys[0]); st.State != types.LobbyAdmitted {
		t.Errorf("the longest-waiting guest was not the one admitted: %q", st.State)
	}

	// Full: admit refuses, and an admitted guest arriving to a full room is turned away.
	h.rooms.setRoster(roomOf(acct.ID, 10)...)
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+h.lobbyID(wb.ID, "Guest 01")+"/admit", nil)
	wantCode(t, res, raw, http.StatusConflict, "meeting_full")
	res, _, raw = h.joinAsGuestKey(wb.ID, keys[0])
	wantCode(t, res, raw, http.StatusConflict, "meeting_full")
	// Someone already counted in the room (a reconnect) is not refused their own seat.
	h.rooms.setRoster(append(roomOf(acct.ID, 9), types.LiveParticipant{Identity: "att_" + keys[0], Role: types.RolePanelist})...)
	if res, _, raw := h.joinAsGuestKey(wb.ID, keys[0]); res.StatusCode != http.StatusOK {
		t.Errorf("reconnect at the cap: status %d body %s", res.StatusCode, raw)
	}

	// An admin raises this account to 50; the same room now has forty more seats.
	capacity := 50
	if err := h.store.SetUserMeetingCap(context.Background(), acct.ID, &capacity); err != nil {
		t.Fatal(err)
	}
	h.rooms.setRoster(roomOf(acct.ID, 10)...)
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/admit-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admit all at 50: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &all)
	if all.Admitted != 11 || all.Left != 0 {
		t.Errorf("admit all at 50 = %+v, want 11 admitted, 0 left", all)
	}
	h.rooms.setRoster(roomOf(acct.ID, 49)...)
	if res, _, raw := h.joinAsGuestKey(wb.ID, keys[5]); res.StatusCode != http.StatusOK {
		t.Errorf("join at 49 of 50: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.setRoster(roomOf(acct.ID, 50)...)
	res, _, raw = h.joinAsGuestKey(wb.ID, keys[6])
	wantCode(t, res, raw, http.StatusConflict, "meeting_full")

	// The room itself is sized from the meeting cap, not the attendee ceiling.
	h.rooms.mu.Lock()
	size := h.rooms.created["webinar_"+wb.ID]
	h.rooms.mu.Unlock()
	if size != 50+5 {
		t.Errorf("meeting room created with max %d, want the meeting cap 50 plus headroom 5", size)
	}
}

// The stage actions have nothing to act on in a meeting, and say so.
func TestMeetingRefusesStageActions(t *testing.T) {
	h := newHarness(t)
	meetingHost(t, h)
	wb := h.instantMeeting("No stage", nil)
	h.goLive(wb.ID)
	base := "/api/host/webinars/" + wb.ID

	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, base + "/participants/att_SOMEONE/stage", types.StageRequest{Role: types.RolePanelist}},
		{http.MethodPost, base + "/participants/att_SOMEONE/stage", types.StageRequest{Role: types.RoleAttendee}},
		{http.MethodPost, base + "/participants/allow-all", nil},
		{http.MethodPost, base + "/participants/stage-all", nil},
		{http.MethodPost, base + "/participants/revoke-all", nil},
		{http.MethodPatch, base + "/controls", types.ControlsPatch{HideAttendees: ptr(true)}},
	} {
		res, raw := h.do(c.method, c.path, c.body)
		if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "not_in_meeting" {
			t.Errorf("%s %s: status %d body %s, want 422 not_in_meeting", c.method, c.path, res.StatusCode, raw)
		}
	}
	// Ordinary controls still work.
	if res, raw := h.do(http.MethodPatch, base+"/controls", types.ControlsPatch{ChatEnabled: ptr(false)}); res.StatusCode != http.StatusOK {
		t.Errorf("chat toggle in a meeting: status %d body %s", res.StatusCode, raw)
	}
}
