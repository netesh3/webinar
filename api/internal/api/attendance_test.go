package api_test

/* Attendance: in, out, and how long somebody was actually there.
 *
 * This exists because the number it checks was wrong in a way nobody could see. Watch time
 * used to be last_seen_at minus first_joined_at — one row per person, two timestamps — so
 * anybody who left and came back was credited with the gap in between. Somebody who watched
 * the first five minutes and the last five of an hour was reported as having watched the
 * whole hour, and the report looked perfectly reasonable while saying it.
 *
 * None of it is reachable by hand. Rejoining, arriving before the host, and a departure that
 * never arrives because a laptop lid closed are all timing, and the clock is the thing under
 * test — so the visits are written at chosen times through the store and the report is read
 * back through the API the browser uses.
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

/* The live window is pinned by hand, because the store cannot express it.
 *
 * SetStatus(live) writes started_at = now(), which makes every interesting case — arriving
 * twenty minutes early, watching for half an hour — a test that has to wait. Writing the two
 * columns directly buys a window with room in it, and it is the same write the host endpoint
 * performs.
 */
func pinSessionWindow(t *testing.T, slug string, started, ended time.Time) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("open pool: %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx,
		`UPDATE webinars SET started_at = $2, ended_at = $3 WHERE slug = $1`,
		slug, started, ended); err != nil {
		t.Fatalf("pin session window: %v", err)
	}
}

/* Instants, not strings.
 *
 * The API formats with time.Format(time.RFC3339), which keeps the offset the database
 * connection is in — so the same moment comes back as "…T16:03:00Z" or "…T21:33:00+05:30"
 * depending on where this runs. Both are correct and a client parses either; a string compare
 * would make these tests pass in London and fail in Delhi.
 */
func sameInstant(t *testing.T, got string, want time.Time, what string) {
	t.Helper()
	if got == "" {
		t.Errorf("%s is empty, want %s", what, want.Format(time.RFC3339))
		return
	}
	parsed, err := time.Parse(time.RFC3339, got)
	if err != nil {
		t.Errorf("%s = %q, which is not RFC3339: %v", what, got, err)
		return
	}
	if !parsed.Equal(want) {
		t.Errorf("%s = %q, want %s", what, got, want.Format(time.RFC3339))
	}
}

func attendeeRow(t *testing.T, rep types.SessionReport, name string) types.AttendanceRow {
	t.Helper()
	for _, a := range rep.Attendees {
		if a.Name == name {
			return a
		}
	}
	t.Fatalf("no attendance row for %q; got %d rows", name, len(rep.Attendees))
	return types.AttendanceRow{}
}

/* TestRejoinIsNotCountedAsStayingThroughout.
 *
 * The bug, stated as a test. Five minutes at the start and five at the end of an hour is ten
 * minutes of watching and two visits — not sixty minutes and not one.
 */
func TestRejoinIsNotCountedAsStayingThroughout(t *testing.T) {
	h := newHarness(t)
	h.signup("Attendance Host", "att-host@test.dev", true)
	wb := h.newWebinar("Attendance", nil)
	h.goLive(wb.ID)

	live := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Hour)
	end := live.Add(time.Hour)
	pinSessionWindow(t, wb.ID, live, end)

	ctx := t.Context()
	reg := h.registerAs(wb.ID, "rejoiner@test.dev")
	identity := "att_" + reg.JoinKey

	// Watched the opening, left, came back for the close.
	mustOpen(t, h, ctx, wb.ID, identity, "Rejoiner", live)
	mustClose(t, h, ctx, wb.ID, identity, live.Add(5*time.Minute))
	mustOpen(t, h, ctx, wb.ID, identity, "Rejoiner", live.Add(55*time.Minute))
	mustClose(t, h, ctx, wb.ID, identity, end)

	rep := h.report(wb.ID)
	row := attendeeRow(t, rep, "Test User")

	if row.WatchMin != 10 {
		t.Errorf("watch time = %d min, want 10 — the gap between visits is being counted", row.WatchMin)
	}
	if len(row.Visits) != 2 {
		t.Fatalf("visits = %d, want 2: %+v", len(row.Visits), row.Visits)
	}
	if row.Visits[0].Minutes != 5 || row.Visits[1].Minutes != 5 {
		t.Errorf("visit minutes = %d and %d, want 5 and 5",
			row.Visits[0].Minutes, row.Visits[1].Minutes)
	}
	// The brackets are the whole session, which is exactly what the old total measured — so
	// a reader can see the difference between "was here from" and "was here for".
	sameInstant(t, row.FirstJoinedAt, live, "first joined")
	sameInstant(t, row.LastLeftAt, end, "last left")
	if rep.AvgWatchMin != 10 {
		t.Errorf("average watch = %d, want 10 — the summary is summing spans, not visits",
			rep.AvgWatchMin)
	}
}

