package api_test

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The WhatsApp outbox at 40 a second (WHATSAPP_SEND_PER_SEC): the rate holds, Meta's
 * throughput refusal backs the number off without losing or double-sending a row, two
 * flushes never claim one row, a contact's messages keep their order, and a big campaign
 * uses at most three database connections. See engage/wa_outbox.go. */

func withSendRate(perSec int) func(*config.Config) {
	return func(c *config.Config) { c.WhatsAppSendPerSec = perSec }
}

// optInContacts adds n opted-in contacts straight into the host's CRM: a 2,000-person
// list registered one request at a time would be the slowest part of the test.
func optInContacts(t *testing.T, h *harness, n int) {
	t.Helper()
	if _, err := h.store.Pool().Exec(context.Background(), `
		INSERT INTO crm_contacts (host_id, phone, name, source, whatsapp_opt_in_at)
		SELECT u.id, '+2784' || lpad(g::text, 7, '0'), 'Bulk ' || g, 'import', now()
		  FROM users u, generate_series(1, $1) g
		 WHERE u.email = 'neeraj@acme.dev'`, n); err != nil {
		t.Fatalf("bulk contacts: %v", err)
	}
}

func optedInBroadcast(t *testing.T, h *harness, template string, params []types.CRMParam) types.CRMBroadcast {
	t.Helper()
	return createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "To everyone " + template, Template: template, Language: "en_US",
		Params: params, Audience: types.AudienceOptedIn,
	})
}

// connectedHost is a host with WhatsApp connected and nothing else queued.
func connectedHost(t *testing.T, g *fakeGraph, tweak ...func(*config.Config)) *harness {
	t.Helper()
	h := newHarness(t, append([]func(*config.Config){whatsappConfigured(g.srv.URL)}, tweak...)...)
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	return h
}

func TestWhatsAppOutboxHonoursTheSendRate(t *testing.T) {
	g := newFakeGraph(t)
	const perSec, n = 20, 60
	h := connectedHost(t, g, withSendRate(perSec))
	optInContacts(t, h, n)
	optedInBroadcast(t, h, testTemplateMarketing, nil)

	flushOnce(t, h)
	at := g.sentAt()
	if len(at) != n {
		t.Fatalf("%d sends, want %d in one flush", len(at), n)
	}
	// A burst of perSec, then perSec a second: 60 sends span at least two seconds.
	if span := at[len(at)-1].Sub(at[0]); span < 1900*time.Millisecond {
		t.Errorf("%d sends took %v at %d a second; the limiter let them through faster", n, span, perSec)
	}
	for i := range at {
		in := 0
		for _, u := range at[i:] {
			if u.Sub(at[i]) < time.Second {
				in++
			}
		}
		if in > 2*perSec {
			t.Fatalf("%d sends in one second from send %d, want at most burst + rate = %d", in, i, 2*perSec)
		}
	}
}

