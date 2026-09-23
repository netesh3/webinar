package api_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Connect WhatsApp, end to end against a fake Graph.
 *
 * Two claims carry the feature and both are asserted here rather than reasoned
 * about. The first is commercial: the token stored belongs to the HOST's business,
 * so their messages are billed to their WABA — which means the callback has to
 * reach Meta with the host's own code and store what comes back against that one
 * account. The second is a leak: that token is a bearer credential for somebody
 * else's WhatsApp business, and it must never appear in a response body.
 *
 * The webhook is public, so its signature check is tested as the access control it
 * is — whatever is written from that endpoint in Phase 1b becomes rows in a host's
 * CRM.
 */

const (
	testMetaAppSecret  = "meta-app-secret"
	testMetaVerifyTok  = "verify-me-please"
	testMetaWABAID     = "waba-1"
	testMetaPhoneID    = "phone-1"
	testMetaHostToken  = "host-own-token"
	testMetaDisplay    = "+27 82 000 0000"
	testMetaBusinessNm = "Acme Coaching"
)

// fakeGraph is Meta's Graph for the three calls connecting and disconnecting
// make. It records them, because the assertions worth making are about what
// reached Meta, not only about what came back.
type fakeGraph struct {
	srv *httptest.Server

	mu sync.Mutex
	// exchanged is the code the callback presented, and redirectURI whether it
	// wrongly sent one — Meta rejects the Embedded Signup exchange if it does.
	exchanged   string
	redirectURI bool
	subscribed  []string
	unsubscribe []string
	numberCalls int

	// templates is what a message_templates read answers with, and templateCalls
	// how many times it was asked — the cache is only worth having if it stops the
	// second question.
	templates     []map[string]any
	templateCalls int
	// sends is every /messages body Meta received, in order. The assertions that
	// matter about a refusal are that nothing arrived here at all.
	sends []map[string]any
	// When sendStatus is set, every send is refused with sendError, which is how a
	// host's unpaid WABA or an expired window is simulated.
	sendStatus int
	sendError  map[string]any

	/* registers is every /register body, recorded whole so a test can assert that the
	 * PIN the host typed is what reached Meta. Nothing else in this file records a
	 * request body the server is forbidden to store, and that is exactly why this one
	 * does: the fake is the only place the PIN is ever visible, so it is the only place
	 * that can prove it was passed through rather than substituted or dropped. */
	registers []map[string]any
	// registerStatus refuses registration, the way Meta does for a number whose
	// two-step PIN is not the one it has on file.
	registerStatus int
	registerError  map[string]any
}

