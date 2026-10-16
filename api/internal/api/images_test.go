package api_test

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// coverFile is the storage key and on-disk bytes of a webinar's cover image.
func coverFile(t *testing.T, h *harness, slug string) (string, []byte) {
	t.Helper()
	var key string
	var data []byte
	if err := h.store.Pool().QueryRow(t.Context(),
		`SELECT image_storage_key, image_data FROM webinars WHERE slug = $1`, slug).Scan(&key, &data); err != nil {
		t.Fatal(err)
	}
	if len(data) != 0 {
		t.Fatalf("cover bytes still in the row (%d)", len(data))
	}
	if key == "" {
		return "", nil
	}
	onDisk, err := os.ReadFile(filepath.Join(h.recordingsDir, key))
	if err != nil {
		t.Fatalf("cover file %s: %v", key, err)
	}
	return key, onDisk
}

func gone(t *testing.T, h *harness, key string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(h.recordingsDir, key)); !os.IsNotExist(err) {
		t.Fatalf("%s still on disk (%v)", key, err)
	}
}

/* A cover upload is a file in the media store and only its key in the row. A
 * replacement deletes the old file, removing the image deletes the file, and so
 * does deleting the webinar. */
func TestCoverImagesLiveInTheMediaStore(t *testing.T) {
	h := newHarness(t)
	h.signup("Cover Host", "cover-host@test.dev", true)
	wb := h.newWebinar("Covered", nil)
	upload := func(body []byte) {
		t.Helper()
		res, raw := h.doRaw(http.MethodPost, "/api/host/webinars/"+wb.ID+"/image", "application/octet-stream", body, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("upload: %d %s", res.StatusCode, raw)
		}
	}

	upload(onePixelPNG)
	first, onDisk := coverFile(t, h, wb.ID)
	if !strings.HasPrefix(first, "covers/"+wb.ID+"/") || !bytes.Equal(onDisk, onePixelPNG) {
		t.Fatalf("first cover = %q (%d bytes)", first, len(onDisk))
	}
	res, raw := h.do(http.MethodGet, "/api/webinars/"+wb.ID+"/image", nil)
	if res.StatusCode != http.StatusOK || !bytes.Equal(raw, onePixelPNG) {
		t.Fatalf("serve: %d, %d bytes", res.StatusCode, len(raw))
	}

	upload(onePixelPNG)
	second, _ := coverFile(t, h, wb.ID)
	if second == first {
		t.Fatal("replacement reused the key")
	}
	gone(t, h, first)

	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/image", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("clear: %d %s", res.StatusCode, raw)
	}
	gone(t, h, second)

	upload(onePixelPNG)
	third, _ := coverFile(t, h, wb.ID)
	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete webinar: %d %s", res.StatusCode, raw)
	}
	gone(t, h, third)
}

/* Images uploaded before 0098 are still bytes in their row. They are served from
 * there until the tick moves them, and moving them keeps the same image. */
func TestImagesInPostgresAreServedThenMoved(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Legacy Host", "legacy-host@test.dev", true)
	wb := h.newWebinar("Legacy cover", nil)
	ctx := t.Context()
	db := h.store.Pool()
	if _, err := db.Exec(ctx, `
		UPDATE webinars SET image_key = 'v-old', image_mime = 'image/png', image_data = $2, image_storage_key = ''
		 WHERE slug = $1`, wb.ID, onePixelPNG); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE users SET avatar_key = 'v-old', avatar_mime = 'image/png', avatar_data = $2, avatar_storage_key = ''
		 WHERE id = $1::uuid`, acct.ID, onePixelPNG); err != nil {
		t.Fatal(err)
	}

	serve := func(path string) {
		t.Helper()
		res, raw := h.do(http.MethodGet, path, nil)
		if res.StatusCode != http.StatusOK || !bytes.Equal(raw, onePixelPNG) {
			t.Fatalf("%s: %d, %d bytes", path, res.StatusCode, len(raw))
		}
	}
	serve("/api/webinars/" + wb.ID + "/image")
	serve("/api/auth/avatar")

	if !h.server.RunTick(ctx) {
		t.Fatal("tick did not run")
	}
	key, onDisk := coverFile(t, h, wb.ID)
	if !strings.HasPrefix(key, "covers/") || !bytes.Equal(onDisk, onePixelPNG) {
		t.Fatalf("moved cover = %q (%d bytes)", key, len(onDisk))
	}
	var avatarKey string
	var avatarData []byte
	if err := db.QueryRow(ctx, `SELECT avatar_storage_key, avatar_data FROM users WHERE id = $1::uuid`, acct.ID).
		Scan(&avatarKey, &avatarData); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(avatarKey, "avatars/"+acct.ID+"/") || len(avatarData) != 0 {
		t.Fatalf("moved avatar = %q, %d bytes left in row", avatarKey, len(avatarData))
	}
	serve("/api/webinars/" + wb.ID + "/image")
	serve("/api/auth/avatar")
}
