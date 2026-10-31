package api_test

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Recording retention: the default window, "Keep longer", the storage quota per plan and per
 * account, the expiry reminders and the email's signed link. See recording_retention.go. */

const gib = int64(1) << 30

func retention30(c *config.Config) { c.RecordingsRetentionDays = 30 }

// endedRecording is one ready session on a fresh ended webinar, stopped `ago` before now.
func (h *harness) endedRecording(topic string, size int64, ago time.Duration) (slug, id string) {
	h.t.Helper()
	slug = h.endedAt(topic, time.Now().AddDate(0, 0, 3).UTC().Truncate(time.Minute))
	id = h.addRecording(slug, "ready", size, 60_000, "")
	if _, err := h.store.Pool().Exec(h.t.Context(),
		`UPDATE recordings SET created_at = now() - $2::interval - interval '1 hour', stopped_at = now() - $2::interval WHERE id = $1::uuid`,
		id, ago.String()); err != nil {
		h.t.Fatal(err)
	}
	return slug, id
}

func (h *harness) recordingIn(slug, id string) types.Recording {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/recordings", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("list recordings: %d %s", res.StatusCode, raw)
	}
	var list []types.Recording
	h.decode(raw, &list)
	for _, r := range list {
		if r.ID == id {
			return r
		}
	}
	h.t.Fatalf("recording %s not in %s", id, raw)
	return types.Recording{}
}

func (h *harness) storage() types.RecordingStorage {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/recording-storage", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("recording storage: %d %s", res.StatusCode, raw)
	}
	var st types.RecordingStorage
	h.decode(raw, &st)
	return st
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("time %q: %v", s, err)
	}
	return at
}

func near(a, b time.Time) bool { d := a.Sub(b); return d < time.Minute && d > -time.Minute }

func TestRecordingKeepLongerIsRepeatable(t *testing.T) {
	h := newHarness(t, retention30)
	h.signup("Keeper", "keeper@test.dev", true)
	slug, id := h.endedRecording("Keep me", 100<<20, time.Hour)
	stopped := time.Now().Add(-time.Hour)

	rec := h.recordingIn(slug, id)
	if rec.RetentionDays != 30 || rec.Extended || !rec.CanExtend {
		t.Fatalf("fresh recording = %+v, want 30 days, not extended, can extend", rec)
	}
	def := stopped.AddDate(0, 0, 30)
	if got := mustTime(t, rec.ExpiresAt); !near(got, def) {
		t.Errorf("default expiry %v, want 30 days from the end (%v)", got, def)
	}

	want := def
	for i := 1; i <= 2; i++ {
		res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings/"+id+"/keep", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("keep #%d: %d %s", i, res.StatusCode, raw)
		}
		var kept types.Recording
		h.decode(raw, &kept)
		want = types.AddMonths(want, types.RecordingKeepMonths)
		if got := mustTime(t, kept.ExpiresAt); !near(got, want) || !kept.Extended {
			t.Errorf("after keep #%d: expires %v extended %v, want %v", i, got, kept.Extended, want)
		}
	}

	// Kept from a month end, whatever today is: 30 Nov + 3 months is the end of February.
	monthEnd := time.Date(time.Now().Year()+1, time.November, 30, 12, 0, 0, 0, time.UTC)
	if _, err := h.store.Pool().Exec(t.Context(), `UPDATE recordings SET keep_until = $2 WHERE id = $1::uuid`, id, monthEnd); err != nil {
		t.Fatal(err)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings/"+id+"/keep", nil)
	var kept types.Recording
	h.decode(raw, &kept)
	feb := time.Date(monthEnd.Year()+1, time.March, 0, 12, 0, 0, 0, time.UTC)
	if got := mustTime(t, kept.ExpiresAt); res.StatusCode != http.StatusOK || !got.Equal(feb) {
		t.Errorf("keep from 30 Nov: %d expires %v, want %v", res.StatusCode, got, feb)
	}

	// "Let it expire" undoes it and stops reminders; the default window is still ahead.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings/"+id+"/let-expire", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("let expire: %d %s", res.StatusCode, raw)
	}
	var let types.Recording
	h.decode(raw, &let)
	if got := mustTime(t, let.ExpiresAt); !near(got, def) || let.Extended || !let.RemindersOff {
		t.Errorf("after let-expire = %+v (%v), want back on %v with reminders off", let, got, def)
	}
}

