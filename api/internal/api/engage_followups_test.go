package api_test

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/types"
)

/* seedTier files a registration under an engagement tier, as the engagement compute would. */
func seedTier(t *testing.T, h *harness, slug, email string, tier types.EngagementTier) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `
		INSERT INTO engagement_scores (webinar_id, identity, registration_id, formula_version,
		       email, score, tier, watch_seconds, first_join_min, last_leave_min, join_timing,
		       visits, counts, components, presence, intensity)
		SELECT w.id, 'att_' || r.id, r.id, 1, $2, 60, $3, 600, 0, 10, 'on_time', 1,
		       '{}', '{}', '{}', '{}'
		  FROM registrations r JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND r.email = $2`, slug, email, string(tier)); err != nil {
		t.Fatalf("seed tier: %v", err)
	}
}

func followups(t *testing.T, h *harness, slug string) types.CRMFollowupsResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/webinars/"+slug+"/followups", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("followups: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMFollowupsResponse
	h.decode(raw, &out)
	return out
}

/* The Engagement tab's Follow up: one card per score tier plus the no-shows, counted the
 * way a send to that card resolves, and marked sent once a follow-up went to exactly it. */
func TestEngageFollowupsByTier(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Tier follow-ups")

	registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)
	registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone3, true)

	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Minute)
	pinSessionWindow(t, wb.ID, start, start.Add(60*time.Minute))
	seedWatch(t, h, wb.ID, "thandi@example.com", 55, start)
	seedWatch(t, h, wb.ID, "ayanda@example.com", 8, start)

	if f := followups(t, h, wb.ID); f.Scored || len(f.Groups) != 5 {
		t.Fatalf("before scoring = %+v, want 5 groups, not scored", f)
	}

	seedTier(t, h, wb.ID, "thandi@example.com", types.TierHigh)
	seedTier(t, h, wb.ID, "ayanda@example.com", types.TierRisk)

	f := followups(t, h, wb.ID)
	if !f.Scored || !f.WhatsAppConnected {
		t.Fatalf("followups = %+v, want scored and connected", f)
	}
	by := map[types.EngagementTier]types.CRMFollowupGroup{}
	for _, x := range f.Groups {
		by[x.ID] = x
	}
	want := map[types.EngagementTier]int{types.TierHigh: 1, types.TierEngaged: 0, types.TierPassive: 0,
		types.TierRisk: 1, types.TierNoShow: 1}
	for id, n := range want {
		if got := by[id].Audience.Recipients; got != n {
			t.Errorf("%s recipients = %d, want %d", id, got, n)
		}
	}
	if fs := by[types.TierHigh].Faces; len(fs) != 1 || fs[0].Name != "Thandi" {
		t.Errorf("high faces = %+v, want Thandi", fs)
	}
	if by[types.TierHigh].Broadcast != nil {
		t.Errorf("high broadcast before any send = %+v", by[types.TierHigh].Broadcast)
	}

	// The Attendees roster carries the same tier, for its chips.
	tiers := map[string]types.EngagementTier{}
	for _, r := range registrants(t, h, wb.ID) {
		tiers[r.Email] = r.Tier
	}
	if tiers["thandi@example.com"] != types.TierHigh || tiers["ayanda@example.com"] != types.TierRisk ||
		tiers["sam@example.com"] != "" {
		t.Errorf("roster tiers = %v", tiers)
	}

	high := by[types.TierHigh].Segment
	// A follow-up to exactly the high tier marks that card, and only that card.
	createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Offer", Template: testTemplateUtility, Language: "en_US",
		Params:   []types.CRMParam{{Field: "watched"}},
		Audience: types.AudienceSegment, WebinarID: wb.ID,
		Segment: &high,
	})
	f = followups(t, h, wb.ID)
	for _, x := range f.Groups {
		if (x.Broadcast != nil) != (x.ID == types.TierHigh) {
			t.Errorf("%s broadcast = %+v", x.ID, x.Broadcast)
		}
	}
}
