package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

// promoteSeedAdmin makes the seeded host an admin, the way boot does from ADMIN_EMAILS.
func promoteSeedAdmin(t *testing.T, h *harness) {
	t.Helper()
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
}

// Every admin session control is behind requireAdmin: a host, even of that very webinar, gets 403.
func TestAdminSessionControlsRefuseNonAdmins(t *testing.T) {
	h := newHarness(t)
	h.signup("Plain Host", "plain-host@test.dev", true)
	wb := h.newWebinar("Not an admin's", nil)
	h.goLive(wb.ID)

	for _, ep := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/admin/webinars/" + wb.ID + "/end", nil},
		{http.MethodPatch, "/api/admin/webinars/" + wb.ID + "/status", types.AdminWebinarStatus{Status: types.StatusDraft}},
		{http.MethodDelete, "/api/admin/webinars/" + wb.ID, nil},
		{http.MethodGet, "/api/admin/webinars?kind=meeting", nil},
	} {
		res, raw := h.do(ep.method, ep.path, ep.body)
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s as a host: status %d body %s, want 403", ep.method, ep.path, res.StatusCode, raw)
		}
	}
	got, err := h.store.WebinarBySlug(context.Background(), wb.ID)
	if err != nil || got.Status != types.StatusLive {
		t.Errorf("after the refused calls: %v, status %q, want still live", err, got.Status)
	}
}

/* An admin's End is the host's End: the room goes, the open recording is finalised, the row
 * says ended, and the deploy guard stops counting it. */
func TestAdminEndsALiveWebinarThroughTheHostEndPath(t *testing.T) {
	h := newHarness(t, withTickSecret)
	h.signup("Live Host", "live-host@test.dev", true)
	grantCloudRecording(t, h)
	wb := h.newWebinar("Admin ends this", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if res, raw := h.doRaw(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/chunks",
		"application/octet-stream", []byte("some-video"), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("chunk: status %d body %s", res.StatusCode, raw)
	}
	if _, got := getLiveStatus(t, h, testTickSecret); !liveStatusHas(got, wb.ID) {
		t.Fatalf("live-status before the end = %+v, want %s in it", got.Live, wb.ID)
	}

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPost, "/api/admin/webinars/"+wb.ID+"/end", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin end: status %d body %s", res.StatusCode, raw)
	}
	var ended types.Webinar
	h.decode(raw, &ended)
	if ended.Status != types.StatusEnded {
		t.Errorf("status after admin end = %q, want ended", ended.Status)
	}

	h.rooms.mu.Lock()
	deleted := append([]string{}, h.rooms.deleted...)
	h.rooms.mu.Unlock()
	if !contains(deleted, lk.RoomName(wb.ID)) {
		t.Errorf("the room was not closed: deleted rooms = %v", deleted)
	}
	recs, err := h.store.Recordings(context.Background(), wb.ID)
	if err != nil || len(recs) != 1 || recs[0].Status != types.RecordingReady {
		t.Errorf("recording after the admin end = %+v (%v), want it finalised as ready", recs, err)
	}
	if _, got := getLiveStatus(t, h, testTickSecret); liveStatusHas(got, wb.ID) {
		t.Errorf("live-status after the end still lists %s: %+v", wb.ID, got.Live)
	}

	// Pressing it again is not an error.
	if res, raw := h.do(http.MethodPost, "/api/admin/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Errorf("second end: status %d body %s, want 200", res.StatusCode, raw)
	}
}

func liveStatusHas(got liveStatus, slug string) bool {
	for _, l := range got.Live {
		if l.Slug == slug {
			return true
		}
	}
	return false
}

