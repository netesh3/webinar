package api_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/mp4probe/mp4fake"
	"github.com/netkumar/webcast/api/types"
)

/* Uploading a video for Simulive (video_upload.go): the browser's multipart upload against a
 * fake bucket, the quota, the probe, ownership, scheduling a simulive from the upload, and
 * retention. */

// fakeBucket is disk storage with S3's multipart upload: parts PUT to its own test server.
type fakeBucket struct {
	*media.Disk
	srv     *httptest.Server
	mu      sync.Mutex
	next    int
	uploads map[string]map[int32][]byte // upload id → part → bytes
	keys    map[string]string           // upload id → key
	aborted []string
}

func newFakeBucket(t *testing.T, disk *media.Disk) *fakeBucket {
	f := &fakeBucket{Disk: disk, uploads: map[string]map[int32][]byte{}, keys: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		n, _ := strconv.Atoi(r.URL.Query().Get("partNumber"))
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		defer f.mu.Unlock()
		parts, ok := f.uploads[r.URL.Query().Get("uploadId")]
		if !ok {
			http.Error(w, "NoSuchUpload", http.StatusNotFound)
			return
		}
		parts[int32(n)] = body
		w.Header().Set("ETag", fmt.Sprintf("\"etag-%d\"", n))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeBucket) CreateMultipart(_ context.Context, key, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	id := "up-" + strconv.Itoa(f.next)
	f.uploads[id] = map[int32][]byte{}
	f.keys[id] = key
	return id, nil
}

func (f *fakeBucket) PresignUploadPart(_ context.Context, key, uploadID string, part int32, _ time.Duration) (string, error) {
	return f.srv.URL + "/" + key + "?uploadId=" + url.QueryEscape(uploadID) + "&partNumber=" + strconv.Itoa(int(part)), nil
}

func (f *fakeBucket) ListUploadedParts(_ context.Context, _, uploadID string) ([]media.UploadedPart, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parts, ok := f.uploads[uploadID]
	if !ok {
		return nil, media.ErrNotFound
	}
	var out []media.UploadedPart
	for n, b := range parts {
		out = append(out, media.UploadedPart{Number: n, ETag: fmt.Sprintf("\"etag-%d\"", n), Size: int64(len(b))})
	}
	return out, nil
}

func (f *fakeBucket) CompleteMultipart(ctx context.Context, key, uploadID string, parts []media.UploadedPart) error {
	f.mu.Lock()
	stored := f.uploads[uploadID]
	delete(f.uploads, uploadID)
	f.mu.Unlock()
	var all []byte
	for _, p := range parts {
		all = append(all, stored[p.Number]...)
	}
	_, err := f.Append(ctx, key, bytes.NewReader(all))
	return err
}

func (f *fakeBucket) AbortMultipart(_ context.Context, _, uploadID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.uploads, uploadID)
	f.aborted = append(f.aborted, uploadID)
	return nil
}

// uploadHarness is a harness with the fake bucket and a simulive host signed in.
func uploadHarness(t *testing.T, email string) (*harness, *fakeBucket, types.Account) {
	h := newHarness(t, retention30)
	bucket := newFakeBucket(t, h.recordings)
	api.SetRecordings(h.server, bucket)
	acct := h.signup("Video Host", email, true)
	grantFeature(t, h, acct.ID, types.FeatureSimulive)
	return h, bucket, acct
}

// putParts uploads file in the parts up asks for, the way the browser does.
func (h *harness) putParts(up types.VideoUpload, file []byte, only ...int) {
	h.t.Helper()
	nums := only
	if len(nums) == 0 {
		for n := 1; n <= up.PartCount; n++ {
			nums = append(nums, n)
		}
	}
	res, raw := h.do(http.MethodPost, "/api/host/videos/uploads/"+up.ID+"/parts", types.VideoUploadPartsRequest{Parts: nums})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("part urls: %d %s", res.StatusCode, raw)
	}
	var urls types.VideoUploadPartsResponse
	h.decode(raw, &urls)
	for _, u := range urls.URLs {
		start := int64(u.Part-1) * up.PartSize
		end := min(start+up.PartSize, int64(len(file)))
		req, _ := http.NewRequest(http.MethodPut, u.URL, bytes.NewReader(file[start:end]))
		put, err := http.DefaultClient.Do(req)
		if err != nil {
			h.t.Fatal(err)
		}
		_ = put.Body.Close()
		if put.StatusCode != http.StatusOK {
			h.t.Fatalf("put part %d: %d", u.Part, put.StatusCode)
		}
	}
}

