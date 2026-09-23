package wa

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

/* The parts worth pinning here are the ones where Meta's flow differs from the
 * YouTube grant this package was modelled on, and the one where being wrong is a
 * security hole rather than a bug: Embedded Signup exchanges a code WITHOUT a
 * redirect_uri, and the webhook signature is the only thing standing between a
 * public endpoint and a host's inbox. */

func TestExchangeSendsNoRedirectURI(t *testing.T) {
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		writeJSON(w, map[string]any{"access_token": "host-token"})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	tok, err := c.Exchange(context.Background(), "code-from-dialog")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if tok.AccessToken != "host-token" {
		t.Errorf("AccessToken = %q, want host-token", tok.AccessToken)
	}
	// Absent expires_in means a token that does not expire, which is the normal
	// Embedded Signup case — not a zero we should have filled in.
	if !tok.ExpiresAt.IsZero() {
		t.Errorf("ExpiresAt = %v, want zero for a non-expiring token", tok.ExpiresAt)
	}
	if _, ok := gotQuery["redirect_uri"]; ok {
		t.Error("sent redirect_uri: Meta rejects the Embedded Signup exchange when it carries one")
	}
	if gotQuery.Get("client_secret") != "app-secret" || gotQuery.Get("code") != "code-from-dialog" {
		t.Errorf("query = %v, want the app secret and the code", gotQuery)
	}
}

func TestExchangeNeedsConfigAndCode(t *testing.T) {
	t.Run("no config id", func(t *testing.T) {
		c := New("app-id", "app-secret", "")
		if _, err := c.Exchange(context.Background(), "code"); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("err = %v, want ErrNotConfigured: without a config id nothing can open the dialog", err)
		}
	})
	t.Run("no code", func(t *testing.T) {
		c := New("app-id", "app-secret", "config-1")
		if _, err := c.Exchange(context.Background(), "  "); !errors.Is(err, ErrNeedCode) {
			t.Errorf("err = %v, want ErrNeedCode", err)
		}
	})
}

func TestNumberAndSubscribeApp(t *testing.T) {
	var subscribed string
	var bearer string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer = r.Header.Get("Authorization")
		switch {
		case r.URL.Path == "/phone-1" && r.Method == http.MethodGet:
			if got := r.URL.Query().Get("fields"); got != "display_phone_number,verified_name" {
				t.Errorf("fields = %q", got)
			}
			writeJSON(w, map[string]any{
				"id":                   "phone-1",
				"display_phone_number": "+27 82 000 0000",
				"verified_name":        "Acme Coaching",
			})
		case r.URL.Path == "/waba-1/subscribed_apps" && r.Method == http.MethodPost:
			subscribed = "waba-1"
			writeJSON(w, map[string]any{"success": true})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	num, err := c.Number(context.Background(), "host-token", "phone-1")
	if err != nil {
		t.Fatalf("Number: %v", err)
	}
	if num.DisplayPhone != "+27 82 000 0000" || num.VerifiedName != "Acme Coaching" {
		t.Errorf("number = %+v", num)
	}
	if bearer != "Bearer host-token" {
		t.Errorf("Authorization = %q, want the host's own token", bearer)
	}
	if err := c.SubscribeApp(context.Background(), "host-token", "waba-1"); err != nil {
		t.Fatalf("SubscribeApp: %v", err)
	}
	if subscribed != "waba-1" {
		t.Error("never subscribed the WABA: the grant would be silent, with no statuses or replies")
	}
}

/* Disconnecting has to stop the traffic, not just forget the token.
 *
 * The subscription lives on the host's WABA. Without the DELETE, Meta keeps
 * posting their customers' messages here after the host asked us to stop — signed,
 * genuine and unwanted.
 */
func TestUnsubscribeAppDeletesTheSubscription(t *testing.T) {
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		writeJSON(w, map[string]any{"success": true})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	if err := c.UnsubscribeApp(context.Background(), "host-token", "waba-1"); err != nil {
		t.Fatalf("UnsubscribeApp: %v", err)
	}
	if method != http.MethodDelete || path != "/waba-1/subscribed_apps" {
		t.Errorf("sent %s %s, want DELETE /waba-1/subscribed_apps", method, path)
	}
	if err := c.UnsubscribeApp(context.Background(), "", "waba-1"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("err = %v, want ErrNotConnected with no token", err)
	}
}

/* The browser's SDK version comes off the same pinned base the server calls, so
 * the two cannot drift apart. An override without a version segment — an
 * httptest server, a local proxy — still has to yield something the SDK accepts.
 */
func TestVersionComesFromTheGraphBase(t *testing.T) {
	if got := New("a", "b", "c").Version(); got != "v23.0" {
		t.Errorf("Version() = %q, want the pinned v23.0", got)
	}
	pinned := &Client{Graph: "https://graph.facebook.com/v19.0/"}
	if got := pinned.Version(); got != "v19.0" {
		t.Errorf("Version() = %q, want v19.0 from the override", got)
	}
	local := &Client{Graph: "http://127.0.0.1:53019"}
	if got := local.Version(); got != "v23.0" {
		t.Errorf("Version() = %q, want the pinned default when the override has no version", got)
	}
}

// A revoked grant has to be distinguishable from one that was never made: the
// two need different words in front of a host.
func TestRevokedTokenIsItsOwnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		writeJSON(w, map[string]any{"error": map[string]any{
			"message": "Error validating access token: the user has not authorized application",
			"code":    190,
		}})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	if _, err := c.Number(context.Background(), "stale-token", "phone-1"); !errors.Is(err, ErrTokenRejected) {
		t.Errorf("err = %v, want ErrTokenRejected", err)
	}
}

func TestVerifySignature(t *testing.T) {
	c := New("app-id", "app-secret", "config-1")
	body := []byte(`{"object":"whatsapp_business_account","entry":[]}`)
	mac := hmac.New(sha256.New, []byte("app-secret"))
	mac.Write(body)
	good := hex.EncodeToString(mac.Sum(nil))

	if !c.VerifySignature(body, "sha256="+good) {
		t.Error("rejected a genuine signature")
	}
	if !c.VerifySignature(body, good) {
		t.Error("rejected the bare hex form")
	}
	// An unsigned request must not be treated as trusted — this endpoint is
	// public, and accepting it would let anyone write into a host's inbox.
	if c.VerifySignature(body, "") {
		t.Error("accepted an unsigned body")
	}
	if c.VerifySignature(body, "sha256="+good[:len(good)-1]+"0") {
		t.Error("accepted a wrong signature")
	}
	if c.VerifySignature([]byte(`{"object":"tampered"}`), "sha256="+good) {
		t.Error("accepted a body that does not match its signature")
	}
	// No secret configured is no basis for trust, whatever the header says.
	if (&Client{}).VerifySignature(body, "sha256="+good) {
		t.Error("verified without an app secret")
	}
}

func newTestClient(graph string) *Client {
	c := New("app-id", "app-secret", "config-1")
	c.Graph = graph
	return c
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
