package api_test

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* GET /api/me/attending: the host portal's Attending tab, paged on the server.
 *
 * Every test builds its own host and its own attendee, so the seed's webinars
 * and registrations are never what a count is counting. */

const (
	attendHostEmail = "attend-host@test.dev"
	attendeeEmail   = "attendee@test.dev"
)

// attendFixture: a host owns the given webinars (topic → start), an attendee is
// registered for every one of them and is signed in when this returns.
func attendFixture(t *testing.T, h *harness, starts map[string]time.Time) map[string]string {
	t.Helper()
	h.signup("Attend Host", attendHostEmail, true)
	slugs := map[string]string{}
	far := time.Now().Add(48 * time.Hour).UTC()
	for topic, at := range starts {
		// Created in the future, then moved: the API refuses a start in the past.
		slug := h.createAt(topic, far.Format(time.RFC3339), "scheduled")
		h.placeFixtureStart(slug, at)
		slugs[topic] = slug
	}
	h.logout()
	h.signup("Attendee", attendeeEmail, false)
	for _, slug := range slugs {
		if _, err := h.store.Register(context.Background(), slug, types.RegisterRequest{
			FirstName: "A", Email: attendeeEmail, Consent: true,
		}, ""); err != nil {
			t.Fatalf("register %s: %v", slug, err)
		}
	}
	return slugs
}

func (h *harness) attending(query string) types.AttendingPage {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/me/attending"+query, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("attending %q: status %d body %s", query, res.StatusCode, raw)
	}
	var page types.AttendingPage
	h.decode(raw, &page)
	return page
}

func attendTopics(items []types.RegisteredWebinar) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Webinar.Topic)
	}
	return out
}

/* Live first, then newest start first, every row exactly once across pages —
 * including three sessions inside one second, which a whole-second cursor would
 * repeat or skip. */
func TestAttendingNewestFirstPagesExactlyOnce(t *testing.T) {
	h := newHarness(t)
	const n = 25
	base := time.Now().AddDate(0, 0, -10).UTC().Truncate(time.Second)
	starts := map[string]time.Time{}
	for i := range n {
		at := base.Add(time.Duration(i) * 7 * time.Hour)
		if i < 3 {
			at = base.Add(time.Duration(i*100) * time.Millisecond)
		}
		starts["S"+at.Format(time.RFC3339Nano)] = at
	}
	slugs := attendFixture(t, h, starts)
	// The oldest session is the one running now: it is pinned above everything.
	oldestTopic := "S" + base.Format(time.RFC3339Nano)
	h.goLive(slugs[oldestTopic])

	var seen []types.RegisteredWebinar
	cursor := ""
	for page := 0; ; page++ {
		if page > n {
			t.Fatal("paging never reached the end")
		}
		q := "?limit=10"
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		got := h.attending(q)
		if got.Total != n {
			t.Errorf("page %d: total = %d, want %d", page, got.Total, n)
		}
		seen = append(seen, got.Items...)
		if got.NextCursor == "" {
			break
		}
		if len(got.Items) != 10 {
			t.Errorf("page %d has a next cursor but %d rows", page, len(got.Items))
		}
		cursor = got.NextCursor
	}
	if len(seen) != n {
		t.Fatalf("paged %d rows, want %d: %v", len(seen), n, attendTopics(seen))
	}
	dup := map[string]bool{}
	for _, it := range seen {
		if dup[it.Webinar.ID] {
			t.Errorf("%s on more than one page", it.Webinar.ID)
		}
		dup[it.Webinar.ID] = true
		if it.Registration.WebinarID != it.Webinar.ID || it.Registration.JoinKey == "" {
			t.Errorf("row %s carries registration %+v", it.Webinar.ID, it.Registration)
		}
	}
	if seen[0].Webinar.Topic != oldestTopic || seen[0].Webinar.Status != types.StatusLive {
		t.Errorf("first row = %q (%s), want the live session pinned", seen[0].Webinar.Topic, seen[0].Webinar.Status)
	}
	for i := 2; i < len(seen); i++ {
		prev, _ := time.Parse(time.RFC3339, seen[i-1].Webinar.StartsAt)
		cur, _ := time.Parse(time.RFC3339, seen[i].Webinar.StartsAt)
		if cur.After(prev) {
			t.Errorf("row %d (%s) starts after row %d (%s): want newest first",
				i, seen[i].Webinar.StartsAt, i-1, seen[i-1].Webinar.StartsAt)
		}
	}
	// The boundary: exactly one full page leaves nothing behind it.
	if got := h.attending("?limit=25"); len(got.Items) != n || got.NextCursor != "" {
		t.Errorf("limit=%d: %d rows, cursor %q; want all and no next page", n, len(got.Items), got.NextCursor)
	}
	if got := h.attending("?limit=24"); len(got.Items) != 24 || got.NextCursor == "" {
		t.Errorf("limit=24: %d rows, cursor %q; want 24 and a next page", len(got.Items), got.NextCursor)
	}
}

