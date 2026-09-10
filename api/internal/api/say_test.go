package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The host-controlled chat destination, and the relay that enforces it.
 *
 * The claim being tested is narrow and worth stating: a panelists-only message is
 * never SENT to an attendee's browser. Not hidden by their client, not filtered out
 * of a list — the SFU is handed a recipient list that does not contain them. These
 * tests assert on that list, because it is the only thing that actually decides who
 * can read a message.
 */

// sayAsGuest posts a realtime message with no cookies at all, which is the path an
// attendee from an emailed link takes. A separate client keeps the harness's
// host session out of it — otherwise a test could pass by exercising the host
// path while claiming to test an attendee.
func (h *harness) sayAsGuest(slug string, body types.SendMessageRequest) (*http.Response, []byte) {
	h.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		h.t.Fatal(err)
	}
	res, err := (&http.Client{}).Post(
		h.srv.URL+"/api/webinars/"+slug+"/say", "application/json", bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res, out
}

// liveWebinar schedules and starts one, so the relay has something to deliver to.
func (h *harness) liveWebinar(topic string, mutate func(*types.WebinarInput)) types.Webinar {
	h.t.Helper()
	wb := h.newWebinar(topic, mutate)
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("start webinar: status %d body %s", res.StatusCode, raw)
	}
	var started types.Webinar
	h.decode(raw, &started)
	return started
}

func (h *harness) setDestination(slug string, to types.ChatDestination) types.Webinar {
	h.t.Helper()
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+slug+"/controls",
		types.ControlsPatch{ChatDestination: &to})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("set destination %q: status %d body %s", to, res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}

// ------------------------------------------------------------ the control

// Everyone by default. A webinar that quietly routed the audience's first messages
// away from the audience would be a surprise, and the restrictive setting is the
// one worth requiring a decision.
func TestChatDestinationDefaultsToEveryone(t *testing.T) {
	h := newHarness(t)
	h.signup("Default Host", "chatdefault@test.dev", true)
	wb := h.newWebinar("Defaults", nil)

	if wb.Controls.ChatDestination != types.ChatToEveryone {
		t.Errorf("ChatDestination = %q, want everyone", wb.Controls.ChatDestination)
	}
}

// Persisted so it applies to somebody who joins ten minutes later, and mirrored
// into room metadata so the browsers already connected react without polling.
func TestChatDestinationPersistsAndBroadcasts(t *testing.T) {
	h := newHarness(t)
	h.signup("Dest Host", "chatdest@test.dev", true)
	wb := h.liveWebinar("Destinations", nil)

	updated := h.setDestination(wb.ID, types.ChatToPanelists)
	if updated.Controls.ChatDestination != types.ChatToPanelists {
		t.Fatalf("response ChatDestination = %q, want panelists", updated.Controls.ChatDestination)
	}

	meta := h.rooms.roomMeta(t, "webinar_"+wb.ID)
	if meta.Controls.ChatDestination != types.ChatToPanelists {
		t.Errorf("room metadata ChatDestination = %q, want panelists — connected clients would never hear about the change",
			meta.Controls.ChatDestination)
	}

	// And it survives a fresh read, which is what makes it apply to a late joiner.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reload: status %d body %s", res.StatusCode, raw)
	}
	var reloaded types.Webinar
	h.decode(raw, &reloaded)
	if reloaded.Controls.ChatDestination != types.ChatToPanelists {
		t.Errorf("stored ChatDestination = %q, want panelists", reloaded.Controls.ChatDestination)
	}
}

// Refused rather than coerced. Falling back to a default would widen an audience
// the host was trying to narrow.
func TestChatDestinationRejectsUnknownValue(t *testing.T) {
	h := newHarness(t)
	h.signup("Strict Host", "chatstrict@test.dev", true)
	wb := h.newWebinar("Strict", nil)
	h.setDestination(wb.ID, types.ChatToPanelists)

	bogus := types.ChatDestination("everybody")
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{ChatDestination: &bogus})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status %d body %s, want 422", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if apiErr.Fields["chatDestination"] == "" {
		t.Errorf("no field error for chatDestination: %s", raw)
	}

	// And the setting the host DID choose is still in place.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reload: status %d body %s", res.StatusCode, raw)
	}
	var reloaded types.Webinar
	h.decode(raw, &reloaded)
	if reloaded.Controls.ChatDestination != types.ChatToPanelists {
		t.Errorf("a rejected patch changed the stored value to %q", reloaded.Controls.ChatDestination)
	}
}