func (h *harness) startUpload(name string, size int64) (*http.Response, []byte, types.VideoUpload) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/videos/uploads",
		types.StartVideoUploadRequest{Filename: name, SizeBytes: size, Mime: "video/mp4"})
	var up types.VideoUpload
	if res.StatusCode == http.StatusCreated {
		h.decode(raw, &up)
	}
	return res, raw, up
}

// uploadVideo uploads file whole and completes it, returning the completion's answer.
func (h *harness) uploadVideo(name string, file []byte) (*http.Response, []byte) {
	h.t.Helper()
	res, raw, up := h.startUpload(name, int64(len(file)))
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("start upload: %d %s", res.StatusCode, raw)
	}
	h.putParts(up, file)
	return h.do(http.MethodPost, "/api/host/videos/uploads/"+up.ID+"/complete", nil)
}

// bigMP4 is an H.264/AAC file a little over two parts long, moov at the end.
func bigMP4(ms int64) []byte {
	return mp4fake.Build(mp4fake.Spec{
		Audio: "mp4a", DurationMs: ms, MoovLast: true, MdatBytes: int(2*types.VideoUploadMinPartBytes) + 1234,
	})
}

func TestVideoUploadInPartsResumesAndBecomesARecording(t *testing.T) {
	h, _, acct := uploadHarness(t, "uploader@test.dev")
	file := bigMP4(42 * 60_000)

	res, raw, up := h.startUpload("Launch talk.mp4", int64(len(file)))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start: %d %s", res.StatusCode, raw)
	}
	if up.PartCount != 3 || up.PartSize != types.VideoUploadMinPartBytes || up.Title != "Launch talk" {
		t.Fatalf("upload = %+v, want 3 parts of the minimum size titled from the file", up)
	}
	// The quota holds the upload while it is in flight: the meter doesn't, yet.
	if st := h.storage(); st.UsedBytes != 0 {
		t.Fatalf("used %d before the upload finished", st.UsedBytes)
	}

	// Part 2 only, then the page is reloaded: the status says what is left.
	h.putParts(up, file, 2)
	res, raw = h.do(http.MethodPost, "/api/host/videos/uploads/"+up.ID+"/complete", nil)
	if res.StatusCode != http.StatusConflict || !strings.Contains(string(raw), `"missing":[1,3]`) {
		t.Fatalf("early complete: %d %s, want 409 missing 1 and 3", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/videos/uploads/"+up.ID, nil)
	var status types.VideoUpload
	h.decode(raw, &status)
	if res.StatusCode != http.StatusOK || len(status.UploadedParts) != 1 || status.UploadedParts[0] != 2 {
		t.Fatalf("status: %d %s, want part 2 uploaded", res.StatusCode, raw)
	}
	h.putParts(up, file, 1, 3)
	res, raw = h.do(http.MethodPost, "/api/host/videos/uploads/"+up.ID+"/complete",
		types.CompleteVideoUploadRequest{Title: "Launch talk (final)"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("complete: %d %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if rec.Source != "upload" || rec.Webinar != "" || rec.Topic != "Launch talk (final)" ||
		rec.Status != types.RecordingReady || rec.SizeBytes != int64(len(file)) || rec.DurationMs != 42*60_000 {
		t.Fatalf("recording = %+v", rec)
	}
	// Kept 30 days from now, and can be kept longer.
	if got := mustTime(t, rec.ExpiresAt); !near(got, time.Now().AddDate(0, 0, 30)) || !rec.CanExtend {
		t.Fatalf("expiry %s canExtend %v, want 30 days from now", rec.ExpiresAt, rec.CanExtend)
	}
	if st := h.storage(); st.UsedBytes != int64(len(file)) {
		t.Fatalf("meter used %d, want the video's %d", st.UsedBytes, len(file))
	}

	// The library lists it; the file plays for its host, byte for byte.
	res, raw = h.do(http.MethodGet, "/api/host/recordings", nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), rec.ID) || !strings.Contains(string(raw), `"source":"upload"`) {
		t.Fatalf("library: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/videos/"+rec.ID+"/file", nil)
	if res.StatusCode != http.StatusOK || !bytes.Equal(raw, file) {
		t.Fatalf("file: %d, %d bytes, want the upload", res.StatusCode, len(raw))
	}
	// The upload is finished: completing it again finds nothing.
	if res, _ := h.do(http.MethodPost, "/api/host/videos/uploads/"+up.ID+"/complete", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("second complete: %d", res.StatusCode)
	}

	// Keep longer: +3 months, repeatable. Rename.
	want := mustTime(t, rec.ExpiresAt)
	for i := 1; i <= 2; i++ {
		res, raw = h.do(http.MethodPost, "/api/host/videos/"+rec.ID+"/keep", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("keep #%d: %d %s", i, res.StatusCode, raw)
		}
		var kept types.Recording
		h.decode(raw, &kept)
		want = want.AddDate(0, types.RecordingKeepMonths, 0)
		if got := mustTime(t, kept.ExpiresAt); !near(got, want) || !kept.Extended {
			t.Fatalf("keep #%d: expires %v, want %v", i, got, want)
		}
	}
	res, raw = h.do(http.MethodPatch, "/api/host/videos/"+rec.ID, types.RenameVideoRequest{Title: "Renamed"})
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"topic":"Renamed"`) {
		t.Fatalf("rename: %d %s", res.StatusCode, raw)
	}

	// The cost report's storage counts it for its host.
	usage, err := h.store.CostStorageUsage(t.Context(), time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	counted := false
	for _, u := range usage {
		if u.HostID == acct.ID && u.RecordingGB > 0 {
			counted = true
		}
	}
	if !counted {
		t.Fatalf("cost storage %+v has no recording bytes for %s", usage, acct.ID)
	}
}

func TestVideoUploadQuotaCountsUploadsInFlight(t *testing.T) {
	h, bucket, acct := uploadHarness(t, "quota-uploader@test.dev")
	quota := int64(20 << 20)
	if err := h.store.SetUserRecordingStorage(t.Context(), acct.ID, &quota, nil); err != nil {
		t.Fatal(err)
	}
	res, raw, first := h.startUpload("a.mp4", 15<<20)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("first: %d %s", res.StatusCode, raw)
	}
	// 15 MB in flight + 10 MB > 20 MB.
	res, raw, _ = h.startUpload("b.mp4", 10<<20)
	if res.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "quota_exceeded") {
		t.Fatalf("second: %d %s, want 409 quota_exceeded", res.StatusCode, raw)
	}
	if len(bucket.aborted) != 1 {
		t.Fatalf("aborted %v, want the refused upload's multipart aborted", bucket.aborted)
	}
	// Cancelling the first frees its space.
	if res, raw := h.do(http.MethodDelete, "/api/host/videos/uploads/"+first.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("cancel: %d %s", res.StatusCode, raw)
	}
	if res, raw, _ := h.startUpload("b.mp4", 10<<20); res.StatusCode != http.StatusCreated {
		t.Fatalf("after cancel: %d %s", res.StatusCode, raw)
	}
	// Too big for anybody.
	if res, _, _ := h.startUpload("huge.mp4", types.MaxVideoUploadBytes+1); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("over the size cap: %d", res.StatusCode)
	}
	if res, _, _ := h.startUpload("clip.webm", 1000); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("webm name: %d", res.StatusCode)
	}
}

func TestVideoUploadProbeRefusesWhatBrowsersCannotPlay(t *testing.T) {
	h, _, _ := uploadHarness(t, "probe-uploader@test.dev")
	cases := map[string]struct {
		file []byte
		want string
	}{
		"hevc":      {mp4fake.Build(mp4fake.Spec{Video: "hvc1", Audio: "mp4a", DurationMs: 60_000}), "HEVC"},
		"not mp4":   {[]byte(strings.Repeat("not a video ", 100)), "isn't an MP4"},
		"no moov":   {mp4fake.Build(mp4fake.Spec{DurationMs: 60_000, MoovLast: true, MdatBytes: 500})[:300], "header"},
		"ac3 sound": {mp4fake.Build(mp4fake.Spec{Audio: "ac-3", DurationMs: 60_000}), "AC-3"},
	}
	for name, c := range cases {
		res, raw := h.uploadVideo(name+".mp4", c.file)
		if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), c.want) ||
			!strings.Contains(string(raw), "H.264") {
			t.Errorf("%s: %d %s, want 422 naming %q and suggesting H.264", name, res.StatusCode, raw, c.want)
		}
	}
	// Nothing refused is listed, kept, or counted.
	res, raw := h.do(http.MethodGet, "/api/host/recordings", nil)
	if res.StatusCode != http.StatusOK || strings.Contains(string(raw), `"source":"upload"`) {
		t.Fatalf("library after refusals: %s", raw)
	}
	if st := h.storage(); st.UsedBytes != 0 {
		t.Fatalf("used %d after refusals", st.UsedBytes)
	}
	var left int
	if err := h.store.Pool().QueryRow(t.Context(), `SELECT count(*) FROM video_uploads`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("uploads left in flight: %d %v", left, err)
	}
}

func TestVideoUploadOwnershipAndSimulive(t *testing.T) {
	h, _, _ := uploadHarness(t, "owner-uploader@test.dev")
	res, raw := h.uploadVideo("Encore.mp4", mp4fake.Build(mp4fake.Spec{Audio: "mp4a", DurationMs: 25 * 60_000}))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)

	// Scheduling a simulive from it: accepted, and it plays from the host's video route.
	res, raw = h.do(http.MethodPost, "/api/host/webinars", simuliveInput(rec.ID))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("schedule simulive: %d %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if wb.SimuliveRecordingID != rec.ID {
		t.Fatalf("simulive plays %q, want %q", wb.SimuliveRecordingID, rec.ID)
	}
	// No original session, so no engagement replay to curate.
	grantFeature(t, h, wb.Host.ID, types.FeatureReplayEngage)
	if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/replay", nil); res.StatusCode != http.StatusConflict ||
		!strings.Contains(string(raw), "uploaded_video") {
		t.Fatalf("replay preview: %d %s, want 409 uploaded_video", res.StatusCode, raw)
	}
	// Its length is the video's.
	if ms, err := h.store.SimuliveLengthMs(t.Context(), wb.ID); err != nil || ms != 25*60_000 {
		t.Fatalf("simulive length %d %v, want the video's", ms, err)
	}

	// Another host: cannot see, play, keep, delete it or schedule it.
	other := h.signup("Other Host", "other-uploader@test.dev", true)
	grantFeature(t, h, other.ID, types.FeatureSimulive)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/host/videos/" + rec.ID + "/file"},
		{http.MethodPost, "/api/host/videos/" + rec.ID + "/keep"},
		{http.MethodPatch, "/api/host/videos/" + rec.ID},
		{http.MethodDelete, "/api/host/videos/" + rec.ID},
	} {
		var body any
		if c.method == http.MethodPatch {
			body = types.RenameVideoRequest{Title: "Mine now"}
		}
		if res, _ := h.do(c.method, c.path, body); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s as another host: %d, want 404", c.method, c.path, res.StatusCode)
		}
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars", simuliveInput(rec.ID))
	h.wantField(res, raw, "simuliveRecordingId")

	// Its owner deletes it: gone from the library and from the simulive.
	h.login("owner-uploader@test.dev")
	if res, raw := h.do(http.MethodDelete, "/api/host/videos/"+rec.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}
	if _, err := h.store.RecordingFileByID(t.Context(), rec.ID); err == nil {
		t.Fatal("the row is still there")
	}
	again, err := h.store.WebinarBySlug(t.Context(), wb.ID)
	if err != nil || again.SimuliveRecordingID != "" {
		t.Fatalf("simulive still plays %q (%v)", again.SimuliveRecordingID, err)
	}
}

func TestUploadedVideoExpiresAndRemindsLikeARecording(t *testing.T) {
	h, _, acct := uploadHarness(t, "expiry-uploader@test.dev")
	res, raw := h.uploadVideo("Old.mp4", mp4fake.Build(mp4fake.Spec{DurationMs: 60_000}))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)

	// Six days left: the 7-day reminder names it and links to the video library.
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE recordings SET stopped_at = now() - interval '24 days', created_at = now() - interval '24 days' WHERE id = $1::uuid`, rec.ID); err != nil {
		t.Fatal(err)
	}
	due, err := h.store.DueExpiryReminders(t.Context(), 30, 50)
	if err != nil || len(due) != 1 || due[0].ID != rec.ID || due[0].HostID != acct.ID || due[0].Topic != "Old" || due[0].Webinar != "" {
		t.Fatalf("due = %+v (%v), want the upload for its host", due, err)
	}

	// Past its expiry: the sweep deletes the row and the file.
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE recordings SET stopped_at = now() - interval '31 days' WHERE id = $1::uuid`, rec.ID); err != nil {
		t.Fatal(err)
	}
	expired, err := h.store.ExpiredRecordings(t.Context(), 30, 50)
	if err != nil || len(expired) != 1 || expired[0].ID != rec.ID {
		t.Fatalf("expired = %+v (%v)", expired, err)
	}
	api.SweepExpiredRecordings(h.server, t.Context())
	if _, err := h.store.RecordingFileByID(t.Context(), rec.ID); err == nil {
		t.Fatal("expired upload still listed")
	}
	if _, err := h.recordings.Stat(t.Context(), "uploads/"+acct.ID+"/"+rec.ID+".mp4"); err == nil {
		t.Fatal("the expired upload's file is still stored")
	}
	var logged string
	if err := h.store.Pool().QueryRow(t.Context(),
		`SELECT coalesce(host_id::text, '') FROM recording_deletions WHERE recording_id = $1::uuid`, rec.ID).Scan(&logged); err != nil || logged != acct.ID {
		t.Fatalf("deletion logged for %q (%v), want the uploader", logged, err)
	}
}

func TestAbandonedVideoUploadsAreAborted(t *testing.T) {
	h, bucket, _ := uploadHarness(t, "abandon-uploader@test.dev")
	res, raw, up := h.startUpload("left.mp4", 20<<20)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start: %d %s", res.StatusCode, raw)
	}
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE video_uploads SET created_at = now() - interval '2 days' WHERE id = $1::uuid`, up.ID); err != nil {
		t.Fatal(err)
	}
	api.SweepAbandonedVideoUploads(h.server, t.Context())
	sort.Strings(bucket.aborted)
	if len(bucket.aborted) != 1 {
		t.Fatalf("aborted %v", bucket.aborted)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/videos/uploads/"+up.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("status after abort: %d", res.StatusCode)
	}
}

func TestVideoUploadNeedsSimuliveAndObjectStorage(t *testing.T) {
	h := newHarness(t, retention30)
	h.signup("No Sim", "nosim-uploader@test.dev", true)
	// Disk storage: no browser uploads.
	if res, _, _ := h.startUpload("a.mp4", 1000); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("disk storage: %d, want 503", res.StatusCode)
	}
	api.SetRecordings(h.server, newFakeBucket(t, h.recordings))
	if res, _, _ := h.startUpload("a.mp4", 1000); res.StatusCode != http.StatusForbidden {
		t.Fatalf("without simulive: %d, want 403", res.StatusCode)
	}
}
