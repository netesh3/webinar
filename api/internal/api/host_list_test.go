package api_test

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The host's own list: paging, search, date range, and the counts behind the
 * portal's tabs.
 *
 * All four moved to the server when the list stopped being sent whole. These
 * tests exist because the browser can no longer check any of it — it holds ten
 * rows and has to believe what it is told about the rest.
 *
 * Every test signs up its own host rather than logging in as a seeded one: the
 * seed owns webinars of its own, and a count assertion has to know what it is
 * counting.
 */

// createAt makes one webinar owned by the signed-in caller, at an exact instant,
// and returns its slug. Fractional seconds in startsAt survive — see
// TestHostListPagesEveryRowExactlyOnce for why that matters.
func (h *harness) createAt(topic, startsAt, status string) string {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": topic, "startsAt": startsAt, "durationMin": 30, "status": status,
	})
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("create %q: status %d body %s", topic, res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb.ID
}

// hostPage reads one page of the host list. query is everything after the path,
// including the leading "?".
func (h *harness) hostPage(query string) types.HostWebinarPage {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars"+query, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("host list %q: status %d body %s", query, res.StatusCode, raw)
	}
	var page types.HostWebinarPage
	h.decode(raw, &page)
	return page
}

func topics(list []types.Webinar) []string {
	out := make([]string, 0, len(list))
	for _, w := range list {
		out = append(out, w.Topic)
	}
	return out
}

/* Paging returns every row once, in order, and stops.
 *
 * Three of the 23 sessions share one whole second, and that is the point.
 * types.Webinar formats StartsAt to whole seconds, so a cursor built from the
 * row a client is holding would compare short against the microsecond value in
 * the database and hand the anchor row straight back on the next page. The
 * cursor carries the slug and lets SQL resolve the timestamp precisely for
 * exactly this case; a duplicate in `seen` below is that regression.
 */
func TestHostListPagesEveryRowExactlyOnce(t *testing.T) {
	h := newHarness(t)
	h.signup("Paging Host", "paging@test.dev", true)

	const n = 23
	base := time.Now().AddDate(0, 0, 1).UTC().Truncate(time.Second)
	for i := range n {
		at := base.Add(time.Duration(i) * time.Minute)
		if i < 3 {
			// Inside one second, a tenth of a second apart.
			at = base.Add(time.Duration(i*100) * time.Millisecond)
		}
		h.createAt("Session "+at.Format(time.RFC3339Nano), at.Format(time.RFC3339Nano), "scheduled")
	}

	var seen []types.Webinar
	cursor := ""
	for page := 0; ; page++ {
		if page > n {
			t.Fatal("paging never reached the end")
		}
		q := "?tab=upcoming&limit=10"
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		got := h.hostPage(q)

		if got.Total != n {
			t.Errorf("page %d: total = %d, want %d", page, got.Total, n)
		}
		if got.Counts.Upcoming != n {
			t.Errorf("page %d: upcoming count = %d, want %d", page, got.Counts.Upcoming, n)
		}
		seen = append(seen, got.Items...)

		if got.NextCursor == "" {
			break
		}
		// A page with more behind it must be full, or the cursor is skipping
		// rows it never returned.
		if len(got.Items) != 10 {
			t.Errorf("page %d has a next cursor but only %d rows, want 10", page, len(got.Items))
		}
		cursor = got.NextCursor
	}

	if len(seen) != n {
		t.Fatalf("paged %d rows in total, want %d: %v", len(seen), n, topics(seen))
	}
	slugs := map[string]bool{}
	for _, w := range seen {
		if slugs[w.ID] {
			t.Errorf("%s came back on more than one page", w.ID)
		}
		slugs[w.ID] = true
	}

	// Upcoming runs ascending: the next thing to happen is at the top, and it
	// stays that way across the page boundary.
	for i := 1; i < len(seen); i++ {
		prev, err := time.Parse(time.RFC3339, seen[i-1].StartsAt)
		if err != nil {
			t.Fatalf("startsAt %q: %v", seen[i-1].StartsAt, err)
		}
		cur, err := time.Parse(time.RFC3339, seen[i].StartsAt)
		if err != nil {
			t.Fatalf("startsAt %q: %v", seen[i].StartsAt, err)
		}
		if cur.Before(prev) {
			t.Errorf("row %d (%s) starts before row %d (%s)",
				i, seen[i].StartsAt, i-1, seen[i-1].StartsAt)
		}
	}
}

