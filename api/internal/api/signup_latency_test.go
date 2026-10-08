package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

/* gateMail blocks inside Send until release is closed. entered closes on the
 * first call, which is the moment a database connection must already be back
 * in the pool.
 */
type gateMail struct {
	mu      sync.Mutex
	sent    []notify.Message
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func newGateMail() *gateMail {
	return &gateMail{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (g *gateMail) Configured() bool { return true }

func (g *gateMail) Send(_ context.Context, m notify.Message) error {
	g.once.Do(func() { close(g.entered) })
	<-g.release
	g.mu.Lock()
	g.sent = append(g.sent, m)
	g.mu.Unlock()
	return nil
}

func (g *gateMail) waitEntered(t *testing.T) {
	t.Helper()
	select {
	case <-g.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("smtp was not started")
	}
}

/* Registration returns while Gmail is still on the line, the CRM contact is
 * already written, and the only database connection is free for the next query.
 */
func TestRegisterReturnsWhileSMTPBlocks(t *testing.T) {
	t.Setenv("DB_MAX_CONNS", "1")
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Signup latency", nil)
	ada := h.signup("Ada Latency", "ada.latency@test.dev", false)

	mail := newGateMail()
	h.server.UseMail(mail)

	status, elapsed, _ := postJSON(t, h, http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Ada", LastName: "Latency", Email: ada.Email, Consent: true, Phone: testPhone,
	})
	if status != http.StatusCreated {
		t.Fatalf("status %d", status)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("register took %s while smtp was blocked", elapsed)
	}
	mail.waitEntered(t)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.store.Pool().Ping(ctx); err != nil {
		t.Fatalf("pool unusable during smtp: %v", err)
	}
	var contacts int
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT count(*) FROM crm_contacts WHERE lower(email) = lower($1)`, ada.Email,
	).Scan(&contacts); err != nil {
		t.Fatalf("contact lookup during smtp: %v", err)
	}
	if contacts != 1 {
		t.Fatalf("contacts = %d, want the CRM row written before smtp", contacts)
	}

	close(mail.release)
	h.server.WaitBackground()
	mail.mu.Lock()
	defer mail.mu.Unlock()
	if len(mail.sent) != 1 || mail.sent[0].To != ada.Email {
		t.Fatalf("sent = %+v", mail.sent)
	}
}

func TestVerifyReturnsWhileSMTPBlocks(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Verify latency", nil)
	h.logout()
	h.holdVerification = true

	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Bea Latency", Email: "bea.latency@test.dev", Password: "webcast-dev",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Bea", LastName: "Latency", Email: "bea.latency@test.dev",
		Consent: true, Phone: testPhone,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d %s", res.StatusCode, raw)
	}

	mail := newGateMail()
	h.server.UseMail(mail)
	token := h.latestVerifyToken("bea.latency@test.dev")
	status, elapsed, verifyBody := postJSON(t, h, http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: token})
	if status != http.StatusOK {
		t.Fatalf("status %d body %s token %s", status, verifyBody, token)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("verify took %s while smtp was blocked", elapsed)
	}
	mail.waitEntered(t)
	close(mail.release)
	h.server.WaitBackground()
	mail.mu.Lock()
	defer mail.mu.Unlock()
	if len(mail.sent) != 1 || mail.sent[0].To != "bea.latency@test.dev" {
		t.Fatalf("sent = %+v", mail.sent)
	}
}

func TestHostRequestReturnsWhileSMTPBlocks(t *testing.T) {
	h := newHarness(t)
	ada := h.signup("Ada Hostreq", "ada.hostlatency@test.dev", false)

	mail := newGateMail()
	h.server.UseMail(mail)
	status, elapsed, _ := postJSON(t, h, http.MethodPost, "/api/me/host-request", types.HostRequest{Phone: testPhone})
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("host request took %s while smtp was blocked", elapsed)
	}
	mail.waitEntered(t)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := h.store.Pool().Ping(ctx); err != nil {
		t.Fatalf("pool unusable during smtp: %v", err)
	}

	close(mail.release)
	h.server.WaitBackground()
	mail.mu.Lock()
	defer mail.mu.Unlock()
	if len(mail.sent) != 1 {
		t.Fatalf("sent = %d", len(mail.sent))
	}
	if mail.sent[0].To != notify.HostRequestRecipient || mail.sent[0].ReplyTo != ada.Email {
		t.Fatalf("mail = %+v", mail.sent[0])
	}
}

/* A lease query whose context is already finished must return the connection,
 * so the next query on a one-connection pool still runs.
 */
func TestExpiredLeaseDoesNotWedgeThePool(t *testing.T) {
	t.Setenv("DB_MAX_CONNS", "1")
	h := newHarness(t)

	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	time.Sleep(2 * time.Millisecond)
	_, _, err := h.store.TryLease(ctx, "expired-lease", time.Minute)
	cancel()
	if err == nil {
		t.Fatal("lease on a finished context returned no error")
	}

	ping, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if err := h.store.Pool().Ping(ping); err != nil {
		t.Fatalf("pool wedged after a timed-out lease: %v", err)
	}
}

func postJSON(t *testing.T, h *harness, method, path string, body any) (int, time.Duration, string) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	type result struct {
		res *http.Response
		err error
		d   time.Duration
		raw string
	}
	done := make(chan result, 1)
	start := time.Now()
	go func() {
		res, err := h.client.Do(req)
		if err != nil {
			done <- result{err: err, d: time.Since(start)}
			return
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		done <- result{res: res, d: time.Since(start), raw: string(b)}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		return got.res.StatusCode, got.d, got.raw
	case <-time.After(2 * time.Second):
		t.Fatal("request blocked")
		return 0, 0, ""
	}
}
