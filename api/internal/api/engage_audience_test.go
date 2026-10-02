package api_test

import (
	"context"
	"net/http"
	"os"
	"strings"
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

	// "Message these N" on the Audience cards resolves the same groups. These filters
	// read the engagement rollup (ce.*); a lookup that forgets that join 500s.
	res, raw = h.do(http.MethodGet, "/api/host/crm/people/ids?filter="+types.PeopleHighlyEngaged, nil)
	var ids types.CRMContactIDsResponse
	h.decode(raw, &ids)
	if res.StatusCode != http.StatusOK || len(ids.ContactIDs) != 1 || ids.ContactIDs[0] != thandi.ID {
		t.Errorf("best people ids = %d %+v (%s), want Thandi", res.StatusCode, ids, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/crm/people/ids?filter="+types.PeopleCameBack, nil)
	h.decode(raw, &ids)
	if res.StatusCode != http.StatusOK || len(ids.ContactIDs) != 1 || ids.ContactIDs[0] != thandi.ID {
		t.Errorf("came back ids = %d %+v (%s), want Thandi", res.StatusCode, ids, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/crm/people/ids?filter="+types.PeopleSlipping, nil)
	h.decode(raw, &ids)
	if res.StatusCode != http.StatusOK || len(ids.ContactIDs) != 1 || ids.ContactIDs[0] != sam.ID {
		t.Errorf("slipping ids = %d %+v (%s), want Sam", res.StatusCode, ids, raw)
	}
}

/* The host is not a member of their own audience.
 *
 * Registering for your own webinar files a contact under the account email, and that
 * contact used to read as a no-show: "Missed all", counted in Everyone / Didn't come /
 * Slipping away, and eligible for Message all. The registration stays — the Attendees
 * tab still lists them — and a co-host who registered with their own email stays too.
 */
func TestHostIsExcludedFromOwnAudience(t *testing.T) {
	h := newHarness(t)
	const hostEmail = "neeraj@acme.dev"
	h.login(hostEmail)

	a := autoWebinar(t, h, "Test Upcoming Webinar")
	b := autoWebinar(t, h, "Second session")
	const hostPhone = "+27 83 000 1111"
	hostContact := registerWithPhone(t, h, a.ID, "Webinar", hostEmail, hostPhone, true)
	registerWithPhone(t, h, b.ID, "Webinar", hostEmail, hostPhone, true)
	ada := registerWithPhone(t, h, a.ID, "Ada", "ada@example.com", "+27 83 000 3333", true)

	co := h.signup("Co Host", "cohost@example.com", false)
	h.login(hostEmail)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+a.ID+"/panelists",
		types.PanelistRequest{Email: co.Email}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+a.ID+"/panelists/"+co.ID+"/co-host",
		types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host: status %d body %s", res.StatusCode, raw)
	}
	cohost := registerWithPhone(t, h, a.ID, "Co", co.Email, "+27 83 000 2222", true)

	// Stored contact emails are lowercased on write. Put the host's back in mixed
	// case, and set the account phone to the number they registered with, so the
	// exclusion has to match email case-insensitively and by phone as well as by
	// the registration's user id.
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `UPDATE crm_contacts SET email = 'Neeraj@Acme.dev' WHERE id = $1::uuid`, hostContact.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET phone = $2 WHERE lower(email) = $1`, hostEmail, hostContact.Phone); err != nil {
		t.Fatal(err)
	}

	start := time.Now().Add(-3 * time.Hour).UTC().Truncate(time.Minute)
	pinSessionWindow(t, a.ID, start, start.Add(60*time.Minute))
	seedWatch(t, h, a.ID, ada.Email, 40, start)
	h.engage.OnScored(context.Background(), a.ID)
	h.engage.OnScored(context.Background(), b.ID)

	hostContactID := hostContact.ID

	listed := false
	for _, row := range registrants(t, h, a.ID) {
		if strings.EqualFold(row.Email, hostEmail) {
			listed = true
		}
	}
	if !listed {
		t.Fatal("host registration was dropped from the webinar roster; only the audience should hide it")
	}

	res, raw := h.do(http.MethodGet, "/api/host/crm/people", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("people: %d %s", res.StatusCode, raw)
	}
	var people types.CRMPeopleResponse
	h.decode(raw, &people)
	if people.Total != 2 || people.Counts.Everyone != 2 || people.Counts.Slipping != 0 ||
		people.Counts.Attended != 1 || people.Counts.NeverAttended != 1 {
		t.Fatalf("counts = %+v total %d, want 2 people, 1 came, 1 didn't, 0 slipping", people.Counts, people.Total)
	}
	sawAda, sawCo := false, false
	for _, p := range people.People {
		if strings.EqualFold(p.Contact.Email, hostEmail) || p.Contact.ID == hostContactID {
			t.Fatalf("host is in the people list: %+v", p.Contact)
		}
		sawAda = sawAda || p.Contact.ID == ada.ID
		sawCo = sawCo || p.Contact.ID == cohost.ID
	}
	if !sawAda || !sawCo {
		t.Fatalf("people = %+v, want Ada and the co-host", people.People)
	}

	for _, filter := range []string{types.PeopleNeverAttended, types.PeopleSlipping, types.PeopleAttended, ""} {
		res, raw = h.do(http.MethodGet, "/api/host/crm/people/ids?filter="+filter, nil)
		var ids types.CRMContactIDsResponse
		h.decode(raw, &ids)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("ids %s: %d %s", filter, res.StatusCode, raw)
		}
		for _, id := range ids.ContactIDs {
			if id == hostContactID {
				t.Errorf("filter %q message set includes the host", filter)
			}
		}
	}
	res, raw = h.do(http.MethodGet, "/api/host/crm/people/ids?filter="+types.PeopleSlipping, nil)
	var slip types.CRMContactIDsResponse
	h.decode(raw, &slip)
	if len(slip.ContactIDs) != 0 {
		t.Errorf("slipping recipients = %+v, want none (only the host registered twice and never came)", slip.ContactIDs)
	}

	sum := audienceSummary(t, h)
	if sum.People != 2 || sum.SlippingCount != 0 || len(sum.Slipping) != 0 {
		t.Fatalf("summary = %+v, want 2 people and no slipping", sum)
	}
	for _, p := range append(sum.Best, sum.Slipping...) {
		if p.ContactID == hostContactID {
			t.Errorf("summary list includes the host: %+v", p)
		}
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+a.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: %d %s", res.StatusCode, raw)
	}
	eng := h.engagementSummary(a.ID)
	sum = audienceSummary(t, h)
	var col *types.CRMAudienceWebinar
	for i := range sum.Webinars {
		if sum.Webinars[i].ID == a.ID {
			col = &sum.Webinars[i]
		}
	}
	if col == nil {
		t.Fatal("ended webinar is missing from the audience chart")
	}
	if col.Registered != eng.KPIs.Registered-1 {
		t.Errorf("chart registered %d, engagement registered %d; the difference should be the host's seat",
			col.Registered, eng.KPIs.Registered)
	}
	if col.Attended != eng.KPIs.Attended {
		t.Errorf("chart attended %d, engagement attended %d; the host did not join", col.Attended, eng.KPIs.Attended)
	}
	if col.Registered > 0 && sum.ShowUpPct != col.Attended*100/col.Registered {
		t.Errorf("show-up %d, want %d from the chart after dropping the host", sum.ShowUpPct, col.Attended*100/col.Registered)
	}

	webinarAud := audiencePreview(t, h, "?audience="+types.AudienceWebinar+"&webinarId="+a.ID)
	if webinarAud.Recipients != 2 || webinarAud.NoNumber != 0 {
		t.Errorf("webinar broadcast audience = %+v, want 2 recipients and the host in none of the buckets", webinarAud)
	}
	opted := audiencePreview(t, h, "?audience="+types.AudienceOptedIn)
	if opted.Recipients != 2 {
		t.Errorf("opted-in broadcast audience = %+v, want 2", opted)
	}
	code, seg, raw := postAudience(t, h, types.CRMBroadcastRequest{
		Audience: types.AudienceSegment, WebinarID: a.ID,
		Segment: &types.CRMSegment{Attendance: types.SegmentNoShow},
		Params:  []types.CRMParam{{Text: "hello"}},
	})
	if code != http.StatusOK || seg.Recipients != 1 {
		t.Fatalf("no-show segment: %d %+v (%s), want the co-host only", code, seg, raw)
	}
	code, picked, raw := postAudience(t, h, types.CRMBroadcastRequest{
		Audience:   types.AudienceContacts,
		ContactIDs: []string{hostContactID, ada.ID, cohost.ID},
		Params:     []types.CRMParam{{Text: "hello"}},
	})
	if code != http.StatusOK || picked.Recipients != 2 {
		t.Fatalf("hand-picked broadcast: %d %+v (%s), want Ada and the co-host", code, picked, raw)
	}
	for _, sample := range append(seg.Samples, picked.Samples...) {
		if sample.ContactID == hostContactID {
			t.Errorf("broadcast sample is the host: %+v", sample)
		}
	}
}
