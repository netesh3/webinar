package api_test

/* Hosting is granted automatically at signup now, and only an admin takes it away.
 *
 * This used to be the other way around — hosting was an admin-only grant, and neither
 * of these requests could produce one:
 *
 *   POST /api/auth/signup  {"wantsHost": true}
 *   PATCH /api/auth/me          {"wantsHost": true}
 *
 * Signup grants hosting unconditionally now, whatever wantsHost says — see handleSignup.
 * PATCH /api/auth/me still cannot grant it after the fact, which is the one piece of the
 * old policy that stayed: an admin's SetHostCapability is still the only way hosting is
 * ever taken away, and self-service can't hand it back once it's gone. wantsHost is kept
 * on the wire, accepted and ignored either way, so an older cached bundle keeps working.
 */

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// TestSignupGrantsHosting: every new account can host immediately, whatever
// wantsHost said — the field is accepted and ignored, not honoured.
func TestSignupGrantsHosting(t *testing.T) {
	h := newHarness(t)

	res, raw := h.do(http.MethodPost, "/api/auth/signup", map[string]any{
		"name":      "New Host",
		"email":     "newhost@test.dev",
		"password":  "a-long-enough-password",
		"wantsHost": false,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)

	if !acct.CanHost {
		t.Error("signup did not grant the hosting capability")
	}
	if acct.IsAdmin {
		t.Error("signup produced an admin")
	}

	// And the capability actually works, not merely present in the response.
	res, raw = h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "A brand new host's first webinar", "startsAt": soon(), "durationMin": 30,
		"status": "scheduled",
	})
	if res.StatusCode != http.StatusCreated {
		t.Errorf("creating a webinar: status %d body %s, want 201", res.StatusCode, raw)
	}
}

// TestAdminCanRevokeHostingAfterSignup: the safety valve signup's automatic
// grant needs, now that it can't be withheld in the first place.
func TestAdminCanRevokeHostingAfterSignup(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Revocable Host", "revocable@test.dev", true)
	if !acct.CanHost {
		t.Fatal("fixture setup: signup did not grant hosting")
	}

	if _, err := h.store.SetHostCapability(context.Background(), acct.ID, false); err != nil {
		t.Fatalf("revoke hosting: %v", err)
	}

	// authenticate() re-reads the account on every request, so the very next
	// call already sees the revoked capability with no re-login needed.
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Should not exist", "startsAt": soon(), "durationMin": 30,
		"status": "scheduled",
	})
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("creating a webinar after revoke: status %d body %s, want 403", res.StatusCode, raw)
	}
}

// TestProfilePatchCannotGrantHosting: the old self-service toggle is inert too.
func TestProfilePatchCannotGrantHosting(t *testing.T) {
	h := newHarness(t)
	h.signup("Patcher", "patcher@test.dev", false)

	res, raw := h.do(http.MethodPatch, "/api/auth/me", map[string]any{"wantsHost": true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.CanHost {
		t.Fatal("PATCH /api/auth/me with wantsHost:true granted the hosting capability")
	}

	/* The same request must still save what it was actually for.
	 *
	 * The field is ignored rather than rejected precisely so an older bundle's profile form
	 * keeps working. If ignoring it had been implemented as a 422 the whole form would fail,
	 * and somebody changing their job title would be told their name was invalid. */
	res, raw = h.do(http.MethodPatch, "/api/auth/me",
		map[string]any{"name": "Renamed Patcher", "wantsHost": true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch with a real change: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &acct)
	if acct.Name != "Renamed Patcher" {
		t.Errorf("name = %q; the ignored field broke the rest of the patch", acct.Name)
	}
	if acct.CanHost {
		t.Error("hosting granted on the second attempt")
	}
}

// TestNonAdminCannotReachAdminEndpoints.
func TestNonAdminCannotReachAdminEndpoints(t *testing.T) {
	h := newHarness(t)

	// A host — the most privileged non-admin there is — still cannot administer.
	h.login("neeraj@acme.dev")
	for _, ep := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/users"},
		{http.MethodPatch, "/api/admin/users/00000000-0000-0000-0000-000000000000/host"},
	} {
		res, raw := h.do(ep.method, ep.path, map[string]any{"canHost": true})
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s as a host: status %d body %s, want 403",
				ep.method, ep.path, res.StatusCode, raw)
		}
	}

	// And anonymously.
	h2 := newHarness(t)
	res, raw := h2.do(http.MethodGet, "/api/admin/users", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("anonymous: status %d body %s, want 401", res.StatusCode, raw)
	}
}

/* TestAdminGrantsAndRevokesHosting is the happy path, and the only path.
 *
 * The admin is made by PromoteAdmins from a config list, not by an endpoint — which is the
 * whole design. If this test could create an admin through the API, the privilege boundary
 * would not exist.
 */
