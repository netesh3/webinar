package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* AUTH_BYPASS removes an authorization boundary on purpose, which makes it exactly
 * the kind of switch that must not drift. Two properties matter, and the second one
 * more than the first: with it on, a caller with no cookie becomes a signed-in host;
 * with it off, nothing changes. A regression in the second direction would hand
 * hosting rights to the internet on a deployment that never asked for it. */

func bypassOn(c *config.Config) { c.AuthBypass = true }

func TestAuthBypassProvisionsAHostPerBrowser(t *testing.T) {
	h := newHarness(t, bypassOn)

	res, raw := h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/auth/me with no session = %d, want 200: %s", res.StatusCode, raw)
	}
	var first types.Account
	if err := json.Unmarshal(raw, &first); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	if !first.CanHost {
		t.Error("a bypass account must be able to host — that is the point of the switch")
	}
	if first.ID == "" || first.Name == "" {
		t.Errorf("expected a real account, got %+v", first)
	}

	// The session must stick, or every request would mint another account and the
	// caller would never be the same person twice.
	_, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	var again types.Account
	if err := json.Unmarshal(raw, &again); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if again.ID != first.ID {
		t.Errorf("second request became a different account (%s then %s): the session cookie is not being honoured",
			first.ID, again.ID)
	}

	// A different browser must be a different person. Sharing one account would mean
	// sharing a LiveKit identity, and the SFU disconnects the older session when a
	// duplicate identity joins — so two laptops would kick each other out.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	h2 := &harness{t: t, srv: h.srv, rooms: h.rooms, client: &http.Client{Jar: jar}}
	_, raw = h2.do(http.MethodGet, "/api/auth/me", nil)
	var other types.Account
	if err := json.Unmarshal(raw, &other); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if other.ID == first.ID {
		t.Error("a second browser got the same account; identities must be distinct")
	}
}

func TestAuthIsEnforcedWhenBypassIsOff(t *testing.T) {
	h := newHarness(t) // the default: bypass off

	for _, path := range []string{
		"/api/auth/me",
		"/api/me/registrations",
		"/api/host/webinars",
		"/api/host/stage",
	} {
		res, raw := h.do(http.MethodGet, path, nil)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s with no session = %d, want 401: %s", path, res.StatusCode, raw)
		}
	}
}