// Only the host may change it. An attendee choosing their own audience is the
// thing this feature exists to prevent, so the endpoint has to refuse them even
// with a valid session.
func TestChatDestinationIsHostOnly(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "chatowner@test.dev", true)
	wb := h.liveWebinar("Ownership", nil)
	h.logout()

	h.signup("Bystander", "chatbystander@test.dev", true)
	to := types.ChatToPanelists
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{ChatDestination: &to})
	if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d body %s, want 403 or 404 for a non-host", res.StatusCode, raw)
	}
}

// ------------------------------------------------------------ the routing

// The load-bearing test. An attendee asks for "everyone" while the host has set
// "panelists", and the message must reach the stage and nobody else.
func TestAttendeeChatCannotOverrideHostDestination(t *testing.T) {
	h := newHarness(t)
	h.signup("Routing Host", "chatroute@test.dev", true)
	wb := h.liveWebinar("Routing", nil)
	h.setDestination(wb.ID, types.ChatToPanelists)

	reg := h.registerAsGuest(wb.ID, "chatroute-attendee@test.dev")
	other := h.registerAsGuest(wb.ID, "chatroute-other@test.dev")

	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_host", Role: types.RoleHost},
		types.LiveParticipant{Identity: "user_panelist", Role: types.RolePanelist},
		types.LiveParticipant{Identity: "att_" + reg.JoinKey, Role: types.RoleAttendee},
		types.LiveParticipant{Identity: "att_" + other.JoinKey, Role: types.RoleAttendee},
	)

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat,
		ID:      "msg-0000001",
		Text:    "can everyone see this?",
		// The override attempt. A patched bundle would send exactly this.
		Destination: types.ChatToEveryone,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}

	var out types.SendMessageResponse
	h.decode(raw, &out)
	if out.Destination != types.ChatToPanelists {
		t.Errorf("response Destination = %q, want panelists", out.Destination)
	}

	packet, to := h.rooms.lastSent(t)
	if packet["destination"] != string(types.ChatToPanelists) {
		t.Errorf("delivered destination = %v, want panelists", packet["destination"])
	}
	if slices.Contains(to, "att_"+other.JoinKey) {
		t.Errorf("a panelists-only message was addressed to another attendee: %v", to)
	}
	for _, want := range []string{"user_host", "user_panelist", "att_" + reg.JoinKey} {
		if !slices.Contains(to, want) {
			t.Errorf("recipient %q missing from %v", want, to)
		}
	}
}

// The sender comes from the credential, so a message cannot be signed with
// somebody else's name. Before the relay, `from` was whatever the sending browser
// wrote and an attendee could label themselves Host.
func TestAttendeeCannotSpoofSender(t *testing.T) {
	h := newHarness(t)
	h.signup("Spoof Host", "chatspoof@test.dev", true)
	wb := h.liveWebinar("Spoofing", nil)
	reg := h.registerAsGuest(wb.ID, "chatspoof-attendee@test.dev")

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat,
		ID:      "msg-0000002",
		Text:    "trust me, I'm the host",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}

	packet, to := h.rooms.lastSent(t)
	if len(to) != 0 {
		t.Errorf("an everyone message was addressed to %v, want a broadcast", to)
	}
	from, ok := packet["from"].(map[string]any)
	if !ok {
		t.Fatalf("packet has no sender: %v", packet)
	}
	if from["role"] != string(types.RoleAttendee) {
		t.Errorf("sender role = %v, want attendee", from["role"])
	}
	if from["identity"] != "att_"+reg.JoinKey {
		t.Errorf("sender identity = %v, want att_%s", from["identity"], reg.JoinKey)
	}
	if from["name"] != "Guest User" {
		t.Errorf("sender name = %v, want the registered name", from["name"])
	}
}

/* A stage-only message with nobody on stage is KEPT, not refused.
 *
 * This changed when chat became persistent, and the new behaviour is the better one: the
 * message goes into the transcript and the first panelist to connect picks it up in their
 * backlog. Refusing it — which is what used to happen — threw away something somebody had
 * taken the trouble to write, on the grounds that the person it was for had not arrived.
 *
 * What must still be true is that it is not BROADCAST. An empty recipient list means "no
 * filter" to the SFU, so delivering it would send a stage-only message to the whole
 * audience. Nothing goes on the wire, and `recipients: 0` is how the sender is told.
 */