func TestRecordingQuotaByPlanAndOverride(t *testing.T) {
	h := newHarness(t, retention30)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	host := h.signup("Quota Host", "quota@test.dev", true)
	ctx := context.Background()

	cases := []struct {
		plan  types.Plan
		trial bool
		want  int64
	}{
		{"", false, 2 * gib},
		{types.PlanProfessional, false, 10 * gib},
		{types.PlanBusiness, false, 50 * gib},
		{types.PlanEnterprise, false, 200 * gib},
		{types.PlanBusiness, true, 10 * gib}, // a trial is Professional
	}
	for _, c := range cases {
		if _, err := h.store.SetUserPlan(ctx, host.ID, c.plan); err != nil {
			t.Fatal(err)
		}
		if c.trial {
			if _, err := h.store.Pool().Exec(ctx, `UPDATE subscriptions SET status = 'trialing' WHERE user_id = $1::uuid`, host.ID); err != nil {
				t.Fatal(err)
			}
		}
		if st := h.storage(); st.QuotaBytes != c.want || st.PlanQuotaBytes != c.want || st.QuotaOverride {
			t.Errorf("plan %q trial %v: quota %d plan %d, want %d", c.plan, c.trial, st.QuotaBytes, st.PlanQuotaBytes, c.want)
		}
	}
	if _, err := h.store.SetUserPlan(ctx, host.ID, ""); err != nil {
		t.Fatal(err)
	}

	// 3 GB stored on no plan (2 GB): over, and "Keep longer" is refused with the numbers.
	slug, id := h.endedRecording("Big one", 3*gib, time.Hour)
	if st := h.storage(); st.UsedBytes != 3*gib || !st.OverQuota {
		t.Fatalf("storage = %+v, want 3 GB used and over quota", st)
	}
	if rec := h.recordingIn(slug, id); rec.CanExtend {
		t.Errorf("canExtend over quota")
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings/"+id+"/keep", nil)
	var qe types.RecordingQuotaError
	h.decode(raw, &qe)
	if res.StatusCode != http.StatusConflict || qe.Error != "quota_exceeded" || qe.QuotaBytes != 2*gib ||
		!strings.Contains(qe.Message, "upgrade") {
		t.Fatalf("keep over quota: %d %s, want 409 quota_exceeded", res.StatusCode, raw)
	}

	// Only an admin may override it.
	five := 5 * gib
	days := 45
	body := types.SetUserRecordingStorageRequest{RecordingQuotaBytes: &five, RecordingRetentionDays: &days}
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/recording-storage", body); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin override: %d %s, want 403", res.StatusCode, raw)
	}
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/recording-storage", body); res.StatusCode != http.StatusOK {
		t.Fatalf("admin override: %d %s", res.StatusCode, raw)
	}
	bad := int64(0)
	if res, _ := h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/recording-storage",
		types.SetUserRecordingStorageRequest{RecordingQuotaBytes: &bad}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("zero quota: %d, want 422", res.StatusCode)
	}
	_, raw = h.do(http.MethodGet, "/api/admin/users?q=quota@test.dev", nil)
	var users []types.AdminUser
	h.decode(raw, &users)
	if len(users) != 1 || users[0].RecordingLimitBytes != five || users[0].PlanRecordingLimitBytes != 2*gib ||
		users[0].RecordingUsedBytes != 3*gib || users[0].RecordingRetentionDays == nil || *users[0].RecordingRetentionDays != 45 ||
		users[0].DefaultRecordingRetentionDays != 30 {
		t.Fatalf("admin list = %s", raw)
	}

	h.login("quota@test.dev")
	if st := h.storage(); st.QuotaBytes != five || !st.QuotaOverride || st.OverQuota || st.RetentionDays != 45 {
		t.Errorf("storage after override = %+v", st)
	}
	// The account's own retention days apply to its recordings.
	stopped := time.Now().Add(-time.Hour)
	if rec := h.recordingIn(slug, id); !near(mustTime(t, rec.ExpiresAt), stopped.AddDate(0, 0, 45)) || rec.RetentionDays != 45 {
		t.Errorf("expiry with 45-day override = %s (%d days)", rec.ExpiresAt, rec.RetentionDays)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings/"+id+"/keep", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("keep under the override: %d %s", res.StatusCode, raw)
	}

	// Back on the plan: over again.
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/recording-storage", types.SetUserRecordingStorageRequest{}); res.StatusCode != http.StatusOK {
		t.Fatalf("clear override: %d %s", res.StatusCode, raw)
	}
	h.login("quota@test.dev")
	if st := h.storage(); st.QuotaBytes != 2*gib || st.QuotaOverride || !st.OverQuota || st.RetentionDays != 30 {
		t.Errorf("storage after clearing = %+v", st)
	}
}

