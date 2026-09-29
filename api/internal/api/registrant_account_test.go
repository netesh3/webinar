package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Registering for a webinar is an account, and the join link waits on the
 * same email verification link as signup.
 *
 * A new address shows up in the admin Accounts list with hosting off and the
 * email unverified. A second registration for that address does not create
 * another user. Opening the link finishes the registration and sends the
 * join link. An address that was already verified skips the link.
 */
func TestRegistrantBecomesAccountAfterEmailVerification(t *testing.T) {
	h := newHarness(t)
	h.holdVerification = true
	h.goLive("simulive-playbook")
	h.goLive("scaling-webrtc-10k")

	const email = "registrant@test.dev"
	res, raw := h.do(http.MethodPost, "/api/webinars/simulive-playbook/register", types.RegisterRequest{
		FirstName: "Rina", LastName: "Shah", Email: email, Consent: true,
		Company: "Northwind", JobTitle: "Analyst",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("registration signed the attendee in")
	}
	var held types.Registration
	h.decode(raw, &held)
	if held.JoinKey != "" || held.State != types.RegUnverified || !held.NeedsEmailVerification {
		t.Fatalf("registration response = %+v, want no join key and a verify prompt", held)
	}
	if !strings.Contains(strings.ToLower(held.Message), "email") {
		t.Fatalf("message = %q, want it to say to check email", held.Message)
	}

	var (
		users    int
		canHost  bool
		verified bool
		state    string
		joinKey  string
	)
	err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM users WHERE lower(email) = lower($1)`, email).Scan(&users)
	if err != nil || users != 1 {
		t.Fatalf("users for %s = %d (%v), want 1", email, users, err)
	}
	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT can_host, email_verified_at IS NOT NULL
		  FROM users WHERE lower(email) = lower($1)`, email).Scan(&canHost, &verified)
	if err != nil {
		t.Fatal(err)
	}
	if canHost || verified {
		t.Fatalf("new attendee canHost=%v verified=%v, want both false", canHost, verified)
	}
	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT r.state, r.join_key
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = 'simulive-playbook' AND lower(r.email) = lower($1)`, email).Scan(&state, &joinKey)
	if err != nil {
		t.Fatal(err)
	}
	if state != string(types.RegUnverified) || joinKey == "" {
		t.Fatalf("stored registration state=%s key=%q", state, joinKey)
	}

	// The key exists in the database and still does not open the room.
	res, raw = h.do(http.MethodPost, "/api/webinars/simulive-playbook/join", types.JoinRequest{JoinKey: joinKey})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("join before verify: status %d body %s, want 403", res.StatusCode, raw)
	}

	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodGet, "/api/admin/users?q="+email, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin users: status %d body %s", res.StatusCode, raw)
	}
	var listed []types.AdminUser
	h.decode(raw, &listed)
	if len(listed) != 1 || listed[0].Email != email || listed[0].Name != "Rina Shah" ||
		listed[0].CanHost || listed[0].EmailVerified || listed[0].IsAdmin {
		t.Fatalf("accounts list = %+v", listed)
	}
	h.logout()

	var confirmedBefore int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM notifications
		 WHERE kind = 'registration_confirmed' AND email = $1`, email).Scan(&confirmedBefore); err != nil {
		t.Fatal(err)
	}
	if confirmedBefore != 0 {
		t.Fatalf("confirmation mails before verify = %d", confirmedBefore)
	}

	token := h.latestVerifyToken(email)
	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: token})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("verify: status %d body %s", res.StatusCode, raw)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("verification signed the attendee in")
	}

	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT can_host, email_verified_at IS NOT NULL FROM users WHERE lower(email) = lower($1)`,
		email).Scan(&canHost, &verified)
	if err != nil {
		t.Fatal(err)
	}
	if canHost || !verified {
		t.Fatalf("after verify canHost=%v verified=%v", canHost, verified)
	}
	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT r.state FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = 'simulive-playbook' AND lower(r.email) = lower($1)`, email).Scan(&state)
	if err != nil || state != string(types.RegApproved) {
		t.Fatalf("state after verify = %s (%v), want approved", state, err)
	}

	var body string
	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT body FROM notifications
		 WHERE kind = 'registration_confirmed' AND email = $1
		 ORDER BY created_at DESC LIMIT 1`, email).Scan(&body)
	if err != nil {
		t.Fatalf("confirmation mail: %v", err)
	}
	if !strings.Contains(body, joinKey) {
		t.Fatal("confirmation mail did not carry the join link")
	}

	res, raw = h.do(http.MethodPost, "/api/webinars/simulive-playbook/join", types.JoinRequest{JoinKey: joinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join after verify: status %d body %s", res.StatusCode, raw)
	}

	// Same address, another webinar: already verified, so this one completes
	// immediately and does not create a second account.
	res, raw = h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/register", types.RegisterRequest{
		FirstName: "Rina", LastName: "Shah", Email: "Registrant@test.dev", Consent: true,
		Passcode: seedPasscode, Phone: testPhone,
		Answers: h.validAnswers("scaling-webrtc-10k"),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("second register: status %d body %s", res.StatusCode, raw)
	}
	var second types.Registration
	h.decode(raw, &second)
	if second.State != types.RegApproved || second.JoinKey == "" || second.NeedsEmailVerification {
		t.Fatalf("verified user was asked to verify again: %+v", second)
	}
	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM users WHERE lower(email) = lower($1)`, email).Scan(&users)
	if err != nil || users != 1 {
		t.Fatalf("users after second webinar = %d (%v), want 1", users, err)
	}
	var verifyMails int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM notifications WHERE kind = 'email_verify' AND email = $1`, email).Scan(&verifyMails); err != nil {
		t.Fatal(err)
	}
	if verifyMails != 1 {
		t.Fatalf("verification mails = %d, want 1", verifyMails)
	}

	// An account that already existed keeps its hosting flag and is not duplicated.
	res, raw = h.do(http.MethodPost, "/api/webinars/simulive-playbook/register", types.RegisterRequest{
		FirstName: "Neeraj", LastName: "Kumar", Email: "neeraj@acme.dev", Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("existing account register: status %d body %s", res.StatusCode, raw)
	}
	var hostReg types.Registration
	h.decode(raw, &hostReg)
	if hostReg.JoinKey == "" || hostReg.State != types.RegApproved {
		t.Fatalf("already-verified host was held back: %+v", hostReg)
	}
	err = h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*), bool_or(can_host) FROM users WHERE lower(email) = 'neeraj@acme.dev'`).Scan(&users, &canHost)
	if err != nil || users != 1 || !canHost {
		t.Fatalf("existing host users=%d canHost=%v err=%v", users, canHost, err)
	}
}
