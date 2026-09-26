package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Bots: the only thing here that talks back.
 *
 * Every other send in this CRM is started by the host — a reminder they scheduled, a
 * broadcast they wrote, a sequence they built. A bot sends because a stranger typed
 * something, and the claims worth proving all follow from nobody being in the room:
 *
 *   - the flow goes where the answer says, whether the person pressed a button or typed
 *     the words, and an answer it does not recognise reaches a human instead of a loop.
 *   - a webhook Meta redelivers does not advance the flow twice. This is the one that
 *     costs real money if it breaks, and it is the reason a session remembers the last
 *     message it acted on.
 *   - a handoff really stops the bot, for every later message, until the host says so.
 *   - STOP outranks all of it: no reply, and the flow the person was in is closed
 *     rather than left to wake up tomorrow.
 *   - the builder refuses a flow that could not run, while the host is still looking at
 *     it — a dead link or a loop is otherwise discovered by a customer.
 *
 * Time is not faked. The waits below are zero minutes, so one AdvanceBots is one step,
 * which is also how the sweeper behaves at 04:00 with nobody watching.
 */

// botNode is the short form of a step, since most of these only vary one field.
func botNode(key, kind, text, next string) types.CRMBotNode {
	return types.CRMBotNode{Key: key, Kind: kind, Text: text, Next: next}
}

func botAsk(key, text string, buttons ...types.CRMBotButton) types.CRMBotNode {
	return types.CRMBotNode{Key: key, Kind: types.BotNodeAsk, Text: text, Buttons: buttons}
}

func createBot(t *testing.T, h *harness, body types.CRMBotRequest) types.CRMBotResponse {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/bots", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create bot: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMBotResponse
	h.decode(raw, &out)
	return out
}

func readBot(t *testing.T, h *harness, id string) types.CRMBotResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/bots/"+id, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("read bot: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMBotResponse
	h.decode(raw, &out)
	return out
}

// onlySession is the single conversation a test expects the bot to be in.
func onlySession(t *testing.T, b types.CRMBotResponse) types.CRMBotSession {
	t.Helper()
	if len(b.Sessions) != 1 {
		t.Fatalf("%d sessions, want exactly one: %+v", len(b.Sessions), b.Sessions)
	}
	return b.Sessions[0]
}

func crmThread(t *testing.T, h *harness, contactID string) types.CRMThreadResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+contactID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("thread: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMThreadResponse
	h.decode(raw, &out)
	return out
}

/* buttonReplyPayload is somebody pressing one of the bot's own buttons.
 *
 * The id is what the bot put there — "node:index" — and Meta echoes it back beside the
 * label. Both halves are in the payload because the runtime prefers the id and falls
 * back to the words, and a test that only ever sent one of them would not notice which.
 */
func buttonReplyPayload(wamid, from, name, replyID, title string) string {
	return fmt.Sprintf(`{"object":"whatsapp_business_account","entry":[{"id":%q,
	  "changes":[{"field":"messages","value":{
	    "messaging_product":"whatsapp",
	    "metadata":{"display_phone_number":"27820000000","phone_number_id":%q},
	    "contacts":[{"profile":{"name":%q},"wa_id":%q}],
	    "messages":[{"from":%q,"id":%q,"timestamp":"1700000000","type":"interactive",
	                 "interactive":{"type":"button_reply",
	                   "button_reply":{"id":%q,"title":%q}}}]}}]}]}`,
		testMetaWABAID, testMetaPhoneID, name, from, from, wamid, replyID, title)
}

/* justNow rewrites a payload's timestamp to this second.
 *
 * Every bot reply is free-form text, which WhatsApp only allows for 24 hours after the
 * person's last message — so the 2023 fixture the ingest tests use would have every
 * flow here stop at its first send with `window_closed`, proving the opposite of what
 * these tests are about. The window is exercised on purpose in its own test below.
 */
func justNow(payload string) string {
	return strings.Replace(payload, `"timestamp":"1700000000"`,
		`"timestamp":"`+strconv.FormatInt(time.Now().Unix(), 10)+`"`, 1)
}

// botInbound is somebody writing to the host's number, now.
func botInbound(t *testing.T, h *harness, wamid, from, name, text string) {
	t.Helper()
	postWebhook(t, h, justNow(inboundPayload(wamid, from, name, text)))
}

