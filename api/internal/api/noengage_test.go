package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* A deployment without the CRM runs webinars the same way.
 *
 * The point of the Engage interface is that the webinar product owes the CRM nothing: with
 * NoEngage wired in, a host can create a webinar, a stranger can register (opt-in box ticked
 * and all), the host can approve, reschedule and end it, and none of that fails or waits on
 * a module that is not there. The CRM's routes are gone rather than broken, and /config
 * says WhatsApp cannot be connected, so the web app shows none of its slots.
 */
func TestWebinarsRunWithoutEngage(t *testing.T) {
	bootWithoutEngage = true
	t.Cleanup(func() { bootWithoutEngage = false })

	h := newHarness(t)
	h.login("neeraj@acme.dev")

	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "No CRM here", "startsAt": soon(), "durationMin": 45, "status": "scheduled",
		"registrationRequired": true, "approval": "manual", "attendeeLimit": 100,
		"options": map[string]any{"whatsappReminders": true},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Thandi", Email: "thandi@example.com",
		Phone: "+27 82 555 0100", Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{IDs: []string{idOf(t, h, wb.ID, "thandi@example.com")}, State: types.RegApproved})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approve: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("roster: status %d body %s", res.StatusCode, raw)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}

	// The CRM's routes are not mounted: a 404 from the router, not a 500 from a handler.
	for _, path := range []string{"/api/host/crm/contacts", "/api/host/crm/setup", "/api/host/whatsapp/connect"} {
		if res, _ := h.do(http.MethodGet, path, nil); res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s = %d without the CRM, want 404", path, res.StatusCode)
		}
	}
	var cfg types.AppConfig
	_, raw = h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if cfg.WhatsAppConnect {
		t.Error("/config says WhatsApp can be connected on a server with no CRM")
	}
}
