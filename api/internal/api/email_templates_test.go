package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/notify"
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
		"name": "Office hours", "subject": "See you soon", "body": "Your seat is saved.",
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
		"name": "Office hours", "subject": "Starts in an hour", "body": "The link is in this mail.",
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
	foundCustom := false
	for _, row := range list.Templates {
		if row.ID == created.ID && row.Subject == "Starts in an hour" && row.Body == "The link is in this mail." {
			foundCustom = true
		}
	}
	if !foundCustom {
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
	for _, row := range list.Templates {
		if row.ID == created.ID || row.Subject == "Starts in an hour" || row.Body == "The link is in this mail." {
			t.Fatalf("B saw A's template %+v", row)
		}
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

func TestEmailTemplateDefaultsSeedEditRevertAndDelete(t *testing.T) {
	h := newHarness(t)
	h.signup("Host A", "defs-a@example.com", true)

	res, raw := h.do(http.MethodGet, "/api/host/email-templates", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: %d %s", res.StatusCode, raw)
	}
	var list struct {
		Templates []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			Subject    string `json:"subject"`
			Body       string `json:"body"`
			Key        string `json:"key"`
			Customized bool   `json:"customized"`
		} `json:"templates"`
	}
	h.decode(raw, &list)
	byKey := map[string]int{}
	for i, row := range list.Templates {
		if row.Key != "" {
			byKey[row.Key] = i
		}
	}
	for _, want := range notify.DefaultEmailTemplates() {
		i, ok := byKey[want.Key]
		if !ok {
			t.Fatalf("missing default %s in %+v", want.Key, list.Templates)
		}
		row := list.Templates[i]
		if row.Customized || row.Name != want.Name || row.Subject != want.Subject || row.Body != want.Body {
			t.Fatalf("default %s = %+v", want.Key, row)
		}
	}

	reminder := list.Templates[byKey[notify.TplReminder]]
	res, raw = h.do(http.MethodPut, "/api/host/email-templates/"+reminder.ID, map[string]string{
		"name": "Reminder", "subject": "See you at {{topic}}", "body": "Hi {{name}}, it starts {{when}}.",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("edit: %d %s", res.StatusCode, raw)
	}
	var edited struct {
		Subject    string `json:"subject"`
		Body       string `json:"body"`
		Customized bool   `json:"customized"`
		Key        string `json:"key"`
	}
	h.decode(raw, &edited)
	if !edited.Customized || edited.Key != notify.TplReminder ||
		edited.Subject != "See you at {{topic}}" || edited.Body != "Hi {{name}}, it starts {{when}}." {
		t.Fatalf("edited = %+v", edited)
	}

	res, raw = h.do(http.MethodDelete, "/api/host/email-templates/"+reminder.ID, nil)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("delete default: %d %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/host/email-templates/"+reminder.ID+"/revert", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revert: %d %s", res.StatusCode, raw)
	}
	var reverted struct {
		Subject    string `json:"subject"`
		Body       string `json:"body"`
		Customized bool   `json:"customized"`
	}
	h.decode(raw, &reverted)
	def, _ := notify.EmailDefaultByKey(notify.TplReminder)
	if reverted.Customized || reverted.Subject != def.Subject || reverted.Body != def.Body {
		t.Fatalf("reverted = %+v, want subject %q", reverted, def.Subject)
	}

	res, raw = h.do(http.MethodPost, "/api/host/email-templates", map[string]string{
		"name": "Office hours", "subject": "Come by", "body": "The door is open.",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create extra: %d %s", res.StatusCode, raw)
	}
	var extra struct {
		ID string `json:"id"`
	}
	h.decode(raw, &extra)
	res, raw = h.do(http.MethodDelete, "/api/host/email-templates/"+extra.ID, nil)
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete extra: %d %s", res.StatusCode, raw)
	}

	h.logout()
	h.signup("Host B", "defs-b@example.com", true)
	res, raw = h.do(http.MethodGet, "/api/host/email-templates", nil)
	h.decode(raw, &list)
	for _, row := range list.Templates {
		if row.ID == reminder.ID || row.ID == extra.ID || row.Subject == "See you at {{topic}}" || row.Subject == "Come by" {
			t.Fatalf("B saw A's template %+v", row)
		}
	}
}