// botPress is somebody pressing one of the bot's buttons, now.
func botPress(t *testing.T, h *harness, wamid, from, name, replyID, title string) {
	t.Helper()
	postWebhook(t, h, justNow(buttonReplyPayload(wamid, from, name, replyID, title)))
}

// lastSend is the body of the most recent /messages call Meta received.
func lastSend(t *testing.T, g *fakeGraph) map[string]any {
	t.Helper()
	sends := g.sent()
	if len(sends) == 0 {
		t.Fatal("nothing reached Meta")
	}
	return sends[len(sends)-1]
}

// sentButtons reads the labels off an interactive send, so a branch can be asserted
// on what the person was actually offered.
func sentButtons(t *testing.T, send map[string]any) (string, []string) {
	t.Helper()
	interactive, ok := send["interactive"].(map[string]any)
	if !ok {
		t.Fatalf("send is not interactive: %+v", send)
	}
	body, _ := interactive["body"].(map[string]any)
	text, _ := body["text"].(string)
	action, _ := interactive["action"].(map[string]any)
	raw, _ := action["buttons"].([]any)
	labels := make([]string, 0, len(raw))
	for _, b := range raw {
		button, _ := b.(map[string]any)
		reply, _ := button["reply"].(map[string]any)
		title, _ := reply["title"].(string)
		labels = append(labels, title)
	}
	return text, labels
}

/* The builder refuses a flow that could not run.
 *
 * The most valuable test here for the same reason as the drip one: a bot is wrong in
 * front of a customer, days after it was saved, with the host asleep. A dead link or a
 * loop has to be a red message on a form, and none of these may reach Meta.
 */
