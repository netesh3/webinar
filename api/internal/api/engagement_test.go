package api_test

/* Engagement: the page's numbers, through the endpoints the page calls.
 *
 * The arithmetic is unit-tested in internal/engagement against hand-built inputs. What is
 * tested here is everything around it that a unit test cannot see: that the relay's
 * reactions reach engagement_events, that the loaders read the same rows the rest of the
 * product writes, that paging and filters are applied in SQL, that the CSV streams, and
 * that nobody but the webinar's own host can read any of it.
 *
 * Set TEST_DATABASE_URL to run; skipped otherwise, like every test in this package.
 */

import (
	"encoding/csv"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/types"
)

func (h *harness) engagementSummary(slug string) types.EngagementSummary {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/engagement", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("engagement %s: status %d body %s", slug, res.StatusCode, raw)
	}
	var out types.EngagementSummary
	h.decode(raw, &out)
	return out
}

func (h *harness) engagementPage(slug, query string) types.EngagementAttendeePage {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/engagement/attendees?"+query, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("attendees %s?%s: status %d body %s", slug, query, res.StatusCode, raw)
	}
	var out types.EngagementAttendeePage
	h.decode(raw, &out)
	return out
}

// engagedWebinar is an ended hour with three attendees who did different amounts.
func engagedWebinar(t *testing.T, h *harness) (types.Webinar, []types.Registration) {
	t.Helper()
	h.signup("Engagement Host", "engagement-host@test.dev", true)
	wb := h.liveWebinar("Engagement", nil)
	regs := []types.Registration{
		h.registerAsGuest(wb.ID, "keen@test.dev"),
		h.registerAsGuest(wb.ID, "quiet@test.dev"),
		h.registerAsGuest(wb.ID, "brief@test.dev"),
		h.registerAsGuest(wb.ID, "absent@test.dev"),
	}
	for _, r := range regs[:3] {
		res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
			JoinKey: r.JoinKey, Kind: types.MsgReaction, ID: "react-" + r.JoinKey[:6], Emoji: "👏",
		})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("react: status %d body %s", res.StatusCode, raw)
		}
	}
	res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: regs[0].JoinKey, Kind: types.MsgChat, ID: "chat-000001", Text: "this is great",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("chat: status %d body %s", res.StatusCode, raw)
	}
	if err := h.server.FlushEngagement(t.Context()); err != nil {
		t.Fatal(err)
	}

	live := time.Now().UTC().Truncate(time.Minute).Add(-90 * time.Minute)
	end := live.Add(time.Hour)
	ctx := t.Context()
	mustOpen(t, h, ctx, wb.ID, "att_"+regs[0].JoinKey, "Keen", live.Add(-2*time.Minute))
	mustClose(t, h, ctx, wb.ID, "att_"+regs[0].JoinKey, end)
	mustOpen(t, h, ctx, wb.ID, "att_"+regs[1].JoinKey, "Quiet", live.Add(time.Minute))
	mustClose(t, h, ctx, wb.ID, "att_"+regs[1].JoinKey, live.Add(40*time.Minute))
	mustOpen(t, h, ctx, wb.ID, "att_"+regs[2].JoinKey, "Brief", live.Add(20*time.Minute))
	mustClose(t, h, ctx, wb.ID, "att_"+regs[2].JoinKey, live.Add(25*time.Minute))

	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}
	pinSessionWindow(t, wb.ID, live, end)
	pinEventTimes(t, wb.ID, live.Add(10*time.Minute))
	return wb, regs
}

