package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Spam detection on live chat and Q&A (spam.go), against the fake gpt-5-nano: the free rules
 * flag on their own, the AI pass is batched (never a call per message) and only while the
 * session may use AI, at a cap it pauses, flags are the host team's alone, the one-click
 * actions work, and Auto-hide is off unless the host turns it on. */

// spamSetup is a live session whose host has AI (unless plain), with no time trigger, and
// four registered guests.
func spamSetup(t *testing.T, reply string, plain bool, tweak func(*config.Config)) (*harness, *fakeOpenAI, types.Webinar, []types.Registration) {
	t.Helper()
	t.Cleanup(api.SetSpamEvery(time.Hour))
	h, model := aiHarness(t, reply, tweak)
	email := "spam-host-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-")) + "@test.dev"
	h.signup("Spam Host", email, true)
	/* The filter, rules included, needs the account's ai switch (Business and up, 1 Nov 2026).
	 * plain is a session that may not use the AI: the account has it, the room's switch is off. */
	enableAI(t, h, email)
	wb := h.liveWebinar("Personal finance for your first job", nil)
	if plain {
		if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
			t.Fatalf("AI off: %d %s", res.StatusCode, raw)
		}
	}
	var guests []types.Registration
	for _, g := range []string{"asha", "ravi", "meera", "kabir"} {
		guests = append(guests, h.registerAsGuest(wb.ID, "spam-"+g+"-"+strings.ToLower(t.Name())+"@test.dev"))
	}
	return h, model, wb, guests
}

var spamSeq int

func (h *harness) spamChat(slug string, g types.Registration, text string) string {
	h.t.Helper()
	spamSeq++
	id := fmt.Sprintf("spam-msg-%06d", spamSeq)
	h.mustSayAsGuest(slug, types.SendMessageRequest{JoinKey: g.JoinKey, Kind: types.MsgChat, ID: id, Text: text})
	return id
}

func (h *harness) spamFlags(slug string) types.SpamFlagsResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/spam", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("spam flags: %d %s", res.StatusCode, raw)
	}
	var out types.SpamFlagsResponse
	h.decode(raw, &out)
	return out
}

func (h *harness) spamAction(slug, kind, id, action string) (*http.Response, []byte) {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/host/webinars/"+slug+"/spam/"+kind+"/"+id, types.SpamActionRequest{Action: action})
}

// spamPackets is every spam-flags packet handed to the SFU, by recipient list.
func (h *harness) spamPackets() [][]string {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	var out [][]string
	for _, p := range h.rooms.sent {
		var m map[string]any
		if json.Unmarshal(p.data, &m) == nil && m["kind"] == "spam-flags" {
			out = append(out, p.to)
		}
	}
	return out
}

func flagFor(out types.SpamFlagsResponse, id string) (types.SpamFlag, bool) {
	for _, f := range out.Flags {
		if f.ID == id {
			return f, true
		}
	}
	return types.SpamFlag{}, false
}

const whatsappSpam = "Join chat.whatsapp.com/AbCdEf for free tips and earn ₹5000 daily"