func TestRecordingStartedOverQuotaIsNotExtended(t *testing.T) {
	h := newHarness(t, retention30)
	host := h.signup("Full Host", "full@test.dev", true)
	ctx := context.Background()

	// 1.9 of 2 GB: a warning, no flag.
	_, small := h.endedRecording("Nearly full", 19*gib/10, 2*time.Hour)
	if msg := api.RecordingStartStorage(h.server, ctx, host.ID, small); !strings.Contains(msg, "almost full") {
		t.Errorf("at 95%%: %q, want a warning", msg)
	}
	// Over: the new recording is flagged, and stays unextendable after space is freed.
	slug, id := h.endedRecording("Over", gib/5, time.Hour)
	if msg := api.RecordingStartStorage(h.server, ctx, host.ID, id); !strings.Contains(msg, "full") {
		t.Errorf("over quota: %q, want the full warning", msg)
	}
	if _, err := h.store.Pool().Exec(ctx, `DELETE FROM recordings WHERE id = $1::uuid`, small); err != nil {
		t.Fatal(err)
	}
	if st := h.storage(); st.OverQuota {
		t.Fatalf("still over after deleting: %+v", st)
	}
	rec := h.recordingIn(slug, id)
	if !rec.OverQuota || rec.CanExtend {
		t.Errorf("flagged recording = %+v, want overQuota and no canExtend", rec)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings/"+id+"/keep", nil); res.StatusCode != http.StatusConflict ||
		!strings.Contains(string(raw), "quota_exceeded") {
		t.Errorf("keep flagged: %d %s, want 409", res.StatusCode, raw)
	}
}

func expiryNotifications(t *testing.T, h *harness, hostID, email string) (bells, emails int, lastBody string) {
	t.Helper()
	ctx := context.Background()
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE user_id = $1::uuid), count(*) FILTER (WHERE email = $2)
		  FROM notifications WHERE kind = 'recording_expiring'`, hostID, email).Scan(&bells, &emails); err != nil {
		t.Fatal(err)
	}
	_ = h.store.Pool().QueryRow(ctx, `
		SELECT body FROM notifications WHERE kind = 'recording_expiring' AND email = $1
		 ORDER BY created_at DESC LIMIT 1`, email).Scan(&lastBody)
	return bells, emails, lastBody
}

var keepLink = regexp.MustCompile(`/recordings/keep\?(\S+)`)

func TestRecordingExpiryRemindersAndKeepLink(t *testing.T) {
	h := newHarness(t, retention30)
	host := h.signup("Reminded", "reminded@test.dev", true)
	ctx := context.Background()
	sweep := func() { api.SweepRecordingExpiryReminders(h.server, ctx) }

	// Two expiring within the week, one not yet, one the host let go.
	slugA, a := h.endedRecording("Expiring A", 10<<20, 24*24*time.Hour) // 6 days left
	_, b := h.endedRecording("Expiring B", 10<<20, 25*24*time.Hour)     // 5 days left
	h.endedRecording("Plenty of time", 10<<20, 2*24*time.Hour)
	slugD, d := h.endedRecording("Let go", 10<<20, 25*24*time.Hour)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slugD+"/recordings/"+d+"/let-expire", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("let expire: %d %s", res.StatusCode, raw)
	}

	sweep()
	bells, emails, body := expiryNotifications(t, h, host.ID, "reminded@test.dev")
	if bells != 1 || emails != 1 {
		t.Fatalf("after first sweep: %d bells %d emails, want one of each (batched)", bells, emails)
	}
	if !strings.Contains(body, "Expiring A") || !strings.Contains(body, "Expiring B") ||
		strings.Contains(body, "Plenty of time") || strings.Contains(body, "Let go") {
		t.Errorf("email lists the wrong recordings:\n%s", body)
	}
	sweep()
	if bells, emails, _ := expiryNotifications(t, h, host.ID, "reminded@test.dev"); bells != 1 || emails != 1 {
		t.Errorf("second sweep resent: %d bells %d emails", bells, emails)
	}

	// The 1-day stage is its own reminder, once.
	if _, err := h.store.Pool().Exec(ctx,
		`UPDATE recordings SET stopped_at = now() - interval '29 days 12 hours' WHERE id = $1::uuid`, b); err != nil {
		t.Fatal(err)
	}
	sweep()
	sweep()
	bells, emails, body = expiryNotifications(t, h, host.ID, "reminded@test.dev")
	if bells != 2 || emails != 2 || !strings.Contains(body, "Expiring B") || strings.Contains(body, "Expiring A") {
		t.Fatalf("1-day stage: %d bells %d emails, body:\n%s", bells, emails, body)
	}

	// The signed link in the first email keeps A for 3 more months, once.
	var first string
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT body FROM notifications WHERE kind = 'recording_expiring' AND email = $1
		 ORDER BY created_at LIMIT 1`, "reminded@test.dev").Scan(&first); err != nil {
		t.Fatal(err)
	}
	var linkA url.Values
	for _, m := range keepLink.FindAllStringSubmatch(first, -1) {
		q, err := url.ParseQuery(m[1])
		if err != nil {
			t.Fatal(err)
		}
		if q.Get("r") == a {
			linkA = q
		}
	}
	if linkA == nil {
		t.Fatalf("no keep link for A in:\n%s", first)
	}
	e, _ := strconv.ParseInt(linkA.Get("e"), 10, 64)
	req := types.KeepRecordingLinkRequest{Recording: a, Expires: e, Sig: linkA.Get("s")}

	before := mustTime(t, h.recordingIn(slugA, a).ExpiresAt)
	tampered := req
	tampered.Expires = e + 86400
	if res, raw := h.do(http.MethodPost, "/api/host/recordings/keep-link", tampered); res.StatusCode != http.StatusForbidden {
		t.Errorf("tampered link: %d %s, want 403", res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodPost, "/api/host/recordings/keep-link", req)
	var kept types.KeepRecordingLinkResponse
	h.decode(raw, &kept)
	if res.StatusCode != http.StatusOK || kept.Status != "kept" || !near(mustTime(t, kept.ExpiresAt), types.AddMonths(before, types.RecordingKeepMonths)) {
		t.Fatalf("keep link: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/host/recordings/keep-link", req)
	h.decode(raw, &kept)
	if res.StatusCode != http.StatusOK || kept.Status != "already_kept" || !near(mustTime(t, kept.ExpiresAt), types.AddMonths(before, types.RecordingKeepMonths)) {
		t.Errorf("reused link: %d %s, want already_kept and no second extension", res.StatusCode, raw)
	}

	// Somebody else signed in: refused, even with the owner's valid link.
	h.signup("Other Host", "other@test.dev", true)
	if res, raw := h.do(http.MethodPost, "/api/host/recordings/keep-link", req); res.StatusCode != http.StatusForbidden {
		t.Errorf("another account: %d %s, want 403", res.StatusCode, raw)
	}
}

func TestExpiredDeletionSkipsExtended(t *testing.T) {
	h := newHarness(t, retention30)
	h.signup("Sweeper", "sweeper@test.dev", true)
	ctx := context.Background()

	slugOld, old := h.endedRecording("Expired", 10<<20, 31*24*time.Hour)
	slugKept, kept := h.endedRecording("Kept", 10<<20, 31*24*time.Hour)
	// Kept longer before the sweep came round: 3 months from its (already passed) expiry.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slugKept+"/recordings/"+kept+"/keep", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("keep: %d %s", res.StatusCode, raw)
	}
	api.SweepExpiredRecordings(h.server, ctx)

	var left []string
	rows, err := h.store.Pool().Query(ctx, `SELECT id::text FROM recordings WHERE id = ANY($1::uuid[])`, []string{old, kept})
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		left = append(left, id)
	}
	rows.Close()
	if len(left) != 1 || left[0] != kept {
		t.Fatalf("after sweep %v, want only the kept one (%s)", left, kept)
	}
	var logged int
	if err := h.store.Pool().QueryRow(ctx, `SELECT count(*) FROM recording_deletions WHERE recording_id = $1::uuid`, old).Scan(&logged); err != nil || logged != 1 {
		t.Errorf("deletion not recorded: %d %v", logged, err)
	}
	_ = slugOld

	// The Completed list's badge carries the soonest expiry.
	page := h.hostPage("?tab=past")
	if s, ok := page.Recordings[slugKept]; !ok || s.ExpiresAt == "" {
		t.Errorf("summary for kept = %+v, want an expiry", page.Recordings[slugKept])
	}
}
