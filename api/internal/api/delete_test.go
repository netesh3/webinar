package api_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* Deleting a webinar has to delete the webinar.
 *
 * "Everything related to the webinar" spans seven tables and two kinds of file, and the
 * failure mode is silent in the worst way: the row goes, the host sees it disappear from their
 * list, and the chat transcript, the poll answers and a two-gigabyte recording stay on the
 * instance for ever. Nothing in the UI would ever show it.
 *
 * So this test builds a webinar with something in every one of those places, deletes it
 * through the HTTP surface the way the host's button does, and then goes looking with SQL and
 * with `os.Stat`. Counting rows through the API would only prove the API stopped listing
 * them.
 */
func TestDeletingAWebinarRemovesEverything(t *testing.T) {
	h := newHarness(t)
	h.signup("Cleanup Host", "cleanup-host@test.dev", true)

	// A panelist, so webinar_panelists has a row. Needs an account to be invited.
	h.signup("Guest Speaker", "cleanup-panelist@test.dev", false)
	h.logout()
	h.login("cleanup-host@test.dev")

	wb := h.newWebinar("Everything Webinar", func(in *types.WebinarInput) {
		in.PanelistEmails = []string{"cleanup-panelist@test.dev"}
		// A custom question, so custom_questions has a row.
		in.CustomQuestions = []types.CustomQuestion{
			{ID: "why", Label: "Why are you here?", Type: "text", Required: false},
		}
	})
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}

	// ---- fill every table -------------------------------------------------

	// A recording, with real bytes on disk.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if res, raw := h.doRaw(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/chunks",
		"application/octet-stream", []byte("some-recorded-bytes"), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("upload chunk: status %d body %s", res.StatusCode, raw)
	}

	// A chat image, which is the other kind of file.
	if res, raw := h.uploadImage(wb.ID, "img-0000042", onePixelPNG, "image/png"); res.StatusCode != http.StatusCreated {
		t.Fatalf("upload image: status %d body %s", res.StatusCode, raw)
	}

	// A poll for somebody to answer.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls",
		types.PollInput{Question: "Ready?", Kind: types.PollOpinion, Options: []string{"Yes", "No"}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create poll: status %d body %s", res.StatusCode, raw)
	}
	var poll types.Poll
	h.decode(raw, &poll)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("open poll: status %d body %s", res.StatusCode, raw)
	}

	h.logout()

	// A registration, and a vote cast with its join key.
	reg := h.registerAsGuest(wb.ID, "cleanup-attendee@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/polls/"+poll.ID+"/vote",
		types.PollVoteRequest{JoinKey: reg.JoinKey, Choice: 0}); res.StatusCode != http.StatusOK {
		t.Fatalf("vote: status %d body %s", res.StatusCode, raw)
	}
	// And a line of chat, so chat_messages holds text as well as the image.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{JoinKey: reg.JoinKey, Kind: types.MsgChat, ID: "msg-0000091", Text: "hello"}); res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}

	/* Everything is in place — assert that BEFORE deleting.
	 *
	 * Without this the test would pass just as well against a webinar that never had any of
	 * these rows, which is the classic way a cleanup test proves nothing: it counts to zero
	 * twice. Every count below must be non-zero here and zero afterwards. */
	before := countEverything(t, wb.ID)
	for name, n := range before {
		if n == 0 {
			t.Fatalf("fixture did not create any %s, so deleting them cannot be tested", name)
		}
	}
	files := storedFiles(t, h.recordingsDir)
	if len(files) < 2 {
		t.Fatalf("expected a recording and a chat image on disk, found %v", files)
	}

	// ---- delete -----------------------------------------------------------

	h.login("cleanup-host@test.dev")
	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}

	// ---- and check ---------------------------------------------------------

	after := countEverything(t, wb.ID)
	for name, n := range after {
		if n != 0 {
			t.Errorf("%d %s survived the delete (was %d)", n, name, before[name])
		}
	}

	if left := storedFiles(t, h.recordingsDir); len(left) != 0 {
		t.Errorf("%d file(s) left in storage: %v", len(left), left)
	}

	/* The live session has to end too. Somebody watching when the host pressed delete is
	 * otherwise still connected to a room for a webinar that no longer exists — they would sit
	 * there until the SFU's empty-room timeout, with chat and polls answering 404. */
	if !contains(h.rooms.deleted, lk.RoomName(wb.ID)) {
		t.Errorf("the SFU room was not closed: deleted rooms = %v", h.rooms.deleted)
	}

	// And the webinar itself is gone from every read path.
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("the host can still open it: status %d", res.StatusCode)
	}
	if res, _ := h.do(http.MethodGet, "/api/webinars/"+wb.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("the public page still resolves: status %d", res.StatusCode)
	}
}

