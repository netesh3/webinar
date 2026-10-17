package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* WhatsApp consent is per coach. A signed-in person who registers without ticking
 * the box is not opted in; ticking it opts them in with that coach only. The read
 * the register page uses reports exactly that, and needs a session. */
func TestWhatsAppConsentIsPerCoach(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	first := autoWebinar(t, h, "First coach")
	h.signup("Second Coach", "second-coach@test.dev", true)
	second := autoWebinar(t, h, "Second coach")
	h.logout()

	if res, _ := h.do(http.MethodGet, "/api/webinars/"+first.ID+"/whatsapp-consent", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous consent read: status %d, want 401", res.StatusCode)
	}

	h.signup("Asha Attendee", "asha-consent@test.dev", false)
	consent := func(slug string) types.WhatsAppConsent {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/webinars/"+slug+"/whatsapp-consent", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("consent %s: status %d body %s", slug, res.StatusCode, raw)
		}
		var c types.WhatsAppConsent
		h.decode(raw, &c)
		return c
	}
	register := func(slug string, optIn bool) {
		t.Helper()
		res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/register", types.RegisterRequest{
			FirstName: "Asha", Email: "asha-consent@test.dev", Phone: testPhone,
			Consent: true, WhatsAppOptIn: optIn,
		})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("register %s: status %d body %s", slug, res.StatusCode, raw)
		}
		// The CRM contact is written after the response.
		h.server.WaitBackground()
	}

	if c := consent(first.ID); c.OptedIn || c.Phone != testPhone {
		t.Fatalf("before registering = %+v, want not opted in with the account phone", c)
	}

	// Registered without the box: still not opted in, so the page asks next time too.
	register(first.ID, false)
	if c := consent(first.ID); c.OptedIn {
		t.Fatal("registering with the box unticked opted them in")
	}

	register(second.ID, true)
	if c := consent(second.ID); !c.OptedIn {
		t.Fatal("ticking the box did not opt them in with that coach")
	}
	if c := consent(first.ID); c.OptedIn {
		t.Fatal("another coach's opt-in counted for this one")
	}
}