// Draft and scheduled move both ways; nothing else does, and each refusal says why.
func TestAdminStatusTransitions(t *testing.T) {
	h := newHarness(t)
	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")

	setStatus := func(slug string, st types.WebinarStatus) (int, types.Webinar, string) {
		t.Helper()
		res, raw := h.do(http.MethodPatch, "/api/admin/webinars/"+slug+"/status", types.AdminWebinarStatus{Status: st})
		var wb types.Webinar
		if res.StatusCode == http.StatusOK {
			h.decode(raw, &wb)
		}
		return res.StatusCode, wb, string(raw)
	}

	planned := h.newWebinar("Planned", nil)
	if code, wb, raw := setStatus(planned.ID, types.StatusDraft); code != http.StatusOK || wb.Status != types.StatusDraft {
		t.Fatalf("scheduled → draft: %d %s", code, raw)
	}
	if code, wb, raw := setStatus(planned.ID, types.StatusScheduled); code != http.StatusOK || wb.Status != types.StatusScheduled {
		t.Fatalf("draft → scheduled: %d %s", code, raw)
	}
	// Not live from here, and not ended either: that is End.
	if code, _, raw := setStatus(planned.ID, types.StatusLive); code != http.StatusConflict {
		t.Errorf("→ live: %d %s, want 409", code, raw)
	}
	if code, _, raw := setStatus(planned.ID, types.StatusEnded); code != http.StatusConflict {
		t.Errorf("→ ended: %d %s, want 409", code, raw)
	}
	// End on a session that is not live has nothing to end.
	if res, raw := h.do(http.MethodPost, "/api/admin/webinars/"+planned.ID+"/end", nil); res.StatusCode != http.StatusConflict {
		t.Errorf("end a scheduled session: %d %s, want 409", res.StatusCode, raw)
	}

	live := h.newWebinar("On the air", nil)
	h.goLive(live.ID)
	if code, _, raw := setStatus(live.ID, types.StatusDraft); code != http.StatusConflict {
		t.Errorf("live → draft: %d %s, want 409", code, raw)
	}

	over := h.newWebinar("Over", nil)
	h.goLive(over.ID)
	if _, err := h.store.SetStatus(context.Background(), over.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	if code, _, raw := setStatus(over.ID, types.StatusScheduled); code != http.StatusConflict {
		t.Errorf("ended → scheduled: %d %s, want 409", code, raw)
	}

	if code, _, raw := setStatus(planned.ID, "paused"); code != http.StatusUnprocessableEntity {
		t.Errorf("unknown status: %d %s, want 422", code, raw)
	}
	if code, _, _ := setStatus("no-such-webinar", types.StatusDraft); code != http.StatusNotFound {
		t.Errorf("missing webinar: %d, want 404", code)
	}
}

// Meetings are on the admin list under their own chip, and an admin can delete one.
func TestAdminListsAndDeletesAMeeting(t *testing.T) {
	h := newHarness(t)
	h.signup("Meeting Host", "meeting-host@test.dev", true)
	meeting := h.newWebinar("Team sync", nil)
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE webinars SET kind = 'meeting' WHERE slug = $1`, meeting.ID); err != nil {
		t.Fatal(err)
	}
	h.goLive(meeting.ID)
	webinar := h.newWebinar("Big talk", nil)

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")

	list := func(qs string) []string {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/admin/webinars?"+qs, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("admin webinars ?%s: status %d body %s", qs, res.StatusCode, raw)
		}
		var rows []types.Webinar
		h.decode(raw, &rows)
		slugs := make([]string, 0, len(rows))
		for _, w := range rows {
			slugs = append(slugs, w.ID)
		}
		return slugs
	}
	if got := list("kind=meeting"); !contains(got, meeting.ID) || contains(got, webinar.ID) {
		t.Errorf("kind=meeting = %v, want the meeting and not the webinar", got)
	}
	if got := list("kind=webinar"); contains(got, meeting.ID) || !contains(got, webinar.ID) {
		t.Errorf("kind=webinar = %v, want the webinar and not the meeting", got)
	}
	// Search by the host's email finds both of theirs.
	if got := list("q=meeting-host@test"); !contains(got, meeting.ID) || !contains(got, webinar.ID) {
		t.Errorf("q=host email = %v, want both sessions", got)
	}
	if res, raw := h.do(http.MethodGet, "/api/admin/webinars?kind=party", nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("kind=party: %d %s, want 422", res.StatusCode, raw)
	}

	if res, raw := h.do(http.MethodDelete, "/api/admin/webinars/"+meeting.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("admin delete meeting: status %d body %s", res.StatusCode, raw)
	}
	if _, err := h.store.WebinarBySlug(context.Background(), meeting.ID); err == nil {
		t.Error("the meeting is still there after the admin deleted it")
	}
	h.rooms.mu.Lock()
	deleted := append([]string{}, h.rooms.deleted...)
	h.rooms.mu.Unlock()
	if !contains(deleted, lk.RoomName(meeting.ID)) {
		t.Errorf("the live meeting's room was not closed: deleted rooms = %v", deleted)
	}
}
