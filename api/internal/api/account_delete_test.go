package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/types"
)

// putFile writes a file into the harness media store under key.
func putFile(t *testing.T, h *harness, key string) string {
	t.Helper()
	full := filepath.Join(h.recordingsDir, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	return full
}

func goneAt(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("%s still on disk (err %v)", path, err)
	}
}

func deleteAccount(t *testing.T, h *harness, body types.DeleteAccountRequest) (int, string) {
	t.Helper()
	res, raw := h.do(http.MethodDelete, "/api/auth/account", body)
	return res.StatusCode, errorCode(t, raw)
}

/* Deleting your own account takes its webinars, its avatar and its WhatsApp media
 * with it, signs it out, and keeps its payment records unlinked. A payment that
 * arrives afterwards for one of its orders is recorded and grants nothing. */
func TestDeletingYourAccountErasesItButKeepsPayments(t *testing.T) {
	h, _ := billingHarness(t)
	acct := h.signup("Leaving Host", "leaving@test.dev", true)
	wb := h.newWebinar("Goodbye session", nil)

	paid := h.buy("professional", billing.Monthly, billing.USD)
	if res := h.webhook("order.paid", paid.OrderID, "pay_leave_1", paid.Amount, "USD"); res.StatusCode != http.StatusOK {
		t.Fatalf("pay: %d", res.StatusCode)
	}
	pending := h.buy("business", billing.Monthly, billing.USD)

	avatarKey := "avatars/" + acct.ID + "/photo.png"
	avatar := putFile(t, h, avatarKey)
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE users SET avatar_storage_key = $2 WHERE id = $1::uuid`, acct.ID, avatarKey); err != nil {
		t.Fatal(err)
	}
	waFile := putFile(t, h, "wa/"+acct.ID+"/some-message")

	if code, ec := deleteAccount(t, h, types.DeleteAccountRequest{Password: "not-it"}); code != http.StatusUnauthorized || ec != "wrong_password" {
		t.Fatalf("wrong password: %d %s", code, ec)
	}
	if code, ec := deleteAccount(t, h, types.DeleteAccountRequest{Password: "webcast-dev"}); code != http.StatusOK {
		t.Fatalf("delete: %d %s", code, ec)
	}

	if res, _ := h.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("after delete /auth/me = %d, want 401: the session must be gone", res.StatusCode)
	}
	db := h.store.Pool()
	var users, webinars int
	_ = db.QueryRow(t.Context(), `SELECT count(*) FROM users WHERE id = $1::uuid`, acct.ID).Scan(&users)
	_ = db.QueryRow(t.Context(), `SELECT count(*) FROM webinars WHERE slug = $1`, wb.ID).Scan(&webinars)
	if users != 0 || webinars != 0 {
		t.Errorf("rows left: users %d webinars %d", users, webinars)
	}
	goneAt(t, avatar)
	goneAt(t, waFile)

	var kept int
	if err := db.QueryRow(t.Context(), `
		SELECT count(*) FROM billing_orders
		 WHERE razorpay_order_id = ANY($1) AND user_id IS NULL`,
		[]string{paid.OrderID, pending.OrderID}).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != 2 {
		t.Fatalf("billing orders kept unlinked = %d, want 2", kept)
	}

	if res := h.webhook("order.paid", pending.OrderID, "pay_leave_2", pending.Amount, "USD"); res.StatusCode != http.StatusOK {
		t.Fatalf("webhook for a deleted account's order: %d, want 200", res.StatusCode)
	}
	var status string
	if err := db.QueryRow(t.Context(),
		`SELECT status FROM billing_orders WHERE razorpay_order_id = $1`, pending.OrderID).Scan(&status); err != nil || status != "paid" {
		t.Fatalf("late payment: status %q err %v, want recorded as paid", status, err)
	}
}

// A Google-only account has no password; it confirms with its email instead.
func TestGoogleOnlyAccountConfirmsWithItsEmail(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Google Person", "google-only@test.dev", false)
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE users SET password_hash = NULL WHERE id = $1::uuid`, acct.ID); err != nil {
		t.Fatal(err)
	}
	if code, ec := deleteAccount(t, h, types.DeleteAccountRequest{Email: "someone-else@test.dev"}); code != http.StatusUnprocessableEntity || ec != "email_mismatch" {
		t.Fatalf("wrong email: %d %s", code, ec)
	}
	if code, ec := deleteAccount(t, h, types.DeleteAccountRequest{Email: "  Google-Only@test.dev "}); code != http.StatusOK {
		t.Fatalf("delete: %d %s", code, ec)
	}
}

// Refused while a webinar is live, and for an admin that ADMIN_EMAILS would re-create.
func TestAccountDeletionRefusals(t *testing.T) {
	h := newHarness(t)
	h.signup("Live Host", "live-leaver@test.dev", true)
	wb := h.newWebinar("Live right now", nil)
	h.goLive(wb.ID)
	if code, ec := deleteAccount(t, h, types.DeleteAccountRequest{Password: "webcast-dev"}); code != http.StatusConflict || ec != "webinar_live" {
		t.Fatalf("while live: %d %s, want 409 webinar_live", code, ec)
	}

	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	if code, ec := deleteAccount(t, h, types.DeleteAccountRequest{Password: "webcast-dev"}); code != http.StatusConflict || ec != "admin_account" {
		t.Fatalf("admin: %d %s, want 409 admin_account", code, ec)
	}
}

// An admin deleting an account removes its files too.
func TestAdminDeleteRemovesTheAccountsFiles(t *testing.T) {
	h := newHarness(t)
	target := h.signup("Removed Person", "removed@test.dev", false)
	avatarKey := "avatars/" + target.ID + "/photo.png"
	avatar := putFile(t, h, avatarKey)
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE users SET avatar_storage_key = $2 WHERE id = $1::uuid`, target.ID, avatarKey); err != nil {
		t.Fatal(err)
	}
	waFile := putFile(t, h, "wa/"+target.ID+"/a-message")

	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodDelete, "/api/admin/users/"+target.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("admin delete: %d %s", res.StatusCode, raw)
	}
	goneAt(t, avatar)
	goneAt(t, waFile)
}