func TestAdminGrantsAndRevokesHosting(t *testing.T) {
	h := newHarness(t)

	// A plain account, created through the public form, with no capability.
	h.signup("Coach Hopeful", "coach@test.dev", false)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Before the grant", "startsAt": soon(), "durationMin": 30, "status": "scheduled",
	})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("pre-grant create: status %d body %s, want 403", res.StatusCode, raw)
	}

	// Promote an operator out of band, exactly as boot does from ADMIN_EMAILS.
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodGet, "/api/admin/users?q=coach@test.dev", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin users: status %d body %s", res.StatusCode, raw)
	}
	var users []types.AdminUser
	h.decode(raw, &users)
	if len(users) != 1 {
		t.Fatalf("search returned %d rows, want 1: %s", len(users), raw)
	}
	target := users[0]
	if target.CanHost {
		t.Fatal("the account already has hosting; the grant below would prove nothing")
	}

	// Grant.
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/host",
		types.HostGrant{CanHost: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("grant: status %d body %s", res.StatusCode, raw)
	}
	var granted types.Account
	h.decode(raw, &granted)
	if !granted.CanHost {
		t.Fatal("grant returned an account that still cannot host")
	}

	// The grantee can now host, for real.
	h.login("coach@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "After the grant", "startsAt": soon(), "durationMin": 30, "status": "scheduled",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("post-grant create: status %d body %s, want 201", res.StatusCode, raw)
	}

	// Revoke, and it takes effect.
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/host",
		types.HostGrant{CanHost: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke: status %d body %s", res.StatusCode, raw)
	}

	h.login("coach@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "After the revoke", "startsAt": soon(), "durationMin": 30, "status": "scheduled",
	})
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("post-revoke create: status %d body %s, want 403", res.StatusCode, raw)
	}
}

/* TestAdminCannotRevokeTheirOwnHosting.
 *
 * The only lockout in the admin panel that cannot be undone from inside the app: the toggle you
 * would use to restore it is the one you just switched off. Recovery means an operator editing
 * the database by hand, so it is refused.
 */
func TestAdminCannotRevokeTheirOwnHosting(t *testing.T) {
	h := newHarness(t)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")

	res, raw := h.do(http.MethodGet, "/api/admin/users?q=neeraj@acme.dev", nil)
	var users []types.AdminUser
	h.decode(raw, &users)
	if len(users) == 0 {
		t.Fatalf("admin cannot find their own account: %s", raw)
	}
	me := users[0]
	if !me.IsAdmin {
		t.Fatalf("PromoteAdmins did not take: %+v", me)
	}

	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+me.ID+"/host",
		types.HostGrant{CanHost: false})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("self-revoke: status %d body %s, want 422", res.StatusCode, raw)
	}
}

/* TestPromoteAdminsReconcilesBothWays.
 *
 * An address removed from ADMIN_EMAILS must lose the privilege on the next restart. A one-way
 * promote would mean a departing admin keeps it indefinitely, because there is deliberately no
 * endpoint that takes it away.
 */
func TestPromoteAdminsReconcilesBothWays(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()

	if _, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev", "priya@acme.dev"}); err != nil {
		t.Fatalf("promote: %v", err)
	}
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/users", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin users: status %d body %s", res.StatusCode, raw)
	}
	var users []types.AdminUser
	h.decode(raw, &users)
	admins := 0
	for _, u := range users {
		if u.IsAdmin {
			admins++
		}
	}
	if admins != 2 {
		t.Fatalf("%d admins after promoting two: %s", admins, raw)
	}

	// Drop one from the list.
	if _, demoted, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("reconcile: %v", err)
	} else if demoted != 1 {
		t.Errorf("demoted = %d, want 1", demoted)
	}

	// Priya is no longer an admin, and cannot administer.
	h.login("priya@acme.dev")
	res, raw = h.do(http.MethodGet, "/api/admin/users", nil)
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("demoted admin: status %d body %s, want 403", res.StatusCode, raw)
	}

	// An email matching no account is ignored rather than failing the boot.
	if _, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev", "ghost@nowhere.invalid"}); err != nil {
		t.Errorf("an unknown admin email must not error: %v", err)
	}
}

/* TestRefusalTellsThemWhatToDo.
 *
 * The old copy said "Turn hosting on in your account settings", which became a lie the moment
 * the toggle was removed. Copy that instructs somebody to do an impossible thing costs more
 * support time than a bare refusal.
 */
func TestRefusalTellsThemWhatToDo(t *testing.T) {
	h := newHarness(t)
	h.signup("Plain User", "plain@test.dev", false)

	_, raw := h.do(http.MethodGet, "/api/host/webinars", nil)
	body := string(raw)
	if strings.Contains(strings.ToLower(body), "account settings") {
		t.Errorf("the refusal still points at a setting that no longer exists: %s", body)
	}
	if !strings.Contains(strings.ToLower(body), "administrator") {
		t.Errorf("the refusal does not say who can grant access: %s", body)
	}
}

