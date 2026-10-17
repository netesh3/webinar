package api_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/types"
)

// oneTap signs a Google ID token for email and posts it, as One Tap does.
func oneTapSetup(t *testing.T) func(h *harness, email, from string) *http.Response {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "kind-kid"
	certs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e}},
		})
	}))
	t.Cleanup(certs.Close)
	prevCerts, prevHTTP := auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() { auth.GoogleCertsURL, auth.GoogleHTTP = prevCerts, prevHTTP })
	auth.GoogleCertsURL, auth.GoogleHTTP = certs.URL, certs.Client()
	n := 0
	return func(h *harness, email, from string) *http.Response {
		t.Helper()
		n++
		nonce := "kind-nonce-" + string(rune('a'+n))
		res, raw := h.do(http.MethodPost, "/api/auth/google", types.GoogleAuthRequest{
			IDToken: signGoogleIDToken(t, key, kid, testGoogleClientID, email, "Kind Person", nonce),
			Nonce:   nonce, From: from,
		})
		if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
			t.Fatalf("one tap %s: status %d body %s", email, res.StatusCode, raw)
		}
		return res
	}
}

func kindOf(t *testing.T, h *harness, email string) types.AccountKind {
	t.Helper()
	u, err := h.store.UserByEmail(t.Context(), email)
	if err != nil {
		t.Fatalf("user %s: %v", email, err)
	}
	return u.AccountKind
}

/* Each creation path records where the account came from, and an audience account
 * becomes a customer when it comes back to the app itself. */
func TestAccountKindAtCreationAndPromotion(t *testing.T) {
	oneTap := oneTapSetup(t)
	h := newHarness(t, withGoogleOAuth)

	h.signup("Password Person", "kind-password@test.dev", false)
	if k := kindOf(t, h, "kind-password@test.dev"); k != types.AccountCustomer {
		t.Errorf("password signup kind = %q, want customer", k)
	}
	h.logout()

	h.registerAs("scaling-webrtc-10k", "kind-guest@test.dev")
	if k := kindOf(t, h, "kind-guest@test.dev"); k != types.AccountAudience {
		t.Errorf("webinar registration kind = %q, want audience", k)
	}

	oneTap(h, "kind-home@test.dev", "")
	if k := kindOf(t, h, "kind-home@test.dev"); k != types.AccountCustomer {
		t.Errorf("One Tap from the site kind = %q, want customer", k)
	}
	h.logout()
	oneTap(h, "kind-webinar@test.dev", "webinar")
	if k := kindOf(t, h, "kind-webinar@test.dev"); k != types.AccountAudience {
		t.Errorf("One Tap from a webinar page kind = %q, want audience", k)
	}
	// A customer signing in on a webinar page stays a customer.
	h.logout()
	oneTap(h, "kind-home@test.dev", "webinar")
	if k := kindOf(t, h, "kind-home@test.dev"); k != types.AccountCustomer {
		t.Errorf("customer after a webinar-page sign-in = %q, want customer", k)
	}
	// The audience account comes back through the site: now a customer.
	h.logout()
	oneTap(h, "kind-webinar@test.dev", "")
	if k := kindOf(t, h, "kind-webinar@test.dev"); k != types.AccountCustomer {
		t.Errorf("audience after signing in from the site = %q, want customer", k)
	}

	for next, want := range map[string]types.AccountKind{
		"/":                      types.AccountCustomer,
		"/pricing":               types.AccountCustomer,
		"/webinars/abc?register": types.AccountAudience,
		"/w/abc/recording/r1":    types.AccountAudience,
		"/host":                  types.AccountCustomer,
	} {
		if got := api.KindForGoogle(next, false); got != want {
			t.Errorf("google next %q kind = %q, want %q", next, got, want)
		}
	}
}

/* The admin list is two lists: customers by default, audience on request, with a
 * count for each. Moving an account is admin-only and does not grant hosting;
 * granting hosting or a plan moves an audience account on its own. */
