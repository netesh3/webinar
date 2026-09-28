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

func audienceSummary(t *testing.T, h *harness) types.CRMAudienceSummary {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/audience/summary", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("audience: %d %s", res.StatusCode, raw)
	}
	var out types.CRMAudienceSummary
	h.decode(raw, &out)
	return out
}

func rollupRow(t *testing.T, contactID string) (registered, attended, avg int) {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := pool.QueryRow(ctx, `SELECT registered, attended, avg_score FROM crm_contact_engagement
		WHERE contact_id = $1::uuid`, contactID).Scan(&registered, &attended, &avg); err != nil {
		t.Fatalf("rollup row: %v", err)
	}
	return
}

/* The Audience rollup: filled on registration, refreshed when a webinar is scored — by
 * the scoring service, whichever path computed it — and the same after scoring twice. */
func TestAudienceRollup(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	a := autoWebinar(t, h, "First")
	b := autoWebinar(t, h, "Second")
	thandi := registerWithPhone(t, h, a.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	registerWithPhone(t, h, b.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	sam := registerWithPhone(t, h, a.ID, "Sam", "sam@example.com", broadcastPhone3, true)
	registerWithPhone(t, h, b.ID, "Sam", "sam@example.com", broadcastPhone3, true)

	// Registering is enough to count as registered, before anything is scored.
	if reg, att, _ := rollupRow(t, thandi.ID); reg != 2 || att != 0 {
		t.Fatalf("after registering: registered %d attended %d, want 2 / 0", reg, att)
	}

	// Thandi comes to both, Sam to neither. Scores written as the engagement compute
	// would, then the scoring hook runs.
	start := time.Now().Add(-3 * time.Hour).UTC().Truncate(time.Minute)
	for _, wb := range []types.Webinar{a, b} {
		pinSessionWindow(t, wb.ID, start, start.Add(60*time.Minute))
		seedWatch(t, h, wb.ID, "thandi@example.com", 50, start)
	}
	seedTier(t, h, a.ID, "thandi@example.com", types.TierHigh)
	seedTier(t, h, b.ID, "thandi@example.com", types.TierHigh)
	for _, wb := range []types.Webinar{a, b} {
		h.engage.OnScored(context.Background(), wb.ID)
	}
	reg, att, avg := rollupRow(t, thandi.ID)
	if reg != 2 || att != 2 || avg != 60 {
		t.Fatalf("thandi = %d/%d avg %d, want 2 registered, 2 attended, avg 60", reg, att, avg)
	}
	// Scoring again changes nothing.
	h.engage.OnScored(context.Background(), a.ID)
	if r2, a2, v2 := rollupRow(t, thandi.ID); r2 != reg || a2 != att || v2 != avg {
		t.Fatalf("after re-scoring: %d/%d/%d, want the same %d/%d/%d", r2, a2, v2, reg, att, avg)
	}

	sum := audienceSummary(t, h)
	if sum.People != 2 || sum.CameBack != 1 || sum.BestCount != 1 || sum.SlippingCount != 1 {
		t.Errorf("summary = %+v, want 2 people, 1 came back, 1 best, 1 slipping", sum)
	}
	if len(sum.Best) != 1 || sum.Best[0].ContactID != thandi.ID {
		t.Errorf("best = %+v, want Thandi", sum.Best)
	}
	if len(sum.Slipping) != 1 || sum.Slipping[0].ContactID != sam.ID {
		t.Errorf("slipping = %+v, want Sam", sum.Slipping)
	}

	// The People list reads the same rollup for its filters and columns.
	res, raw := h.do(http.MethodGet, "/api/host/crm/people?filter="+types.PeopleHighlyEngaged, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("people: %d %s", res.StatusCode, raw)
	}
	var people types.CRMPeopleResponse
	h.decode(raw, &people)
	if people.Counts.HighlyEngaged != 1 || len(people.People) != 1 || people.People[0].AvgScore != 60 ||
		people.People[0].Tier != string(types.TierHigh) {
		t.Errorf("people highly engaged = %+v", people.People)
	}
}
