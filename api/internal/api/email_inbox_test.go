package api_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const inboxTestSecret = "inbox-test-secret"

type inboxBody struct {
	Address    string  `json:"address"`
	Local      string  `json:"local"`
	CanRename  bool    `json:"canRename"`
	Alias      string  `json:"alias"`
	Total      int     `json:"total"`
	NextCursor *string `json:"nextCursor"`
	Messages   []struct {
		ID        string `json:"id"`
		Direction string `json:"direction"`
		From      string `json:"from"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
		ThreadID  string `json:"threadId"`
	} `json:"items"`
}

type captureMail struct{ msgs []notify.Message }

func (c *captureMail) Configured() bool { return true }
func (c *captureMail) Send(_ context.Context, m notify.Message) error {
	c.msgs = append(c.msgs, m)
	return nil
}

func TestEmailInboxRoutingRenameAndIsolation(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.InboxWebhookSecret = inboxTestSecret
	})
	mail := &captureMail{}
	h.engage.UseMail(mail)

	a := h.signup("Alex Kim", "alex-a@example.com", true)
	res, raw := h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox A: %d %s", res.StatusCode, raw)
	}
	var inboxA inboxBody
	h.decode(raw, &inboxA)
	if !inboxA.CanRename || inboxA.Local == "" || !strings.HasPrefix(inboxA.Address, inboxA.Local+"@") {
		t.Fatalf("default inbox = %+v", inboxA)
	}
	if inboxA.Local != "alex-kim" && !strings.HasPrefix(inboxA.Local, "alex-kim-") {
		t.Fatalf("slug = %s", inboxA.Local)
	}

	h.logout()
	b := h.signup("Alex Kim", "alex-b@example.com", true)
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox B: %d %s", res.StatusCode, raw)
	}
	var inboxB inboxBody
	h.decode(raw, &inboxB)
	if inboxB.Local == inboxA.Local {
		t.Fatalf("identical names shared %s", inboxB.Local)
	}
	if !inboxB.CanRename {
		t.Fatal("default address cannot be changed")
	}

	res, raw = h.do(http.MethodPut, "/api/host/email-inbox/address", map[string]string{"local": inboxA.Local})
	if res.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "taken") {
		t.Fatalf("taken rename: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxB)
	if inboxB.Local == inboxA.Local {
		t.Fatal("taken rename was saved")
	}

	next := "alex-host"
	res, raw = h.do(http.MethodPut, "/api/host/email-inbox/address", map[string]string{"local": next})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("rename: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &inboxB)
	if inboxB.Local != next || !inboxB.CanRename || inboxB.Alias == "" {
		t.Fatalf("after rename = %+v", inboxB)
	}
	original := inboxB.Alias

	res, raw = h.do(http.MethodPut, "/api/host/email-inbox/address", map[string]string{"local": "alex-other"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second rename: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &inboxB)
	if inboxB.Local != "alex-other" || !inboxB.CanRename || inboxB.Alias != next {
		t.Fatalf("after second rename = %+v", inboxB)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxB)
	if inboxB.Local != "alex-other" || inboxB.Alias != next {
		t.Fatalf("second rename did not stick: %+v", inboxB)
	}
	res, raw = h.do(http.MethodPut, "/api/host/email-inbox/address", map[string]string{"local": "ab"})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("short rename: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxB)
	if inboxB.Local != "alex-other" {
		t.Fatalf("rejected rename changed address to %s", inboxB.Local)
	}

	post := func(local, from string) (int, string) {
		body, _ := json.Marshal(map[string]string{
			"to": local + "@webinarliv.com", "from": from,
			"subject": "Hello", "text": "body " + local, "messageId": "<m-" + local + "@x>",
		})
		res, raw := h.doRaw(http.MethodPost, "/api/webhooks/email", "application/json", body,
			map[string]string{"X-Inbox-Webhook-Secret": inboxTestSecret})
		var stored struct {
			Stored bool `json:"stored"`
		}
		_ = json.Unmarshal(raw, &stored)
		if stored.Stored {
			return res.StatusCode, "stored"
		}
		return res.StatusCode, "dropped"
	}
	if code, got := post("nobody-here", "x@example.com"); code != http.StatusOK || got != "dropped" {
		t.Fatalf("unknown local: %d %s", code, got)
	}
	if code, got := post("alex-other", "fan@example.com"); code != http.StatusOK || got != "stored" {
		t.Fatalf("current address: %d %s", code, got)
	}
	if code, got := post(next, "fan@example.com"); code != http.StatusOK || got != "stored" {
		t.Fatalf("previous address: %d %s", code, got)
	}
	if code, got := post(original, "fan@example.com"); code != http.StatusOK || got != "stored" {
		t.Fatalf("original address: %d %s", code, got)
	}
	body, _ := json.Marshal(map[string]string{"to": next + "@webinarliv.com", "from": "x@example.com", "text": "nope"})
	res, _ = h.doRaw(http.MethodPost, "/api/webhooks/email", "application/json", body, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing secret: %d", res.StatusCode)
	}

	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxB)
	if len(inboxB.Messages) != 3 {
		t.Fatalf("host B messages = %d, want 3 (current + previous + original)", len(inboxB.Messages))
	}
	for _, m := range inboxB.Messages {
		if m.From != "fan@example.com" {
			t.Fatalf("unexpected message %+v", m)
		}
	}

	h.logout()
	h.login(a.Email)
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxA)
	if len(inboxA.Messages) != 0 {
		t.Fatalf("host A saw %d of host B's messages", len(inboxA.Messages))
	}

	h.logout()
	h.login(b.Email)
	id := inboxB.Messages[0].ID
	res, raw = h.do(http.MethodPost, "/api/host/email-inbox/"+id+"/reply", map[string]string{"body": "Thanks"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reply: %d %s", res.StatusCode, raw)
	}
	if len(mail.msgs) != 1 {
		t.Fatalf("sent %d", len(mail.msgs))
	}
	sent := mail.msgs[0]
	if sent.ReplyTo != "alex-other@webinarliv.com" {
		t.Fatalf("Reply-To = %s", sent.ReplyTo)
	}
	if sent.InReplyTo != "<m-alex-other@x>" && sent.InReplyTo != "<m-"+next+"@x>" && sent.InReplyTo != "<m-"+original+"@x>" {
		t.Fatalf("In-Reply-To = %s", sent.InReplyTo)
	}
	if sent.To != "fan@example.com" {
		t.Fatalf("To = %s", sent.To)
	}
	_ = a
}

// A reminder the app sends for host A shows in A's inbox as sent, including a
// row that was already marked sent, and never in host B's. An inbound reply
// still shows as received, and only for the host it was addressed to.
func TestSentMailShowsForThatHostOnly(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.InboxWebhookSecret = inboxTestSecret
		c.TickSecret = testTickSecret
	})
	mail := &captureMail{}
	h.server.UseMail(mail)

	h.signup("Host A", "sent-a@example.com", true)
	res, raw := h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox A: %d %s", res.StatusCode, raw)
	}
	var inboxA inboxBody
	h.decode(raw, &inboxA)
	wb := h.newWebinar("Sent on behalf", nil)

	ctx := context.Background()
	if _, err := h.store.Pool().Exec(ctx, `
		INSERT INTO notifications (email, kind, webinar_id, subject, body, delivery, delivered_at)
		VALUES ('past@example.com', 'registration_confirmed', $1::uuid,
		        'Earlier reminder', 'already sent', 'sent', now())`, wb.WebinarID); err != nil {
		t.Fatal(err)
	}
	if err := h.store.Notify(ctx, h.store.DB(), store.Notification{
		Email:       "guest@example.com",
		Kind:        types.NotifyRegistrationConfirmed,
		WebinarSlug: wb.ID,
		Subject:     "See you soon",
		Body:        "Your seat is confirmed.",
	}); err != nil {
		t.Fatal(err)
	}
	if code, body := tick(t, h, testTickSecret); code != http.StatusOK || !strings.Contains(body, `"ran"`) {
		t.Fatalf("tick: %d %s", code, body)
	}
	if len(mail.msgs) != 1 {
		t.Fatalf("smtp sends = %d", len(mail.msgs))
	}
	// Message has no From field. The transport keeps SMTP_FROM and only adds Reply-To.
	if mail.msgs[0].ReplyTo != inboxA.Address || mail.msgs[0].To != "guest@example.com" {
		t.Fatalf("sent message = %+v, want Reply-To %s", mail.msgs[0], inboxA.Address)
	}

	payload, _ := json.Marshal(map[string]string{
		"to": inboxA.Address, "from": "guest@example.com",
		"subject": "Re: See you soon", "text": "Thanks", "messageId": "<reply-a@x>",
	})
	res, raw = h.doRaw(http.MethodPost, "/api/webhooks/email", "application/json", payload,
		map[string]string{"X-Inbox-Webhook-Secret": inboxTestSecret})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbound: %d %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox A after send: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &inboxA)
	got := map[string]string{}
	for _, m := range inboxA.Messages {
		got[m.Subject] = m.Direction
	}
	if got["See you soon"] != "out" || got["Earlier reminder"] != "out" || got["Re: See you soon"] != "in" {
		t.Fatalf("A messages = %+v", inboxA.Messages)
	}

	h.logout()
	h.signup("Host B", "sent-b@example.com", true)
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox B: %d %s", res.StatusCode, raw)
	}
	var inboxB inboxBody
	h.decode(raw, &inboxB)
	for _, m := range inboxB.Messages {
		if m.Subject == "See you soon" || m.Subject == "Earlier reminder" || m.Subject == "Re: See you soon" {
			t.Fatalf("host B saw %s (%s)", m.Subject, m.Direction)
		}
	}
}

// Mail to the same person about different webinars stays as separate rows.
// A reply stays on the letter it answered, including when that letter has no
// Message-ID. Another host's pages do not include those rows.
func TestEmailInboxThreadsStaySeparate(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.InboxWebhookSecret = inboxTestSecret
	})
	mail := &captureMail{}
	h.engage.UseMail(mail)

	a := h.signup("Host A", "threads-a@example.com", true)
	ctx := context.Background()
	base := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	insert := func(subject, messageID string, at time.Time) store.HostEmail {
		t.Helper()
		row, err := h.store.InsertHostEmail(ctx, store.HostEmail{
			UserID:    a.ID,
			Direction: "out",
			To:        "guest@example.com",
			Subject:   subject,
			Body:      subject,
			MessageID: messageID,
			CreatedAt: at,
		})
		if err != nil {
			t.Fatal(err)
		}
		return row
	}
	alpha := insert("You're registered: Alpha", "outbox:alpha", base)
	beta := insert("Reminder: Beta", "outbox:beta", base.Add(time.Minute))
	plain := insert("Panelist invite", "", base.Add(2*time.Minute))

	var inbox inboxBody
	res, raw := h.do(http.MethodGet, "/api/host/email-inbox?page=1", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &inbox)
	if inbox.Total != 3 || len(inbox.Messages) != 3 {
		t.Fatalf("inbox = total %d messages %d, want 3 separate rows", inbox.Total, len(inbox.Messages))
	}
	threads := map[string]string{}
	for _, m := range inbox.Messages {
		threads[m.Subject] = m.ThreadID
	}
	if threads[alpha.Subject] == "" || threads[alpha.Subject] == threads[beta.Subject] || threads[beta.Subject] == threads[plain.Subject] || threads[alpha.Subject] == threads[plain.Subject] {
		t.Fatalf("same recipient was combined: %+v", threads)
	}

	res, raw = h.do(http.MethodPost, "/api/host/email-inbox/"+alpha.ID+"/reply", map[string]string{"body": "See you there"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reply alpha: %d %s", res.StatusCode, raw)
	}
	if len(mail.msgs) != 1 || mail.msgs[0].InReplyTo != "<outbox:alpha>" || mail.msgs[0].References != "<outbox:alpha>" {
		t.Fatalf("alpha smtp headers = %+v", mail.msgs)
	}
	res, raw = h.do(http.MethodPost, "/api/host/email-inbox/"+plain.ID+"/reply", map[string]string{"body": "You're on the panel"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reply plain: %d %s", res.StatusCode, raw)
	}
	if mail.msgs[1].InReplyTo != "" || mail.msgs[1].References != "" {
		t.Fatalf("invented a Message-ID: %+v", mail.msgs[1])
	}

	res, raw = h.do(http.MethodGet, "/api/host/email-inbox?page=1", nil)
	h.decode(raw, &inbox)
	got := map[string]string{}
	for _, m := range inbox.Messages {
		got[m.Subject] = m.ThreadID
	}
	if got["Re: You're registered: Alpha"] != threads[alpha.Subject] {
		t.Fatalf("reply left its letter: %+v", got)
	}
	if got["Re: Panelist invite"] != threads[plain.Subject] {
		t.Fatalf("reply without a Message-ID left its letter: %+v", got)
	}
	if got[beta.Subject] != threads[beta.Subject] || got[beta.Subject] == got["Re: You're registered: Alpha"] {
		t.Fatalf("beta was pulled into another thread: %+v", got)
	}
	if inbox.Total != 3 {
		t.Fatalf("total threads = %d, want 3", inbox.Total)
	}

	h.logout()
	h.signup("Host B", "threads-b@example.com", true)
	for _, page := range []string{"1", "2"} {
		res, raw = h.do(http.MethodGet, "/api/host/email-inbox?page="+page, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("host B page %s: %d %s", page, res.StatusCode, raw)
		}
		var other inboxBody
		h.decode(raw, &other)
		for _, m := range other.Messages {
			if strings.Contains(m.Subject, "Alpha") || strings.Contains(m.Subject, "Beta") || strings.Contains(m.Subject, "Panelist") {
				t.Fatalf("host B page %s saw %s", page, m.Subject)
			}
		}
	}
}

func TestEmailInboxPagesAreHostScoped(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {})
	a := h.signup("Host A", "pages-a@example.com", true)
	ctx := context.Background()
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for i := 0; i < 26; i++ {
		if _, err := h.store.InsertHostEmail(ctx, store.HostEmail{
			UserID:    a.ID,
			Direction: "out",
			To:        "guest@example.com",
			Subject:   fmt.Sprintf("Letter %02d", i),
			Body:      "body",
			MessageID: fmt.Sprintf("outbox:letter-%02d", i),
			CreatedAt: base.Add(time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}

	load := func(cursor string) inboxBody {
		t.Helper()
		path := "/api/host/email-inbox"
		if cursor != "" {
			path += "?cursor=" + url.QueryEscape(cursor)
		}
		res, raw := h.do(http.MethodGet, path, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("cursor %q: %d %s", cursor, res.StatusCode, raw)
		}
		var inbox inboxBody
		h.decode(raw, &inbox)
		return inbox
	}
	nextOf := func(inbox inboxBody) string {
		t.Helper()
		if inbox.NextCursor == nil {
			return ""
		}
		return *inbox.NextCursor
	}

	page1 := load("")
	if page1.Total != 26 || len(page1.Messages) != 5 || nextOf(page1) == "" {
		t.Fatalf("first page total=%d rows=%d next=%q", page1.Total, len(page1.Messages), nextOf(page1))
	}
	if page1.Messages[0].Subject != "Letter 25" || page1.Messages[4].Subject != "Letter 21" {
		t.Fatalf("first page subjects start %s end %s", page1.Messages[0].Subject, page1.Messages[4].Subject)
	}
	seen := map[string]bool{}
	for _, m := range page1.Messages {
		seen[m.ID] = true
		if m.ThreadID == "" {
			t.Fatalf("row missing thread id: %+v", m)
		}
	}
	cursor := nextOf(page1)
	var last inboxBody
	for page := 2; page <= 8; page++ {
		last = load(cursor)
		if last.Total != 26 {
			t.Fatalf("page %d total = %d", page, last.Total)
		}
		for _, m := range last.Messages {
			if seen[m.ID] {
				t.Fatalf("page %d repeats %s (%s)", page, m.ID, m.Subject)
			}
			seen[m.ID] = true
		}
		cursor = nextOf(last)
		if cursor == "" {
			break
		}
	}
	if cursor != "" || len(seen) != 26 || len(last.Messages) != 1 || last.Messages[0].Subject != "Letter 00" {
		t.Fatalf("walked %d rows, last=%d %q next=%q", len(seen), len(last.Messages), subjectOf(last), cursor)
	}
	hostACursor := nextOf(page1)

	h.logout()
	b := h.signup("Host B", "pages-b@example.com", true)
	if _, err := h.store.InsertHostEmail(ctx, store.HostEmail{
		UserID:    b.ID,
		Direction: "out",
		To:        "other@example.com",
		Subject:   "Host B only",
		Body:      "mine",
		MessageID: "outbox:host-b",
		CreatedAt: base,
	}); err != nil {
		t.Fatal(err)
	}
	for _, cursor := range []string{"", hostACursor} {
		inbox := load(cursor)
		for _, m := range inbox.Messages {
			if strings.HasPrefix(m.Subject, "Letter ") {
				t.Fatalf("host B cursor %q saw %s", cursor, m.Subject)
			}
		}
		if cursor == "" {
			if inbox.Total != 1 || len(inbox.Messages) != 1 || inbox.Messages[0].Subject != "Host B only" || nextOf(inbox) != "" {
				t.Fatalf("host B first page = total %d next %q %+v", inbox.Total, nextOf(inbox), inbox.Messages)
			}
		}
	}
}

func subjectOf(inbox inboxBody) string {
	if len(inbox.Messages) == 0 {
		return ""
	}
	return inbox.Messages[0].Subject
}

func TestEmailInboxMalformedCursor(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {})
	h.signup("Host A", "cursor-a@example.com", true)
	for _, cursor := range []string{"nope", "%%%", base64.RawURLEncoding.EncodeToString([]byte("{}"))} {
		res, raw := h.do(http.MethodGet, "/api/host/email-inbox?cursor="+url.QueryEscape(cursor), nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("cursor %q: %d %s", cursor, res.StatusCode, raw)
		}
	}
	res, raw := h.do(http.MethodGet, "/api/host/email-inbox?limit=0", nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("limit 0: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("first page: %d %s", res.StatusCode, raw)
	}
}
