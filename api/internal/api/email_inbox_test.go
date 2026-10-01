package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/notify"
)

const inboxTestSecret = "inbox-test-secret"

type inboxBody struct {
	Address   string `json:"address"`
	Local     string `json:"local"`
	CanRename bool   `json:"canRename"`
	Alias     string `json:"alias"`
	Messages  []struct {
		ID        string `json:"id"`
		Direction string `json:"direction"`
		From      string `json:"from"`
		Subject   string `json:"subject"`
		Body      string `json:"body"`
	} `json:"messages"`
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
		t.Fatal("auto-assign consumed the one change")
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
	if inboxB.Local != next || inboxB.CanRename || inboxB.Alias == "" {
		t.Fatalf("after rename = %+v", inboxB)
	}
	old := inboxB.Alias

	res, raw = h.do(http.MethodPut, "/api/host/email-inbox/address", map[string]string{"local": "alex-other"})
	if res.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "support") {
		t.Fatalf("second rename: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxB)
	if inboxB.Local != next {
		t.Fatalf("locked rename changed address to %s", inboxB.Local)
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
	if code, got := post(next, "fan@example.com"); code != http.StatusOK || got != "stored" {
		t.Fatalf("current address: %d %s", code, got)
	}
	if code, got := post(old, "fan@example.com"); code != http.StatusOK || got != "stored" {
		t.Fatalf("alias: %d %s", code, got)
	}
	body, _ := json.Marshal(map[string]string{"to": next + "@webinarliv.com", "from": "x@example.com", "text": "nope"})
	res, _ = h.doRaw(http.MethodPost, "/api/webhooks/email", "application/json", body, nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing secret: %d", res.StatusCode)
	}

	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxB)
	if len(inboxB.Messages) != 2 {
		t.Fatalf("host B messages = %d, want 2 (current + alias)", len(inboxB.Messages))
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
	if sent.ReplyTo != next+"@webinarliv.com" {
		t.Fatalf("Reply-To = %s", sent.ReplyTo)
	}
	if sent.InReplyTo != "<m-"+next+"@x>" && sent.InReplyTo != "<m-"+old+"@x>" {
		t.Fatalf("In-Reply-To = %s", sent.InReplyTo)
	}
	if sent.To != "fan@example.com" {
		t.Fatalf("To = %s", sent.To)
	}
	_ = a
}