// Search matches the topic or the host's name, literally; dates bound starts_at
// inclusively; total follows the filters.
func TestAttendingSearchAndDateRange(t *testing.T) {
	h := newHarness(t)
	day := time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC)
	attendFixture(t, h, map[string]time.Time{
		"Pricing 101":       day,
		"Pricing deep dive": day.AddDate(0, 0, 2).Add(14 * time.Hour), // 23:00 on the 12th
		"Hiring 50% faster": day.AddDate(0, 0, 5),
	})

	if got := h.attending("?q=pricing"); got.Total != 2 || len(got.Items) != 2 {
		t.Errorf("q=pricing: %v total %d, want the two pricing sessions", attendTopics(got.Items), got.Total)
	}
	if got := h.attending("?q=" + url.QueryEscape("50%")); len(got.Items) != 1 || got.Items[0].Webinar.Topic != "Hiring 50% faster" {
		t.Errorf("q=50%%: %v, want the one literal match", attendTopics(got.Items))
	}
	if got := h.attending("?q=" + url.QueryEscape("%")); len(got.Items) != 1 {
		t.Errorf("q=%%: %v, want only the title containing a percent sign", attendTopics(got.Items))
	}
	// Host name: every session here is by "Attend Host".
	if got := h.attending("?q=attend+host"); got.Total != 3 {
		t.Errorf("q=host name: total %d, want 3", got.Total)
	}
	if got := h.attending("?q=nothing-like-this"); got.Total != 0 || len(got.Items) != 0 {
		t.Errorf("no match: %v", attendTopics(got.Items))
	}

	// The 12th includes the session at 23:00 that day.
	got := h.attending("?from=2026-03-10&to=2026-03-12")
	if got.Total != 2 || len(got.Items) != 2 || got.Items[0].Webinar.Topic != "Pricing deep dive" {
		t.Errorf("10th–12th: %v total %d, want deep dive then 101", attendTopics(got.Items), got.Total)
	}
	if got := h.attending("?from=2026-03-11"); got.Total != 2 {
		t.Errorf("from only: total %d, want 2", got.Total)
	}
	if got := h.attending("?to=2026-03-10&q=pricing"); got.Total != 1 || got.Items[0].Webinar.Topic != "Pricing 101" {
		t.Errorf("to+q: %v", attendTopics(got.Items))
	}
}

// Only this account's registrations, and never a session it hosts itself.
func TestAttendingIsScopedToTheCaller(t *testing.T) {
	h := newHarness(t)
	slugs := attendFixture(t, h, map[string]time.Time{
		"Someone else's": time.Now().Add(72 * time.Hour),
	})

	// A host who registers for sessions they host themselves has nothing to
	// attend: both of these are theirs.
	h.logout()
	h.login(attendHostEmail)
	own := h.createAt("My own", time.Now().Add(96*time.Hour).UTC().Format(time.RFC3339), "scheduled")
	for _, slug := range []string{own, slugs["Someone else's"]} {
		if _, err := h.store.Register(context.Background(), slug, types.RegisterRequest{
			FirstName: "H", Email: attendHostEmail, Consent: true,
		}, ""); err != nil {
			t.Fatalf("register host: %v", err)
		}
	}
	if got := h.attending(""); got.Total != 0 || len(got.Items) != 0 {
		t.Errorf("host's attending = %v, want nothing: their own sessions are not attended", attendTopics(got.Items))
	}

	h.logout()
	h.signup("Bystander", "bystander@test.dev", false)
	if got := h.attending(""); got.Total != 0 || len(got.Items) != 0 {
		t.Errorf("bystander sees %v, want nothing", attendTopics(got.Items))
	}

	h.logout()
	h.login(attendeeEmail)
	got := h.attending("")
	if got.Total != 1 || len(got.Items) != 1 || got.Items[0].Webinar.Topic != "Someone else's" {
		t.Errorf("attendee sees %v, want their one registration", attendTopics(got.Items))
	}
	if got.Items[0].Webinar.Passcode != "" {
		t.Error("an attendee row carried the passcode")
	}

	h.logout()
	if res, _ := h.do(http.MethodGet, "/api/me/attending", nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: status %d, want 401", res.StatusCode)
	}
}

// One series signup lists every session of it, each under the same join key —
// what /api/me/registrations does — and those rows page and count like any.
func TestAttendingExpandsASeriesSignup(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "attend-series-host@test.dev", true)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", seriesBody("Office hours", seriesStart(t), 3))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var first types.Webinar
	h.decode(raw, &first)
	h.logout()
	h.signup("Series Attendee", "attend-series@test.dev", false)
	reg := h.registerAs(first.ID, "attend-series@test.dev")

	got := h.attending("?limit=2")
	if got.Total != 3 || len(got.Items) != 2 || got.NextCursor == "" {
		t.Fatalf("page 1 = %v total %d cursor %q, want 2 of 3", attendTopics(got.Items), got.Total, got.NextCursor)
	}
	rest := h.attending("?limit=2&cursor=" + url.QueryEscape(got.NextCursor))
	all := append(got.Items, rest.Items...)
	if len(all) != 3 || rest.NextCursor != "" {
		t.Fatalf("all pages = %d rows, want 3", len(all))
	}
	seen := map[string]bool{}
	for _, it := range all {
		if seen[it.Webinar.ID] || it.Registration.JoinKey != reg.JoinKey || it.Registration.WebinarID != it.Webinar.ID {
			t.Errorf("row %s: dup=%v reg=%+v", it.Webinar.ID, seen[it.Webinar.ID], it.Registration)
		}
		seen[it.Webinar.ID] = true
	}
	// Newest first: the series' first session is the last row.
	if all[2].Webinar.ID != first.ID {
		t.Errorf("last row = %s, want the series' first session %s", all[2].Webinar.ID, first.ID)
	}
}

func TestAttendingRejectsUnusableParameters(t *testing.T) {
	h := newHarness(t)
	h.signup("Param Attendee", "params@test.dev", false)
	for _, q := range []string{"?from=March", "?to=2026-13-01", "?limit=0", "?cursor=!!", "?cursor=" + url.QueryEscape("bm9wZQ")} {
		if res, raw := h.do(http.MethodGet, "/api/me/attending"+q, nil); res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d body %s, want 422", q, res.StatusCode, raw)
		}
	}
}
