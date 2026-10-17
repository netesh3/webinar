package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The home page's sales chat, against a fake model.
 *
 * The model is an httptest.Server speaking the OpenAI chat API, the same dialect
 * every configured provider speaks. It answers a sales question, asks for a person
 * when the question is about custom pricing, and records the system prompt so a
 * test can see the assistant was told the real prices.
 */

type fakeModel struct {
	mu     sync.Mutex
	calls  int
	system string
}

func newFakeModel(t *testing.T) (*fakeModel, *httptest.Server) {
	f := &fakeModel{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.calls++
		if len(req.Messages) > 0 {
			f.system = req.Messages[0].Content
		}
		f.mu.Unlock()
		last := strings.ToLower(req.Messages[len(req.Messages)-1].Content)
		answer := "For 250 live attendees, Business (up to 300) fits: ₹14,999/month."
		if strings.Contains(last, "custom") {
			answer = "[HANDOFF] wants custom pricing for 1,200 students"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": answer}}},
		})
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeModel) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func salesHarness(t *testing.T, withModel bool) (*harness, *fakeModel) {
	t.Helper()
	var model *fakeModel
	var url string
	if withModel {
		var srv *httptest.Server
		model, srv = newFakeModel(t)
		url = srv.URL
	}
	h := newHarness(t, func(c *config.Config) {
		c.BillingGSTPercent = 18
		if url != "" {
			c.AIProviders = []config.AIProvider{{ID: "fake", BaseURL: url, APIKey: "k", Model: "fake-1"}}
		}
	})
	return h, model
}

// visitor is one browser holding a chat token.
type visitor struct {
	h     *harness
	token string
	last  int64
}

func (h *harness) startSalesChat() *visitor {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/sales/chat", types.StartSalesChatRequest{Page: "/"})
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("start chat: %d %s", res.StatusCode, raw)
	}
	var chat types.SalesChat
	h.decode(raw, &chat)
	if chat.Token == "" || len(chat.Messages) != 1 || chat.Messages[0].Role != types.SalesFromAI || chat.Status != types.SalesAI {
		h.t.Fatalf("new chat: %+v", chat)
	}
	return &visitor{h: h, token: chat.Token, last: chat.Messages[0].ID}
}

func (v *visitor) call(method, path string, body any) (int, types.SalesChat) {
	v.h.t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	res, out := v.h.doRaw(method, path+sep+"after="+itoa64(v.last), "application/json", raw,
		map[string]string{"X-Chat-Token": v.token})
	var chat types.SalesChat
	if res.StatusCode == http.StatusOK {
		v.h.decode(out, &chat)
		if n := len(chat.Messages); n > 0 {
			v.last = chat.Messages[n-1].ID
		}
	}
	return res.StatusCode, chat
}

func (v *visitor) say(text string) types.SalesChat {
	v.h.t.Helper()
	code, chat := v.call(http.MethodPost, "/api/sales/chat/messages", types.SalesMessageRequest{Body: text})
	if code != http.StatusOK {
		v.h.t.Fatalf("say %q: %d", text, code)
	}
	return chat
}