func TestWhatsAppThroughputLimitBacksOffTheNumber(t *testing.T) {
	g := newFakeGraph(t)
	const n = 100
	h := connectedHost(t, g, withSendRate(40))
	optInContacts(t, h, n)
	b := optedInBroadcast(t, h, testTemplateMarketing, nil)

	g.refuseSends(130429)
	flushOnce(t, h)
	tried := len(g.sent())
	if tried == 0 || tried > 40 {
		t.Fatalf("%d sends reached Meta after a 130429, want only the ones already in flight (at most 40)", tried)
	}
	var queued, attempts int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FILTER (WHERE delivery = 'pending'), COALESCE(sum(attempts), 0)
		  FROM notifications WHERE broadcast_id = $1::uuid`, b.ID).Scan(&queued, &attempts); err != nil {
		t.Fatal(err)
	}
	if queued != n || attempts != 0 {
		t.Fatalf("after a throughput refusal %d of %d rows pending with %d attempts counted, "+
			"want all pending and none counted: nothing reached anybody", queued, n, attempts)
	}

	g.refuseSends(0)
	for pass := 0; pass < 5 && readBroadcast(t, h, b.ID).Stats.Sent < n; pass++ {
		flushOnce(t, h)
	}
	if got := readBroadcast(t, h, b.ID).Stats; got.Sent != n || got.Queued != 0 {
		t.Fatalf("after the limit lifted stats = %+v, want all %d sent", got, n)
	}
	seen := map[any]int{}
	for _, s := range g.sent()[tried:] {
		seen[s["to"]]++
	}
	if len(seen) != n {
		t.Errorf("%d numbers sent to after the limit lifted, want %d", len(seen), n)
	}
	for to, c := range seen {
		if c != 1 {
			t.Errorf("%v sent %d times once the limit lifted", to, c)
		}
	}
}

func TestWhatsAppNoDoubleClaimAcrossConcurrentFlushes(t *testing.T) {
	g := newFakeGraph(t)
	const n = 80
	h := connectedHost(t, g, withSendRate(40))
	optInContacts(t, h, n)
	b := optedInBroadcast(t, h, testTemplateMarketing, nil)

	// The claim itself, with no lease in front of it: two claimers over the same rows
	// split them.
	var ids []string
	rows, err := h.store.Pool().Query(context.Background(),
		`SELECT id::text FROM notifications WHERE broadcast_id = $1::uuid`, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	var mu sync.Mutex
	got := map[string]int{}
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := h.store.ClaimSends(context.Background(), ids)
			if err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			for _, id := range c {
				got[id]++
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(got) != n {
		t.Errorf("%d rows claimed by four concurrent claims, want all %d", len(got), n)
	}
	for id, c := range got {
		if c != 1 {
			t.Errorf("row %s claimed %d times", id, c)
		}
	}
	if err := h.store.ReleaseClaims(context.Background(), ids); err != nil {
		t.Fatal(err)
	}

	// And two flushes at once, as two instances' ticks would run them.
	g.slowSends(20 * time.Millisecond)
	var ran atomic.Int32
	for pass := 0; pass < 10 && len(g.sent()) < n; pass++ {
		var fw sync.WaitGroup
		for range 2 {
			fw.Add(1)
			go func() {
				defer fw.Done()
				if h.engage.FlushWhatsAppOutbox(context.Background()) {
					ran.Add(1)
				}
			}()
		}
		fw.Wait()
	}
	sends := g.sent()
	if len(sends) != n {
		t.Fatalf("%d sends from concurrent flushes, want exactly %d", len(sends), n)
	}
	seen := map[any]int{}
	for _, s := range sends {
		seen[s["to"]]++
	}
	for to, c := range seen {
		if c != 1 {
			t.Errorf("%v sent %d times by concurrent flushes", to, c)
		}
	}
}

func TestWhatsAppKeepsEachContactsOrder(t *testing.T) {
	g := newFakeGraph(t)
	const n = 30
	h := connectedHost(t, g, withSendRate(40))
	wb := autoWebinar(t, h, "Order")
	for i := range n {
		registerWithPhone(t, h, wb.ID, fmt.Sprintf("P%d", i),
			fmt.Sprintf("p%d@example.com", i), fmt.Sprintf("+2785%07d", i), true)
	}
	flushOnce(t, h)
	// Two messages each, the marketing one first; Meta answers slowly, so many are in flight.
	g.slowSends(40 * time.Millisecond)
	optedInBroadcast(t, h, testTemplateMarketing, nil)
	optedInBroadcast(t, h, testTemplateUtility, []types.CRMParam{{Field: "name"}})

	for pass := 0; pass < 5 && len(g.sent()) < 2*n; pass++ {
		flushOnce(t, h)
	}
	sends := g.sent()
	if len(sends) != 2*n {
		t.Fatalf("%d sends, want %d", len(sends), 2*n)
	}
	order := map[any][]any{}
	for _, s := range sends {
		tmpl, _ := s["template"].(map[string]any)
		order[s["to"]] = append(order[s["to"]], tmpl["name"])
	}
	for to, names := range order {
		if len(names) != 2 || names[0] != testTemplateMarketing || names[1] != testTemplateUtility {
			t.Errorf("%v got %v, want the marketing message and then the reminder", to, names)
		}
	}
}

/* 2,000 recipients, Meta taking 200 ms a send, at the default 40 a second: about 50 s of
 * sending over five flushes of 400, and never more than three of the pool's connections. */
func TestWhatsAppBigCampaignThroughputAndConnections(t *testing.T) {
	if testing.Short() {
		t.Skip("about a minute of real time")
	}
	g := newFakeGraph(t)
	const n = 2000
	h := connectedHost(t, g)
	optInContacts(t, h, n)
	b := optedInBroadcast(t, h, testTemplateMarketing, nil)
	if b.Stats.Recipients != n {
		t.Fatalf("recipients = %d", b.Stats.Recipients)
	}
	g.slowSends(200 * time.Millisecond)

	pool := h.store.Pool()
	idle := pool.Stat().AcquiredConns()
	var peak atomic.Int32
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				if c := pool.Stat().AcquiredConns(); c > peak.Load() {
					peak.Store(c)
				}
			}
		}
	}()
	start := time.Now()
	flushes := 0
	var sending time.Duration
	for len(g.sent()) < n && flushes < 12 {
		sending += flushOnce(t, h)
		flushes++
	}
	took := time.Since(start)
	close(stop)
	<-sampled

	sends := g.sent()
	at := g.sentAt()
	rate := float64(len(sends)) / at[len(at)-1].Sub(at[0]).Seconds()
	t.Logf("%d sends in %d flushes, %v of flushing (%v wall); %.1f sends a second; "+
		"peak %d pool connections in use (%d idle before)", len(sends), flushes, sending.Round(time.Millisecond),
		took.Round(time.Millisecond), rate, peak.Load(), idle)
	if len(sends) != n {
		t.Fatalf("%d sends, want %d", len(sends), n)
	}
	seen := map[any]bool{}
	for _, s := range sends {
		if seen[s["to"]] {
			t.Fatalf("%v sent twice", s["to"])
		}
		seen[s["to"]] = true
	}
	if rate < 36 || rate > 44 {
		t.Errorf("%.1f sends a second, want about 40", rate)
	}
	if sending > 70*time.Second {
		t.Errorf("%v of flushing for %d sends, want about 50 s", sending, n)
	}
	if peak.Load()-idle > 3 {
		t.Errorf("a flush used %d pool connections at once, want at most 3", peak.Load()-idle)
	}
	if got := readBroadcast(t, h, b.ID).Stats; got.Sent != n || got.Queued != 0 {
		t.Errorf("stats = %+v, want all %d sent", got, n)
	}
}

// 131048 pauses the host and tells them once; 131056 retries the row; 131049 retires it.
func TestWhatsAppMetaLimitCodes(t *testing.T) {
	ctx := context.Background()
	state := func(t *testing.T, h *harness, b types.CRMBroadcast) (delivery string, attempts int) {
		t.Helper()
		if err := h.store.Pool().QueryRow(ctx, `SELECT delivery, attempts FROM notifications
			WHERE broadcast_id = $1::uuid`, b.ID).Scan(&delivery, &attempts); err != nil {
			t.Fatal(err)
		}
		return delivery, attempts
	}
	for _, c := range []struct {
		code     int
		delivery string
		attempts int
		alerts   int
	}{
		{131048, "pending", 0, 1},
		{131056, "pending", 1, 0},
		{131049, "failed", 1, 0},
	} {
		t.Run(fmt.Sprint(c.code), func(t *testing.T) {
			g := newFakeGraph(t)
			h := connectedHost(t, g)
			optInContacts(t, h, 1)
			b := optedInBroadcast(t, h, testTemplateMarketing, nil)
			g.refuseSends(c.code)
			flushOnce(t, h)
			if c.code == 131048 {
				// Meta's limit lasts: the next pass meets it again, and says nothing new.
				flushOnce(t, h)
			}
			if d, a := state(t, h, b); d != c.delivery || a != c.attempts {
				t.Errorf("after %d: delivery %q attempts %d, want %q %d", c.code, d, a, c.delivery, c.attempts)
			}
			var alerts int
			if err := h.store.Pool().QueryRow(ctx, `SELECT count(*) FROM notifications n
				JOIN users u ON u.id = n.user_id
				WHERE u.email = 'neeraj@acme.dev' AND n.kind = 'whatsapp_limited'`).Scan(&alerts); err != nil {
				t.Fatal(err)
			}
			if alerts != c.alerts {
				t.Errorf("after %d: %d whatsapp_limited alerts on the host's bell, want %d", c.code, alerts, c.alerts)
			}
		})
	}
}