func TestPanelistChatWithNobodyOnStage(t *testing.T) {
	h := newHarness(t)
	h.signup("Empty Host", "chatempty@test.dev", true)
	wb := h.liveWebinar("Empty stage", nil)
	h.setDestination(wb.ID, types.ChatToPanelists)
	reg := h.registerAsGuest(wb.ID, "chatempty-attendee@test.dev")

	// An audience, and nobody on the stage.
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "att_" + reg.JoinKey, Role: types.RoleAttendee},
		types.LiveParticipant{Identity: "att_OTHER", Role: types.RoleAttendee},
	)

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat,
		ID:      "msg-0000003",
		Text:    "anyone there?",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s, want 200 — the message should be kept", res.StatusCode, raw)
	}
	var out types.SendMessageResponse
	h.decode(raw, &out)
	if out.Destination != types.ChatToPanelists {
		t.Errorf("destination = %q, want panelists", out.Destination)
	}
	if out.Recipients != 0 {
		t.Errorf("recipients = %d, want 0 — nobody is on stage", out.Recipients)
	}

	// Nothing on the wire: a broadcast here would show the audience a stage-only line.
	h.rooms.mu.Lock()
	sent := len(h.rooms.sent)
	h.rooms.mu.Unlock()
	if sent != 0 {
		t.Error("a stage-only message was broadcast to the audience")
	}

	// But it is in the transcript, which is how the stage eventually reads it.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/chat", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("transcript: status %d body %s", res.StatusCode, raw)
	}
	var archive struct {
		Messages []types.ChatMessage `json:"messages"`
	}
	h.decode(raw, &archive)
	if len(archive.Messages) != 1 || archive.Messages[0].Message != "anyone there?" {
		t.Errorf("the message was not kept: %+v", archive.Messages)
	}
}

// Turning chat off has to stop messages arriving, not just stop a compose box
// being drawn for the person who wanted to send one.
func TestChatDisabledStopsAttendeesNotTheStage(t *testing.T) {
	h := newHarness(t)
	h.signup("Muted Host", "chatmuted@test.dev", true)
	wb := h.liveWebinar("Chat off", func(in *types.WebinarInput) {
		in.Controls.ChatEnabled = false
	})
	reg := h.registerAsGuest(wb.ID, "chatmuted-attendee@test.dev")

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat,
		ID:      "msg-0000004",
		Text:    "hello?",
	})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("attendee status %d body %s, want 403", res.StatusCode, raw)
	}

	// The host is not silenced by their own control — they still have to be able
	// to explain why chat is off.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{Kind: types.MsgChat, ID: "msg-0000005", Text: "chat is off, sorry"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host status %d body %s, want 200", res.StatusCode, raw)
	}
	packet, _ := h.rooms.lastSent(t)
	from, _ := packet["from"].(map[string]any)
	if from["role"] != string(types.RoleHost) {
		t.Errorf("sender role = %v, want host", from["role"])
	}
}

// The host may address the stage, because a panelists-only message is addressed
// to the people who are already in that conversation.
func TestHostMayChooseItsOwnDestination(t *testing.T) {
	h := newHarness(t)
	h.signup("Choosy Host", "chatchoosy@test.dev", true)
	wb := h.liveWebinar("Host choice", nil)
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_panelist", Role: types.RolePanelist},
		types.LiveParticipant{Identity: "att_AUDIENCE", Role: types.RoleAttendee},
	)

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{
			Kind:        types.MsgChat,
			ID:          "msg-0000006",
			Text:        "two minutes to go",
			Destination: types.ChatToPanelists,
		})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}
	packet, to := h.rooms.lastSent(t)
	if packet["destination"] != string(types.ChatToPanelists) {
		t.Errorf("destination = %v, want panelists", packet["destination"])
	}
	if slices.Contains(to, "att_AUDIENCE") {
		t.Errorf("the audience was addressed on a stage-only message: %v", to)
	}
}

// ------------------------------------------------------------ the other kinds

