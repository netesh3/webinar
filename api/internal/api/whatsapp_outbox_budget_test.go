package api_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The WhatsApp outbox inside a bounded pass (1 Nov 2026).
 *
 * A 658-person broadcast was sent a message a second inside the tick, with no deadline of
 * its own: every pass ran the whole 90 s lane, past the server's write timeout, and Cloud Run
 * took each instance it answered on out of service. Seven sends cut off by the deadline were
 * sent again on the next pass. These pin the three things that changed: one flush stops at
 * its budget and the rest goes next pass, nobody is sent the same message twice, and a send
 * that got no answer is not retried.
 */

// broadcastToMany registers n opted-in contacts, lets their registrations' own flushes
// settle, runs before (which sets Meta and the outbox up for the test), and then queues
// one broadcast to all of them.
func broadcastToMany(t *testing.T, h *harness, n int, before func()) types.CRMBroadcast {
	t.Helper()
	wb := autoWebinar(t, h, "Big list")
	for i := range n {
		registerWithPhone(t, h, wb.ID, fmt.Sprintf("Guest%d", i),
			fmt.Sprintf("guest%d@example.com", i), fmt.Sprintf("+2783%07d", i), true)
	}
	flushOnce(t, h)
	before()
	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Everyone", Template: testTemplateMarketing, Language: "en_US",
		Audience: types.AudienceOptedIn,
	})
	if b.Stats.Recipients != n {
		t.Fatalf("recipients = %d, want %d", b.Stats.Recipients, n)
	}
	return b
}

