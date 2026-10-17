package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

// pdfOf is a PDF-looking document of n bytes.
func pdfOf(n int) []byte {
	return append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte{'0'}, n-9)...)
}

func quotaRefusal(t *testing.T, raw []byte) types.CRMMediaQuotaError {
	t.Helper()
	var q types.CRMMediaQuotaError
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatalf("quota body %s: %v", raw, err)
	}
	return q
}

/* The library holds up to its limit — 1 MB here — counted as stored. A file that does
 * not fit is refused before it is kept, with the numbers; deleting frees the space at
 * once; an admin's per-account limit replaces the default; and nothing outside the
 * library (covers, inbound WhatsApp media copies) counts. */
func TestMediaQuotaIsEnforcedFreedAndOverridable(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), func(c *config.Config) { c.MediaQuotaDefaultMB = 1 })
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	me := meAccount(t, h)
	const mb = 1 << 20

	if lib := mediaLibrary(t, h, ""); lib.UsedBytes != 0 || lib.LimitBytes != mb {
		t.Fatalf("empty library space = %d of %d", lib.UsedBytes, lib.LimitBytes)
	}
	code, first, raw := uploadMedia(t, h, "application/pdf", "first.pdf", pdfOf(600<<10))
	if code != http.StatusCreated {
		t.Fatalf("first upload: %d %s", code, raw)
	}
	if lib := mediaLibrary(t, h, ""); lib.UsedBytes != 600<<10 {
		t.Fatalf("used after one = %d", lib.UsedBytes)
	}

	code, _, raw = uploadMedia(t, h, "application/pdf", "second.pdf", pdfOf(600<<10))
	q := quotaRefusal(t, raw)
	if code != http.StatusRequestEntityTooLarge || q.Error != "media_quota_exceeded" ||
		q.UsedBytes != 600<<10 || q.LimitBytes != mb || q.FileBytes != 600<<10 {
		t.Fatalf("over the limit: %d %s", code, raw)
	}
	var rows int
	if err := h.store.Pool().QueryRow(t.Context(), `SELECT count(*) FROM crm_media_files`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("rows after a refusal = %d (%v)", rows, err)
	}
	if files, _ := os.ReadDir(filepath.Join(h.recordingsDir, "wa", me.ID, "files")); len(files) != 1 {
		t.Fatalf("files on disk after a refusal = %d", len(files))
	}

	// Not library files: a webinar cover and an inbound WhatsApp media copy.
	wb := h.newWebinar("Quota cover", nil)
	if res, raw := h.doRaw(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image", "image/png", onePixelPNG, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("cover: %d %s", res.StatusCode, raw)
	}
	if err := os.WriteFile(filepath.Join(h.recordingsDir, "wa", me.ID, "wamid.inbound"), pdfOf(900<<10), 0o600); err != nil {
		t.Fatal(err)
	}
	if lib := mediaLibrary(t, h, ""); lib.UsedBytes != 600<<10 {
		t.Fatalf("used counts files outside the library: %d", lib.UsedBytes)
	}

	// Deleting frees the space in the same response.
	res, raw := h.do(http.MethodPost, "/api/host/crm/media/delete", types.CRMMediaDeleteRequest{IDs: []string{first.ID}})
	var del types.CRMMediaDeleteResult
	h.decode(raw, &del)
	if res.StatusCode != http.StatusOK || del.UsedBytes != 0 || del.LimitBytes != mb {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}
	if code, _, raw := uploadMedia(t, h, "application/pdf", "second.pdf", pdfOf(600<<10)); code != http.StatusCreated {
		t.Fatalf("upload after a delete: %d %s", code, raw)
	}

	// An admin raises this account's limit; null puts it back on the default.
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	two := int64(2 * mb)
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+me.ID+"/media-quota", types.SetUserMediaQuotaRequest{MediaQuotaBytes: &two}); res.StatusCode != http.StatusOK {
		t.Fatalf("set quota: %d %s", res.StatusCode, raw)
	}
	if code, _, raw := uploadMedia(t, h, "application/pdf", "third.pdf", pdfOf(600<<10)); code != http.StatusCreated {
		t.Fatalf("upload under the raised limit: %d %s", code, raw)
	}
	if lib := mediaLibrary(t, h, ""); lib.LimitBytes != two || lib.UsedBytes != 1200<<10 {
		t.Fatalf("space with the override = %d of %d", lib.UsedBytes, lib.LimitBytes)
	}
	res, raw = h.do(http.MethodGet, "/api/admin/users?q="+url.QueryEscape("neeraj@acme.dev"), nil)
	var users []types.AdminUser
	h.decode(raw, &users)
	if res.StatusCode != http.StatusOK || len(users) == 0 || users[0].MediaQuotaBytes == nil ||
		*users[0].MediaQuotaBytes != two || users[0].MediaLimitBytes != two || users[0].MediaUsedBytes != 1200<<10 {
		t.Fatalf("admin row: %d %s", res.StatusCode, raw)
	}
	for _, bad := range []int64{0, -1, (10 << 30) + 1} {
		if res, _ := h.do(http.MethodPatch, "/api/admin/users/"+me.ID+"/media-quota", types.SetUserMediaQuotaRequest{MediaQuotaBytes: &bad}); res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("quota %d: %d, want 422", bad, res.StatusCode)
		}
	}

	// Back on the 1 MB default with 1.2 MB kept: nothing is deleted, nothing more fits.
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+me.ID+"/media-quota", types.SetUserMediaQuotaRequest{}); res.StatusCode != http.StatusOK {
		t.Fatalf("reset quota: %d %s", res.StatusCode, raw)
	}
	if lib := mediaLibrary(t, h, ""); len(lib.Files) != 2 || lib.LimitBytes != mb {
		t.Fatalf("over the limit after a reset: %d files, limit %d", len(lib.Files), lib.LimitBytes)
	}
	code, _, raw = uploadMedia(t, h, "image/jpeg", "tiny.jpg", testJPEG(t, 40, 40))
	if code != http.StatusRequestEntityTooLarge || !strings.Contains(quotaRefusal(t, raw).Message, "Your files are kept") {
		t.Fatalf("upload while over the limit: %d %s", code, raw)
	}

	// Only an admin sets limits.
	h.signup("Plain Host", "plain-host@test.dev", true)
	if res, _ := h.do(http.MethodPatch, "/api/admin/users/"+me.ID+"/media-quota", types.SetUserMediaQuotaRequest{MediaQuotaBytes: &two}); res.StatusCode != http.StatusForbidden {
		t.Errorf("a host set a limit: %d", res.StatusCode)
	}
}