func newFakeGraph(t *testing.T) *fakeGraph {
	t.Helper()
	g := &fakeGraph{templates: defaultFakeTemplates()}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/oauth/access_token":
			g.exchanged = r.URL.Query().Get("code")
			_, g.redirectURI = r.URL.Query()["redirect_uri"]
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": testMetaHostToken})
		case r.URL.Path == "/"+testMetaPhoneID && r.Method == http.MethodGet:
			g.numberCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":                   testMetaPhoneID,
				"display_phone_number": testMetaDisplay,
				"verified_name":        testMetaBusinessNm,
			})
		case strings.HasSuffix(r.URL.Path, "/message_templates") && r.Method == http.MethodGet:
			g.templateCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{"data": g.templates})
		case strings.HasSuffix(r.URL.Path, "/messages") && r.Method == http.MethodPost:
			var body map[string]any
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			g.sends = append(g.sends, body)
			if g.sendStatus != 0 {
				w.WriteHeader(g.sendStatus)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": g.sendError})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"messaging_product": "whatsapp",
				"messages":          []map[string]string{{"id": fmt.Sprintf("wamid.OUT%d", len(g.sends))}},
			})
		case strings.HasSuffix(r.URL.Path, "/register") && r.Method == http.MethodPost:
			var body map[string]any
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			g.registers = append(g.registers, body)
			if g.registerStatus != 0 {
				w.WriteHeader(g.registerStatus)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": g.registerError})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		case strings.HasSuffix(r.URL.Path, "/subscribed_apps"):
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), "/subscribed_apps")
			if r.Method == http.MethodDelete {
				g.unsubscribe = append(g.unsubscribe, id)
			} else {
				g.subscribed = append(g.subscribed, id)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
		default:
			t.Errorf("unexpected call to Meta: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(g.srv.Close)
	return g
}

/* defaultFakeTemplates is a plausible template list for a host: one approved
 * utility template with a variable in it, one approved marketing template, and one
 * still waiting for Meta. Every send test needs a template to name, and a
 * realistic mix is what makes the category and approval rules testable at all.
 */
func defaultFakeTemplates() []map[string]any {
	return []map[string]any{
		{
			"name": testTemplateUtility, "language": "en_US", "status": "APPROVED",
			"category": "UTILITY",
			"components": []map[string]any{
				{"type": "BODY", "text": "Hi {{1}}, your webinar starts in an hour."},
				{"type": "FOOTER", "text": "Reply STOP to unsubscribe"},
			},
		},
		{
			"name": testTemplateMarketing, "language": "en_US", "status": "APPROVED",
			"category":   "MARKETING",
			"components": []map[string]any{{"type": "BODY", "text": "New course, live next week."}},
		},
		{
			"name": testTemplatePending, "language": "en_US", "status": "PENDING",
			"category":   "MARKETING",
			"components": []map[string]any{{"type": "BODY", "text": "Waiting on Meta."}},
		},
	}
}

const (
	testTemplateUtility   = "webinar_reminder_1h"
	testTemplateMarketing = "course_launch"
	testTemplatePending   = "not_approved_yet"
)

// setTemplates changes what Meta will report next, for the cases where a template
// is created, paused or deleted between two syncs.
func (g *fakeGraph) setTemplates(ts []map[string]any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.templates = ts
}

// sent is every send Meta received. Copied under the lock: the handler runs on the
// server's goroutine.
func (g *fakeGraph) sent() []map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]map[string]any(nil), g.sends...)
}

// registered is every /register Meta received, bodies and all.
func (g *fakeGraph) registered() []map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]map[string]any(nil), g.registers...)
}

// failRegister makes Meta refuse registration — a wrong PIN, most often.
func (g *fakeGraph) failRegister(status int, err map[string]any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.registerStatus, g.registerError = status, err
}

func (g *fakeGraph) syncs() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.templateCalls
}

// failSends makes Meta refuse every send, the way a WABA with no payment method
// on it does.
func (g *fakeGraph) failSends(status int, err map[string]any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sendStatus, g.sendError = status, err
}

// whatsappConfigured is the config tweak that turns the feature on and points it
// at the fake instead of graph.facebook.com.
func whatsappConfigured(graph string) func(*config.Config) {
	return func(c *config.Config) {
		c.MetaAppID = "meta-app-id"
		c.MetaAppSecret = testMetaAppSecret
		c.MetaWhatsAppConfigID = "signup-config-1"
		c.MetaWebhookVerifyToken = testMetaVerifyTok
		c.WhatsAppGraphURL = graph
	}
}

func TestWhatsAppIsOffWithoutMetaCredentials(t *testing.T) {
	h := newHarness(t)

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if cfg.WhatsAppConnect {
		t.Error("whatsappConnect true with no META_* set: the UI would offer a Connect button that dead-ends")
	}

	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/host/whatsapp/connect", nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("connect status %d, want 503\n  body: %s", res.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "META_APP_ID") {
		t.Errorf("503 does not say what is missing: %s", raw)
	}
}