// Search matches anywhere in the topic, ignoring case, and narrows every tab's
// count — a host who searches is being told which tab holds their matches, so a
// badge that still showed the unfiltered total would be pointing at nothing.
func TestHostListSearchNarrowsRowsAndCounts(t *testing.T) {
	h := newHarness(t)
	h.signup("Search Host", "search@test.dev", true)

	day := time.Now().AddDate(0, 0, 2).UTC().Truncate(time.Minute)
	h.createAt("Quarterly onboarding walkthrough", day.Format(time.RFC3339), "scheduled")
	h.createAt("Security review", day.Add(time.Hour).Format(time.RFC3339), "scheduled")
	h.createAt("Onboarding, second pass", day.Add(2*time.Hour).Format(time.RFC3339), "draft")

	unfiltered := h.hostPage("")
	if unfiltered.Counts.Upcoming != 2 || unfiltered.Counts.Drafts != 1 {
		t.Fatalf("unfiltered counts = %+v, want 2 upcoming and 1 draft", unfiltered.Counts)
	}

	for _, q := range []string{"onboarding", "ONBOARDING", "boardin"} {
		got := h.hostPage("?q=" + url.QueryEscape(q))
		if len(got.Items) != 1 || got.Items[0].Topic != "Quarterly onboarding walkthrough" {
			t.Errorf("q=%q returned %v, want just the quarterly walkthrough", q, topics(got.Items))
		}
		if got.Total != 1 {
			t.Errorf("q=%q: total = %d, want 1", q, got.Total)
		}
		// The draft matches too, and the badge has to say so.
		if got.Counts.Upcoming != 1 || got.Counts.Drafts != 1 || got.Counts.Past != 0 {
			t.Errorf("q=%q: counts = %+v, want 1 upcoming, 1 draft, 0 past", q, got.Counts)
		}
	}

	if got := h.hostPage("?q=" + url.QueryEscape("nothing by this name")); len(got.Items) != 0 {
		t.Errorf("a search that matches nothing returned %v", topics(got.Items))
	}
}

/* A wildcard the host typed is a character, not an operator.
 *
 * "50%" unescaped becomes the pattern %50%% — every topic containing "50",
 * which is not what anybody typing a percentage means. Same for "_", which
 * would quietly match any single character.
 */
func TestHostListSearchTreatsWildcardsLiterally(t *testing.T) {
	h := newHarness(t)
	h.signup("Wildcard Host", "wildcard@test.dev", true)

	day := time.Now().AddDate(0, 0, 3).UTC().Truncate(time.Minute)
	h.createAt("50% faster builds", day.Format(time.RFC3339), "scheduled")
	h.createAt("50 ways to lose a viewer", day.Add(time.Hour).Format(time.RFC3339), "scheduled")
	h.createAt("kick_off planning", day.Add(2*time.Hour).Format(time.RFC3339), "scheduled")
	h.createAt("kickoff planning", day.Add(3*time.Hour).Format(time.RFC3339), "scheduled")

	for _, tc := range []struct{ q, want string }{
		{"50%", "50% faster builds"},
		{"kick_off", "kick_off planning"},
	} {
		got := h.hostPage("?q=" + url.QueryEscape(tc.q))
		if len(got.Items) != 1 || got.Items[0].Topic != tc.want {
			t.Errorf("q=%q returned %v, want just %q", tc.q, topics(got.Items), tc.want)
		}
	}
}

// from/to bound starts_at inclusively on both ends. The end of the `to` day
// counts: a bare date otherwise means midnight, which would drop every session
// on the day the host actually picked.
func TestHostListDateRangeIsInclusiveOnBothEnds(t *testing.T) {
	h := newHarness(t)
	h.signup("Range Host", "range@test.dev", true)

	// Fixed UTC instants: from/to are read as UTC days, so an assertion about
	// which side of a boundary a session falls on has to be written in UTC.
	h.createAt("On the from boundary", "2027-03-10T00:00:00Z", "scheduled")
	h.createAt("Inside the range", "2027-03-15T12:00:00Z", "scheduled")
	h.createAt("Late on the to boundary", "2027-03-20T23:30:00Z", "scheduled")
	h.createAt("After the range", "2027-04-01T09:00:00Z", "scheduled")

	got := h.hostPage("?from=2027-03-10&to=2027-03-20")
	if len(got.Items) != 3 || got.Total != 3 {
		t.Fatalf("range returned %d rows (total %d): %v, want the three inside it",
			len(got.Items), got.Total, topics(got.Items))
	}
	for _, w := range got.Items {
		if w.Topic == "After the range" {
			t.Error("a session past the to date came back")
		}
	}

	// One end alone still means something: everything up to here.
	if got := h.hostPage("?to=2027-03-10"); len(got.Items) != 1 {
		t.Errorf("to alone returned %v, want only the March 10 session", topics(got.Items))
	}
	if got := h.hostPage("?from=2027-04-01"); len(got.Items) != 1 {
		t.Errorf("from alone returned %v, want only the April session", topics(got.Items))
	}
}

/* Past runs newest first, the opposite of Upcoming.
 *
 * A host reviewing what happened means the session that just ended, not the
 * first one they ever ran. Ordering per tab is also what the cursor comparison
 * has to flip direction for, so this covers the descending keyset as well.
 */
