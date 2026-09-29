package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func richTemplates() []map[string]any {
	return append(defaultFakeTemplates(), map[string]any{
		"name": "wl_reminder", "language": "en", "status": "APPROVED", "category": "UTILITY",
		"components": []map[string]any{
			{"type": "HEADER", "format": "IMAGE"},
			{"type": "BODY", "text": "Hi {{1}}, your webinar starts soon."},
			{"type": "BUTTONS", "buttons": []map[string]any{
				{"type": "URL", "text": "Join", "url": "http://localhost:3000/{{1}}"},
				{"type": "QUICK_REPLY", "text": "Can't make it"},
			}},
		},
	})
}

/* A confirmation on a rich template: the cover goes in the header, and the Join button
 * carries this person's own link — cut to the part after the approved address. */
func TestRichTemplateConfirmationFillsImageAndLink(t *testing.T) {
	g := newFakeGraph(t)
	g.setTemplates(richTemplates())
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	crmTemplates(t, h, "?refresh=1")

	tpls := crmTemplates(t, h, "")
	var rich types.CRMTemplate
	for _, tp := range tpls.Templates {
		if tp.Name == "wl_reminder" {
			rich = tp
		}
	}
	if !rich.Sendable || rich.HeaderFormat != "IMAGE" || len(rich.Buttons) != 2 || !rich.Buttons[0].Dynamic {
		t.Fatalf("rich template = %+v", rich)
	}

	setReminders(t, h, types.CRMReminder{Kind: types.NotifyWhatsAppConfirmed,
		Template: "wl_reminder", Language: "en", Params: []string{"first_name"}})
	wb := remindersWebinar(t, h, "Rich", true)
	registerOptedIn(t, h, wb.ID)
	drainWhatsAppOutbox(t, h, wb.ID)

	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("sends = %d, want the confirmation", len(sends))
	}
	comps, _ := sends[0]["template"].(map[string]any)["components"].([]any)
	var header, button map[string]any
	for _, c := range comps {
		m := c.(map[string]any)
		switch m["type"] {
		case "header":
			header = m
		case "button":
			button = m
		}
	}
	if header == nil {
		t.Fatalf("no header in %v", comps)
	}
	link := header["parameters"].([]any)[0].(map[string]any)["image"].(map[string]any)["link"].(string)
	if !strings.HasPrefix(link, "http://localhost:3000/") {
		t.Errorf("image link = %q, want a public link Meta can fetch", link)
	}
	if button == nil {
		t.Fatalf("no button in %v", comps)
	}
	suffix := button["parameters"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.HasPrefix(suffix, "webinars/"+wb.ID+"/room?k=") {
		t.Errorf("join suffix = %q, want this person's own join link", suffix)
	}
}

/* The starter set is created at Meta in one go, skipping ones already there, and then
 * shows as pending. A tap on "Can't make it" tags the person; "Tell me more" makes them a
 * hot lead. */
func TestStarterTemplatesAndQuickReplyActions(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureCRMTags)
	connectWhatsApp(t, h)

	res, raw := h.do(http.MethodPost, "/api/host/crm/templates/starters", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("create starters: %d %s", res.StatusCode, raw)
	}
	var out types.CRMStarterTemplatesResponse
	h.decode(raw, &out)
	if len(out.Templates) < 4 || len(g.created) != len(out.Templates) {
		t.Fatalf("created %d of %d", len(g.created), len(out.Templates))
	}
	for _, st := range out.Templates {
		if st.Status != "PENDING" || st.Error != "" {
			t.Errorf("%s status %q err %q", st.Name, st.Status, st.Error)
		}
	}
	// Every URL button points under this app's address, ending in the variable.
	for _, c := range g.created {
		for _, comp := range c["components"].([]any) {
			m := comp.(map[string]any)
			if m["type"] != "BUTTONS" {
				continue
			}
			for _, b := range m["buttons"].([]any) {
				bm := b.(map[string]any)
				if bm["type"] == "URL" && bm["url"] != "http://localhost:3000/{{1}}" {
					t.Errorf("url button = %v", bm)
				}
			}
		}
	}
	// A second press creates nothing new.
	h.do(http.MethodPost, "/api/host/crm/templates/starters", nil)
	if len(g.created) != len(out.Templates) {
		t.Errorf("second press created %d more", len(g.created)-len(out.Templates))
	}

	wb := autoWebinar(t, h, "Taps")
	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	postWebhook(t, h, buttonTap("wamid.B1", crmPhoneDigits, "Can't make it"))
	postWebhook(t, h, buttonTap("wamid.B2", crmPhoneDigits, "Tell me more"))
	tags := map[string]bool{}
	for _, tg := range threadFor(t, h, thandi.ID).Contact.Tags {
		tags[tg.Name] = true
	}
	if !tags["Can't make it"] || !tags["Hot lead"] {
		t.Errorf("tags = %v, want Can't make it and Hot lead", tags)
	}
}

// buttonTap is a template quick-reply tap, as Meta posts it.
func buttonTap(wamid, from, text string) string {
	return `{"object":"whatsapp_business_account","entry":[{"id":"` + testMetaWABAID + `","changes":[{"field":"messages","value":{
		"messaging_product":"whatsapp",
		"metadata":{"display_phone_number":"` + testMetaDisplay + `","phone_number_id":"` + testMetaPhoneID + `"},
		"contacts":[{"profile":{"name":"Thandi"},"wa_id":"` + from + `"}],
		"messages":[{"from":"` + from + `","id":"` + wamid + `","timestamp":"` + unixNow() + `","type":"button",
			"button":{"text":"` + text + `","payload":"` + text + `"}}]}}]}]}`
}
