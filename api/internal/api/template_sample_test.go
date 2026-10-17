package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* A media-header template can be submitted with no file: Meta reviews a bundled
 * sample, the sample is not the template's default file, and it never lands in the
 * coach's media library or quota. Until a default file is set, a video template is
 * refused for a reminder with a message that says what to do. */
func TestMediaHeaderTemplateWithoutAFileSubmitsASample(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	for i, tc := range []struct{ format, mime string }{
		{"IMAGE", "image%2Fjpeg"},
		{"VIDEO", "video%2Fmp4"},
		{"DOCUMENT", "application%2Fpdf"},
	} {
		res, raw := h.do(http.MethodPost, "/api/host/crm/templates", types.CRMWordingRequest{
			Body: "Hi {{1}}, see you soon.", Category: "UTILITY",
			Header: &types.CRMTemplateHeaderInput{Format: tc.format},
		})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s with no file: %d %s", tc.format, res.StatusCode, raw)
		}
		var saved struct{ Name string }
		h.decode(raw, &saved)

		ups := g.uploaded()
		if len(ups) != i+1 || !strings.Contains(ups[i].Query, "file_type="+tc.mime) || len(ups[i].Body) == 0 {
			t.Fatalf("%s sample upload = %+v", tc.format, ups)
		}
		created := g.createdTemplates()
		head := created[len(created)-1]["components"].([]any)[0].(map[string]any)
		if head["format"] != tc.format || len(head["example"].(map[string]any)["header_handle"].([]any)) != 1 {
			t.Fatalf("%s submitted header = %v", tc.format, head)
		}
		if tp := templateNamed2(t, h, saved.Name); tp.HeaderFile != nil {
			t.Errorf("%s template default file = %+v, want none (the sample is not it)", tc.format, tp.HeaderFile)
		}
	}

	res, raw := h.do(http.MethodGet, "/api/host/crm/media", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("library: %d %s", res.StatusCode, raw)
	}
	var lib types.CRMMediaLibrary
	h.decode(raw, &lib)
	if len(lib.Files) != 0 || lib.UsedBytes != 0 {
		t.Errorf("library = %d files, %d bytes; samples must not be stored or counted", len(lib.Files), lib.UsedBytes)
	}

	g.addTemplate(map[string]any{
		"name": "intro_video", "language": "en", "status": "APPROVED", "category": "UTILITY",
		"components": []map[string]any{
			{"type": "HEADER", "format": "VIDEO"},
			{"type": "BODY", "text": "Your webinar is today."},
		},
	})
	crmTemplates(t, h, "?refresh=1")
	res, raw = h.do(http.MethodPut, "/api/host/crm/reminders", types.CRMRemindersRequest{
		Reminders: []types.CRMReminder{{
			Kind: types.NotifyWhatsAppConfirmed, Template: "intro_video", Language: "en",
		}},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_template_unusable" ||
		!strings.Contains(string(raw), "Choose default file") {
		t.Fatalf("reminder with a fileless video template: %d %s", res.StatusCode, raw)
	}
}
