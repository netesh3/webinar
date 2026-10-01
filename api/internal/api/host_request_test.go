package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

func TestHostRequest(t *testing.T) {
	h := newHarness(t)
	mail := &fakeMail{}
	h.server.UseMail(mail)

	ada := h.signup("Ada Lovelace", "ada.hostreq@test.dev", false)
	if ada.CanHost || ada.Phone != "" || ada.HostRequestedAt != "" {
		t.Fatalf("new account = canHost %v phone %q requested %q", ada.CanHost, ada.Phone, ada.HostRequestedAt)
	}

	res, raw := h.do(http.MethodPost, "/api/me/host-request", types.HostRequest{})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("missing phone: status %d body %s", res.StatusCode, raw)
	}
	var bad types.APIError
	h.decode(raw, &bad)
	if bad.Fields["phone"] == "" {
		t.Fatalf("missing phone field error: %+v", bad)
	}

	res, raw = h.do(http.MethodPost, "/api/me/host-request", types.HostRequest{Phone: "12345"})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("short phone: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/me/host-request", types.HostRequest{Phone: "+91 98765 43210"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("request: status %d body %s", res.StatusCode, raw)
	}
	var got types.Account
	h.decode(raw, &got)
	if got.CanHost {
		t.Fatal("the request granted hosting")
	}
	if got.Phone != "+919876543210" {
		t.Errorf("phone = %q, want the saved E.164 number", got.Phone)
	}
	if got.HostRequestedAt == "" {
		t.Fatal("hostRequestedAt was not recorded")
	}
	assertHostRequestRow(t, h, ada.ID, "+919876543210", true)

	notes := hostRequestMail(mail)
	if len(notes) != 1 {
		t.Fatalf("emails = %d, want 1", len(notes))
	}
	m := notes[0]
	if m.To != notify.HostRequestRecipient {
		t.Errorf("to = %q", m.To)
	}
	if m.ReplyTo != "ada.hostreq@test.dev" {
		t.Errorf("reply-to = %q", m.ReplyTo)
	}
	for _, part := range []string{m.Subject, m.Body} {
		for _, want := range []string{
			"Ada Lovelace", "ada.hostreq@test.dev", "+919876543210", ada.ID, "requested hosting",
		} {
			if !strings.Contains(part, want) {
				t.Errorf("missing %q in:\n%s", want, part)
			}
		}
	}

	res, raw = h.do(http.MethodPost, "/api/me/host-request", types.HostRequest{Phone: "+919876543210"})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("second request: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &bad)
	if bad.Error != "host_request_exists" || !strings.Contains(bad.Message, "already in") {
		t.Fatalf("second request body: %+v", bad)
	}
	if n := len(hostRequestMail(mail)); n != 1 {
		t.Fatalf("after a second request: emails = %d, want still 1", n)
	}

	// An account that already has a phone is not asked again, and that number
	// is the one in the email — a different number on the request is ignored.
	grace := signupWithPhone(h, "Grace Hopper", "grace.hostreq@test.dev", "+1 (202) 555-0143")
	res, raw = h.do(http.MethodPost, "/api/me/host-request", types.HostRequest{Phone: "+919999999999"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("existing phone: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &got)
	if got.Phone != "+12025550143" {
		t.Errorf("phone = %q, want the number already on the account", got.Phone)
	}
	if got.CanHost || got.HostRequestedAt == "" {
		t.Fatalf("grace after request: canHost %v requested %q", got.CanHost, got.HostRequestedAt)
	}
	notes = hostRequestMail(mail)
	if len(notes) != 2 {
		t.Fatalf("emails = %d, want 2", len(notes))
	}
	if !strings.Contains(notes[1].Body, "+12025550143") || strings.Contains(notes[1].Body, "+919999999999") {
		t.Errorf("email did not reuse the stored phone:\n%s", notes[1].Body)
	}
	if !strings.Contains(notes[1].Subject, grace.ID) || notes[1].ReplyTo != "grace.hostreq@test.dev" {
		t.Errorf("grace email: to-reply %q subject %q", notes[1].ReplyTo, notes[1].Subject)
	}

	host := h.signup("Host Ada", "host.already@test.dev", true)
	res, raw = h.do(http.MethodPost, "/api/me/host-request", types.HostRequest{})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("host request: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &bad)
	if bad.Error != "already_host" {
		t.Fatalf("host refusal: %+v", bad)
	}
	if n := len(hostRequestMail(mail)); n != 2 {
		t.Fatalf("a host's request sent email: count %d", n)
	}
	assertHostRequestRow(t, h, host.ID, "", false)
}

func hostRequestMail(mail *fakeMail) []notify.Message {
	mail.mu.Lock()
	defer mail.mu.Unlock()
	var out []notify.Message
	for _, m := range mail.sent {
		if m.To == notify.HostRequestRecipient {
			out = append(out, m)
		}
	}
	return out
}

func signupWithPhone(h *harness, name, email, phone string) types.Account {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: name, Email: email, Password: "webcast-dev", Phone: phone,
	})
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("signup %s: status %d body %s", email, res.StatusCode, raw)
	}
	if err := h.store.MarkEmailVerifiedByEmail(context.Background(), email); err != nil {
		h.t.Fatalf("verify %s: %v", email, err)
	}
	h.login(email)
	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("me %s: status %d body %s", email, res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	return acct
}

func assertHostRequestRow(t *testing.T, h *harness, id, phone string, requested bool) {
	t.Helper()
	var gotPhone string
	var open bool
	var canHost bool
	err := h.store.Pool().QueryRow(context.Background(), `
		SELECT phone, host_requested_at IS NOT NULL, can_host FROM users WHERE id = $1`, id,
	).Scan(&gotPhone, &open, &canHost)
	if err != nil {
		t.Fatal(err)
	}
	if gotPhone != phone || open != requested {
		t.Errorf("row phone %q open %v, want phone %q open %v", gotPhone, open, phone, requested)
	}
	if requested && canHost {
		t.Error("recording the request also granted hosting")
	}
}