/* An ended webinar can be deleted too.
 *
 * It could not before: the store refused any webinar that had run, on the reasoning that its
 * registrations are the attendance record. A reasonable policy and not ours to impose — a host
 * asking for their data to be removed means it, and the previous behaviour left them with a row
 * they could not get rid of through any screen in the product.
 */
func TestAnEndedWebinarCanBeDeleted(t *testing.T) {
	h := newHarness(t)
	h.signup("Ended Host", "ended-host@test.dev", true)
	wb := h.newWebinar("Already Over", nil)

	for _, action := range []string{"start", "end"} {
		if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/"+action, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d body %s", action, res.StatusCode, raw)
		}
	}

	res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete an ended webinar: status %d body %s", res.StatusCode, raw)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("still there: status %d", res.StatusCode)
	}
}

/* Deleting is still the owner's privilege, and only theirs.
 *
 * Worth its own test now that the status guard is gone. The guard was never access control,
 * but it did mean the most destructive version of this endpoint — deleting a webinar with an
 * audience in it — was unreachable. It is reachable now, so the ownership check is the only
 * thing standing in front of it.
 */
func TestOnlyTheOwnerCanDelete(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "delete-owner@test.dev", true)
	wb := h.newWebinar("Not Yours", nil)
	h.logout()

	// Another host, with the capability but not this webinar.
	h.signup("Other Host", "delete-other@test.dev", true)
	if res, _ := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusNotFound &&
		res.StatusCode != http.StatusForbidden {
		t.Errorf("another host deleted somebody else's webinar: status %d", res.StatusCode)
	}
	h.logout()

	// And nobody at all.
	if res, _ := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("an anonymous request deleted a webinar: status %d", res.StatusCode)
	}

	// Still there.
	h.login("delete-owner@test.dev")
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil); res.StatusCode != http.StatusOK {
		t.Errorf("the owner's webinar did not survive: status %d", res.StatusCode)
	}
}

/* countEverything asks the database directly, by slug.
 *
 * Directly, because the point is what is left in the tables and not what the API is willing to
 * report. Keyed by name so a failure says which table, and derived from the slug so it still
 * works after the webinars row itself is gone.
 */
func countEverything(t *testing.T, slug string) map[string]int {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pool.Close()

	counts := map[string]int{}
	queries := map[string]string{
		"webinars":      `SELECT count(*) FROM webinars WHERE slug = $1`,
		"registrations": `SELECT count(*) FROM registrations r JOIN webinars w ON w.id = r.webinar_id WHERE w.slug = $1`,
		"chat messages": `SELECT count(*) FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id WHERE w.slug = $1`,
		"polls":         `SELECT count(*) FROM polls p JOIN webinars w ON w.id = p.webinar_id WHERE w.slug = $1`,
		"poll votes": `SELECT count(*) FROM poll_votes v JOIN polls p ON p.id = v.poll_id
		                JOIN webinars w ON w.id = p.webinar_id WHERE w.slug = $1`,
		"recordings": `SELECT count(*) FROM recordings c JOIN webinars w ON w.id = c.webinar_id WHERE w.slug = $1`,
		"panelists":  `SELECT count(*) FROM webinar_panelists p JOIN webinars w ON w.id = p.webinar_id WHERE w.slug = $1`,
		"questions":  `SELECT count(*) FROM custom_questions q JOIN webinars w ON w.id = q.webinar_id WHERE w.slug = $1`,
	}
	for name, q := range queries {
		var n int
		if err := pool.QueryRow(ctx, q, slug).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", name, err)
		}
		counts[name] = n
	}
	return counts
}

/** storedFiles lists every regular file under the storage root, so "the bytes are gone" is
 *  checked against the filesystem rather than against a row that used to name them. */
func storedFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(root, path)
			out = append(out, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return out
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