/* Two uploads racing for the last of the space: both pass the early check, and the
 * per-host lock around the final check and insert lets exactly one in. */
func TestMediaQuotaHoldsUnderConcurrentUploads(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), func(c *config.Config) { c.MediaQuotaDefaultMB = 1 })
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	for round := 0; round < 3; round++ {
		if _, err := h.store.Pool().Exec(t.Context(), `DELETE FROM crm_media_files`); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		codes := make([]int, 2)
		for i := range codes {
			wg.Add(1)
			go func() {
				defer wg.Done()
				req, err := http.NewRequest(http.MethodPost, h.srv.URL+"/api/host/crm/media?filename=race.pdf",
					bytes.NewReader(pdfOf(600<<10)))
				if err != nil {
					t.Error(err)
					return
				}
				req.Header.Set("Content-Type", "application/pdf")
				res, err := h.client.Do(req)
				if err != nil {
					t.Error(err)
					return
				}
				res.Body.Close()
				codes[i] = res.StatusCode
			}()
		}
		wg.Wait()
		created, refused := 0, 0
		for _, c := range codes {
			switch c {
			case http.StatusCreated:
				created++
			case http.StatusRequestEntityTooLarge:
				refused++
			}
		}
		if created != 1 || refused != 1 {
			t.Fatalf("round %d: statuses %v, want one 201 and one 413", round, codes)
		}
		if lib := mediaLibrary(t, h, ""); lib.UsedBytes != 600<<10 {
			t.Fatalf("round %d: used %d", round, lib.UsedBytes)
		}
	}
}

/* Without the CRM module there is no library: picking from it is a 404 and the
 * direct upload the schedule form falls back to still works. */
func TestCoverFromMediaWithoutEngage(t *testing.T) {
	bootWithoutEngage = true
	t.Cleanup(func() { bootWithoutEngage = false })
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhatsAppCRM)
	wb := h.newWebinar("No library", nil)
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image/from-media",
		types.WebinarImageFromMediaRequest{MediaID: "00000000-0000-0000-0000-000000000001"})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("from media without the CRM: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.doRaw(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image", "image/png", onePixelPNG, nil); res.StatusCode != http.StatusOK {
		t.Errorf("direct upload without the CRM: %d %s", res.StatusCode, raw)
	}
}

