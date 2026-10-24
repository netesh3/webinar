package api_test

/* Edge event streams end when their viewer is gone, not 25 minutes later.
 *
 * In the 24 Oct 2026 load test every event stream ran its full lifetime (1,500 s, to the
 * second) although each simulated viewer had said goodbye: behind Cloudflare and Cloud Run's
 * front end the client going away never reached the handler, so each instance sat on ~500
 * dead streams, ~1,000 goroutines, for 25 minutes after every step. The test client here
 * plays the proxy: it keeps the connection open and keeps reading whatever the viewer does,
 * so only the server can end the stream. */

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/api"
)

// waitClosed fails unless ch closes (the server ended the response) within d.
func waitClosed(t *testing.T, ch <-chan sseEvent, d time.Duration, what string) []sseEvent {
	t.Helper()
	var got []sseEvent
	deadline := time.After(d)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return got
			}
			got = append(got, ev)
		case <-deadline:
			t.Fatalf("%s: stream still open after %s", what, d)
		}
	}
}

// waitGoroutines waits for the process to come back to at most want goroutines.
func waitGoroutines(t *testing.T, want int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	// A finished response leaves its keep-alive connection idle (a goroutine at each end):
	// pooled, not leaked. Close those, so only streams still running are counted.
	http.DefaultClient.CloseIdleConnections()
	n := runtime.NumGoroutine()
	for n > want && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		http.DefaultClient.CloseIdleConnections()
		n = runtime.NumGoroutine()
	}
	if n > want {
		buf := make([]byte, 1<<20)
		t.Fatalf("goroutines = %d, want <= %d\n%s", n, want, buf[:runtime.Stack(buf, true)])
	}
}

func TestEdgeLeaveEndsTheViewersStreams(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-streams-leave@test.dev")
	wb := edgeWebinar(h, "Edge leave ends streams")

	// The LISTEN connection and the server's own goroutines are up before the baseline.
	warm := h.registerAsGuest(wb.ID, "edge-streams-warm@test.dev")
	_, wj, _ := h.joinAsGuestKey(wb.ID, warm.JoinKey)
	warmCh, _, cancelWarm := h.openEvents(wb.ID, wj.EventsToken)
	defer cancelWarm()
	syncStream(t, h, wb.ID, warmCh)
	http.DefaultClient.CloseIdleConnections()
	time.Sleep(200 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	const n = 40
	type viewer struct {
		token string
		ch    <-chan sseEvent
	}
	viewers := make([]viewer, 0, n)
	for i := 0; i < n; i++ {
		reg := h.registerAsGuest(wb.ID, fmt.Sprintf("edge-streams-%d@test.dev", i))
		_, j, _ := h.joinAsGuestKey(wb.ID, reg.JoinKey)
		ch, _, cancel := h.openEvents(wb.ID, j.EventsToken)
		defer cancel()
		waitFor(t, ch, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
		viewers = append(viewers, viewer{j.EventsToken, ch})
	}
	if extra := runtime.NumGoroutine() - baseline; extra < n {
		t.Fatalf("only %d more goroutines with %d streams open; the test measures nothing", extra, n)
	}

	// Every viewer says goodbye. Their streams end on the server, with nobody hanging up.
	base := "/api/webinars/" + wb.ID + "/events/leave?t="
	for _, v := range viewers {
		if code := h.edgePost(base + v.token); code != http.StatusNoContent {
			t.Fatalf("leave: %d", code)
		}
	}
	for i, v := range viewers {
		waitClosed(t, v.ch, 5*time.Second, fmt.Sprintf("viewer %d after leave", i))
	}
	waitGoroutines(t, baseline+2, 5*time.Second)

	// The viewer who did not leave is still connected.
	noEvent(t, warmCh, 300*time.Millisecond, func(sseEvent) bool { return false })
	select {
	case _, ok := <-warmCh:
		if !ok {
			t.Fatal("the viewer who stayed lost their stream")
		}
	default:
	}
}

/* A viewer whose beats stopped, with no goodbye (the tab was killed, the beacon lost), has
 * their stream ended with "reconnect" once the webinar is live; one who beats keeps theirs. */
func TestEdgeStreamWithoutBeatsEnds(t *testing.T) {
	defer api.SetEdgeStreamTiming(150*time.Millisecond, 100*time.Millisecond, time.Second)()
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-streams-idle@test.dev")
	wb := edgeWebinar(h, "Edge idle")
	pinSessionWindow(t, wb.ID, time.Now().Add(-time.Hour), time.Time{})
	clearEnded(t, wb.ID)

	gone := h.registerAsGuest(wb.ID, "edge-streams-gone@test.dev")
	stays := h.registerAsGuest(wb.ID, "edge-streams-stays@test.dev")
	_, gj, _ := h.joinAsGuestKey(wb.ID, gone.JoinKey)
	_, sj, _ := h.joinAsGuestKey(wb.ID, stays.JoinKey)
	goneCh, _, cancelGone := h.openEvents(wb.ID, gj.EventsToken)
	defer cancelGone()
	staysCh, _, cancelStays := h.openEvents(wb.ID, sj.EventsToken)
	defer cancelStays()
	waitFor(t, goneCh, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
	waitFor(t, staysCh, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })

	// The gone viewer's last beat was ten minutes ago.
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(),
		`UPDATE attendance_visits SET seen_at = now() - interval '10 minutes', joined_at = now() - interval '20 minutes'
		  WHERE identity = $1 AND left_at IS NULL`, gj.Identity); err != nil {
		t.Fatal(err)
	}

	// The other keeps beating.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-time.After(200 * time.Millisecond):
				h.edgePost("/api/webinars/" + wb.ID + "/events/beat?t=" + sj.EventsToken)
			}
		}
	}()

	got := waitClosed(t, goneCh, 5*time.Second, "the viewer with no beats")
	if len(got) == 0 || got[len(got)-1].kind != "reconnect" {
		t.Fatalf("events before the end = %+v, want a final reconnect", got)
	}
	noEvent(t, staysCh, 1500*time.Millisecond, func(e sseEvent) bool { return e.kind == "reconnect" })
	select {
	case _, ok := <-staysCh:
		if !ok {
			t.Fatal("the viewer who beats lost their stream")
		}
	default:
	}
}