func TestCRMBotBuilderRefusesAFlowThatCannotRun(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")

	/* Before WhatsApp is connected there is nothing for a bot to answer on: a flow
	 * belongs to a number, and this host has none. */
	res, raw := h.do(http.MethodPost, "/api/host/crm/bots", types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "hi",
		Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello!", "")},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_not_connected" {
		t.Fatalf("unconnected host: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}

	connectWhatsApp(t, h)
	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "Course", Trigger: types.DripManual, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	})

	hello := botNode("hi", types.BotNodeMessage, "Hello!", "")
	for _, tc := range []struct {
		name, code string
		body       types.CRMBotRequest
	}{
		{"no name", "crm_no_name", types.CRMBotRequest{
			Trigger: types.BotAnyMessage, Entry: "hi", Nodes: []types.CRMBotNode{hello}}},
		{"a trigger nobody implemented", "crm_bad_trigger", types.CRMBotRequest{
			Name: "B", Trigger: "when_they_wave", Entry: "hi", Nodes: []types.CRMBotNode{hello}}},
		{"keyword trigger with no keywords", "crm_bot_no_keywords", types.CRMBotRequest{
			Name: "B", Trigger: types.BotKeyword, Keywords: []string{"  "},
			Entry: "hi", Nodes: []types.CRMBotNode{hello}}},
		{"no steps at all", "crm_bot_no_nodes", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi"}},
		{"a step kind that does not exist", "crm_bot_bad_kind", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{botNode("hi", "telepathy", "Hello!", "")}}},
		{"two steps with the same name", "crm_bot_bad_key", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{hello, botNode("hi", types.BotNodeMessage, "Again", "")}}},
		{"a message with nothing in it", "crm_bot_no_text", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "   ", "")}}},
		{"a message longer than WhatsApp allows", "crm_bot_text_too_long", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage,
				strings.Repeat("x", types.BotMaxText+1), "")}}},
		{"a question with no buttons", "crm_bot_bad_button", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "ask",
			Nodes: []types.CRMBotNode{botAsk("ask", "Which one?")}}},
		{"four buttons, when WhatsApp allows three", "crm_bot_bad_button", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "ask",
			Nodes: []types.CRMBotNode{botAsk("ask", "Which one?",
				types.CRMBotButton{Label: "A", Next: "hi"},
				types.CRMBotButton{Label: "B", Next: "hi"},
				types.CRMBotButton{Label: "C", Next: "hi"},
				types.CRMBotButton{Label: "D", Next: "hi"}), hello}}},
		{"a button label WhatsApp would cut off", "crm_bot_bad_button", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "ask",
			Nodes: []types.CRMBotNode{botAsk("ask", "Which one?",
				types.CRMBotButton{Label: strings.Repeat("y", types.BotMaxButtonLabel+1), Next: "hi"}), hello}}},
		{"two buttons saying the same thing", "crm_bot_bad_button", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "ask",
			Nodes: []types.CRMBotNode{botAsk("ask", "Which one?",
				types.CRMBotButton{Label: "Yes", Next: "hi"},
				types.CRMBotButton{Label: "yes", Next: "hi"}), hello}}},
		{"a wait longer than the service window", "crm_bot_bad_delay", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "wait",
			Nodes: []types.CRMBotNode{
				{Key: "wait", Kind: types.BotNodeWait, DelayMinutes: 24*60 + 1, Next: "hi"}, hello}}},
		{"an enrol step with no sequence", "crm_bot_no_sequence", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "enrol",
			Nodes: []types.CRMBotNode{{Key: "enrol", Kind: types.BotNodeEnroll}}}},
		{"a sequence that is not this host's", "crm_bot_no_sequence", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "enrol",
			Nodes: []types.CRMBotNode{
				{Key: "enrol", Kind: types.BotNodeEnroll, DripID: "11111111-1111-1111-1111-111111111111"}}}},
		{"a step pointing at one that was deleted", "crm_bot_bad_link", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello!", "gone")}}},
		{"no starting step", "crm_bot_no_entry", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Nodes: []types.CRMBotNode{hello}}},
		{"a start that is not one of the steps", "crm_bot_no_entry", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "elsewhere",
			Nodes: []types.CRMBotNode{hello}}},
		/* The loop is the expensive one. Nothing in a flow can escape one — there is no
		 * counter a host can branch on — so it is a bot that messages somebody until the
		 * step budget stops it, and every one of those messages is billed. */
		{"a flow that leads back to itself", "crm_bot_loop", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{
				botNode("hi", types.BotNodeMessage, "Hello!", "again"),
				botNode("again", types.BotNodeMessage, "Hello again!", "hi")}}},
		{"a loop through a wait, which is still a loop", "crm_bot_loop", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{
				botNode("hi", types.BotNodeMessage, "Hello!", "nap"),
				{Key: "nap", Kind: types.BotNodeWait, DelayMinutes: 60, Next: "hi"}}}},
		{"a question that branches back to itself", "crm_bot_loop", types.CRMBotRequest{
			Name: "B", Trigger: types.BotAnyMessage, Entry: "ask",
			Nodes: []types.CRMBotNode{botAsk("ask", "Which one?",
				types.CRMBotButton{Label: "Again", Next: "ask"})}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.do(http.MethodPost, "/api/host/crm/bots", tc.body)
			if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != tc.code {
				t.Fatalf("status %d code %q, want 422 %s\n  body: %s",
					res.StatusCode, errorCode(t, raw), tc.code, raw)
			}
		})
	}

	// An unreachable loop is a draft, not a bill: nothing can enter it, so the host is
	// left to finish drawing.
	createBot(t, h, types.CRMBotRequest{
		Name: "Half drawn", Trigger: types.BotAnyMessage, Entry: "hi",
		Nodes: []types.CRMBotNode{
			hello,
			botNode("orphan", types.BotNodeMessage, "Nobody gets here", "orphan2"),
			botNode("orphan2", types.BotNodeMessage, "Nor here", "orphan"),
		},
	})
	// And a flow that does everything, saved and read back with its edges intact.
	full := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotKeyword, Keywords: []string{" Price ", "price", "COST"},
		Entry: "ask",
		Nodes: []types.CRMBotNode{
			botAsk("ask", "What can I help with?",
				types.CRMBotButton{Label: "The course", Next: "enrol"},
				types.CRMBotButton{Label: "Something else", Next: "human"}),
			{Key: "enrol", Kind: types.BotNodeEnroll, DripID: drip.Drip.ID, Next: "nap"},
			{Key: "nap", Kind: types.BotNodeWait, DelayMinutes: 0, Next: "bye"},
			botNode("bye", types.BotNodeMessage, "Sent you the details.", ""),
			botNode("human", types.BotNodeHandoff, "One moment, fetching a colleague.", ""),
		},
	})
	if got := full.Bot.Keywords; len(got) != 2 || got[0] != "price" || got[1] != "cost" {
		t.Errorf("keywords = %v, want them lower-cased and de-duplicated", got)
	}
	if len(full.Bot.Nodes) != 5 {
		t.Fatalf("%d nodes saved, want 5: %+v", len(full.Bot.Nodes), full.Bot.Nodes)
	}
	// The sequence's name comes back with the node, so the builder can show what the
	// enrol step does without a second read.
	for _, n := range full.Bot.Nodes {
		if n.Kind == types.BotNodeEnroll && n.DripName != "Course" {
			t.Errorf("enrol node dripName = %q, want the sequence's name", n.DripName)
		}
	}
	if len(g.sent()) != 0 {
		t.Fatalf("saving a bot sent %d messages; a bot only sends when somebody writes", len(g.sent()))
	}
}

