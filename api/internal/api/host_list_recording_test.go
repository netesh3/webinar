package api_test

import (
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The Completed tab's recording filter: ?recording=with|without.
 *
 * "With" means at least one recording the host can play — ready, with bytes.
 * A take that is still processing, or one that failed, does not count, and the
 * filter narrows the Completed count with the rows so the badge and the list
 * agree. Upcoming and Drafts are not narrowed by it.
 */

// addRecording inserts one recording row on a webinar and returns its id.
// parent folds it under an earlier take of the same session.
func (h *harness) addRecording(slug, status string, size, durationMs int64, parent string) string {
	h.t.Helper()
	var id string
	var p any
	if parent != "" {
		p = parent
	}
	if err := h.store.Pool().QueryRow(h.t.Context(), `
		INSERT INTO recordings (webinar_id, status, mime, storage_key, size_bytes, duration_ms, parent_id, stopped_at)
		SELECT id, $2, 'video/mp4', 'rf/' || gen_random_uuid()::text || '.mp4', $3, $4, $5::uuid,
		       CASE WHEN $2 = 'recording' THEN NULL ELSE now() END
		  FROM webinars WHERE slug = $1 RETURNING id::text`,
		slug, status, size, durationMs, p).Scan(&id); err != nil {
		h.t.Fatalf("add %s recording on %s: %v", status, slug, err)
	}
	return id
}

func (h *harness) endedAt(topic string, at time.Time) string {
	h.t.Helper()
	slug := h.createAt(topic, at.Format(time.RFC3339), "scheduled")
	if _, err := h.store.SetStatus(h.t.Context(), slug, types.StatusEnded); err != nil {
		h.t.Fatalf("end %s: %v", slug, err)
	}
	return slug
}

func slugsOf(list []types.Webinar) []string {
	out := make([]string, 0, len(list))
	for _, w := range list {
		out = append(out, w.ID)
	}
	return out
}

func TestHostListRecordingFilter(t *testing.T) {
	h := newHarness(t)
	h.signup("Recorder Host", "recorder@test.dev", true)

	day := time.Now().AddDate(0, 0, 3).UTC().Truncate(time.Minute)
	ready := h.endedAt("Launch recap", day)
	twoTakes := h.endedAt("Launch deep dive", day.Add(time.Hour))
	processing := h.endedAt("Launch Q&A", day.Add(2*time.Hour))
	failed := h.endedAt("Pricing review", day.Add(3*time.Hour))
	empty := h.endedAt("Pricing office hours", day.Add(4*time.Hour))
	none := h.endedAt("Launch retro", day.Add(5*time.Hour))
	upcoming := h.createAt("Launch next", day.AddDate(0, 0, 30).Format(time.RFC3339), "scheduled")
	h.createAt("Launch draft", day.AddDate(0, 0, 30).Format(time.RFC3339), "draft")
	// A ready recording on an upcoming webinar is not a reason to list it under Completed.
	h.addRecording(upcoming, "ready", 1000, 60_000, "")

	h.addRecording(ready, "ready", 1000, 600_000, "")
	first := h.addRecording(twoTakes, "ready", 1000, 300_000, "")
	h.addRecording(twoTakes, "ready", 1000, 120_000, first)
	h.addRecording(twoTakes, "failed", 10, 5_000, first) // a failed part adds no time
	h.addRecording(processing, "processing", 1000, 60_000, "")
	h.addRecording(failed, "failed", 1000, 60_000, "")
	h.addRecording(empty, "ready", 0, 0, "") // ready with no bytes is the missed-webhook case

	with := h.hostPage("?tab=past&recording=with")
	if got, want := slugsOf(with.Items), []string{twoTakes, ready}; !slices.Equal(got, want) {
		t.Errorf("with = %v, want %v", topics(with.Items), want)
	}
	if with.Total != 2 || with.Counts.Past != 2 {
		t.Errorf("with total %d past %d, want 2", with.Total, with.Counts.Past)
	}
	// Only Completed narrows: the other badges still describe their own tabs.
	if with.Counts.Upcoming != 1 || with.Counts.Drafts != 1 {
		t.Errorf("with counts = %+v, want upcoming 1 and drafts 1 untouched", with.Counts)
	}
	if s := with.Recordings[twoTakes]; s.Count != 1 || s.DurationMs != 420_000 {
		t.Errorf("two-take summary = %+v, want one session of 420000ms", s)
	}
	if s := with.Recordings[ready]; s.Count != 1 || s.DurationMs != 600_000 {
		t.Errorf("ready summary = %+v, want one session of 600000ms", s)
	}

	without := h.hostPage("?tab=past&recording=without")
	if got, want := slugsOf(without.Items), []string{none, empty, failed, processing}; !slices.Equal(got, want) {
		t.Errorf("without = %v, want %v", topics(without.Items), want)
	}
	if without.Total != 4 || len(without.Recordings) != 0 {
		t.Errorf("without total %d recordings %v, want 4 and no badges", without.Total, without.Recordings)
	}

	all := h.hostPage("?tab=past")
	if all.Total != 6 || len(all.Recordings) != 2 {
		t.Errorf("unfiltered total %d badges %d, want 6 and 2", all.Total, len(all.Recordings))
	}

	// Other tabs ignore it rather than emptying themselves.
	if up := h.hostPage("?tab=upcoming&recording=without"); up.Total != 1 || len(up.Items) != 1 {
		t.Errorf("upcoming with recording=without = %v, want the one upcoming row", topics(up.Items))
	}

	// Combined with search, dates and paging.
	if got := h.hostPage("?tab=past&recording=with&q=deep"); !slices.Equal(slugsOf(got.Items), []string{twoTakes}) || got.Total != 1 {
		t.Errorf("with+search = %v total %d, want the deep dive", topics(got.Items), got.Total)
	}
	if got := h.hostPage("?tab=past&recording=without&q=pricing"); !slices.Equal(slugsOf(got.Items), []string{empty, failed}) {
		t.Errorf("without+search = %v, want the two pricing sessions", topics(got.Items))
	}
	d := day.Format("2006-01-02")
	if got := h.hostPage("?tab=past&recording=with&from=" + d + "&to=" + d); got.Total != 2 {
		t.Errorf("with+dates total %d, want 2", got.Total)
	}
	if got := h.hostPage("?tab=past&recording=with&from=" + day.AddDate(0, 0, 1).Format("2006-01-02")); got.Total != 0 || len(got.Items) != 0 {
		t.Errorf("with+later dates = %v, want none", topics(got.Items))
	}
	p1 := h.hostPage("?tab=past&recording=without&limit=3")
	if len(p1.Items) != 3 || p1.NextCursor == "" || p1.Total != 4 {
		t.Fatalf("without page 1 = %v cursor %q total %d", topics(p1.Items), p1.NextCursor, p1.Total)
	}
	p2 := h.hostPage("?tab=past&recording=without&limit=3&cursor=" + url.QueryEscape(p1.NextCursor))
	if !slices.Equal(slugsOf(p2.Items), []string{processing}) || p2.NextCursor != "" {
		t.Errorf("without page 2 = %v cursor %q, want the processing one and the end", topics(p2.Items), p2.NextCursor)
	}

	// A bad value is a 422 the UI can recognise.
	res, raw := h.do(http.MethodGet, "/api/host/webinars?tab=past&recording=yes", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "bad_recording" {
		t.Errorf("recording=yes: status %d body %s, want 422 bad_recording", res.StatusCode, raw)
	}

	// Scoped to the caller: another host sees none of these, with or without.
	h.signup("Other Host", "other-recorder@test.dev", true)
	theirs := h.endedAt("Launch recap", day)
	if got := h.hostPage("?tab=past&recording=with"); len(got.Items) != 0 || got.Total != 0 || len(got.Recordings) != 0 {
		t.Errorf("other host with = %v, want nothing", topics(got.Items))
	}
	if got := h.hostPage("?tab=past&recording=without"); !slices.Equal(slugsOf(got.Items), []string{theirs}) {
		t.Errorf("other host without = %v, want only their own", topics(got.Items))
	}
}