/* TestWaitingForTheHostIsNotWatchTime.
 *
 * Attendees sit in the room while the "waiting for the host" screen is up, so time connected
 * is not time watching. Somebody who arrives twenty minutes early and leaves at half past has
 * been in the room for fifty minutes and seen thirty.
 */
func TestWaitingForTheHostIsNotWatchTime(t *testing.T) {
	h := newHarness(t)
	h.signup("Attendance Host", "early-host@test.dev", true)
	wb := h.newWebinar("Early bird", nil)
	h.goLive(wb.ID)

	live := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Hour)
	pinSessionWindow(t, wb.ID, live, live.Add(time.Hour))

	ctx := t.Context()
	reg := h.registerAs(wb.ID, "early@test.dev")
	identity := "att_" + reg.JoinKey

	mustOpen(t, h, ctx, wb.ID, identity, "Early", live.Add(-20*time.Minute))
	mustClose(t, h, ctx, wb.ID, identity, live.Add(30*time.Minute))

	row := attendeeRow(t, h.report(wb.ID), "Test User")
	if row.WatchMin != 30 {
		t.Errorf("watch time = %d min, want 30 — the waiting screen is being counted as watching",
			row.WatchMin)
	}
	// The arrival is still recorded truthfully: "when did people start showing up" is a real
	// question and clipping the TOTAL must not rewrite the timestamp.
	sameInstant(t, row.FirstJoinedAt, live.Add(-20*time.Minute),
		"first joined (the real arrival, 20 minutes early)")
}

/* TestLostDepartureDoesNotWatchForever.
 *
 * A closed laptop sends no leave. The visit stays open, and an open visit is measured against
 * now() — so without a backstop that person's watch time grows every time anybody opens the
 * report, and a month later they have watched a month.
 */
func TestLostDepartureDoesNotWatchForever(t *testing.T) {
	h := newHarness(t)
	h.signup("Attendance Host", "lid-host@test.dev", true)
	wb := h.newWebinar("Lid closed", nil)
	h.goLive(wb.ID)

	live := time.Now().UTC().Truncate(time.Minute).Add(-3 * time.Hour)
	end := live.Add(time.Hour)
	pinSessionWindow(t, wb.ID, live, end)

	ctx := t.Context()
	reg := h.registerAs(wb.ID, "lid@test.dev")
	identity := "att_" + reg.JoinKey
	mustOpen(t, h, ctx, wb.ID, identity, "Lid", live)

	// Still open: the report has to say "still here" rather than invent a departure...
	row := attendeeRow(t, h.report(wb.ID), "Test User")
	if row.LastLeftAt != "" {
		t.Errorf("last left = %q while the visit is open, want empty", row.LastLeftAt)
	}
	if len(row.Visits) != 1 || row.Visits[0].LeftAt != "" {
		t.Errorf("open visit reported a departure: %+v", row.Visits)
	}
	// ...but it is bounded by the end of the session, not by now(), so it cannot be more than
	// the webinar was long however late the report is read.
	if row.WatchMin != 60 {
		t.Errorf("open visit = %d min, want 60 (clipped to the session), not time since", row.WatchMin)
	}

	// ...and ending the session closes it for good.
	if err := h.store.CloseOpenVisits(ctx, wb.ID, end); err != nil {
		t.Fatalf("close open visits: %v", err)
	}
	row = attendeeRow(t, h.report(wb.ID), "Test User")
	sameInstant(t, row.LastLeftAt, end, "last left, after closing open visits")
	if row.WatchMin != 60 {
		t.Errorf("watch time = %d after closing, want 60", row.WatchMin)
	}
}

/* TestRepeatedWebhooksDoNotDoubleTheTime.
 *
 * LiveKit retries a webhook until it is acknowledged, so a duplicate participant_joined is
 * ordinary. Two open visits for one person would double their time for the rest of the
 * session; the partial unique index is what stops it, and this is the test that says so.
 */
