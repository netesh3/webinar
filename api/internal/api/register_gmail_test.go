package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

const gmailWebinar = "simulive-playbook"

func registerBody(email string) types.RegisterRequest {
	return types.RegisterRequest{
		FirstName: "Rina", LastName: "Shah", Email: email, Consent: true,
	}
}

func countRows(t *testing.T, h *harness, query, email string) int {
	t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), query, email).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

/* Anonymous Gmail on a public webinar link is sent to Google.
 *
 * Nothing is written first. Any other domain still gets the existing
 * verification mail and an unverified registration. A signed-in Gmail
 * account registers in place, including one that already has a seat.
 */
func TestRegisterGmailVersusOtherEmail(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)
	h.holdVerification = true

	res, raw := h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody("Ada@Gmail.com"))
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("gmail: status %d body %s", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if apiErr.Error != "google_signin_required" {
		t.Fatalf("code %q message %q", apiErr.Error, apiErr.Message)
	}
	if countRows(t, h, `SELECT count(*) FROM users WHERE lower(email) = lower($1)`, "ada@gmail.com") != 0 {
		t.Fatal("gmail redirect created a user")
	}
	if countRows(t, h, `
		SELECT count(*) FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND lower(r.email) = 'ada@gmail.com'`, gmailWebinar) != 0 {
		t.Fatal("gmail redirect created a registration")
	}

	const other = "rina@company.test"
	res, raw = h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody(other))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("other: status %d body %s", res.StatusCode, raw)
	}
	var held types.Registration
	h.decode(raw, &held)
	if held.State != types.RegUnverified || held.JoinKey != "" || !held.NeedsEmailVerification {
		t.Fatalf("other registration = %+v", held)
	}
	if countRows(t, h, `
		SELECT count(*) FROM notifications WHERE kind = 'email_verify' AND email = $1`, other) != 1 {
		t.Fatal("other domain did not get the verification mail")
	}

	// Lookalike domains stay on the mail path.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody("ada@gmail.com.evil"))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("lookalike: status %d body %s", res.StatusCode, raw)
	}

	acct := h.signup("Ada Google", "ada@gmail.com", false)
	res, raw = h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody("ada@gmail.com"))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signed-in gmail: status %d body %s", res.StatusCode, raw)
	}
	var done types.Registration
	h.decode(raw, &done)
	if done.State != types.RegApproved || done.JoinKey == "" || done.NeedsEmailVerification {
		t.Fatalf("signed-in registration = %+v", done)
	}
	if done.Email != acct.Email {
		t.Fatalf("registration email %q", done.Email)
	}

	h.logout()
	res, raw = h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody("ada@gmail.com"))
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("anonymous return: status %d body %s", res.StatusCode, raw)
	}
	if countRows(t, h, `
		SELECT count(*) FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND lower(r.email) = 'ada@gmail.com'`, gmailWebinar) != 1 {
		t.Fatal("anonymous gmail post changed the existing registration")
	}

	res, raw = h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseToken(t, "ada@gmail.com", "Ada Google"),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("google return: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody("ada@gmail.com"))
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("finish after google: status %d body %s", res.StatusCode, raw)
	}
	var again types.Registration
	h.decode(raw, &again)
	if again.JoinKey == "" || again.State != types.RegApproved || again.ID != done.ID {
		t.Fatalf("finished registration = %+v, want the same seat %s", again, done.ID)
	}
}

func TestRegisterGmailUsesEmailVerifyWhenGoogleAuthOff(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) {
		cfg.SupabaseURL = ""
		cfg.SupabaseAnonKey = ""
	})
	h.holdVerification = true
	res, raw := h.do(http.MethodPost, "/api/webinars/"+gmailWebinar+"/register", registerBody("ada@gmail.com"))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("status %d body %s", res.StatusCode, raw)
	}
	var held types.Registration
	h.decode(raw, &held)
	if held.State != types.RegUnverified || !held.NeedsEmailVerification {
		t.Fatalf("registration = %+v", held)
	}
}