func TestWhatsAppConnectHandsOverTheSignupPayload(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if !cfg.WhatsAppConnect {
		t.Error("whatsappConnect false with all three META_* set")
	}
	// The public config carries the flag and nothing else. The app id is not a
	// secret, but there is no reason for an anonymous visitor to receive it.
	if strings.Contains(string(raw), "meta-app-id") || strings.Contains(string(raw), testMetaAppSecret) {
		t.Errorf("/api/config leaked Meta identifiers: %s", raw)
	}

	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/host/whatsapp/connect", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("connect status %d\n  body: %s", res.StatusCode, raw)
	}
	var signup types.WhatsAppSignup
	h.decode(raw, &signup)
	if signup.AppID != "meta-app-id" || signup.ConfigID != "signup-config-1" {
		t.Errorf("signup payload = %+v", signup)
	}
	// The SDK needs a real version string; the fake Graph URL has none, so this is
	// the pinned default rather than a host:port.
	if !strings.HasPrefix(signup.GraphVersion, "v") {
		t.Errorf("graphVersion = %q, want something the JS SDK can be initialised with", signup.GraphVersion)
	}
	if strings.Contains(string(raw), testMetaAppSecret) {
		t.Fatal("the app secret reached the browser")
	}
}

func TestWhatsAppCallbackStoresTheHostsOwnGrant(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")

	res, raw := h.do(http.MethodPost, "/api/host/whatsapp/callback", types.WhatsAppCallbackRequest{
		Code: "code-from-dialog", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("callback status %d\n  body: %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.WhatsApp == nil || !acct.WhatsApp.Connected {
		t.Fatalf("account does not report a connection: %s", raw)
	}
	if acct.WhatsApp.DisplayPhone != testMetaDisplay || acct.WhatsApp.VerifiedName != testMetaBusinessNm {
		t.Errorf("link = %+v, want the number a host would recognise as theirs", acct.WhatsApp)
	}
	if acct.WhatsApp.ConnectedAt == "" {
		t.Error("connectedAt empty: the UI has nothing to say about when this happened")
	}
	/* The token is a bearer credential for somebody else's WhatsApp business.
	 * Public() omits it deliberately, and this is the assertion that keeps it
	 * omitted when the struct grows a field next month. */
	if strings.Contains(string(raw), testMetaHostToken) {
		t.Fatal("the host's WhatsApp access token was returned to the browser")
	}

	g.mu.Lock()
	code, sentRedirect, subscribed, numbers := g.exchanged, g.redirectURI, g.subscribed, g.numberCalls
	g.mu.Unlock()
	if code != "code-from-dialog" {
		t.Errorf("exchanged %q, want the code the dialog produced", code)
	}
	if sentRedirect {
		t.Error("sent redirect_uri: Meta rejects the Embedded Signup exchange when it carries one")
	}
	if numbers != 1 {
		t.Errorf("read the number %d times, want once", numbers)
	}
	// Without this the grant is real and completely silent — no inbound reply and
	// no delivery status ever arrives.
	if len(subscribed) != 1 || subscribed[0] != testMetaWABAID {
		t.Errorf("subscribed = %v, want [%s]", subscribed, testMetaWABAID)
	}

	// Signing in as somebody else must not see this host's connection.
	h.logout()
	h.login("lucia@cabify.com")
	_, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	var other types.Account
	h.decode(raw, &other)
	if other.WhatsApp != nil {
		t.Errorf("another host's account reports a WhatsApp link: %+v", other.WhatsApp)
	}

	// Disconnecting has to stop the webhook traffic as well as forget the token.
	h.logout()
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodDelete, "/api/host/whatsapp", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("disconnect status %d\n  body: %s", res.StatusCode, raw)
	}
	// A fresh struct, not the one above: `whatsapp` is omitempty, so decoding an
	// absent field into the already-populated one would leave the stale pointer in
	// place and pass whatever the server said.
	var afterDisconnect types.Account
	h.decode(raw, &afterDisconnect)
	if afterDisconnect.WhatsApp != nil {
		t.Errorf("still linked after disconnect: %+v", afterDisconnect.WhatsApp)
	}
	g.mu.Lock()
	unsub := g.unsubscribe
	g.mu.Unlock()
	if len(unsub) != 1 || unsub[0] != testMetaWABAID {
		t.Errorf("unsubscribed = %v, want [%s]: Meta would keep posting this host's customer messages", unsub, testMetaWABAID)
	}
}

// A code with no ids buys a token with nothing to send from, which would present
// as a connected account that cannot message anybody.
func TestWhatsAppCallbackNeedsTheNumberIDs(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")

	for _, body := range []types.WhatsAppCallbackRequest{
		{Code: "", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID},
		{Code: "code", WABAID: "", PhoneNumberID: testMetaPhoneID},
		{Code: "code", WABAID: testMetaWABAID, PhoneNumberID: "  "},
	} {
		res, raw := h.do(http.MethodPost, "/api/host/whatsapp/callback", body)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%+v: status %d, want 422\n  body: %s", body, res.StatusCode, raw)
		}
	}
	g.mu.Lock()
	code := g.exchanged
	g.mu.Unlock()
	if code != "" {
		t.Errorf("reached Meta with an incomplete payload (code %q)", code)
	}
}