func (v *visitor) poll() types.SalesChat {
	v.h.t.Helper()
	code, chat := v.call(http.MethodGet, "/api/sales/chat", nil)
	if code != http.StatusOK {
		v.h.t.Fatalf("poll: %d", code)
	}
	return chat
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

func (h *harness) salesOutbox(kind string) []struct{ To, Subject, Body, ReplyTo string } {
	h.t.Helper()
	rows, err := h.store.Pool().Query(context.Background(),
		`SELECT email, subject, body, reply_to FROM notifications WHERE kind = $1 ORDER BY created_at, email`, kind)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	var out []struct{ To, Subject, Body, ReplyTo string }
	for rows.Next() {
		var r struct{ To, Subject, Body, ReplyTo string }
		if err := rows.Scan(&r.To, &r.Subject, &r.Body, &r.ReplyTo); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func lastOf(c types.SalesChat) types.SalesMessage {
	if len(c.Messages) == 0 {
		return types.SalesMessage{}
	}
	return c.Messages[len(c.Messages)-1]
}

func TestSalesChatAnswersFromTheRealPriceList(t *testing.T) {
	h, model := salesHarness(t, true)
	v := h.startSalesChat()

	chat := v.say("I have about 250 students per webinar. Which plan?")
	if len(chat.Messages) != 2 || chat.Messages[0].Role != types.SalesFromVisitor || chat.Messages[1].Role != types.SalesFromAI {
		t.Fatalf("want the question and an answer, got %+v", chat.Messages)
	}
	if !strings.Contains(lastOf(chat).Body, "Business") || chat.Status != types.SalesAI {
		t.Fatalf("answer: %+v status %s", lastOf(chat), chat.Status)
	}
	// The model was told the prices checkout charges and the caps the API enforces.
	for _, want := range []string{"₹14,999/month", "up to 300 live attendees", "18% GST", "[HANDOFF]"} {
		if !strings.Contains(model.system, want) {
			t.Errorf("system prompt lacks %q", want)
		}
	}
	// An auto-opened chat nobody typed into stays out of the inbox; this one is in it.
	h.signup("Ops", "ops@example.com", false)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"ops@example.com"}); err != nil {
		t.Fatal(err)
	}
	h.startSalesChat() // silent
	res, raw := h.do(http.MethodGet, "/api/admin/sales?filter=ai", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox: %d %s", res.StatusCode, raw)
	}
	var inbox types.SalesInbox
	h.decode(raw, &inbox)
	if len(inbox.Conversations) != 1 || inbox.NeedsYou != 0 {
		t.Fatalf("inbox: %+v", inbox)
	}
}

func TestSalesHandoffEmailsAdminsOnceAndAdminJoinsLive(t *testing.T) {
	h, model := salesHarness(t, true)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev", "priya@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	v := h.startSalesChat()

	// The model decides this one needs a person.
	chat := v.say("We're an academy with 1,200 students. Can you do a custom price?")
	if chat.Status != types.SalesWaiting || !strings.Contains(lastOf(chat).Body, "asked a person") {
		t.Fatalf("handoff: status %s last %+v", chat.Status, lastOf(chat))
	}
	for _, m := range chat.Messages {
		if strings.Contains(m.Body, "[HANDOFF]") {
			t.Fatalf("the handoff tag reached the visitor: %q", m.Body)
		}
	}
	mails := h.salesOutbox("sales_handoff")
	if len(mails) != 2 || mails[0].To != "neeraj@acme.dev" || mails[1].To != "priya@acme.dev" {
		t.Fatalf("handoff mail: %+v", mails)
	}
	if !strings.Contains(mails[0].Body, "custom pricing for 1,200 students") || !strings.Contains(mails[0].Body, "/admin/sales?c=") {
		t.Fatalf("mail body: %s", mails[0].Body)
	}

	// Asking again is not a second handoff, and the model stays out of it now.
	calls := model.callCount()
	if code, _ := v.call(http.MethodPost, "/api/sales/chat/handoff", nil); code != http.StatusOK {
		t.Fatalf("handoff again: %d", code)
	}
	v.say("Hello? Anyone there?")
	if len(h.salesOutbox("sales_handoff")) != 2 || model.callCount() != calls {
		t.Fatal("a waiting chat emailed admins again or asked the model")
	}

	// An admin opens the inbox: the visitor now sees the team online.
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/sales?filter=needs", nil)
	var inbox types.SalesInbox
	h.decode(raw, &inbox)
	if res.StatusCode != http.StatusOK || inbox.NeedsYou != 1 || len(inbox.Conversations) != 1 || !inbox.Conversations[0].VisitorOnline {
		t.Fatalf("needs-you inbox: %d %+v", res.StatusCode, inbox)
	}
	conv := inbox.Conversations[0]
	if conv.HandoffReason != "wants custom pricing for 1,200 students" {
		t.Fatalf("reason: %q", conv.HandoffReason)
	}
	if !v.poll().TeamOnline {
		t.Fatal("team should be online while an admin has the inbox open")
	}

	// Join: the visitor sees who joined, and the agent's first name.
	if res, raw := h.do(http.MethodPost, "/api/admin/sales/"+conv.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	chat = v.poll()
	if chat.Status != types.SalesHuman || chat.AgentName != "Neeraj" || !strings.Contains(lastOf(chat).Body, "Neeraj joined the chat") {
		t.Fatalf("after join: %+v", chat)
	}

	// A live reply lands in the chat, not in an inbox.
	res, raw = h.do(http.MethodPost, "/api/admin/sales/"+conv.ID+"/messages", types.SalesMessageRequest{Body: "Hi! Let's set up a call."})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reply: %d %s", res.StatusCode, raw)
	}
	chat = v.poll()
	if m := lastOf(chat); m.Role != types.SalesFromAdmin || m.AuthorName != "Neeraj" || m.Emailed || m.Body != "Hi! Let's set up a call." {
		t.Fatalf("visitor sees: %+v", m)
	}
	if len(h.salesOutbox("sales_reply")) != 0 {
		t.Fatal("a reply to a visitor who is here was emailed")
	}
	v.say("Tomorrow 11am works")
	if model.callCount() != calls {
		t.Fatal("the model answered a conversation a person had taken")
	}
}

func TestAdminReplyGoesByEmailWhenTheVisitorHasLeft(t *testing.T) {
	h, _ := salesHarness(t, true)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	v := h.startSalesChat()
	v.say("Can I talk to a human?") // no model call: asked plainly
	if code, chat := v.call(http.MethodPost, "/api/sales/chat/contact", types.SalesContactRequest{Name: "Ritu Sharma", Email: "Ritu@Bright.in"}); code != http.StatusOK || chat.Email != "ritu@bright.in" {
		t.Fatalf("contact: %d %+v", code, chat)
	}
	if code, _ := v.call(http.MethodPost, "/api/sales/chat/contact", types.SalesContactRequest{Email: "not-an-email"}); code != http.StatusUnprocessableEntity {
		t.Fatalf("bad email: %d, want 422", code)
	}

	// The visitor closes the tab.
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE sales_conversations SET visitor_seen_at = now() - interval '10 minutes'`); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	var inbox types.SalesInbox
	_, raw := h.do(http.MethodGet, "/api/admin/sales?filter=needs", nil)
	h.decode(raw, &inbox)
	if len(inbox.Conversations) != 1 || inbox.Conversations[0].VisitorOnline {
		t.Fatalf("inbox: %+v", inbox)
	}
	id := inbox.Conversations[0].ID

	res, raw := h.do(http.MethodPost, "/api/admin/sales/"+id+"/messages", types.SalesMessageRequest{Body: "Pricing for 1,200 starts at ₹1,20,000/year."})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reply: %d %s", res.StatusCode, raw)
	}
	var detail types.SalesConversationDetail
	h.decode(raw, &detail)
	if m := detail.Messages[len(detail.Messages)-1]; !m.Emailed {
		t.Fatalf("reply to an absent visitor should be emailed: %+v", m)
	}
	mails := h.salesOutbox("sales_reply")
	if len(mails) != 1 || mails[0].To != "ritu@bright.in" || mails[0].ReplyTo != "neeraj@acme.dev" ||
		!strings.Contains(mails[0].Body, "Hi Ritu") || !strings.Contains(mails[0].Body, "₹1,20,000") ||
		!strings.Contains(mails[0].Body, "Can I talk to a human?") {
		t.Fatalf("reply mail: %+v", mails)
	}

	// Email needs an address: a chat without one says so instead of dropping the reply.
	v2 := h.startSalesChat()
	v2.say("hello")
	if _, err := h.store.Pool().Exec(context.Background(), `UPDATE sales_conversations SET user_id = NULL, email = ''`); err != nil {
		t.Fatal(err)
	}
	_, raw = h.do(http.MethodGet, "/api/admin/sales?filter=ai", nil)
	h.decode(raw, &inbox)
	if res, _ := h.do(http.MethodPost, "/api/admin/sales/"+inbox.Conversations[0].ID+"/messages",
		types.SalesMessageRequest{Body: "hi", Via: "email"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("email reply with no address: %d, want 422", res.StatusCode)
	}
}

func TestSalesChatWithoutAModelGoesStraightToAPerson(t *testing.T) {
	h, _ := salesHarness(t, false)
	v := h.startSalesChat()
	chat := v.say("Which plan is right for me?")
	if chat.Status != types.SalesWaiting || chat.AIEnabled || !strings.Contains(lastOf(chat).Body, "person from the team") {
		t.Fatalf("no model: %+v", chat)
	}
	if len(h.salesOutbox("sales_handoff")) != 1 {
		t.Fatal("with no admins configured the note still goes to the review inbox")
	}
}

func TestSalesChatIsKeyedByItsTokenAndAdminsOnly(t *testing.T) {
	h, _ := salesHarness(t, true)
	v := h.startSalesChat()

	if res, _ := h.do(http.MethodGet, "/api/sales/chat", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d, want 401", res.StatusCode)
	}
	stranger := &visitor{h: h, token: "not-the-token"}
	if code, _ := stranger.call(http.MethodGet, "/api/sales/chat", nil); code != http.StatusNotFound {
		t.Fatalf("wrong token: %d, want 404", code)
	}
	if code, _ := v.call(http.MethodPost, "/api/sales/chat/messages", types.SalesMessageRequest{Body: strings.Repeat("a", 1001)}); code != http.StatusUnprocessableEntity {
		t.Fatalf("long message: %d, want 422", code)
	}

	h.signup("Not Admin", "plain@example.com", true)
	for _, path := range []string{"/api/admin/sales", "/api/admin/sales/00000000-0000-0000-0000-000000000000"} {
		if res, _ := h.do(http.MethodGet, path, nil); res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s as a host: %d, want 403", path, res.StatusCode)
		}
	}
}

// "Talk to a person" before typing anything is still a lead, and lands in the inbox.
func TestTalkToAPersonWithoutTypingReachesTheInbox(t *testing.T) {
	h, _ := salesHarness(t, true)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	v := h.startSalesChat()
	if code, chat := v.call(http.MethodPost, "/api/sales/chat/handoff", nil); code != http.StatusOK || chat.Status != types.SalesWaiting {
		t.Fatalf("handoff: %d %+v", code, chat)
	}
	h.login("neeraj@acme.dev")
	var inbox types.SalesInbox
	_, raw := h.do(http.MethodGet, "/api/admin/sales?filter=needs", nil)
	h.decode(raw, &inbox)
	if inbox.NeedsYou != 1 || len(inbox.Conversations) != 1 {
		t.Fatalf("a visitor who asked for a person without typing is missing: %+v", inbox)
	}
}