/* One conversation, all the way through: asked, answered, enrolled, slept, finished.
 *
 * The buttons are asserted on what Meta was actually given, because that is the only
 * version of the question the person ever sees — and the branch is taken on the id the
 * bot put on the button, not on the words, so a host rewording "The course" tomorrow
 * does not break somebody mid-answer.
 */
func TestCRMBotAsksAnswersAndFinishes(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Bots that answer")
	connectWhatsApp(t, h)
	contact := registerOptedIn(t, h, wb.ID)

	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "Course details", Trigger: types.DripManual, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	})
	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "ask", Active: true,
		Nodes: []types.CRMBotNode{
			botAsk("ask", "What can I help with?",
				types.CRMBotButton{Label: "The course", Next: "enrol"},
				types.CRMBotButton{Label: "Something else", Next: "human"}),
			{Key: "enrol", Kind: types.BotNodeEnroll, DripID: drip.Drip.ID, Next: "nap"},
			{Key: "nap", Kind: types.BotNodeWait, DelayMinutes: 0, Next: "bye"},
			botNode("bye", types.BotNodeMessage, "Sent you the details.", ""),
			botNode("human", types.BotNodeHandoff, "One moment.", ""),
		},
	})

	// Somebody writes in. Nothing about this person is an opt-in to marketing, and the
	// bot answers anyway: they asked a question.
	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")

	text, labels := sentButtons(t, lastSend(t, g))
	if text != "What can I help with?" {
		t.Errorf("question body = %q", text)
	}
	if len(labels) != 2 || labels[0] != "The course" || labels[1] != "Something else" {
		t.Fatalf("buttons = %v, want both in the order they were drawn", labels)
	}
	session := onlySession(t, readBot(t, h, bot.Bot.ID))
	if session.State != "waiting" || session.NodeKey != "ask" {
		t.Fatalf("session = %+v, want it waiting at the question it asked", session)
	}

	/* The answer, as a button press. The id is the flow's own: "ask:0" is the first
	 * branch of the node called ask. */
	botPress(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "ask:0", "The course")

	// Enrol, then a wait: the flow parks rather than running to the end, which is what
	// makes the sweeper's half of this testable at all.
	session = onlySession(t, readBot(t, h, bot.Bot.ID))
	if session.State != "sleeping" || session.NodeKey != "bye" {
		t.Fatalf("session = %+v, want it asleep holding the step it wakes up to run", session)
	}
	if got := readDrip(t, h, drip.Drip.ID); len(got.Enrollments) != 1 ||
		onlyEnrollment(t, got).ContactID != contact.ID {
		t.Fatalf("enrollments = %+v, want the person who pressed the button", got.Enrollments)
	}
	// Two messages so far: the question, and nothing else. An enrol step sends nothing
	// itself — the sequence does that on its own clock.
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends before the wait was over, want 1 (the question)", n)
	}

	h.engage.AdvanceBots(context.Background())

	if body := lastSend(t, g)["text"]; body == nil {
		t.Fatalf("the woken flow did not send plain text: %+v", lastSend(t, g))
	}
	session = onlySession(t, readBot(t, h, bot.Bot.ID))
	if session.State != "done" || session.EndedReason != "" {
		t.Fatalf("session = %+v, want done with no reason: it reached the end", session)
	}
	if stats := readBot(t, h, bot.Bot.ID).Bot.Stats; stats.Done != 1 || stats.Waiting != 0 {
		t.Errorf("stats = %+v, want one finished conversation", stats)
	}

	/* The thread is the record a host reads, and the bot's messages are in it, marked
	 * as the bot's: an outbound message nobody remembers sending is how a host ends up
	 * apologising for something a flow said. */
	thread := crmThread(t, h, contact.ID)
	bots := 0
	for _, m := range thread.Messages {
		if m.Direction == "out" {
			if m.FromBot != "Front desk" {
				t.Errorf("outbound message fromBot = %q, want the bot's name: %+v", m.FromBot, m)
			}
			bots++
		}
	}
	if bots != 2 {
		t.Errorf("%d of the bot's messages in the thread, want 2", bots)
	}
	// A second AdvanceBots must not resend anything: the session is done, not due.
	h.engage.AdvanceBots(context.Background())
	if n := len(g.sent()); n != 2 {
		t.Errorf("%d sends after a second sweep, want 2: a finished flow was woken again", n)
	}
}

