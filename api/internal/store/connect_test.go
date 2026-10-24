package store

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

/* The boot retry against a fake dialer and a fake clock: a full pooler is waited out, a wrong
 * password is not, and the budget is honoured. */

// fakeDialer fails with errs in order, then succeeds.
type fakeDialer struct {
	errs  []error
	calls int
}

func (f *fakeDialer) dial(context.Context) error {
	f.calls++
	if f.calls <= len(f.errs) {
		return f.errs[f.calls-1]
	}
	return nil
}

// fakeClock records sleeps without sleeping.
type fakeClock struct{ slept []time.Duration }

func (c *fakeClock) sleep(_ context.Context, d time.Duration) error {
	c.slept = append(c.slept, d)
	return nil
}

func (c *fakeClock) total() time.Duration {
	var t time.Duration
	for _, d := range c.slept {
		t += d
	}
	return t
}

var errPoolerFull = &pgconn.PgError{
	Severity: "FATAL", Code: "XX000",
	Message: "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15",
}

func bufLog() (*slog.Logger, *bytes.Buffer) {
	var b bytes.Buffer
	return slog.New(slog.NewTextHandler(&b, nil)), &b
}

func TestRetryConnectWaitsOutAFullPooler(t *testing.T) {
	d := &fakeDialer{errs: []error{errPoolerFull, errPoolerFull, errPoolerFull}}
	c := &fakeClock{}
	log, buf := bufLog()
	if err := retryConnect(context.Background(), log, 90*time.Second, c.sleep, d.dial); err != nil {
		t.Fatalf("err = %v", err)
	}
	if d.calls != 4 || len(c.slept) != 3 {
		t.Fatalf("calls=%d sleeps=%d", d.calls, len(c.slept))
	}
	// Backoff grows: ~0.5s, ~1s, ~2s (±20%).
	for i, want := range []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second} {
		lo, hi := want*8/10, want*12/10
		if c.slept[i] < lo || c.slept[i] > hi {
			t.Errorf("sleep %d = %v, want within [%v, %v]", i, c.slept[i], lo, hi)
		}
	}
	if !strings.Contains(buf.String(), "database pooler full, retrying") {
		t.Errorf("log does not say the pooler is full:\n%s", buf.String())
	}
}

func TestRetryConnectGivesUpAtTheBudget(t *testing.T) {
	d := &fakeDialer{errs: make([]error, 1000)}
	for i := range d.errs {
		d.errs[i] = errPoolerFull
	}
	c := &fakeClock{}
	log, buf := bufLog()
	err := retryConnect(context.Background(), log, 60*time.Second, c.sleep, d.dial)
	if !errors.Is(err, errPoolerFull) {
		t.Fatalf("err = %v, want the last connect error", err)
	}
	if c.total() != 60*time.Second {
		t.Errorf("waited %v, want exactly the 60s budget", c.total())
	}
	for _, s := range c.slept {
		if s > connectBackoffMax*12/10 {
			t.Errorf("sleep %v exceeds the backoff cap", s)
		}
	}
	if !strings.Contains(buf.String(), "giving up") {
		t.Errorf("no give-up log:\n%s", buf.String())
	}
}

func TestRetryConnectDoesNotRetryBadCredentials(t *testing.T) {
	bad := &pgconn.PgError{Severity: "FATAL", Code: "28P01", Message: "password authentication failed"}
	d := &fakeDialer{errs: []error{bad}}
	c := &fakeClock{}
	log, _ := bufLog()
	if err := retryConnect(context.Background(), log, 90*time.Second, c.sleep, d.dial); !errors.Is(err, bad) {
		t.Fatalf("err = %v", err)
	}
	if d.calls != 1 || len(c.slept) != 0 {
		t.Errorf("calls=%d sleeps=%d, want one attempt and no wait", d.calls, len(c.slept))
	}
}

func TestRetryConnectRetriesPlainNetworkErrors(t *testing.T) {
	d := &fakeDialer{errs: []error{errors.New("dial tcp: connection refused")}}
	c := &fakeClock{}
	log, buf := bufLog()
	if err := retryConnect(context.Background(), log, 90*time.Second, c.sleep, d.dial); err != nil {
		t.Fatal(err)
	}
	if d.calls != 2 || !strings.Contains(buf.String(), "database connection failed, retrying") {
		t.Errorf("calls=%d log=%s", d.calls, buf.String())
	}
}

func TestRetryConnectStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	d := &fakeDialer{errs: []error{errPoolerFull, errPoolerFull}}
	log, _ := bufLog()
	err := retryConnect(ctx, log, 90*time.Second, func(ctx context.Context, _ time.Duration) error {
		cancel()
		return ctx.Err()
	}, d.dial)
	if err == nil || d.calls != 1 {
		t.Fatalf("err=%v calls=%d", err, d.calls)
	}
}

func TestPoolerFull(t *testing.T) {
	for _, e := range []error{
		errPoolerFull,
		&pgconn.PgError{Code: "53300", Message: "sorry, too many clients already"},
		errors.New("FATAL: no more connections allowed (max_client_conn)"),
	} {
		if !poolerFull(e) {
			t.Errorf("poolerFull(%v) = false", e)
		}
	}
	if poolerFull(errors.New("connection refused")) {
		t.Error("connection refused is not a full pooler")
	}
}