func TestHostListPastTabIsNewestFirst(t *testing.T) {
	h := newHarness(t)
	h.signup("History Host", "history@test.dev", true)

	day := time.Now().AddDate(0, 0, 4).UTC().Truncate(time.Minute)
	oldest := h.createAt("First ever", day.Format(time.RFC3339), "scheduled")
	middle := h.createAt("The one after", day.Add(time.Hour).Format(time.RFC3339), "scheduled")
	newest := h.createAt("Most recent", day.Add(2*time.Hour).Format(time.RFC3339), "scheduled")

	for _, slug := range []string{oldest, middle, newest} {
		if _, err := h.store.SetStatus(t.Context(), slug, types.StatusEnded); err != nil {
			t.Fatalf("end %s: %v", slug, err)
		}
	}

	got := h.hostPage("?tab=past")
	if len(got.Items) != 3 {
		t.Fatalf("past returned %v, want three ended sessions", topics(got.Items))
	}
	if got.Items[0].ID != newest || got.Items[2].ID != oldest {
		t.Errorf("past order = %v, want most recent first", topics(got.Items))
	}
	// Ended sessions are past and nothing else — the upcoming badge must not
	// still be counting them.
	if got.Counts.Past != 3 || got.Counts.Upcoming != 0 {
		t.Errorf("counts = %+v, want 3 past and 0 upcoming", got.Counts)
	}

	// Descending paging, one row at a time, still walks straight down.
	first := h.hostPage("?tab=past&limit=1")
	if len(first.Items) != 1 || first.Items[0].ID != newest || first.NextCursor == "" {
		t.Fatalf("first page of one = %v (cursor %q), want the newest and more to come",
			topics(first.Items), first.NextCursor)
	}
	second := h.hostPage("?tab=past&limit=1&cursor=" + url.QueryEscape(first.NextCursor))
	if len(second.Items) != 1 || second.Items[0].ID != middle {
		t.Errorf("second page of one = %v, want the middle session", topics(second.Items))
	}
}

// Counts describe all three tabs whichever one was asked for, because the
// portal draws all three badges from one response.
func TestHostListCountsEveryTabAtOnce(t *testing.T) {
	h := newHarness(t)
	h.signup("Tally Host", "tally@test.dev", true)

	day := time.Now().AddDate(0, 0, 5).UTC().Truncate(time.Minute)
	h.createAt("Coming up", day.Format(time.RFC3339), "scheduled")
	h.createAt("Half written", day.Add(time.Hour).Format(time.RFC3339), "draft")
	done := h.createAt("Already run", day.Add(2*time.Hour).Format(time.RFC3339), "scheduled")
	if _, err := h.store.SetStatus(t.Context(), done, types.StatusEnded); err != nil {
		t.Fatalf("end %s: %v", done, err)
	}

	want := types.HostWebinarCounts{Upcoming: 1, Past: 1, Drafts: 1}
	for _, tab := range []string{"", "?tab=upcoming", "?tab=past", "?tab=drafts"} {
		if got := h.hostPage(tab); got.Counts != want {
			t.Errorf("tab %q: counts = %+v, want %+v", tab, got.Counts, want)
		}
	}

	// No tab means upcoming, the same page the portal opens on.
	if got := h.hostPage(""); len(got.Items) != 1 || got.Items[0].Topic != "Coming up" {
		t.Errorf("default tab returned %v, want the upcoming session", topics(got.Items))
	}
}

// A parameter the server cannot act on is refused, with a code the UI can tell
// apart from "something went wrong" — a stale cursor means reload the list, not
// that the list is broken.
func TestHostListRejectsUnusableParameters(t *testing.T) {
	h := newHarness(t)
	h.signup("Picky Host", "picky@test.dev", true)

	for _, tc := range []struct{ query, code string }{
		{"?tab=upcomming", "bad_tab"},
		{"?tab=everything", "bad_tab"},
		{"?from=10-03-2027", "bad_from"},
		{"?to=next+tuesday", "bad_to"},
		{"?limit=0", "bad_limit"},
		{"?limit=-5", "bad_limit"},
		{"?limit=ten", "bad_limit"},
		{"?cursor=" + url.QueryEscape("not base64 !!"), "bad_cursor"},
	} {
		res, raw := h.do(http.MethodGet, "/api/host/webinars"+tc.query, nil)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d body %s, want 422", tc.query, res.StatusCode, raw)
			continue
		}
		var err types.APIError
		h.decode(raw, &err)
		if err.Error != tc.code {
			t.Errorf("%s: code %q, want %q", tc.query, err.Error, tc.code)
		}
	}

	// And a limit above the cap is clamped rather than refused: asking for too
	// much is not a mistake, it just does not get the whole table.
	h.createAt("Only one", time.Now().AddDate(0, 0, 6).UTC().Format(time.RFC3339), "scheduled")
	if got := h.hostPage("?limit=100000"); len(got.Items) != 1 {
		t.Errorf("clamped limit returned %d rows, want the 1 that exists", len(got.Items))
	}
}
