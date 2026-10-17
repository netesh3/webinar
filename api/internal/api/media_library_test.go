package api_test

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

func mediaLibrary(t *testing.T, h *harness, query string) types.CRMMediaLibrary {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/media"+query, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("library %q: %d %s", query, res.StatusCode, raw)
	}
	var out types.CRMMediaLibrary
	h.decode(raw, &out)
	return out
}

func storageKeyOf(t *testing.T, h *harness, id string) (key, thumb string) {
	t.Helper()
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT storage_key, thumb_key FROM crm_media_files WHERE id = $1::uuid`, id).Scan(&key, &thumb); err != nil {
		t.Fatalf("storage key %s: %v", id, err)
	}
	return key, thumb
}

func onDisk(h *harness, key string) bool {
	_, err := os.Stat(filepath.Join(h.recordingsDir, key))
	return err == nil
}

/* The library lists a host's files newest first, a page at a time, narrowed by kind
 * and name, with a thumbnail for every image — made on upload, or the first time an
 * older image is listed. Another host sees none of it. */
func TestMediaLibraryListsPagesAndThumbnails(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	_, pdf, _ := uploadMedia(t, h, "application/pdf", "Course deck.pdf", fakePDF)
	_, first, _ := uploadMedia(t, h, "image/jpeg", "launch.jpg", testJPEG(t, 1200, 628))
	code, second, raw := uploadMedia(t, h, "image/jpeg", "banner.jpg", testJPEG(t, 800, 800))
	if code != http.StatusCreated || second.ThumbURL == "" || second.Width != 800 || second.Height != 800 {
		t.Fatalf("image upload: %d %+v %s", code, second, raw)
	}
	key, thumb := storageKeyOf(t, h, second.ID)
	if thumb != key+".thumb.jpg" || !onDisk(h, thumb) {
		t.Fatalf("thumbnail key %q (file present %v)", thumb, onDisk(h, thumb))
	}

	// An image from before thumbnails: the gallery makes one when it lists it.
	firstKey, firstThumb := storageKeyOf(t, h, first.ID)
	if err := os.Remove(filepath.Join(h.recordingsDir, firstThumb)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE crm_media_files SET thumb_key = '', width = 0, height = 0 WHERE id = $1::uuid`, first.ID); err != nil {
		t.Fatal(err)
	}

	page := mediaLibrary(t, h, "?limit=2")
	if len(page.Files) != 2 || page.Files[0].ID != second.ID || page.Files[1].ID != first.ID || page.NextCursor == "" {
		t.Fatalf("first page = %+v", page)
	}
	if page.Files[1].ThumbURL == "" || page.Files[1].Width != 1200 || !onDisk(h, firstKey+".thumb.jpg") {
		t.Fatalf("backfilled thumbnail: %+v", page.Files[1])
	}
	rest := mediaLibrary(t, h, "?limit=2&cursor="+url.QueryEscape(page.NextCursor))
	if len(rest.Files) != 1 || rest.Files[0].ID != pdf.ID || rest.NextCursor != "" || rest.Files[0].ThumbURL != "" {
		t.Fatalf("second page = %+v", rest)
	}

	// The disk store cannot sign links, so the thumbnail comes through the public token.
	res, body := h.doRaw(http.MethodGet, publicPath(t, page.Files[0].ThumbURL), "", nil, nil)
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "image/jpeg" || len(body) == 0 {
		t.Fatalf("thumbnail: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}

	if docs := mediaLibrary(t, h, "?type=document"); len(docs.Files) != 1 || docs.Files[0].ID != pdf.ID {
		t.Errorf("documents = %+v", docs.Files)
	}
	if found := mediaLibrary(t, h, "?q=BANN"); len(found.Files) != 1 || found.Files[0].ID != second.ID {
		t.Errorf("search = %+v", found.Files)
	}
	if found := mediaLibrary(t, h, "?q=%25"); len(found.Files) != 0 {
		t.Errorf("a %% search matched everything: %+v", found.Files)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/crm/media?cursor=nonsense", nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("bad cursor: %d, want 422", res.StatusCode)
	}

	res, raw = h.do(http.MethodPatch, "/api/host/crm/media/"+pdf.ID, types.CRMMediaRenameRequest{Filename: "Week 1 deck.pdf"})
	var renamed types.CRMMediaFile
	h.decode(raw, &renamed)
	if res.StatusCode != http.StatusOK || renamed.Filename != "Week 1 deck.pdf" {
		t.Fatalf("rename: %d %s", res.StatusCode, raw)
	}

	h.signup("Other Coach", "other-coach@test.dev", true)
	if other := mediaLibrary(t, h, ""); len(other.Files) != 0 {
		t.Fatalf("another host sees %d files", len(other.Files))
	}
	if res, _ := h.do(http.MethodPatch, "/api/host/crm/media/"+pdf.ID, types.CRMMediaRenameRequest{Filename: "x"}); res.StatusCode != http.StatusNotFound {
		t.Errorf("rename another host's file: %d, want 404", res.StatusCode)
	}
	res, raw = h.do(http.MethodDelete, "/api/host/crm/media/"+pdf.ID, nil)
	if res.StatusCode != http.StatusNotFound || !onDisk(h, storageKeyFor(t, h, pdf.ID)) {
		t.Errorf("delete another host's file: %d %s", res.StatusCode, raw)
	}
}

func storageKeyFor(t *testing.T, h *harness, id string) string {
	key, _ := storageKeyOf(t, h, id)
	return key
}

/* A file still used — a template's header, a carousel card, a broadcast not yet sent —
 * cannot be deleted, and the refusal says where. A free file goes from storage and
 * from the library; several at once delete what they can and report the rest. */
func TestMediaDeleteRefusesFilesInUseAndSaysWhere(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	ctx := context.Background()
	db := h.store.Pool()

	_, header, _ := uploadMedia(t, h, "application/pdf", "deck.pdf", fakePDF)
	res, raw := h.do(http.MethodPost, "/api/host/crm/templates", types.CRMWordingRequest{
		Body: "Hi {{1}}, here is the deck.", Category: "MARKETING",
		Header: &types.CRMTemplateHeaderInput{Format: "DOCUMENT", FileID: header.ID},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("submit: %d %s", res.StatusCode, raw)
	}
	var tmpl struct{ Name, Language string }
	h.decode(raw, &tmpl)

	_, card, _ := uploadMedia(t, h, "image/jpeg", "card.jpg", testJPEG(t, 600, 600))
	_, scheduled, _ := uploadMedia(t, h, "image/jpeg", "promo.jpg", testJPEG(t, 600, 314))
	_, sentOnly, _ := uploadMedia(t, h, "image/jpeg", "old.jpg", testJPEG(t, 600, 314))
	_, free, _ := uploadMedia(t, h, "image/jpeg", "spare.jpg", testJPEG(t, 400, 400))
	_, free2, _ := uploadMedia(t, h, "application/pdf", "spare.pdf", fakePDF)

	var hostID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM users WHERE email = 'neeraj@acme.dev'`).Scan(&hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO crm_template_defaults (host_id, name, language, card_file_ids)
		VALUES ($1::uuid, $2, $3, ARRAY[$4::uuid])`, hostID, tmpl.Name, tmpl.Language, card.ID); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	broadcast := func(name string, when time.Time, file string) {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, `
			INSERT INTO crm_broadcasts (host_id, name, template_name, template_language, audience, scheduled_at)
			VALUES ($1::uuid, $2, $3, $4, 'opted_in', $5) RETURNING id::text`,
			hostID, name, tmpl.Name, tmpl.Language, when).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO crm_broadcast_header (broadcast_id, file_id) VALUES ($1::uuid, $2::uuid)`, id, file); err != nil {
			t.Fatal(err)
		}
	}
	broadcast("Diwali offer", at, scheduled.ID)
	broadcast("Last month", time.Now().Add(-30*24*time.Hour), sentOnly.ID)

	lib := mediaLibrary(t, h, "")
	inUse := map[string][]types.CRMMediaUsage{}
	for _, f := range lib.Files {
		if f.InUse != (len(f.Usages) > 0) {
			t.Errorf("%s inUse %v with %d usages", f.Filename, f.InUse, len(f.Usages))
		}
		inUse[f.ID] = f.Usages
	}
	if u := inUse[header.ID]; len(u) != 1 || u[0].Kind != "template" || u[0].Name != tmpl.Name || u[0].Language != tmpl.Language {
		t.Errorf("header usages = %+v", u)
	}
	if u := inUse[card.ID]; len(u) != 1 || u[0].Kind != "carousel" || u[0].Name != tmpl.Name {
		t.Errorf("card usages = %+v", u)
	}
	if u := inUse[scheduled.ID]; len(u) != 1 || u[0].Kind != "broadcast" || u[0].Name != "Diwali offer" ||
		u[0].ScheduledAt != at.Format(time.RFC3339) {
		t.Errorf("scheduled broadcast usages = %+v", u)
	}
	if u := inUse[sentOnly.ID]; len(u) != 0 {
		t.Errorf("a sent broadcast still holds its file: %+v", u)
	}

	res, raw = h.do(http.MethodDelete, "/api/host/crm/media/"+header.ID, nil)
	var refused types.CRMMediaDeleteResult
	h.decode(raw, &refused)
	if res.StatusCode != http.StatusConflict || len(refused.Skipped) != 1 || refused.Skipped[0].Reason != "in_use" ||
		len(refused.Skipped[0].Usages) != 1 || !strings.Contains(refused.Skipped[0].Message, tmpl.Name) {
		t.Fatalf("delete in-use header: %d %s", res.StatusCode, raw)
	}
	if !onDisk(h, storageKeyFor(t, h, header.ID)) {
		t.Fatal("a refused delete removed the file")
	}

	freeKey, freeThumb := storageKeyOf(t, h, free.ID)
	res, raw = h.do(http.MethodDelete, "/api/host/crm/media/"+free.ID, nil)
	if res.StatusCode != http.StatusOK || onDisk(h, freeKey) || onDisk(h, freeThumb) {
		t.Fatalf("delete free file: %d %s (file %v, thumb %v)", res.StatusCode, raw, onDisk(h, freeKey), onDisk(h, freeThumb))
	}
	var rows int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM crm_media_files WHERE id = $1::uuid`, free.ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("row left after delete: %d %v", rows, err)
	}

	free2Key := storageKeyFor(t, h, free2.ID)
	res, raw = h.do(http.MethodPost, "/api/host/crm/media/delete", types.CRMMediaDeleteRequest{
		IDs: []string{free2.ID, scheduled.ID, card.ID, sentOnly.ID, "00000000-0000-0000-0000-000000000000"},
	})
	var batch types.CRMMediaDeleteResult
	h.decode(raw, &batch)
	if res.StatusCode != http.StatusOK || len(batch.Deleted) != 2 || len(batch.Skipped) != 3 {
		t.Fatalf("batch delete: %d %s", res.StatusCode, raw)
	}
	reasons := map[string]types.CRMMediaSkipped{}
	for _, s := range batch.Skipped {
		reasons[s.ID] = s
	}
	if s := reasons[scheduled.ID]; s.Reason != "in_use" || len(s.Usages) != 1 || !strings.Contains(s.Message, "Diwali offer") {
		t.Errorf("scheduled broadcast skip = %+v", s)
	}
	if s := reasons[card.ID]; s.Reason != "in_use" || s.Usages[0].Kind != "carousel" {
		t.Errorf("card skip = %+v", s)
	}
	if s := reasons["00000000-0000-0000-0000-000000000000"]; s.Reason != "not_found" {
		t.Errorf("unknown id skip = %+v", s)
	}
	if onDisk(h, free2Key) {
		t.Error("batch-deleted file still on disk")
	}

	// Storage refuses: the row stays, so the file is not orphaned and can be retried.
	// A read-only directory is the refusal; root ignores permissions, so not as root.
	if os.Geteuid() == 0 {
		return
	}
	_, stuck, _ := uploadMedia(t, h, "application/pdf", "stuck.pdf", fakePDF)
	dir := filepath.Dir(filepath.Join(h.recordingsDir, storageKeyFor(t, h, stuck.ID)))
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodDelete, "/api/host/crm/media/"+stuck.ID, nil)
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var failed types.CRMMediaDeleteResult
	h.decode(raw, &failed)
	if res.StatusCode != http.StatusBadGateway || len(failed.Skipped) != 1 || failed.Skipped[0].Reason != "storage" {
		t.Fatalf("delete with storage refusing: %d %s", res.StatusCode, raw)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM crm_media_files WHERE id = $1::uuid`, stuck.ID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("row after a refused storage delete: %d %v", rows, err)
	}
}

/* Library files are the coach's own uploads: no retention sweep — recordings, chat
 * images, captions, WhatsApp media copies, notification content — removes them,
 * however old they are. */
func TestRetentionSweepsLeaveTheMediaLibraryAlone(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), func(c *config.Config) { c.RecordingsRetentionDays = 1 })
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	ctx := context.Background()

	_, img, _ := uploadMedia(t, h, "image/jpeg", "kept.jpg", testJPEG(t, 600, 600))
	_, doc, _ := uploadMedia(t, h, "application/pdf", "kept.pdf", fakePDF)
	if _, err := h.store.Pool().Exec(ctx,
		`UPDATE crm_media_files SET created_at = now() - interval '2 years'`); err != nil {
		t.Fatal(err)
	}
	if !h.server.RunTick(ctx) {
		t.Fatal("tick did not run")
	}
	for _, id := range []string{img.ID, doc.ID} {
		key, thumb := storageKeyOf(t, h, id)
		if !onDisk(h, key) || (thumb != "" && !onDisk(h, thumb)) {
			t.Errorf("retention removed library file %s (%s)", id, key)
		}
	}
	if lib := mediaLibrary(t, h, ""); len(lib.Files) != 2 {
		t.Errorf("library after sweeps = %d files, want 2", len(lib.Files))
	}
}