func TestAdminAccountKindListsAndMoves(t *testing.T) {
	h := newHarness(t)
	h.registerAs("scaling-webrtc-10k", "kind-aud-1@test.dev")
	h.registerAs("scaling-webrtc-10k", "kind-aud-2@test.dev")
	h.registerAs("scaling-webrtc-10k", "kind-aud-3@test.dev")

	h.signup("Not Admin", "kind-notadmin@test.dev", false)
	if res, _ := h.do(http.MethodGet, "/api/admin/users/counts", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin counts: status %d, want 403", res.StatusCode)
	}
	aud, err := h.store.UserByEmail(t.Context(), "kind-aud-1@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	if res, _ := h.do(http.MethodPatch, "/api/admin/users/"+aud.ID+"/kind",
		types.SetAccountKindRequest{Kind: types.AccountCustomer}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin move: status %d, want 403", res.StatusCode)
	}

	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")

	list := func(query string) map[string]types.AdminUser {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/admin/users"+query, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("users%s: status %d body %s", query, res.StatusCode, raw)
		}
		var users []types.AdminUser
		h.decode(raw, &users)
		out := map[string]types.AdminUser{}
		for _, u := range users {
			out[u.Email] = u
		}
		return out
	}
	counts := func() types.AdminAccountCounts {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/admin/users/counts", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("counts: status %d body %s", res.StatusCode, raw)
		}
		var c types.AdminAccountCounts
		h.decode(raw, &c)
		return c
	}

	before := counts()
	if _, ok := list("")["kind-aud-1@test.dev"]; ok {
		t.Error("an audience account is in the default (customer) list")
	}
	audience := list("?kind=audience")
	row, ok := audience["kind-aud-1@test.dev"]
	if !ok || row.AccountKind != types.AccountAudience || row.RegistrationCount != 1 || row.LastWebinarTopic == "" {
		t.Fatalf("audience row = %+v (present %v), want one registration with its topic", row, ok)
	}
	if _, ok := audience["neeraj@acme.dev"]; ok {
		t.Error("a host is in the audience list")
	}
	if res, _ := h.do(http.MethodGet, "/api/admin/users?kind=martians", nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("bad kind: status %d, want 422", res.StatusCode)
	}

	res, raw := h.do(http.MethodPatch, "/api/admin/users/"+aud.ID+"/kind",
		types.SetAccountKindRequest{Kind: types.AccountCustomer})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("move: status %d body %s", res.StatusCode, raw)
	}
	moved := list("?q=kind-aud-1@test.dev")["kind-aud-1@test.dev"]
	if moved.AccountKind != types.AccountCustomer || moved.CanHost {
		t.Fatalf("after move = %+v, want a customer still without hosting", moved)
	}
	var setBy string
	if err := h.store.Pool().QueryRow(t.Context(),
		`SELECT coalesce(account_kind_set_by::text, '') FROM users WHERE id = $1::uuid`, aud.ID).Scan(&setBy); err != nil {
		t.Fatal(err)
	}
	if setBy == "" {
		t.Error("a manual move did not record who made it")
	}
	if res, _ := h.do(http.MethodPatch, "/api/admin/users/"+aud.ID+"/kind",
		map[string]string{"kind": "vip"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("bad kind move: status %d, want 422", res.StatusCode)
	}
	if after := counts(); after.Audience != before.Audience-1 || after.Customers != before.Customers+1 {
		t.Errorf("counts %+v -> %+v, want one moved from audience to customers", before, after)
	}

	// Hosting and a plan each make an audience account a customer.
	for email, grant := range map[string]func(id string){
		"kind-aud-2@test.dev": func(id string) {
			if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+id+"/host",
				types.HostGrant{CanHost: true}); res.StatusCode != http.StatusOK {
				t.Fatalf("grant host: status %d body %s", res.StatusCode, raw)
			}
		},
		"kind-aud-3@test.dev": func(id string) {
			if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+id+"/plan",
				types.SetUserPlanRequest{Plan: types.PlanProfessional}); res.StatusCode != http.StatusOK {
				t.Fatalf("set plan: status %d body %s", res.StatusCode, raw)
			}
		},
	} {
		u, err := h.store.UserByEmail(t.Context(), email)
		if err != nil {
			t.Fatal(err)
		}
		grant(u.ID)
		if k := kindOf(t, h, email); k != types.AccountCustomer {
			t.Errorf("%s after the grant = %q, want customer", email, k)
		}
	}
}

/* The migration's backfill, run on rows shaped like the ones that existed before
 * account_kind: only a passwordless account that its first registration made is
 * audience. */
func TestAccountKindBackfillRule(t *testing.T) {
	raw, err := os.ReadFile("../store/migrations/0109_account_kind.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	start := strings.Index(sql, "UPDATE users u")
	end := strings.Index(sql[start:], ";")
	if start < 0 || end < 0 {
		t.Fatal("backfill UPDATE not found in the migration")
	}
	backfill := sql[start : start+end]

	h := newHarness(t)
	ctx := t.Context()
	db := h.store.Pool()
	seed := map[string]string{
		// email → how the row is reshaped after registering
		"bf-audience@test.dev": `UPDATE users SET password_hash = '', created_at = now() - interval '1 hour' WHERE lower(email) = $1`,
		"bf-password@test.dev": `UPDATE users SET password_hash = 'x', created_at = now() - interval '1 hour' WHERE lower(email) = $1`,
		"bf-host@test.dev":     `UPDATE users SET password_hash = '', can_host = true, created_at = now() - interval '1 hour' WHERE lower(email) = $1`,
		"bf-old@test.dev":      `UPDATE users SET password_hash = '', created_at = now() - interval '3 days' WHERE lower(email) = $1`,
	}
	for email, reshape := range seed {
		h.registerAs("scaling-webrtc-10k", email)
		if _, err := db.Exec(ctx, reshape, email); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `
			UPDATE registrations SET created_at = now() - interval '1 hour' + interval '30 seconds'
			 WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1)`, email); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(ctx, `UPDATE users SET account_kind = 'customer' WHERE email LIKE 'bf-%'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, backfill); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	for email, want := range map[string]types.AccountKind{
		"bf-audience@test.dev": types.AccountAudience,
		"bf-password@test.dev": types.AccountCustomer,
		"bf-host@test.dev":     types.AccountCustomer,
		"bf-old@test.dev":      types.AccountCustomer,
	} {
		if got := kindOf(t, h, email); got != want {
			t.Errorf("%s backfilled to %q, want %q", email, got, want)
		}
	}
}