// pinEventTimes moves the captured events and chat into the pinned live window.
func pinEventTimes(t *testing.T, slug string, at time.Time) {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, q := range []string{
		`UPDATE engagement_events SET occurred_at = $2 WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`,
		`UPDATE chat_messages SET created_at = $2 WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`,
	} {
		if _, err := pool.Exec(t.Context(), q, slug, at); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEngagementReadsCapturedReactionsAndScoresEveryone(t *testing.T) {
	h := newHarness(t)
	wb, regs := engagedWebinar(t, h)
	if st := h.server.EngagementCaptureStats(); st.Written < 3 {
		t.Fatalf("captured %+v, want the three reactions written", st)
	}

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/engagement/recompute", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("recompute: status %d body %s", res.StatusCode, raw)
	}
	s := h.engagementSummary(wb.ID)
	if s.State != types.EngagementReady {
		t.Fatalf("state %s", s.State)
	}
	k := s.KPIs
	if k.Attended != 3 || k.Registered != 4 || k.NoShows != 1 {
		t.Fatalf("attended %d registered %d no-shows %d", k.Attended, k.Registered, k.NoShows)
	}
	if k.Reactions != 3 || k.ChatMessages != 1 {
		t.Fatalf("reactions %d chat %d, want 3 and 1", k.Reactions, k.ChatMessages)
	}
	if s.Webinar.SessionMin != 60 || s.JoinSplit.Early != 1 {
		t.Fatalf("session %d min, join split %+v", s.Webinar.SessionMin, s.JoinSplit)
	}

	page := h.engagementPage(wb.ID, "sort=score&limit=2")
	if page.Total != 3 || len(page.Rows) != 2 || page.NextCursor != "2" || page.Axis.Columns == 0 {
		t.Fatalf("page total %d rows %d next %q axis %+v", page.Total, len(page.Rows), page.NextCursor, page.Axis)
	}
	if page.Rows[0].Identity != "att_"+regs[0].JoinKey || page.Rows[0].Score < page.Rows[1].Score {
		t.Fatalf("not sorted by score: %+v", page.Rows)
	}
	rest := h.engagementPage(wb.ID, "sort=score&limit=2&cursor="+page.NextCursor)
	if len(rest.Rows) != 1 || rest.NextCursor != "" {
		t.Fatalf("second page %d rows next %q", len(rest.Rows), rest.NextCursor)
	}
	byName := h.engagementPage(wb.ID, "sort=watch&dir=asc")
	if byName.Rows[0].Identity != "att_"+regs[2].JoinKey {
		t.Fatalf("shortest watch first: %s", byName.Rows[0].Identity)
	}
	tier := page.Rows[0].Tier
	filtered := h.engagementPage(wb.ID, "tier="+string(tier))
	for _, r := range filtered.Rows {
		if r.Tier != tier {
			t.Fatalf("tier filter leaked %s", r.Tier)
		}
	}
	if found := h.engagementPage(wb.ID, "q=KEEN@test"); found.Total != 1 {
		t.Fatalf("search by email found %d", found.Total)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement/attendees/att_"+regs[0].JoinKey, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("detail: status %d body %s", res.StatusCode, raw)
	}
	var d types.EngagementAttendeeDetail
	h.decode(raw, &d)
	if len(d.Visits) != 1 || len(d.Components) == 0 || len(d.Reactions) != 1 {
		t.Fatalf("detail visits %d components %d reactions %+v", len(d.Visits), len(d.Components), d.Reactions)
	}
	var sawChat bool
	for _, e := range d.Timeline {
		sawChat = sawChat || (e.Kind == types.EventChat && e.Text == "this is great")
	}
	if !sawChat {
		t.Fatalf("timeline is missing the chat line: %+v", d.Timeline)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement.csv", nil)
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/csv") {
		t.Fatalf("csv: status %d type %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	records, err := csv.NewReader(strings.NewReader(string(raw))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 5 {
		t.Fatalf("csv has %d lines, want header + 4 registrants (no-show included)", len(records))
	}
	if last := records[len(records)-1]; last[2] != "false" || last[4] != "no_show" {
		t.Fatalf("no-show row %v", last)
	}
}

func TestEngagementIsOnlyForTheWebinarsHost(t *testing.T) {
	h := newHarness(t)
	wb, regs := engagedWebinar(t, h)
	h.logout()
	h.signup("Other Host", "engagement-other@test.dev", true)
	for _, path := range []string{
		"/engagement", "/engagement/attendees", "/engagement/attendees/att_" + regs[0].JoinKey, "/engagement.csv",
	} {
		res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+path, nil)
		if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusNotFound {
			t.Errorf("another host read %s: status %d", path, res.StatusCode)
		}
	}
	h.logout()
	res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: status %d, want 401", res.StatusCode)
	}
}

func TestEngagementRejectsBadQueries(t *testing.T) {
	h := newHarness(t)
	h.signup("Query Host", "engagement-query@test.dev", true)
	wb := h.newWebinar("Queries", nil)
	for _, q := range []string{"sort=drop", "tier=bogus", "cursor=-1", "limit=x", "dir=sideways"} {
		res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement/attendees?"+q, nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status %d body %s, want 400", q, res.StatusCode, raw)
		}
	}
	s := h.engagementSummary(wb.ID)
	if s.State != types.EngagementNotStarted {
		t.Fatalf("a scheduled webinar is %s", s.State)
	}
	if page := h.engagementPage(wb.ID, ""); page.Total != 0 || page.Rows == nil {
		t.Fatalf("a scheduled webinar has rows: %+v", page)
	}
}