// An account without the hosting capability has no WABA to connect and no
// business reaching any of this.
func TestWhatsAppRoutesNeedHostingCapability(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.signup("Attendee", "attendee-wa@example.com", false)

	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/host/whatsapp/connect"},
		{http.MethodPost, "/api/host/whatsapp/callback"},
		{http.MethodDelete, "/api/host/whatsapp"},
	} {
		res, raw := h.do(r.method, r.path, nil)
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s: status %d, want 403\n  body: %s", r.method, r.path, res.StatusCode, raw)
		}
	}
}

/* Meta GETs the callback URL once to confirm the subscription and expects the
 * challenge echoed as plain text. Getting it wrong is not subtle — the app
 * dashboard simply refuses to save the URL — and accepting the wrong token would
 * let a stranger point their own Meta app at this instance.
 */
func TestWhatsAppWebhookVerifyHandshake(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))

	res, raw := h.do(http.MethodGet,
		"/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token="+testMetaVerifyTok+"&hub.challenge=echo-me", nil)
	if res.StatusCode != http.StatusOK || string(raw) != "echo-me" {
		t.Fatalf("handshake: status %d body %q, want 200 and the challenge", res.StatusCode, raw)
	}

	res, _ = h.do(http.MethodGet,
		"/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=echo-me", nil)
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("wrong verify token: status %d, want 403", res.StatusCode)
	}

	// The unconfigured instance says so rather than silently confirming.
	bare := newHarness(t)
	res, _ = bare.do(http.MethodGet,
		"/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=echo-me", nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("unconfigured instance: status %d, want 503", res.StatusCode)
	}
}

/* The signature is the whole access control on a public endpoint that will, from
 * Phase 1b, write into a host's CRM. A verified delivery is acknowledged even
 * though nothing is ingested yet: Meta retries a non-2xx for hours and then
 * disables the subscription outright.
 */
func TestWhatsAppWebhookRequiresAMetaSignature(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))

	body := []byte(`{"object":"whatsapp_business_account","entry":[{"id":"waba-1","changes":[]}]}`)
	mac := hmac.New(sha256.New, []byte(testMetaAppSecret))
	mac.Write(body)
	good := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	for _, tc := range []struct {
		name   string
		header string
		body   []byte
		want   int
	}{
		{"unsigned", "", body, http.StatusForbidden},
		{"wrong signature", "sha256=" + strings.Repeat("0", 64), body, http.StatusForbidden},
		{"tampered body", good, append(body, ' '), http.StatusForbidden},
		{"genuine", good, body, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := map[string]string{}
			if tc.header != "" {
				headers["X-Hub-Signature-256"] = tc.header
			}
			res, raw := h.doRaw(http.MethodPost, "/api/webhooks/whatsapp", "application/json", tc.body, headers)
			if res.StatusCode != tc.want {
				t.Errorf("status %d, want %d\n  body: %s", res.StatusCode, tc.want, raw)
			}
		})
	}
}