/* A redelivered webhook must not be read as a second answer.
 *
 * Meta retries anything it did not see a 200 for, and it does see one here — but a
 * timeout on their side, or a second instance of this server, delivers the same message
 * again. Without the session remembering the id it acted on, the flow takes its branch
 * twice and the host pays for both.
 */
func TestCRMBotIgnoresARedeliveredMessage(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "ask", Active: true,
		Nodes: []types.CRMBotNode{
			botAsk("ask", "Yes or no?", types.CRMBotButton{Label: "Yes", Next: "done"}),
			botNode("done", types.BotNodeMessage, "Noted.", ""),
		},
	})

	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")
	// The same delivery again, byte for byte.
	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends after the same message arrived twice, want 1", n)
	}
	if s := onlySession(t, readBot(t, h, bot.Bot.ID)); s.State != "waiting" || s.NodeKey != "ask" {
		t.Fatalf("session = %+v, want it still waiting at the question", s)
	}

	botPress(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "ask:0", "Yes")
	botPress(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "ask:0", "Yes")
	if n := len(g.sent()); n != 2 {
		t.Fatalf("%d sends after the answer arrived twice, want 2", n)
	}
	// Only one conversation, too: a retry must not start a second one either.
	if s := onlySession(t, readBot(t, h, bot.Bot.ID)); s.State != "done" {
		t.Fatalf("session = %+v, want done", s)
	}
}

/* Typed answers, and an answer the bot does not understand.
 *
 * People type "yes" at a button that says Yes, constantly, and a flow that only reads
 * ids would ignore them. And an answer that matches nothing goes to a person rather
 * than round again: repeating the question is how somebody ends up arguing with a robot
 * at 23:00.
 */
func TestCRMBotReadsTypedAnswersAndHandsOverWhatItCannotPlace(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	// No fallback on the question, so an unrecognised answer is a handoff.
	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "ask", Active: true,
		Nodes: []types.CRMBotNode{
			botAsk("ask", "Are you joining us?", types.CRMBotButton{Label: "Yes", Next: "good"}),
			botNode("good", types.BotNodeMessage, "See you there.", ""),
		},
	})

	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hi")
	// Typed, not pressed, and in a different case than the label.
	botInbound(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "  YES  ")
	if n := len(g.sent()); n != 2 {
		t.Fatalf("%d sends, want 2: a typed answer did not match the button that says it", n)
	}
	if s := onlySession(t, readBot(t, h, bot.Bot.ID)); s.State != "done" {
		t.Fatalf("session = %+v, want done", s)
	}

	// A second person, who answers something else entirely.
	const otherDigits = "27835554444"
	botInbound(t, h, "wamid.IN3", otherDigits, "Sipho", "hi")
	botInbound(t, h, "wamid.IN4", otherDigits, "Sipho", "do you have parking")

	// Nothing was said in reply — there is no node to send — and the conversation is a
	// person's now.
	if n := len(g.sent()); n != 3 {
		t.Fatalf("%d sends, want 3: the bot answered an answer it did not understand", n)
	}
	other := contactWithPhone(t, crmContacts(t, h).Contacts, "+"+otherDigits)
	if other.BotPausedAt == "" {
		t.Fatal("botPausedAt empty: an answer the bot could not place did not reach a human")
	}
	sessions := readBot(t, h, bot.Bot.ID).Sessions
	if len(sessions) != 2 {
		t.Fatalf("%d sessions, want two people", len(sessions))
	}
	stats := readBot(t, h, bot.Bot.ID).Bot.Stats
	if stats.Done != 1 || stats.HandedOff != 1 {
		t.Errorf("stats = %+v, want one finished and one handed over", stats)
	}
}

