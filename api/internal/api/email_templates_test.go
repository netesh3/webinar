package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
)

func TestEmailTemplatesAndInboxStayWithTheHost(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.InboxWebhookSecret = inboxTestSecret
	})

	h.signup("Host A", "tmpl-a@example.com", true)
	res, raw := h.do(http.MethodGet, "/api/host/email-inbox", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox A: %d %s", res.StatusCode, raw)
	}
	var inboxA inboxBody
	h.decode(raw, &inboxA)

	res, raw = h.do(http.MethodPost, "/api/host/email-templates", map[string]string{
		"name": "Reminder", "subject": "See you soon", "body": "Your seat is saved.",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var created struct {
		ID      string `json:"id"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	h.decode(raw, &created)
	if created.ID == "" || created.Subject != "See you soon" || created.Body != "Your seat is saved." {
		t.Fatalf("created = %+v", created)
	}

	res, raw = h.do(http.MethodPut, "/api/host/email-templates/"+created.ID, map[string]string{
		"name": "Reminder", "subject": "Starts in an hour", "body": "The link is in this mail.",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("update: %d %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodGet, "/api/host/email-templates", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list A: %d %s", res.StatusCode, raw)
	}
	var list struct {
		Templates []struct {
			ID      string `json:"id"`
			Subject string `json:"subject"`
			Body    string `json:"body"`
		} `json:"templates"`
	}
	h.decode(raw, &list)
	if len(list.Templates) != 1 || list.Templates[0].ID != created.ID ||
		list.Templates[0].Subject != "Starts in an hour" ||
		list.Templates[0].Body != "The link is in this mail." {
		t.Fatalf("A templates = %+v", list.Templates)
	}

	payload, _ := json.Marshal(map[string]string{
		"to": inboxA.Address, "from": "guest@example.com",
		"subject": "Re: Starts in an hour", "text": "Got it", "messageId": "<tmpl-a@x>",
	})
	res, raw = h.doRaw(http.MethodPost, "/api/webhooks/email", "application/json", payload,
		map[string]string{"X-Inbox-Webhook-Secret": inboxTestSecret})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbound: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	h.decode(raw, &inboxA)
	gotIn := false
	for _, m := range inboxA.Messages {
		if m.Subject == "Re: Starts in an hour" && m.Direction == "in" {
			gotIn = true
		}
	}
	if !gotIn {
		t.Fatalf("A inbox missing received reply: %+v", inboxA.Messages)
	}

	h.logout()
	h.signup("Host B", "tmpl-b@example.com", true)
	res, raw = h.do(http.MethodGet, "/api/host/email-templates", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list B: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &list)
	if len(list.Templates) != 0 {
		t.Fatalf("B saw templates %+v", list.Templates)
	}
	res, raw = h.do(http.MethodPut, "/api/host/email-templates/"+created.ID, map[string]string{
		"name": "Stolen", "subject": "Nope", "body": "Nope",
	})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("B update: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/email-inbox", nil)
	var inboxB inboxBody
	h.decode(raw, &inboxB)
	for _, m := range inboxB.Messages {
		if m.Subject == "Re: Starts in an hour" || m.Subject == "Starts in an hour" {
			t.Fatalf("B saw %s", m.Subject)
		}
	}
}
