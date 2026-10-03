package api_test

import (
	"io"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* A recording is private until the host publishes it.
 *
 * The share link is on screen from the moment the file lands, and every recording used to
 * start public: anyone holding that link could watch and download a coaching call or a
 * paid class the host had not even played back yet. So the claims are made the way that
 * person meets them — no session, only the link — at both doors the public page uses: the
 * metadata it reads and the stream its player plays.
 */

// strangerGet is somebody with the link and nothing else: no cookie jar, no session.
func strangerGet(t *testing.T, h *harness, path string) (int, []byte) {
	t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return res.StatusCode, body
}

func TestARecordingIsPrivateUntilTheHostPublishesIt(t *testing.T) {
	h := newHarness(t)
	h.signup("Share Host", "sharehost@test.dev", true)
	wb := h.newWebinar("One-to-one coaching", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start webinar: status %d body %s", res.StatusCode, raw)
	}
	page := func(id string) string { return "/api/webinars/" + wb.ID + "/recordings/" + id + "/public" }
	stream := func(id string) string { return "/api/webinars/" + wb.ID + "/recordings/" + id + "/stream" }

	rec := readyRecording(t, h, wb.ID)
	if rec.IsPublic {
		t.Error("starting a recording returned it as public")
	}
	_, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	var list []types.Recording
	h.decode(raw, &list)
	if len(list) != 1 || list[0].IsPublic {
		t.Fatalf("host's list = %+v, want one private recording", list)
	}
	for _, path := range []string{page(rec.ID), stream(rec.ID)} {
		if code, body := strangerGet(t, h, path); code != http.StatusNotFound {
			t.Errorf("%s before publishing: status %d body %s, want 404", path, code, body)
		}
	}

	// Stop and record again: still the same private session.
	take := readyRecording(t, h, wb.ID)
	if take.IsPublic {
		t.Error("a second take of a private session came back public")
	}
	if code, _ := strangerGet(t, h, stream(take.ID)); code != http.StatusNotFound {
		t.Errorf("second take's stream before publishing: status %d, want 404", code)
	}

	// Publishing opens the whole session: the page and every take's file.
	if !publishRecording(t, h, wb.ID, rec.ID, true).IsPublic {
		t.Fatal("publishing did not make the recording public")
	}
	code, raw := strangerGet(t, h, page(rec.ID))
	if code != http.StatusOK {
		t.Fatalf("public page after publishing: status %d body %s", code, raw)
	}
	var pub types.PublicRecording
	h.decode(raw, &pub)
	if pub.ID != rec.ID || !pub.Unlocked || len(pub.Parts) != 2 {
		t.Errorf("public page = %+v, want the unlocked session with both takes", pub)
	}
	for _, id := range []string{rec.ID, take.ID} {
		if code, body := strangerGet(t, h, stream(id)); code != http.StatusOK || string(body) != "a-recording-of-something" {
			t.Errorf("stream of %s after publishing: status %d body %q", id, code, body)
		}
	}

	// A take recorded after publishing follows its session rather than starting private:
	// the public page lists it, so a private part there would be one that refuses to play.
	later := readyRecording(t, h, wb.ID)
	if !later.IsPublic {
		t.Error("a take recorded after publishing came back private")
	}
	if code, _ := strangerGet(t, h, stream(later.ID)); code != http.StatusOK {
		t.Errorf("stream of the take recorded after publishing: status %d, want 200", code)
	}

	// And switching it off closes the link again, every take included.
	publishRecording(t, h, wb.ID, rec.ID, false)
	if code, _ := strangerGet(t, h, page(rec.ID)); code != http.StatusNotFound {
		t.Errorf("public page after unpublishing: status %d, want 404", code)
	}
	for _, id := range []string{rec.ID, take.ID, later.ID} {
		if code, _ := strangerGet(t, h, stream(id)); code != http.StatusNotFound {
			t.Errorf("stream of %s after unpublishing: status %d, want 404", id, code)
		}
	}
}