/* A handoff really stops the bot, and only the host starts it again.
 *
 * The failure this prevents is the worst-looking one in the whole feature: a host
 * typing to somebody in the inbox while a flow answers over the top of them.
 */
func TestCRMBotHandoffPausesEveryBotUntilTheHostSaysOtherwise(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "hand", Active: true,
		Nodes: []types.CRMBotNode{
			botNode("hand", types.BotNodeHandoff, "Let me get somebody.", ""),
		},
	})

	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends, want the one line before the handoff", n)
	}
	contact := contactWithPhone(t, crmContacts(t, h).Contacts, "+"+crmPhoneDigits)
	if contact.BotPausedAt == "" {
		t.Fatal("botPausedAt empty after a handoff node")
	}
	if s := onlySession(t, readBot(t, h, bot.Bot.ID)); s.State != "handoff" || s.EndedReason != "handed_over" {
		t.Fatalf("session = %+v, want handoff", s)
	}

	// Everything they say now is for the host to answer.
	botInbound(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "are you there?")
	botInbound(t, h, "wamid.IN3", crmPhoneDigits, "Thandi", "hello?")
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends, want 1: a bot answered somebody a human had taken over", n)
	}
	if len(readBot(t, h, bot.Bot.ID).Sessions) != 1 {
		t.Error("a paused contact started a second conversation with the bot")
	}

	// The host finishes, and hands them back. The old flow is not resumed: the next
	// message starts one from the top, which is the only honest place to pick up.
	res, raw := h.do(http.MethodPut, "/api/host/crm/contacts/"+contact.ID+"/bot",
		types.CRMBotPauseRequest{Paused: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("resume: status %d body %s", res.StatusCode, raw)
	}
	var back types.CRMContact
	h.decode(raw, &back)
	if back.BotPausedAt != "" {
		t.Fatalf("botPausedAt = %q after resuming", back.BotPausedAt)
	}

	botInbound(t, h, "wamid.IN4", crmPhoneDigits, "Thandi", "one more thing")
	if n := len(g.sent()); n != 2 {
		t.Fatalf("%d sends after the host handed them back, want 2", n)
	}
	if n := len(readBot(t, h, bot.Bot.ID).Sessions); n != 2 {
		t.Errorf("%d sessions, want a second one started from the top", n)
	}

	/* And the host can take a conversation over without the bot offering: this is the
	 * button in the inbox, and it closes whatever flow was under way so the host's own
	 * reply is not read as an answer to a question. */
	const otherDigits = "27835557777"
	botInbound(t, h, "wamid.IN5", otherDigits, "Sipho", "hi")
	sipho := contactWithPhone(t, crmContacts(t, h).Contacts, "+"+otherDigits)
	res, raw = h.do(http.MethodPut, "/api/host/crm/contacts/"+sipho.ID+"/bot",
		types.CRMBotPauseRequest{Paused: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("pause: status %d body %s", res.StatusCode, raw)
	}
	sends := len(g.sent())
	botInbound(t, h, "wamid.IN6", otherDigits, "Sipho", "still there?")
	if len(g.sent()) != sends {
		t.Errorf("the bot answered a contact the host had taken over")
	}
}

/* STOP outranks the bot, both on the way in and days later.
 *
 * Two halves, and the second is the one that would embarrass a host: a flow asleep on a
 * wait node when somebody opts out must not wake up tomorrow and carry on talking to
 * them.
 */
func TestCRMBotNeverAnswersSomebodyWhoSaidStop(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "hi", Active: true,
		Nodes: []types.CRMBotNode{
			botNode("hi", types.BotNodeMessage, "Hello! One moment.", "nap"),
			{Key: "nap", Kind: types.BotNodeWait, DelayMinutes: 0, Next: "bye"},
			botNode("bye", types.BotNodeMessage, "Here are the details.", ""),
		},
	})

	// A flow under way, asleep on its wait node.
	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")
	if s := onlySession(t, readBot(t, h, bot.Bot.ID)); s.State != "sleeping" {
		t.Fatalf("session = %+v, want it asleep", s)
	}

	// And then they opt out, before the wait is over.
	botInbound(t, h, "wamid.IN2", crmPhoneDigits, "Thandi", "STOP")
	session := onlySession(t, readBot(t, h, bot.Bot.ID))
	if session.State != "stopped" || session.EndedReason != "opted_out" {
		t.Fatalf("session = %+v, want it stopped the moment they opted out", session)
	}

	h.engage.AdvanceBots(context.Background())
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends, want 1: the sweeper woke a flow for somebody who had opted out", n)
	}
	// Nor does a new message from them start one — opted out is opted out, and there is
	// no reply of any kind, not even a helpful one.
	botInbound(t, h, "wamid.IN3", crmPhoneDigits, "Thandi", "hello again")
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends, want 1: a bot answered somebody who had opted out", n)
	}
}

