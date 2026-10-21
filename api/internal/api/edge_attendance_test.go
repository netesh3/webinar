package api_test

/* Edge attendance: an edge viewer's visit follows their browser's beats and goodbye, not the
 * event stream.
 *
 * The stream cannot say either thing. On instant-webinar-4178 (2026-10-21) a phone pressed
 * Leave at 11:11 and its stream stayed open on the server until 11:29, because the CDN in
 * front did not pass the disconnect on; the same phone rejoined at 11:23, and the old stream
 * ending at 11:29 closed the visit the new one was relying on. The report said one visit,
 * 11:04 to 11:29. These tests pin what replaced it.
 *
 * Set TEST_DATABASE_URL to run; skipped otherwise, like every test in this package.
 */

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/types"
)

func (h *harness) edgePost(path string) int {
	h.t.Helper()
	res, err := http.Post(h.srv.URL+path, "text/plain", nil)
	if err != nil {
		h.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func edgeViewers(t *testing.T, h *harness, slug string) int {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/edge", nil)
	var status types.EdgeStatus
	h.decode(raw, &status)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("edge status: %d %s", res.StatusCode, raw)
	}
	return status.Viewers
}

func TestEdgeStreamEndingDoesNotEndTheVisit(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-att-reload@test.dev")
	wb := edgeWebinar(h, "Edge reload")
	alice := h.registerAsGuest(wb.ID, "edge-att-alice@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)

	first, _, cancelFirst := h.openEvents(wb.ID, aj.EventsToken)
	defer cancelFirst()
	waitFor(t, first, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
	if n := edgeViewers(t, h, wb.ID); n != 1 {
		t.Fatalf("viewers after connecting = %d, want 1", n)
	}

	// A reload: the new stream connects, then the old one ends. She is still watching.
	second, _, cancelSecond := h.openEvents(wb.ID, aj.EventsToken)
	defer cancelSecond()
	waitFor(t, second, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
	cancelFirst()
	time.Sleep(300 * time.Millisecond)
	if n := edgeViewers(t, h, wb.ID); n != 1 {
		t.Fatalf("viewers after the old stream ended = %d, want 1", n)
	}

	base := "/api/webinars/" + wb.ID + "/events/"
	if code := h.edgePost(base + "beat?t=not-a-token"); code != http.StatusUnauthorized {
		t.Fatalf("beat with a bad token: %d, want 401", code)
	}
	if code := h.edgePost(base + "beat?t=" + aj.EventsToken); code != http.StatusNoContent {
		t.Fatalf("beat: %d, want 204", code)
	}

	// Leave ends the visit now, with the stream still open.
	if code := h.edgePost(base + "leave?t=" + aj.EventsToken); code != http.StatusNoContent {
		t.Fatalf("leave: %d, want 204", code)
	}
	if n := edgeViewers(t, h, wb.ID); n != 0 {
		t.Fatalf("viewers after leaving = %d, want 0", n)
	}
	row := rowFor(t, h.report(wb.ID), aj.Identity)
	if len(row.Visits) != 1 || row.Visits[0].LeftAt == "" || row.LastLeftAt == "" {
		t.Fatalf("visits after leaving = %+v (last left %q), want one closed visit", row.Visits, row.LastLeftAt)
	}

	// Coming back opens a second visit; it is not stitched onto the first.
	if code := h.edgePost(base + "beat?t=" + aj.EventsToken); code != http.StatusNoContent {
		t.Fatalf("beat after leaving: %d, want 204", code)
	}
	row = rowFor(t, h.report(wb.ID), aj.Identity)
	if len(row.Visits) != 2 || row.Visits[1].LeftAt != "" {
		t.Fatalf("visits after coming back = %+v, want a closed one and an open one", row.Visits)
	}
}

/* A viewer whose beats stop — the tab closed and the goodbye never got out — is gone from the
 * last beat: not counted as watching until the end, and not holding a seat. */
func TestEdgeVisitEndsAtTheLastBeat(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-att-stale@test.dev")
	wb := edgeWebinar(h, "Edge stale")
	live := time.Now().UTC().Truncate(time.Minute).Add(-time.Hour)
	pinSessionWindow(t, wb.ID, live, time.Time{})
	clearEnded(t, wb.ID)

	ctx := context.Background()
	gone := h.registerAsGuest(wb.ID, "edge-att-gone@test.dev")
	stays := h.registerAsGuest(wb.ID, "edge-att-stays@test.dev")
	goneID, staysID := "att_"+gone.JoinKey, "att_"+stays.JoinKey

	// Gone: beat from 0 to 10 minutes, then nothing.
	for m := 0; m <= 10; m++ {
		mustBeat(t, h, ctx, wb.ID, goneID, live.Add(time.Duration(m)*time.Minute))
	}
	// Stays: beats now. Somebody connected on the waiting screen is counted from a beat too.
	mustBeat(t, h, ctx, wb.ID, staysID, time.Now())

	if n := edgeViewers(t, h, wb.ID); n != 1 {
		t.Fatalf("viewers = %d, want 1 — a stale visit is holding a seat", n)
	}
	goneRow := rowFor(t, h.report(wb.ID), goneID)
	if len(goneRow.Visits) != 1 || goneRow.WatchMin != 10 {
		t.Fatalf("gone viewer = %+v, want one 10-minute visit", goneRow)
	}
	sameInstant(t, goneRow.LastLeftAt, live.Add(10*time.Minute), "last left (the last beat)")

	// Back after an hour away: a new visit, the gap not counted.
	mustBeat(t, h, ctx, wb.ID, goneID, time.Now())
	if err := h.store.CloseOpenVisits(ctx, wb.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if a := rowFor(t, h.report(wb.ID), goneID); len(a.Visits) != 2 || a.WatchMin != 10 {
		t.Fatalf("after coming back = %+v, want two visits and 10 minutes", a)
	}
}

/* A viewer promoted to the stage keeps one visit across the switch: the webhook's join takes
 * the feed visit over, and their goodbye from the feed does not close it. */
func TestEdgePromotionHandsTheVisitToTheWebhooks(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-att-stage@test.dev")
	wb := edgeWebinar(h, "Edge to stage")
	pinSessionWindow(t, wb.ID, time.Now().Add(-time.Hour), time.Time{})
	clearEnded(t, wb.ID)
	reg := h.registerAsGuest(wb.ID, "edge-att-staged@test.dev")
	identity := "att_" + reg.JoinKey
	ctx := context.Background()
	at := time.Now().Add(-5 * time.Minute)

	mustBeat(t, h, ctx, wb.ID, identity, at)
	mustOpen(t, h, ctx, wb.ID, identity, "Staged", at.Add(time.Minute))
	if err := h.store.CloseEdgeVisit(ctx, wb.ID, identity, at.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	mustBeat(t, h, ctx, wb.ID, identity, at.Add(3*time.Minute)) // a late beat from the feed tab
	row := rowFor(t, h.report(wb.ID), identity)
	if len(row.Visits) != 1 || row.Visits[0].LeftAt != "" {
		t.Fatalf("visits = %+v, want one open visit", row.Visits)
	}
	mustClose(t, h, ctx, wb.ID, identity, at.Add(4*time.Minute))
	row = rowFor(t, h.report(wb.ID), identity)
	if len(row.Visits) != 1 || row.WatchMin != 4 {
		t.Fatalf("after leaving the stage = %+v, want one 4-minute visit", row)
	}
}

func rowFor(t *testing.T, rep types.SessionReport, identity string) types.AttendanceRow {
	t.Helper()
	for _, a := range rep.Attendees {
		if a.Identity == identity {
			return a
		}
	}
	t.Fatalf("no attendance row for %s; got %d rows", identity, len(rep.Attendees))
	return types.AttendanceRow{}
}

func mustBeat(t *testing.T, h *harness, ctx context.Context, slug, identity string, at time.Time) {
	t.Helper()
	if err := h.store.TouchEdgeVisit(ctx, slug, identity, at); err != nil {
		t.Fatalf("beat for %s at %s: %v", identity, at, err)
	}
}

// clearEnded keeps a pinned window open-ended: the webinar is still live.
func clearEnded(t *testing.T, slug string) {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `UPDATE webinars SET ended_at = NULL WHERE slug = $1`, slug); err != nil {
		t.Fatal(err)
	}
}
