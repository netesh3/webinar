package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Registering the connected number with Cloud API, with the host's own PIN.
 *
 * The step that decides whether anything else in this whole feature works: a number
 * created inside Embedded Signup is connected, verified, and unable to send until it has
 * been registered. So the assertions are about the PIN — that the one the host typed is
 * the one Meta received, unchanged and unsubstituted — and about the three places it must
 * never turn up. The fake Graph is the only thing in the test suite that holds a PIN, and
 * it holds one precisely so this file can check where it went.
 */

const testRegisterPin = "419357"

func TestWhatsAppRegisterPassesTheHostsPinToMeta(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	me := meAccount(t, h)
	grantFeature(t, h, me.ID, types.FeatureWhatsAppRegister)

	if me.WhatsApp == nil || me.WhatsApp.RegisteredAt != "" {
		t.Fatalf("a freshly connected account is already registered: %+v", me.WhatsApp)
	}

	res, raw := h.do(http.MethodPost, "/api/host/whatsapp/register",
		types.WhatsAppRegisterRequest{Pin: testRegisterPin})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}

	calls := g.registered()
	if len(calls) != 1 {
		t.Fatalf("Meta received %d register calls, want 1", len(calls))
	}
	if got := calls[0]["pin"]; got != testRegisterPin {
		t.Errorf("pin reached Meta as %v, want the one the host typed", got)
	}
	// Meta rejects the call without it, and there is no default.
	if got := calls[0]["messaging_product"]; got != "whatsapp" {
		t.Errorf("messaging_product = %v, want whatsapp", got)
	}

	/* The PIN is not in the answer, and not in any later one either.
	 *
	 * Checked against the raw bytes rather than a decoded struct on purpose: a struct
	 * can only be searched for fields somebody remembered to look at, and the failure
	 * being guarded against here is a field nobody meant to add.
	 */
	if strings.Contains(string(raw), testRegisterPin) {
		t.Errorf("the register response carries the PIN: %s", raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.WhatsApp == nil || acct.WhatsApp.RegisteredAt == "" {
		t.Fatalf("registeredAt not set after registering: %+v", acct.WhatsApp)
	}
	registered := acct.WhatsApp.RegisteredAt

	_, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if strings.Contains(string(raw), testRegisterPin) {
		t.Errorf("the account carries the PIN: %s", raw)
	}
	h.decode(raw, &acct)
	if acct.WhatsApp.RegisteredAt != registered {
		t.Errorf("registeredAt did not persist: %q, was %q", acct.WhatsApp.RegisteredAt, registered)
	}

	/* Registering twice is not an error, because a host will press it twice.
	 *
	 * Meta itself is idempotent for the same number and PIN, and this endpoint keeps
	 * that promise rather than inventing an "already registered" refusal that would
	 * leave somebody staring at a red message about a number that works.
	 */
	res, raw = h.do(http.MethodPost, "/api/host/whatsapp/register",
		types.WhatsAppRegisterRequest{Pin: testRegisterPin})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second register: status %d body %s", res.StatusCode, raw)
	}
	if len(g.registered()) != 2 {
		t.Errorf("second press did not reach Meta: %d calls", len(g.registered()))
	}
}

func TestWhatsAppRegisterRefusals(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	me := meAccount(t, h)
	grantFeature(t, h, me.ID, types.FeatureWhatsAppRegister)

	// Nothing to register before the host has connected anything.
	res, raw := h.do(http.MethodPost, "/api/host/whatsapp/register",
		types.WhatsAppRegisterRequest{Pin: testRegisterPin})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_not_connected" {
		t.Fatalf("register before connecting: status %d code %q\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	connectWhatsApp(t, h)

	/* Shape, checked here rather than left to Meta.
	 *
	 * Every one of these is a plausible thing to type into a six-box field, and each has
	 * to come back as something to fix in that field — Meta's own answer is about
	 * parameter validation and names nothing the host can see. The full-width digits are
	 * not pedantry: a phone keyboard can produce them, and they are not digits Meta will
	 * accept.
	 */
	for _, pin := range []string{"", "12345", "1234567", "12345a", "12 345", "１２３４５６", "12-34-56"} {
		res, raw := h.do(http.MethodPost, "/api/host/whatsapp/register",
			types.WhatsAppRegisterRequest{Pin: pin})
		if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_bad_pin" {
			t.Errorf("pin %q: status %d code %q, want 422 whatsapp_bad_pin",
				pin, res.StatusCode, errorCode(t, raw))
		}
	}
	if n := len(g.registered()); n != 0 {
		t.Errorf("%d malformed PINs were sent to Meta anyway", n)
	}

	/* Meta's refusal is Meta's sentence, because every cause is the host's to act on —
	 * most often a PIN that is not the one set on the number in WhatsApp Manager.
	 */
	g.failRegister(http.StatusBadRequest, map[string]any{
		"message": "Two-step verification PIN mismatch", "code": 100,
	})
	res, raw = h.do(http.MethodPost, "/api/host/whatsapp/register",
		types.WhatsAppRegisterRequest{Pin: "000000"})
	if res.StatusCode != http.StatusBadGateway || errorCode(t, raw) != "whatsapp_register_failed" {
		t.Fatalf("rejected pin: status %d code %q\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	var apiErr types.APIError
	if err := json.Unmarshal(raw, &apiErr); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	if !strings.Contains(apiErr.Message, "PIN mismatch") {
		t.Errorf("message = %q, want Meta's own words", apiErr.Message)
	}
	// A refused attempt is not a registration: the timestamp says "we did this".
	if after := meAccount(t, h); after.WhatsApp.RegisteredAt != "" {
		t.Errorf("registeredAt set after Meta refused: %+v", after.WhatsApp)
	}

	// Surrounding whitespace is a paste, not a different PIN.
	g.failRegister(0, nil)
	res, raw = h.do(http.MethodPost, "/api/host/whatsapp/register",
		types.WhatsAppRegisterRequest{Pin: "  " + testRegisterPin + "\n"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("pasted pin: status %d body %s", res.StatusCode, raw)
	}
	if got := lastRegister(t, g)["pin"]; got != testRegisterPin {
		t.Errorf("pasted pin reached Meta as %q, want it trimmed", got)
	}
}

func lastRegister(t *testing.T, g *fakeGraph) map[string]any {
	t.Helper()
	calls := g.registered()
	if len(calls) == 0 {
		t.Fatal("Meta received no register call")
	}
	return calls[len(calls)-1]
}