/* Which bot answers, and whose bots they are.
 *
 * A keyword bot beats the catch-all on its own words, only one catch-all may be
 * switched on at a time, and a bot that is off answers nothing. The last part is the
 * one that matters most: these flows send messages billed to a host's own WABA, so
 * another host must not be able to read, edit or delete one.
 */
func TestCRMBotMatchingAndHostScope(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	catchAll := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "hi", Active: true,
		Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello!", "")},
	})
	// A second active catch-all would make two bots answer one message.
	res, raw := h.do(http.MethodPost, "/api/host/crm/bots", types.CRMBotRequest{
		Name: "Second desk", Trigger: types.BotAnyMessage, Entry: "hi", Active: true,
		Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello again!", "")},
	})
	if res.StatusCode != http.StatusConflict || errorCode(t, raw) != "crm_bot_catch_all" {
		t.Fatalf("second catch-all: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}
	// Switched off, the same bot is fine: a host may keep as many drafts as they like.
	off := createBot(t, h, types.CRMBotRequest{
		Name: "Second desk", Trigger: types.BotAnyMessage, Entry: "hi",
		Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello again!", "")},
	})

	pricing := createBot(t, h, types.CRMBotRequest{
		Name: "Pricing", Trigger: types.BotKeyword, Keywords: []string{"price"},
		Entry: "quote", Active: true,
		Nodes: []types.CRMBotNode{botNode("quote", types.BotNodeMessage, "It is R499.", "")},
	})

	// The keyword wins on its own word, even though the catch-all would also match.
	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", " Price ")
	if got, ok := lastSend(t, g)["text"].(map[string]any); !ok || got["body"] != "It is R499." {
		t.Fatalf("send = %+v, want the keyword bot's answer", lastSend(t, g))
	}
	// And anything else falls to the catch-all.
	const otherDigits = "27835551111"
	botInbound(t, h, "wamid.IN2", otherDigits, "Sipho", "hi there")
	if got, ok := lastSend(t, g)["text"].(map[string]any); !ok || got["body"] != "Hello!" {
		t.Fatalf("send = %+v, want the catch-all's answer", lastSend(t, g))
	}
	if len(readBot(t, h, off.Bot.ID).Sessions) != 0 {
		t.Error("a bot that is switched off answered somebody")
	}
	if n := len(readBot(t, h, pricing.Bot.ID).Sessions); n != 1 {
		t.Errorf("%d sessions on the keyword bot, want 1", n)
	}

	// Another host, with their own WhatsApp connection and their own bots.
	h.logout()
	h.signup("Rivka Levy", "rivka@other.dev", true)
	res, raw = h.do(http.MethodGet, "/api/host/crm/bots", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("other host's bots: status %d body %s", res.StatusCode, raw)
	}
	var list types.CRMBotsResponse
	h.decode(raw, &list)
	if len(list.Bots) != 0 {
		t.Fatalf("another host can see %d of these bots", len(list.Bots))
	}
	if list.WhatsAppConnected {
		t.Error("whatsappConnected true for a host who has not connected")
	}
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/host/crm/bots/" + catchAll.Bot.ID, nil},
		{http.MethodPut, "/api/host/crm/bots/" + catchAll.Bot.ID, types.CRMBotRequest{
			Name: "Mine now", Trigger: types.BotAnyMessage, Entry: "hi",
			Nodes: []types.CRMBotNode{botNode("hi", types.BotNodeMessage, "Hello!", "")}}},
		{http.MethodDelete, "/api/host/crm/bots/" + catchAll.Bot.ID, nil},
	} {
		res, raw := h.do(tc.method, tc.path, tc.body)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s as another host: status %d, want 404\n  body: %s",
				tc.method, tc.path, res.StatusCode, raw)
		}
	}

	// The owner deletes it, and it stops answering.
	h.logout()
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodDelete, "/api/host/crm/bots/"+catchAll.Bot.ID, nil)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}
	sends := len(g.sent())
	botInbound(t, h, "wamid.IN3", "27835552222", "Ayanda", "hi there")
	if len(g.sent()) != sends {
		t.Error("a deleted bot answered a message")
	}
}

