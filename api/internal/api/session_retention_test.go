package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
)

/* Chat images are deleted the recording-retention window after their webinar ends,
 * and captions are archived into one stored transcript 30 days after it ends. The
 * chat message and the transcript download both survive; a webinar that ended last
 * week keeps everything. */
func TestChatImagesAndCaptionsExpireAfterTheWebinar(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.RecordingsRetentionDays = 30 })
	h.signup("Retention Host", "session-retention@test.dev", true)
	oldWb := h.newWebinar("Ended long ago", nil)
	newWb := h.newWebinar("Ended last week", nil)
	ctx := t.Context()
	db := h.store.Pool()

	if _, err := db.Exec(ctx, `
		UPDATE webinars SET status = 'ended', ended_at = CASE slug
		       WHEN $1 THEN now() - interval '40 days'
		       ELSE now() - interval '5 days' END
		 WHERE slug IN ($1, $2)`, oldWb.ID, newWb.ID); err != nil {
		t.Fatal(err)
	}

	for _, slug := range []string{oldWb.ID, newWb.ID} {
		key := "chat/" + slug + "/img-" + slug + ".png"
		path := filepath.Join(h.recordingsDir, key)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("png-"+slug), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO chat_messages (id, webinar_id, sender_identity, sender_name, sender_role,
			                           message_type, media_key, media_mime)
			SELECT 'img-'||$1, id, 'att_x', 'Ada', 'attendee', 'image', $2, 'image/png'
			  FROM webinars WHERE slug = $1`, slug, key); err != nil {
			t.Fatal(err)
		}
		for _, line := range []string{"hello everyone", "thanks for joining"} {
			if err := h.store.AppendCaption(ctx, slug, "host_1", line); err != nil {
				t.Fatal(err)
			}
		}
	}

	transcript := func(slug string) string {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/transcript.txt", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("transcript %s: %d %s", slug, res.StatusCode, raw)
		}
		return string(raw)
	}
	before := transcript(oldWb.ID)
	if !strings.Contains(before, "host_1: hello everyone") || !strings.Contains(before, "thanks for joining") {
		t.Fatalf("transcript before archive = %q", before)
	}

	if !h.server.RunTick(ctx) {
		t.Fatal("tick did not run")
	}

	image := func(slug string) (int, string) {
		t.Helper()
		res, raw := h.doRaw(http.MethodGet, "/api/webinars/"+slug+"/chat/media/img-"+slug, "", nil, nil)
		return res.StatusCode, string(raw)
	}
	if code, body := image(oldWb.ID); code != http.StatusGone {
		t.Fatalf("expired chat image: %d %s, want 410", code, body)
	}
	if _, err := os.Stat(filepath.Join(h.recordingsDir, "chat/"+oldWb.ID+"/img-"+oldWb.ID+".png")); !os.IsNotExist(err) {
		t.Fatalf("expired chat image file still on disk: %v", err)
	}
	if code, body := image(newWb.ID); code != http.StatusOK || body != "png-"+newWb.ID {
		t.Fatalf("recent chat image: %d %q", code, body)
	}

	var oldRows, newRows, messages int
	if err := db.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM session_captions c JOIN webinars w ON w.id = c.webinar_id WHERE w.slug = $1),
		       (SELECT count(*) FROM session_captions c JOIN webinars w ON w.id = c.webinar_id WHERE w.slug = $2),
		       (SELECT count(*) FROM chat_messages WHERE id = 'img-'||$1)`, oldWb.ID, newWb.ID).
		Scan(&oldRows, &newRows, &messages); err != nil {
		t.Fatal(err)
	}
	if oldRows != 0 || newRows != 2 || messages != 1 {
		t.Fatalf("caption rows old=%d new=%d, chat message kept=%d; want 0, 2, 1", oldRows, newRows, messages)
	}
	if after := transcript(oldWb.ID); after != before {
		t.Fatalf("archived transcript = %q, want %q", after, before)
	}
}