/*
	The DEFAULT state on a deployment that has not set ADMIN_EMAILS yet. An empty list must

reconcile cleanly rather than erroring on Postgres array type inference — this runs at every
boot, so an error here would mean the admin set silently never reconciles.
*/
func TestPromoteAdminsWithNoConfigDoesNotError(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()

	if _, _, err := h.store.PromoteAdmins(ctx, nil); err != nil {
		t.Fatalf("nil list: %v", err)
	}
	if _, _, err := h.store.PromoteAdmins(ctx, []string{}); err != nil {
		t.Fatalf("empty slice: %v", err)
	}
	// And blank entries, which is what ADMIN_EMAILS="" or "a,,b" produces after splitting.
	if _, _, err := h.store.PromoteAdmins(ctx, []string{"", "  "}); err != nil {
		t.Fatalf("blank entries: %v", err)
	}

	// Promote, then reconcile to empty: the admin must actually be demoted.
	if p, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil || p != 1 {
		t.Fatalf("promote: p=%d err=%v", p, err)
	}
	if _, d, err := h.store.PromoteAdmins(ctx, nil); err != nil {
		t.Fatalf("demote to empty: %v", err)
	} else if d != 1 {
		t.Errorf("demoted = %d, want 1 — an emptied config must clear the admin set", d)
	}
}

/* The admin bootstrap: create if missing, never touch what exists.
 *
 * ADMIN_EMAILS alone could only promote an account that already existed, so a fresh database —
 * or one that has just been cleared — named somebody who had to sign up through the public form
 * before they could administer anything. EnsureAdminAccount closes that, and runs on every boot
 * rather than in a migration: a migration is recorded once, so an admin deleted afterwards would
 * never come back.
 */
func TestAdminAccountIsCreatedWhenMissing(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()

	hash, err := auth.HashPassword("bootstrap-password-1234")
	if err != nil {
		t.Fatal(err)
	}
	const email = "bootstrap-admin@test.dev"

	created, err := h.store.EnsureAdminAccount(ctx, email, store.NameFromEmail(email), hash)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if !created {
		t.Fatal("reported no creation on an empty database")
	}

	// Idempotent: a second boot must not create a duplicate or report one.
	again, err := h.store.EnsureAdminAccount(ctx, email, store.NameFromEmail(email), hash)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if again {
		t.Error("reported creating an account that already existed")
	}

	// Created WITHOUT privileges; PromoteAdmins is the single writer of those two columns.
	if _, _, err := h.store.PromoteAdmins(ctx, []string{email}); err != nil {
		t.Fatalf("promote: %v", err)
	}

	// And the whole point: the created account can actually sign in and administer.
	res, raw := h.do(http.MethodPost, "/api/auth/login",
		map[string]string{"email": email, "password": "bootstrap-password-1234"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login as the bootstrapped admin: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if !acct.IsAdmin || !acct.CanHost {
		t.Errorf("bootstrapped admin has isAdmin=%v canHost=%v, want both true",
			acct.IsAdmin, acct.CanHost)
	}
	if res, raw := h.do(http.MethodGet, "/api/admin/users", nil); res.StatusCode != http.StatusOK {
		t.Errorf("admin endpoint: status %d body %s", res.StatusCode, raw)
	}
}

/* TestBootstrapNeverOverwritesAnExistingPassword.
 *
 * This is the assertion that keeps ADMIN_PASSWORD a bootstrap value instead of a back door. If
 * the boot path ever "ensured" by UPDATE rather than INSERT, an admin who rotated their password
 * would have it silently reverted on the next deploy — and anybody holding the environment
 * variable would have permanent access to a live account.
 */
func TestBootstrapNeverOverwritesAnExistingPassword(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()

	// An account already exists with a password of its own, created the normal way.
	const email = "rotated@test.dev"
	h.signup("Rotated", email, false)

	other, err := auth.HashPassword("a-completely-different-password")
	if err != nil {
		t.Fatal(err)
	}
	created, err := h.store.EnsureAdminAccount(ctx, email, "Someone Else", other)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if created {
		t.Fatal("created an account that already existed")
	}

	// The original password still works…
	res, raw := h.do(http.MethodPost, "/api/auth/login",
		map[string]string{"email": email, "password": "webcast-dev"})
	if res.StatusCode != http.StatusOK {
		t.Errorf("the original password stopped working: status %d body %s", res.StatusCode, raw)
	}
	// …and the environment's password does not.
	res, raw = h.do(http.MethodPost, "/api/auth/login",
		map[string]string{"email": email, "password": "a-completely-different-password"})
	if res.StatusCode == http.StatusOK {
		t.Errorf("ADMIN_PASSWORD signed in to an existing account — that is a back door: %s", raw)
	}
}

func TestNameFromEmail(t *testing.T) {
	for in, want := range map[string]string{
		"admin@gmail.com":       "Admin",
		"neeraj.kumar@acme.dev": "Neeraj Kumar",
		"first_last@x.io":       "First Last",
		"a-b@x.io":              "A B",
		"ops+webinars@x.io":     "Ops Webinars",
		"@nothing.dev":          "Administrator",
	} {
		if got := store.NameFromEmail(in); got != want {
			t.Errorf("NameFromEmail(%q) = %q, want %q", in, got, want)
		}
	}
}