/* Nothing is sent that WhatsApp would not allow, and a refused send stops the flow.
 *
 * Both halves are about a flow carrying on as though it had spoken. A bot whose second
 * message was refused and whose third arrives anyway is a conversation with a hole in
 * it — the person is asked to choose between options they were never shown.
 */
func TestCRMBotStopsWhenItCannotSpeak(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Front desk", Trigger: types.BotAnyMessage, Entry: "hi", Active: true,
		Nodes: []types.CRMBotNode{
			botNode("hi", types.BotNodeMessage, "Hello!", "more"),
			botNode("more", types.BotNodeMessage, "And here are the details.", ""),
		},
	})

	/* A message Meta delivered late — the fixture timestamp is 2023, which is exactly
	 * what a flow waking up past the 24-hour window looks like from here. Free-form text
	 * is not allowed, and the alternative of queueing an approved template instead would
	 * answer somebody's question a day later with marketing copy. */
	postWebhook(t, h, inboundPayload("wamid.OLD1", crmPhoneDigits, "Thandi", "hello?"))
	if n := len(g.sent()); n != 0 {
		t.Fatalf("%d sends outside the service window, want none", n)
	}
	session := onlySession(t, readBot(t, h, bot.Bot.ID))
	if session.State != "stopped" || session.EndedReason != "window_closed" {
		t.Fatalf("session = %+v, want it stopped because the window was shut", session)
	}

	// Inside the window, and Meta refuses the send anyway — an unpaid WABA, a number
	// that is not registered. The flow stops at the step that failed, not after it.
	g.failSends(http.StatusBadRequest, map[string]any{
		"message": "This message was not delivered", "code": 131047,
	})
	const otherDigits = "27835558888"
	botInbound(t, h, "wamid.IN1", otherDigits, "Sipho", "hi")
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends after the first was refused, want 1: the flow carried on talking", n)
	}
	sessions := readBot(t, h, bot.Bot.ID).Sessions
	if len(sessions) != 2 {
		t.Fatalf("%d sessions, want two", len(sessions))
	}
	failed := sessions[0]
	if failed.State != "stopped" || failed.EndedReason != "send_failed" {
		t.Fatalf("session = %+v, want it stopped at the send Meta refused", failed)
	}
}

/* A flow cannot send a hundred messages out of one of theirs.
 *
 * The step budget is a spend limit, not a performance one: every node in a run of
 * messages is a WhatsApp message billed to the host's own WABA. Loops are refused when
 * a bot is saved, but a long straight line is not a loop and is still somebody's money.
 */
func TestCRMBotStopsAtItsStepBudget(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	// Twenty messages in a row, which is more than one turn is allowed to run.
	nodes := make([]types.CRMBotNode, 0, 20)
	for i := 0; i < 20; i++ {
		next := ""
		if i < 19 {
			next = fmt.Sprintf("n%d", i+1)
		}
		nodes = append(nodes, botNode(fmt.Sprintf("n%d", i),
			types.BotNodeMessage, fmt.Sprintf("Message %d", i), next))
	}
	bot := createBot(t, h, types.CRMBotRequest{
		Name: "Over-eager", Trigger: types.BotAnyMessage, Entry: "n0", Active: true,
		Nodes: nodes,
	})

	botInbound(t, h, "wamid.IN1", crmPhoneDigits, "Thandi", "hello?")

	if n := len(g.sent()); n != 12 {
		t.Fatalf("%d sends from one inbound message, want the 12 the budget allows", n)
	}
	session := onlySession(t, readBot(t, h, bot.Bot.ID))
	if session.State != "stopped" || session.EndedReason != "too_many_steps" {
		t.Fatalf("session = %+v, want it stopped on the budget", session)
	}
	if session.Steps != 12 {
		t.Errorf("steps = %d, want the 12 it ran recorded on the session", session.Steps)
	}
}
