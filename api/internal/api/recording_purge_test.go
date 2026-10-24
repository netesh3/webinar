package api_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/mp4probe/mp4fake"
	"github.com/netkumar/webcast/api/types"
)

/* The admin's "Delete all recordings" (recording_purge.go): every recording of every host,
 * its files, clips and uploads, and nothing that is not a recording. */

// ListMultipartUploads makes the fake bucket a media.MultipartLister.
func (f *fakeBucket) ListMultipartUploads(context.Context) ([]media.PendingUpload, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []media.PendingUpload
	for id, key := range f.keys {
		if _, open := f.uploads[id]; open {
			out = append(out, media.PendingUpload{Key: key, UploadID: id, Initiated: time.Now().Add(-time.Minute)})
		}
	}
	return out, nil
}

func (f *fakeBucket) put(t *testing.T, key, body string) {
	t.Helper()
	if _, err := f.Append(context.Background(), key, strings.NewReader(body)); err != nil {
		t.Fatalf("put %s: %v", key, err)
	}
}

func (h *harness) objectExists(key string) bool {
	_, err := os.Stat(filepath.Join(h.recordingsDir, filepath.FromSlash(key)))
	return err == nil
}

func (h *harness) count(sql string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		h.t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// purge runs the purge to the end the way the admin page does: POST until done.
func (h *harness) purge() types.RecordingPurgeStatus {
	h.t.Helper()
	for i := 0; i < 20; i++ {
		res, raw := h.do(http.MethodPost, "/api/admin/recordings/purge",
			types.RecordingPurgeRequest{Confirm: types.RecordingPurgeConfirm})
		if res.StatusCode != http.StatusOK {
			h.t.Fatalf("purge: %d %s", res.StatusCode, raw)
		}
		var st types.RecordingPurgeStatus
		h.decode(raw, &st)
		if st.Latest == nil {
			h.t.Fatalf("purge: no run in %s", raw)
		}
		if st.Latest.LastError != "" {
			h.t.Fatalf("purge step failed: %s", st.Latest.LastError)
		}
		if st.Latest.Phase == types.PurgeDone {
			return st
		}
		// Nothing in these tests is uploading for real; skip the wait for stopped recorders.
		h.exec(`UPDATE recording_purges SET settle_until = NULL`)
	}
	h.t.Fatal("purge never finished")
	return types.RecordingPurgeStatus{}
}

func TestAdminPurgeDeletesEveryRecordingAndNothingElse(t *testing.T) {
	h, bucket, host1 := uploadHarness(t, "purge-host-one@test.dev")
	ctx := context.Background()

	// Host one: a recorded, published session with a clip, an uploaded video playing as a
	// scheduled simulive, and an upload still arriving.
	wb := h.liveWebinar("Purge session one", nil)
	rec1 := readyRecording(t, h, wb.ID)
	publishRecording(t, h, wb.ID, rec1.ID, true)
	clipID := uuid.NewString()
	clipKey := "clips/" + clipID[:2] + "/" + clipID + ".mp4"
	h.exec(`INSERT INTO clip_jobs (id, recording_id, kind, format, segments, duration_sec, status, storage_key, size_bytes)
	        VALUES ($1::uuid, $2::uuid, 'clip', '9x16', '[]', 10, 'ready', $3, 7)`, clipID, rec1.ID, clipKey)
	bucket.put(t, clipKey, "a-clip!")
	h.exec(`INSERT INTO clip_plans (clip_id) VALUES ($1::uuid)`, clipID)
	h.exec(`INSERT INTO recording_highlights (recording_id, status) VALUES ($1::uuid, 'ready')`, rec1.ID)

	res, raw := h.uploadVideo("Encore.mp4", mp4fake.Build(mp4fake.Spec{Audio: "mp4a", DurationMs: 20 * 60_000}))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d %s", res.StatusCode, raw)
	}
	var video types.Recording
	h.decode(raw, &video)
	res, raw = h.do(http.MethodPost, "/api/host/webinars", simuliveInput(video.ID))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule simulive: %d %s", res.StatusCode, raw)
	}
	var sim types.Webinar
	h.decode(raw, &sim)
	res, raw, _ = h.startUpload("Half.mp4", int64(len(bigMP4(60_000))))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start upload: %d %s", res.StatusCode, raw)
	}

	// Host two: a recording still in progress.
	h.logout()
	host2 := h.signup("Purge Host Two", "purge-host-two@test.dev", true)
	wb2 := h.liveWebinar("Purge session two", nil)
	h.addRecording(wb2.ID, "recording", 0, 0, "")

	// Not recordings: images, chat media, WhatsApp media. And a recording nobody's row points
	// at any more (with an Egress manifest beside it), and an upload the bucket half has.
	keep := []string{"avatars/" + host1.ID + "/me.png", "covers/" + wb.ID + "/c.jpg",
		"chat/" + wb.ID + "/p.png", "wa/" + host2.ID + "/files/doc"}
	for _, k := range keep {
		bucket.put(t, k, "keep me")
	}
	orphanID := uuid.NewString()
	orphan := orphanID[:2] + "/" + orphanID[2:4] + "/" + orphanID + ".mp4"
	bucket.put(t, orphan, "orphaned bytes")
	bucket.put(t, orphan+".json", "{}")
	stray, err := bucket.CreateMultipart(ctx, "uploads/"+host2.ID+"/"+uuid.NewString()+".mp4", "video/mp4")
	if err != nil {
		t.Fatal(err)
	}

	files := []string{}
	for _, id := range []string{rec1.ID, video.ID} {
		f, err := h.store.RecordingFileByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f.StorageKey)
		if !h.objectExists(f.StorageKey) {
			t.Fatalf("fixture: %s has no file", f.StorageKey)
		}
	}

	// The admin sees the totals before pressing anything.
	h.logout()
	h.signup("Purge Admin", "purge-admin@test.dev", false)
	if _, _, err := h.store.PromoteAdmins(ctx, []string{"purge-admin@test.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("purge-admin@test.dev")
	res, raw = h.do(http.MethodGet, "/api/admin/recordings/purge", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status: %d %s", res.StatusCode, raw)
	}
	var before types.RecordingPurgeStatus
	h.decode(raw, &before)
	if before.Totals.Recordings != 3 || before.Totals.Clips != 1 || before.Totals.Uploads != 1 || before.Latest != nil {
		t.Fatalf("totals before = %+v (latest %v), want 3 recordings, 1 clip, 1 upload, no run", before.Totals, before.Latest)
	}

	st := h.purge()
	sum := st.Latest.Summary
	if sum.Recordings != 3 || sum.Clips != 1 || sum.UploadsAborted != 2 || sum.SimulivesAffected != 1 ||
		sum.RecordingsStopped != 1 {
		t.Fatalf("summary = %+v", sum)
	}
	// rec1's file, the video, the clip, the orphan and its manifest.
	if sum.Files < 5 || sum.Bytes <= 0 {
		t.Fatalf("summary files/bytes = %+v", sum)
	}
	if st.Totals != (types.RecordingStorageTotals{}) {
		t.Fatalf("totals after = %+v, want zero", st.Totals)
	}

	for _, n := range []struct {
		what string
		sql  string
	}{
		{"recordings", `SELECT count(*) FROM recordings`},
		{"clip jobs", `SELECT count(*) FROM clip_jobs`},
		{"clip plans", `SELECT count(*) FROM clip_plans`},
		{"highlights", `SELECT count(*) FROM recording_highlights`},
		{"video uploads", `SELECT count(*) FROM video_uploads`},
		{"clip blob queue", `SELECT count(*) FROM clip_blob_deletions`},
	} {
		if got := h.count(n.sql); got != 0 {
			t.Errorf("%s left: %d", n.what, got)
		}
	}
	for _, k := range append(files, clipKey, orphan, orphan+".json") {
		if h.objectExists(k) {
			t.Errorf("%s is still in the bucket", k)
		}
	}
	for _, k := range keep {
		if !h.objectExists(k) {
			t.Errorf("%s was deleted; it is not a recording", k)
		}
	}
	bucket.mu.Lock()
	_, strayOpen := bucket.uploads[stray]
	open := len(bucket.uploads)
	bucket.mu.Unlock()
	if strayOpen || open != 0 {
		t.Errorf("multipart uploads still open: %d (the stray one: %v)", open, strayOpen)
	}

	// The scheduled simulive is a draft that says why; storage is back to nothing.
	again, err := h.store.WebinarBySlug(ctx, sim.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != types.StatusDraft || again.SimuliveRecordingID != "" || !again.SimuliveRecordingDeleted {
		t.Fatalf("simulive = status %s recording %q deleted %v, want a draft that says its recording was deleted",
			again.Status, again.SimuliveRecordingID, again.SimuliveRecordingDeleted)
	}
	if used := h.count(`SELECT recording_used_bytes($1::uuid)::int`, host1.ID); used != 0 {
		t.Fatalf("host one still uses %d bytes", used)
	}

	// The published link says the recording is gone.
	h.logout()
	res, raw = h.do(http.MethodGet, "/api/webinars/"+wb.ID+"/recordings/"+rec1.ID+"/public", nil)
	if res.StatusCode != http.StatusNotFound || !strings.Contains(string(raw), "no longer available") {
		t.Fatalf("public replay: %d %s, want 404 no longer available", res.StatusCode, raw)
	}

	// Running it again is a run with nothing to do.
	h.login("purge-admin@test.dev")
	second := h.purge()
	if second.Latest.ID == st.Latest.ID || second.Latest.Summary != (types.RecordingPurgeSummary{}) {
		t.Fatalf("second run = %+v, want a new run that did nothing", second.Latest)
	}
	for _, k := range keep {
		if !h.objectExists(k) {
			t.Errorf("%s deleted by the second run", k)
		}
	}
}

func TestAdminPurgeSparesARecordingStartedAfterIt(t *testing.T) {
	h, bucket, _ := uploadHarness(t, "purge-later@test.dev")
	ctx := context.Background()
	wb := h.liveWebinar("Later session", nil)
	old := readyRecording(t, h, wb.ID)

	h.logout()
	h.signup("Purge Admin", "purge-admin2@test.dev", false)
	if _, _, err := h.store.PromoteAdmins(ctx, []string{"purge-admin2@test.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("purge-admin2@test.dev")
	// Start a run, then a recording is made before the run gets to deleting.
	job, _, err := h.store.StartRecordingPurge(ctx, "", "purge-admin2@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	newID := uuid.NewString()
	newKey := newID[:2] + "/" + newID[2:4] + "/" + newID + ".mp4"
	h.exec(`INSERT INTO recordings (id, webinar_id, status, mime, storage_key, size_bytes, duration_ms, stopped_at, created_at)
	        SELECT $1::uuid, id, 'ready', 'video/mp4', $2, 5, 1000, now(), $4 FROM webinars WHERE slug = $3`,
		newID, newKey, wb.ID, job.StartedAt.Add(time.Second))
	bucket.put(t, newKey, "fresh")
	bucket.put(t, newKey+".json", "{}")

	h.purge()
	if _, err := h.store.RecordingFileByID(ctx, old.ID); err == nil {
		t.Fatal("the old recording survived")
	}
	if _, err := h.store.RecordingFileByID(ctx, newID); err != nil {
		t.Fatalf("the recording made after the run started was deleted: %v", err)
	}
	if !h.objectExists(newKey) || !h.objectExists(newKey+".json") {
		t.Fatal("the new recording's files were swept")
	}
}

func TestAdminPurgeIsAdminOnlyAndNeedsTheExactPhrase(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.signup("Not Admin", "purge-host@test.dev", true)
	wb := h.liveWebinar("Keep me", nil)
	id := h.addRecording(wb.ID, "ready", 10, 1000, "")

	for _, m := range []string{http.MethodGet, http.MethodPost} {
		res, raw := h.do(m, "/api/admin/recordings/purge", types.RecordingPurgeRequest{Confirm: types.RecordingPurgeConfirm})
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s as a host: %d %s, want 403", m, res.StatusCode, raw)
		}
	}
	h.logout()
	if res, _ := h.do(http.MethodPost, "/api/admin/recordings/purge", types.RecordingPurgeRequest{Confirm: types.RecordingPurgeConfirm}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d, want 401", res.StatusCode)
	}

	h.signup("Purge Admin", "purge-admin3@test.dev", false)
	if _, _, err := h.store.PromoteAdmins(ctx, []string{"purge-admin3@test.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("purge-admin3@test.dev")
	for _, phrase := range []string{"", "delete all recordings", "DELETE ALL RECORDINGS ", "yes"} {
		res, raw := h.do(http.MethodPost, "/api/admin/recordings/purge", types.RecordingPurgeRequest{Confirm: phrase})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("confirm %q: %d %s, want 400", phrase, res.StatusCode, raw)
		}
	}
	if _, err := h.store.RecordingFileByID(ctx, id); err != nil {
		t.Fatalf("a refused purge deleted a recording: %v", err)
	}
	if n := h.count(`SELECT count(*) FROM recording_purges`); n != 0 {
		t.Fatalf("a refused purge started a run (%d)", n)
	}
}