/* A cover picked from the gallery is a copy of the library image, set the way an
 * upload sets it: a new key under covers/, the old cover deleted. The host must own
 * the library file, the account needs the CRM, and the copy takes no library space. */
func TestCoverFromTheMediaLibrary(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	me := meAccount(t, h)
	grantFeature(t, h, me.ID, types.FeatureWhatsAppCRM)

	_, img, _ := uploadMedia(t, h, "image/jpeg", "cover.jpg", testJPEG(t, 1280, 720))
	_, doc, _ := uploadMedia(t, h, "application/pdf", "deck.pdf", fakePDF)
	before := mediaLibrary(t, h, "").UsedBytes

	wb := h.newWebinar("From the library", nil)
	if res, raw := h.doRaw(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image", "image/png", onePixelPNG, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("first cover: %d %s", res.StatusCode, raw)
	}
	old, _ := coverFile(t, h, wb.ID)
	fromMedia := func(id string) (*http.Response, []byte) {
		return h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image/from-media", types.WebinarImageFromMediaRequest{MediaID: id})
	}

	res, raw := fromMedia(img.ID)
	var got types.Webinar
	h.decode(raw, &got)
	if res.StatusCode != http.StatusOK || got.ImageURL == "" {
		t.Fatalf("cover from media: %d %s", res.StatusCode, raw)
	}
	key, data := coverFile(t, h, wb.ID)
	libKey := storageKeyFor(t, h, img.ID)
	libData, err := os.ReadFile(filepath.Join(h.recordingsDir, libKey))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "covers/"+wb.ID+"/") || key == old || !bytes.Equal(data, libData) {
		t.Fatalf("cover = %q (%d bytes, library %d)", key, len(data), len(libData))
	}
	gone(t, h, old)
	if after := mediaLibrary(t, h, "").UsedBytes; after != before {
		t.Errorf("the cover copy took library space: %d → %d", before, after)
	}

	// Deleting the library file leaves the cover, which is a copy.
	if res, raw := h.do(http.MethodDelete, "/api/host/crm/media/"+img.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete library image: %d %s", res.StatusCode, raw)
	}
	if k, _ := coverFile(t, h, wb.ID); k != key {
		t.Errorf("cover changed when its library original went: %q", k)
	}

	if res, _ := fromMedia(doc.ID); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Errorf("a PDF as cover: %d, want 415", res.StatusCode)
	}
	if res, _ := fromMedia(img.ID); res.StatusCode != http.StatusNotFound {
		t.Errorf("a deleted file as cover: %d, want 404", res.StatusCode)
	}

	// Another host's library file is not theirs to use, even on their own webinar.
	_, mine, _ := uploadMedia(t, h, "image/jpeg", "mine.jpg", testJPEG(t, 320, 180))
	other := h.signup("Other Cover Host", "other-cover@test.dev", true)
	grantFeature(t, h, other.ID, types.FeatureWhatsAppCRM)
	theirs := h.newWebinar("Theirs", nil)
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+theirs.ID+"/image/from-media", types.WebinarImageFromMediaRequest{MediaID: mine.ID})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("another host's file: %d %s, want 404", res.StatusCode, raw)
	}
	// Nor is somebody else's webinar.
	h.login("neeraj@acme.dev")
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+theirs.ID+"/image/from-media", types.WebinarImageFromMediaRequest{MediaID: mine.ID}); res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Errorf("another host's webinar: %d", res.StatusCode)
	}

	// The CRM switched off for the account: refused, so the form uploads directly.
	if _, err := h.store.SetFeatureOverride(t.Context(), me.ID, types.FeatureWhatsAppCRM, new(false)); err != nil {
		t.Fatal(err)
	}
	if res, raw := fromMedia(mine.ID); res.StatusCode != http.StatusForbidden || !strings.Contains(string(raw), "feature_off") {
		t.Errorf("with the CRM off: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.doRaw(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image", "image/png", onePixelPNG, nil); res.StatusCode != http.StatusOK {
		t.Errorf("direct upload with the CRM off: %d %s", res.StatusCode, raw)
	}
}