// flushOnce runs one WhatsApp flush, waiting for the outbox lease to come free first (a
// registration starts a flush of its own after it responds).
func flushOnce(t *testing.T, h *harness) time.Duration {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		start := time.Now()
		if h.engage.FlushWhatsAppOutbox(context.Background()) {
			return time.Since(start)
		}
		if time.Now().After(deadline) {
			t.Fatal("the WhatsApp outbox lease never came free")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWhatsAppFlushStopsAtItsBudgetAndResumes(t *testing.T) {
	g := newFakeGraph(t)
	// 10 a second (burst 10), so a 300 ms sending window cannot reach all 20.
	h := newHarness(t, whatsappConfigured(g.srv.URL), func(c *config.Config) { c.WhatsAppSendPerSec = 10 })
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	const n = 20
	const budget, sendTimeout, delay = 600 * time.Millisecond, 300 * time.Millisecond, 200 * time.Millisecond
	b := broadcastToMany(t, h, n, func() {
		h.engage.SetWhatsAppFlushTiming(budget, sendTimeout)
		g.slowSends(delay)
	})
	if got := len(g.sent()); got != 0 {
		t.Fatalf("%d sends before the broadcast's pass", got)
	}

	took := flushOnce(t, h)
	first := len(g.sent())
	if first == 0 || first >= n {
		t.Fatalf("one bounded flush sent %d of %d, want some but not all: the budget is what "+
			"keeps a long list from holding the tick", first, n)
	}
	if took > budget+sendTimeout+500*time.Millisecond {
		t.Errorf("one flush took %v with a %v budget: a send starts only with a send's time left", took, budget)
	}
	mid := readBroadcast(t, h, b.ID)
	if mid.Stats.Sent != first || mid.Stats.Queued != n-first {
		t.Errorf("after one pass stats = %+v, want %d sent and the rest still queued", mid.Stats, first)
	}

	for pass := 0; len(g.sent()) < n && pass < 20; pass++ {
		flushOnce(t, h)
	}
	g.slowSends(0)
	flushOnce(t, h)
	sends := g.sent()
	if len(sends) != n {
		t.Fatalf("%d sends reached Meta, want exactly one per recipient (%d)", len(sends), n)
	}
	seen := map[any]int{}
	for _, s := range sends {
		seen[s["to"]]++
	}
	for to, c := range seen {
		if c != 1 {
			t.Errorf("%v was sent %d copies", to, c)
		}
	}
	done := readBroadcast(t, h, b.ID)
	if done.Stats.Sent != n || done.Stats.Queued != 0 || done.Stats.Failed != 0 {
		t.Errorf("final stats = %+v, want all %d sent", done.Stats, n)
	}

	// Every send's wamid was stored, so its delivery report finds it.
	for i := 1; i <= n; i++ {
		postWebhook(t, h, `{"entry":[{"id":"`+testMetaWABAID+`","changes":[{"field":"messages","value":{
		  "metadata":{"phone_number_id":"`+testMetaPhoneID+`"},
		  "statuses":[{"id":"wamid.OUT`+fmt.Sprint(i)+`","status":"delivered","timestamp":"1700000300"}]}}]}]}`)
	}
	if got := readBroadcast(t, h, b.ID).Stats.Delivered; got != n {
		t.Errorf("delivered = %d after %d delivery reports, want every one matched to its message", got, n)
	}
}

/* A send whose answer never came may have been delivered, so it is not sent again. The
 * fake records the message before it stalls: as far as the recipient is concerned it
 * arrived. */
func TestWhatsAppSendWithNoAnswerIsNotSentAgain(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	b := broadcastToMany(t, h, 1, func() {
		h.engage.SetWhatsAppFlushTiming(2*time.Second, 150*time.Millisecond)
		g.slowSends(600 * time.Millisecond)
	})
	flushOnce(t, h)
	if got := len(g.sent()); got != 1 {
		t.Fatalf("%d sends, want the one that timed out", got)
	}

	g.slowSends(0)
	for range 3 {
		flushOnce(t, h)
	}
	if got := len(g.sent()); got != 1 {
		t.Fatalf("%d sends reached Meta: a send with no answer was sent again, so the "+
			"contact may have it twice", got)
	}
	after := readBroadcast(t, h, b.ID)
	if after.Stats.Failed != 1 || after.Stats.Queued != 0 || after.Stats.Sent != 0 {
		t.Errorf("stats = %+v, want the one recipient failed and nothing left queued", after.Stats)
	}
	var reason string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT delivery_error FROM notifications WHERE broadcast_id = $1::uuid`, b.ID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(reason, "may have been delivered") {
		t.Errorf("delivery_error = %q, want it to say why it was not retried", reason)
	}
}

/* A refusal Meta answered sent nothing, so it is still retried. */
func TestWhatsAppRefusedSendIsStillRetried(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	b := broadcastToMany(t, h, 1, func() {
		g.mu.Lock()
		g.sendStatus = 400
		g.sendError = map[string]any{"message": "(#131000) Something went wrong", "code": 131000}
		g.mu.Unlock()
	})
	flushOnce(t, h)
	if got := readBroadcast(t, h, b.ID); got.Stats.Queued != 1 || got.Stats.Sent != 0 {
		t.Fatalf("after a refusal stats = %+v, want it back in the queue", got.Stats)
	}

	g.mu.Lock()
	g.sendStatus = 0
	g.mu.Unlock()
	// The retry waits out its backoff; bring it due.
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE notifications SET due_at = now() WHERE broadcast_id = $1::uuid`, b.ID); err != nil {
		t.Fatal(err)
	}
	flushOnce(t, h)
	if got := readBroadcast(t, h, b.ID); got.Stats.Sent != 1 || got.Stats.Queued != 0 {
		t.Errorf("after the retry stats = %+v, want it sent", got.Stats)
	}
	if got := len(g.sent()); got != 2 {
		t.Errorf("%d sends reached Meta, want the refused one and its retry", got)
	}
}

/* Meta's first status for every send is "sent", which the row already says: a known
 * message, not an unknown one. */
func TestWhatsAppStatusKnownButNotMoved(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	b := broadcastToMany(t, h, 1, func() {})
	flushOnce(t, h)
	if len(g.sent()) != 1 {
		t.Fatalf("%d sends, want 1", len(g.sent()))
	}
	var hostID string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT host_id::text FROM crm_broadcasts WHERE id = $1::uuid`, b.ID).Scan(&hostID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, c := range []struct {
		wamid, status string
		known, moved  bool
	}{
		{"wamid.OUT1", "sent", true, false},
		{"wamid.OUT1", "delivered", true, true},
		{"wamid.OUT1", "delivered", true, false},
		{"wamid.NOPE", "delivered", false, false},
	} {
		known, moved, err := h.crm.SetMessageStatus(ctx, hostID, c.wamid, c.status, "")
		if err != nil {
			t.Fatal(err)
		}
		if known != c.known || moved != c.moved {
			t.Errorf("%s %s: known=%v moved=%v, want %v %v", c.wamid, c.status, known, moved, c.known, c.moved)
		}
	}
}