func TestRepeatedWebhooksDoNotDoubleTheTime(t *testing.T) {
	h := newHarness(t)
	h.signup("Attendance Host", "retry-host@test.dev", true)
	wb := h.newWebinar("Retries", nil)
	h.goLive(wb.ID)

	live := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Hour)
	pinSessionWindow(t, wb.ID, live, live.Add(time.Hour))

	ctx := t.Context()
	reg := h.registerAs(wb.ID, "retry@test.dev")
	identity := "att_" + reg.JoinKey

	// The same arrival, delivered three times.
	mustOpen(t, h, ctx, wb.ID, identity, "Retry", live)
	mustOpen(t, h, ctx, wb.ID, identity, "Retry", live.Add(time.Second))
	mustOpen(t, h, ctx, wb.ID, identity, "Retry", live.Add(2*time.Second))
	// And the same departure, twice.
	mustClose(t, h, ctx, wb.ID, identity, live.Add(20*time.Minute))
	mustClose(t, h, ctx, wb.ID, identity, live.Add(40*time.Minute))

	row := attendeeRow(t, h.report(wb.ID), "Test User")
	if len(row.Visits) != 1 {
		t.Fatalf("visits = %d, want 1 — a retried webhook opened a second visit: %+v",
			len(row.Visits), row.Visits)
	}
	if row.WatchMin != 20 {
		t.Errorf("watch time = %d min, want 20 — the second close moved the departure",
			row.WatchMin)
	}
}

/* TestTheStageIsListedButNotCounted.
 *
 * The host is a participant like any other and has an attendance row. Counting it would put
 * them in their own audience and drag the average towards the one person who was present for
 * the whole hour by definition — but dropping them entirely loses the answer to "was my
 * panelist actually there?", so they are listed and labelled instead.
 */
func TestTheStageIsListedButNotCounted(t *testing.T) {
	h := newHarness(t)
	h.signup("Attendance Host", "roles-host@test.dev", true)
	wb := h.newWebinar("Roles", nil)
	h.goLive(wb.ID)

	live := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Hour)
	pinSessionWindow(t, wb.ID, live, live.Add(time.Hour))

	ctx := t.Context()
	reg := h.registerAs(wb.ID, "audience@test.dev")

	// The host, by the identity scheme join.go uses: "user_" plus their id.
	host := "user_" + wb.Host.ID
	mustOpen(t, h, ctx, wb.ID, host, "The Host", live)
	mustClose(t, h, ctx, wb.ID, host, live.Add(time.Hour))

	// One attendee, present for ten minutes.
	att := "att_" + reg.JoinKey
	mustOpen(t, h, ctx, wb.ID, att, "Audience", live)
	mustClose(t, h, ctx, wb.ID, att, live.Add(10*time.Minute))

	rep := h.report(wb.ID)

	if rep.Attended != 1 {
		t.Errorf("attended = %d, want 1 — the host is being counted as audience", rep.Attended)
	}
	if rep.AvgWatchMin != 10 {
		t.Errorf("average watch = %d, want 10 — the host's full hour is in the average",
			rep.AvgWatchMin)
	}

	roles := map[string]string{}
	for _, a := range rep.Attendees {
		roles[a.Name] = a.Role
	}
	if roles["The Host"] != "host" {
		t.Errorf("the host is labelled %q, want \"host\" (rows: %+v)", roles["The Host"], roles)
	}
	if roles["Test User"] != "attendee" {
		t.Errorf("the attendee is labelled %q, want \"attendee\"", roles["Test User"])
	}
	if len(rep.Attendees) != 2 {
		t.Errorf("rows = %d, want 2 — the stage should be listed, not dropped", len(rep.Attendees))
	}
}

// ------------------------------------------------------------------- helpers

func mustOpen(t *testing.T, h *harness, ctx context.Context, slug, identity, name string, at time.Time) {
	t.Helper()
	if err := h.store.OpenVisit(ctx, slug, identity, name, at); err != nil {
		t.Fatalf("open visit for %s at %s: %v", identity, at, err)
	}
}

func mustClose(t *testing.T, h *harness, ctx context.Context, slug, identity string, at time.Time) {
	t.Helper()
	if err := h.store.CloseVisit(ctx, slug, identity, at); err != nil {
		t.Fatalf("close visit for %s at %s: %v", identity, at, err)
	}
}

/* report reads it back the way the browser does, rather than calling the store.
 *
 * The rounding, the clipping and the role are all in the SQL, and a test that called
 * SessionReport directly would still be testing them — but it would not be testing that they
 * survive the JSON, which is where a field renamed on one side of the wire goes missing.
 */
func (h *harness) report(slug string) types.SessionReport {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/report", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("report %s: status %d body %s", slug, res.StatusCode, raw)
	}
	var rep types.SessionReport
	h.decode(raw, &rep)
	return rep
}