// The same relay carries questions, hands and reactions, and the controls that
// govern them are enforced in the same place.
func TestRelayEnforcesTheOtherControls(t *testing.T) {
	h := newHarness(t)
	h.signup("Controls Host", "chatothers@test.dev", true)
	wb := h.liveWebinar("Other controls", func(in *types.WebinarInput) {
		in.Controls.QAEnabled = false
		in.Controls.RaiseHandEnabled = false
		in.Controls.ReactionsEnabled = true
	})
	reg := h.registerAsGuest(wb.ID, "chatothers-attendee@test.dev")

	cases := []struct {
		name string
		req  types.SendMessageRequest
		want int
	}{
		{"question with Q&A closed", types.SendMessageRequest{
			Kind: types.MsgQuestion, ID: "qst-0000001", Text: "why?",
		}, http.StatusForbidden},
		{"upvote with Q&A closed", types.SendMessageRequest{
			Kind: types.MsgUpvote, QuestionID: "qst-0000001",
		}, http.StatusForbidden},
		{"hand with raise hand off", types.SendMessageRequest{
			Kind: types.MsgHand, Raised: true,
		}, http.StatusForbidden},
		{"reaction with reactions on", types.SendMessageRequest{
			Kind: types.MsgReaction, Emoji: "👏",
		}, http.StatusOK},
		// A fixed list, checked server-side: this string would otherwise be
		// rendered in every browser in the room.
		{"unknown reaction", types.SendMessageRequest{
			Kind: types.MsgReaction, Emoji: "<script>",
		}, http.StatusBadRequest},
		{"unknown kind", types.SendMessageRequest{
			Kind: types.RoomMessageKind("shout"), Text: "hi",
		}, http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := tc.req
			req.JoinKey = reg.JoinKey
			res, raw := h.sayAsGuest(wb.ID, req)
			if res.StatusCode != tc.want {
				t.Errorf("status %d body %s, want %d", res.StatusCode, raw, tc.want)
			}
		})
	}
}

// A message needs a credential. Without this the endpoint would be an open relay
// into somebody else's webinar.
func TestSayRequiresACredential(t *testing.T) {
	h := newHarness(t)
	h.signup("Closed Host", "chatclosed@test.dev", true)
	wb := h.liveWebinar("Credentials", nil)

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		Kind: types.MsgChat, ID: "msg-0000007", Text: "let me in",
	})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d body %s, want 401", res.StatusCode, raw)
	}

	res, raw = h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: "NOTAKEY",
		Kind:    types.MsgChat, ID: "msg-0000008", Text: "or me",
	})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad key: status %d body %s, want 401", res.StatusCode, raw)
	}
}

// Nothing is relayed into a webinar that is not running.
func TestSayRequiresALiveWebinar(t *testing.T) {
	h := newHarness(t)
	h.signup("Scheduled Host", "chatscheduled@test.dev", true)
	wb := h.newWebinar("Not started", nil)
	reg := h.registerAsGuest(wb.ID, "chatscheduled-attendee@test.dev")

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat, ID: "msg-0000009", Text: "early",
	})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status %d body %s, want 409", res.StatusCode, raw)
	}
}

// The wire format is a contract with web/lib/realtime.ts, which is the only way a
// message enters the frontend. A field renamed on one side and not the other
// produces a silently empty chat rather than a compile error, so the keys are
// pinned here.
func TestSayPacketWireFormat(t *testing.T) {
	h := newHarness(t)
	h.signup("Wire Host", "chatwire@test.dev", true)
	wb := h.liveWebinar("Wire format", nil)
	reg := h.registerAsGuest(wb.ID, "chatwire-attendee@test.dev")

	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey,
		Kind:    types.MsgChat,
		ID:      "msg-0000010",
		Text:    "  padded  ",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}

	packet, _ := h.rooms.lastSent(t)
	for _, key := range []string{"kind", "id", "from", "text", "destination", "at"} {
		if _, ok := packet[key]; !ok {
			t.Errorf("packet is missing %q: %v", key, packet)
		}
	}
	if packet["text"] != "padded" {
		t.Errorf("text = %q, want it trimmed", packet["text"])
	}
	if at, ok := packet["at"].(float64); !ok || at <= 0 {
		t.Errorf("at = %v, want the server's clock in milliseconds", packet["at"])
	}
	from, ok := packet["from"].(map[string]any)
	if !ok {
		t.Fatalf("from is not an object: %v", packet["from"])
	}
	for _, key := range []string{"identity", "name", "role"} {
		if _, ok := from[key]; !ok {
			t.Errorf("sender is missing %q: %v", key, from)
		}
	}
}