func TestSpamRulesFlagWithoutAIAndOnlyForTheHostTeam(t *testing.T) {
	h, model, wb, g := spamSetup(t, `{"items":[]}`, true, nil)
	host := h.hostWebinar(wb.ID).Host

	clean := h.spamChat(wb.ID, g[0], "What is a good emergency fund size?")
	spam := h.spamChat(wb.ID, g[1], whatsappSpam)
	// A middling score is for the AI, which this session may not use: not recorded at all.
	link := h.spamChat(wb.ID, g[2], "notes at www.example.com")

	out := h.spamFlags(wb.ID)
	if out.AI || len(out.Flags) != 1 {
		t.Fatalf("flags = %+v", out)
	}
	f := out.Flags[0]
	if f.ID != spam || f.Kind != "chat" || f.Status != "flagged" || f.Source != "rules" || f.Category != "scam" ||
		f.Confidence < 0.9 || f.Identity != "att_"+g[1].JoinKey {
		t.Fatalf("flag = %+v", f)
	}
	if _, ok := flagFor(out, clean); ok {
		t.Fatal("a clean message was flagged")
	}
	if _, ok := flagFor(out, link); ok {
		t.Fatal("a link was flagged without AI")
	}
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls without AI = %d", n)
	}
	// Never auto-deleted by default.
	var deleted bool
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT deleted_at IS NOT NULL FROM chat_messages WHERE id = $1`, spam).Scan(&deleted); err != nil || deleted {
		t.Fatalf("deleted = %v %v", deleted, err)
	}

	// The nudge went to the host alone, never to the room.
	packets := h.spamPackets()
	if len(packets) == 0 {
		t.Fatal("no spam-flags packet")
	}
	for _, to := range packets {
		if len(to) != 1 || to[0] != "user_"+host.ID {
			t.Fatalf("spam-flags packet to %v, want the host only", to)
		}
	}
	// And no packet to the room carried a flag.
	h.rooms.mu.Lock()
	for _, p := range h.rooms.sent {
		if len(p.to) == 0 && strings.Contains(string(p.data), "spam-flags") {
			t.Errorf("room packet mentions spam: %s", p.data)
		}
	}
	h.rooms.mu.Unlock()

	// Another host: not theirs. An attendee: no session at all.
	h.signup("Other Spam Host", "spam-other-host@test.dev", true)
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/spam", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("other host: %d", res.StatusCode)
	}
	h.logout()
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/spam", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("attendee: %d", res.StatusCode)
	}
	// The audience's chat backlog has no flag in it.
	res, raw := h.do(http.MethodGet, "/api/webinars/"+wb.ID+"/chat?joinKey="+g[0].JoinKey, nil)
	if res.StatusCode == http.StatusOK && strings.Contains(string(raw), "flagged") {
		t.Fatalf("backlog mentions a flag: %s", raw)
	}
}

func TestSpamAIPassIsBatchedScrubbedAndCapped(t *testing.T) {
	reply := `{"items":[{"id":"m1","spam":true,"category":"promo","confidence":0.92},` +
		`{"id":"m2","spam":false,"category":"other","confidence":0.1},` +
		`{"id":"m9","spam":true,"category":"scam","confidence":0.95}]}`
	h, model, wb, g := spamSetup(t, reply, false, nil)
	// The batching rule with a small batch, so eight messages make it (production: 20).
	t.Cleanup(api.SetSpamBatch(8))

	// Suspicious but not flagged: three links. Not a batch and not old enough: no call.
	a := h.spamChat(wb.ID, g[0], "my course at www.bestcourse.example.com")
	b := h.spamChat(wb.ID, g[1], "slides at www.slides.example.com")
	h.spamChat(wb.ID, g[2], "notes www.notes.example.com")
	h.spamChat(wb.ID, g[3], "Is SIP better than FD?")
	out := h.spamFlags(wb.ID)
	if !out.AI || len(out.Flags) != 0 || model.callCount() != 0 {
		t.Fatalf("before the batch: %+v, calls %d", out, model.callCount())
	}
	// Five more suspicious make the batch (eight). One has a phone number, which is scrubbed.
	h.spamChat(wb.ID, g[0], "call 98765 43210 for notes")
	h.spamChat(wb.ID, g[1], "www.one.example.com")
	h.spamChat(wb.ID, g[2], "www.two.example.com")
	h.spamChat(wb.ID, g[3], "www.three.example.com")
	h.spamChat(wb.ID, g[3], "www.four.example.com")
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls on the say path = %d, want 0", n)
	}
	out = h.spamFlags(wb.ID)
	if n := model.callsFor("chat_spam"); n != 1 {
		t.Fatalf("chat_spam calls = %d, want 1 for the batch", n)
	}
	p := model.userPrompt(0)
	for _, want := range []string{"Personal finance", "m1: my course at www.bestcourse", "[suspicious: link]", "[phone]", "Is SIP better than FD?"} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt missing %q:\n%s", want, p)
		}
	}
	for _, never := range []string{"98765", "Guest User", g[0].JoinKey} {
		if strings.Contains(p, never) {
			t.Errorf("prompt carries %q:\n%s", never, p)
		}
	}
	f, ok := flagFor(out, a)
	if !ok || f.Status != "flagged" || f.Source != "ai" || f.Category != "promo" || f.Confidence != 0.92 {
		t.Fatalf("flag for m1 = %+v (%v), all %+v", f, ok, out.Flags)
	}
	if _, ok := flagFor(out, b); ok {
		t.Fatal("the AI said m2 was fine, and it was flagged")
	}
	// m9 is the sampled clean message ("Is SIP …"): flagged from the sample at 0.95.
	if len(out.Flags) != 2 {
		t.Fatalf("flags = %+v", out.Flags)
	}

	// Nothing pending: the next read makes no call.
	h.spamFlags(wb.ID)
	if n := model.callsFor("chat_spam"); n != 1 {
		t.Fatalf("calls with nothing pending = %d", n)
	}

	// The tick's lane runs a due pass too: one pending, old enough.
	h.spamChat(wb.ID, g[0], "www.late.example.com")
	restore := api.SetSpamEvery(0)
	api.RunSpamLane(h.server, context.Background())
	restore()
	if n := model.callsFor("chat_spam"); n != 2 {
		t.Fatalf("calls after the lane = %d, want 2", n)
	}

	st := h.adminAI()
	found := false
	for _, f := range st.Month.Features {
		if f.Feature == types.AIFeatureChatSpam && f.Calls == 2 {
			found = true
		}
	}
	if !found {
		t.Fatalf("ai usage = %+v, want two chat_spam calls", st.Month.Features)
	}
}

func TestSpamAIGateOffMakesNoCalls(t *testing.T) {
	h, model, wb, g := spamSetup(t, `{"items":[]}`, false, nil)
	t.Cleanup(api.SetSpamEvery(0))
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("AI off: %d %s", res.StatusCode, raw)
	}
	for i := 0; i < 9; i++ {
		h.spamChat(wb.ID, g[i%4], fmt.Sprintf("www.site%d.example.com", i))
	}
	out := h.spamFlags(wb.ID)
	api.RunSpamLane(h.server, context.Background())
	if out.AI || len(out.Flags) != 0 || model.callCount() != 0 {
		t.Fatalf("with AI paused: %+v, calls %d", out, model.callCount())
	}
	// The rules still flag on their own.
	h.spamChat(wb.ID, g[0], whatsappSpam)
	if out := h.spamFlags(wb.ID); len(out.Flags) != 1 || model.callCount() != 0 {
		t.Fatalf("rules with AI paused: %+v, calls %d", out, model.callCount())
	}
}

func TestSpamAIPausesAtTheCap(t *testing.T) {
	h, model, wb, g := spamSetup(t, `{"items":[]}`, false, func(c *config.Config) { c.AIHostMonthlyUSD = 0.01 })
	t.Cleanup(api.SetSpamEvery(0))
	host := h.hostWebinar(wb.ID).Host
	if _, err := api.AIComplete(h.server, context.Background(), types.AIFeatureRecap, host.ID, aiHello); err != nil {
		t.Fatal(err)
	}
	h.spamChat(wb.ID, g[0], "www.capped.example.com")
	out := h.spamFlags(wb.ID)
	if !out.AI || !out.Limited || model.callsFor("chat_spam") != 0 {
		t.Fatalf("at the cap: %+v, calls %d", out, model.callsFor("chat_spam"))
	}
	// Paused: more reads do not knock on the cap.
	h.spamChat(wb.ID, g[1], "www.capped2.example.com")
	h.spamFlags(wb.ID)
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls = %d, want only the one that spent the month", n)
	}
}

func TestSpamActions(t *testing.T) {
	h, _, wb, g := spamSetup(t, `{"items":[]}`, true, nil)
	ctx := context.Background()
	chat := h.spamChat(wb.ID, g[0], whatsappSpam)
	h.ask(wb.ID, g[1], "q-spam-0001", "DM me on +91 98765 43210 for crypto tips")
	out := h.spamFlags(wb.ID)
	if len(out.Flags) != 2 {
		t.Fatalf("flags = %+v", out.Flags)
	}

	// Delete the chat message: gone from the transcript, and the room told.
	if res, raw := h.spamAction(wb.ID, "chat", chat, "delete"); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}
	var deleted bool
	if err := h.store.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM chat_messages WHERE id = $1`, chat).Scan(&deleted); err != nil || !deleted {
		t.Fatalf("deleted = %v %v", deleted, err)
	}
	// Hide the question: dismissed, which the audience's reads leave out.
	if res, raw := h.spamAction(wb.ID, "question", "q-spam-0001", "hide"); res.StatusCode != http.StatusOK {
		t.Fatalf("hide: %d %s", res.StatusCode, raw)
	}
	var dismissed bool
	if err := h.store.Pool().QueryRow(ctx, `SELECT dismissed FROM session_questions WHERE id = 'q-spam-0001'`).Scan(&dismissed); err != nil || !dismissed {
		t.Fatalf("dismissed = %v %v", dismissed, err)
	}
	// Mute: their chat and questions are refused until unmuted.
	if res, raw := h.spamAction(wb.ID, "chat", chat, "mute"); res.StatusCode != http.StatusOK {
		t.Fatalf("mute: %d %s", res.StatusCode, raw)
	}
	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{JoinKey: g[0].JoinKey, Kind: types.MsgChat, ID: "spam-muted-01", Text: "hello?"})
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "muted" {
		t.Fatalf("muted say: %d %s", res.StatusCode, raw)
	}
	if out := h.spamFlags(wb.ID); len(out.Muted) != 1 || out.Muted[0] != "att_"+g[0].JoinKey {
		t.Fatalf("muted = %v", out.Muted)
	}
	// Someone else is not muted.
	h.spamChat(wb.ID, g[2], "Thanks, very useful")
	if res, raw := h.spamAction(wb.ID, "chat", chat, "unmute"); res.StatusCode != http.StatusOK {
		t.Fatalf("unmute: %d %s", res.StatusCode, raw)
	}
	h.spamChat(wb.ID, g[0], "sorry")
	// Remove the person.
	if res, raw := h.spamAction(wb.ID, "question", "q-spam-0001", "remove"); res.StatusCode != http.StatusOK {
		t.Fatalf("remove: %d %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	removed := append([]string{}, h.rooms.removed...)
	h.rooms.mu.Unlock()
	if len(removed) != 1 || removed[0] != "att_"+g[1].JoinKey {
		t.Fatalf("removed = %v", removed)
	}
	// Not spam.
	if res, raw := h.spamAction(wb.ID, "chat", chat, "not_spam"); res.StatusCode != http.StatusOK {
		t.Fatalf("not spam: %d %s", res.StatusCode, raw)
	}
	out = h.spamFlags(wb.ID)
	if f, _ := flagFor(out, chat); f.Status != "not_spam" {
		t.Fatalf("chat flag = %+v", f)
	}
	if f, _ := flagFor(out, "q-spam-0001"); f.Status != "removed" {
		t.Fatalf("question flag = %+v", f)
	}
	// Unknown action, and a message that is not flagged.
	if res, _ := h.spamAction(wb.ID, "chat", chat, "explode"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown action: %d", res.StatusCode)
	}
	if res, _ := h.spamAction(wb.ID, "chat", "spam-nope-0001", "delete"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unflagged: %d", res.StatusCode)
	}
	// The Results page's counts: two flagged, one taken out (the removed person's question).
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recap", nil)
	if res.StatusCode == http.StatusOK {
		var rc types.SessionRecapResponse
		h.decode(raw, &rc)
		if rc.SpamFlagged != 2 || rc.SpamRemoved != 1 {
			t.Fatalf("recap counts = %d flagged, %d removed", rc.SpamFlagged, rc.SpamRemoved)
		}
	}
}

func TestSpamAutoHideIsOffByDefault(t *testing.T) {
	h, _, wb, g := spamSetup(t, `{"items":[]}`, true, nil)
	ctx := context.Background()
	isDeleted := func(id string) bool {
		var d bool
		if err := h.store.Pool().QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM chat_messages WHERE id = $1`, id).Scan(&d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	if out := h.spamFlags(wb.ID); out.Settings.AutoHide || out.Settings.AllowLinks {
		t.Fatalf("default settings = %+v", out.Settings)
	}
	first := h.spamChat(wb.ID, g[0], whatsappSpam)
	if isDeleted(first) {
		t.Fatal("hidden with Auto-hide off")
	}

	on := true
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/spam/settings", types.SpamSettingsPatch{AutoHide: &on})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("settings: %d %s", res.StatusCode, raw)
	}
	var st types.SpamSettings
	h.decode(raw, &st)
	if !st.AutoHide || st.AllowLinks {
		t.Fatalf("settings = %+v", st)
	}
	before := len(h.rooms.sent)
	second := h.spamChat(wb.ID, g[1], "Join chat.whatsapp.com/XyZ for guaranteed profit and earn ₹9000 daily")
	if !isDeleted(second) {
		t.Fatal("not hidden with Auto-hide on")
	}
	out := h.spamFlags(wb.ID)
	if f, _ := flagFor(out, second); f.Status != "auto_hidden" {
		t.Fatalf("flag = %+v", f)
	}
	// The room was told to drop it, the way a host's delete tells it.
	h.rooms.mu.Lock()
	told := false
	for _, p := range h.rooms.sent[before:] {
		told = told || (strings.Contains(string(p.data), `"chat-deleted"`) && strings.Contains(string(p.data), second))
	}
	h.rooms.mu.Unlock()
	if !told {
		t.Fatal("no chat-deleted packet")
	}
	// Below 0.9 is still only flagged.
	third := h.spamChat(wb.ID, g[2], "DM me, call me on +91 99887 76655")
	if isDeleted(third) {
		t.Fatal("a 0.75 flag was auto-hidden")
	}
}

// Below Business (no ai switch) there is no filter at all, rules included, and chat still works.
func TestSpamFilterNeedsBusiness(t *testing.T) {
	t.Cleanup(api.SetSpamEvery(time.Hour))
	h, model := aiHarness(t, `{"items":[]}`, nil)
	h.signup("No Filter Host", "spam-basic-host@test.dev", true)
	wb := h.liveWebinar("No filter on Basic", nil)
	g := h.registerAsGuest(wb.ID, "spam-basic-guest@test.dev")
	h.spamChat(wb.ID, g, whatsappSpam)
	if out := h.spamFlags(wb.ID); len(out.Flags) != 0 || model.callCount() != 0 {
		t.Fatalf("a host without ai got spam flags: %+v, calls %d", out, model.callCount())
	}
}
