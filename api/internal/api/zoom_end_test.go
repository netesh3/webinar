package api_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* Ending the meeting in Zoom is what marks the webinar ended, and the people
 * Zoom reports are the attendance the host page already reads.
 */

func TestZoomEndRecordsAttendance(t *testing.T) {
	const secret = "zoom-hook-secret"
	const meetingID = "1001"
	guest := "ada-zoom-end@example.test"

	zoomSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth/token":
			_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh-1","expires_in":3600}`))
		case r.URL.Path == "/past_meetings/"+meetingID+"/participants":
			_, _ = w.Write([]byte(`{"participants":[
				{"id":"zhost","user_id":"h1","name":"Zoom Host","user_email":"zoom-end-host@test.dev","join_time":"2026-10-01T13:25:00Z","leave_time":"2026-10-01T13:30:00Z"},
				{"user_id":"guest-1","name":"Test User","user_email":"` + guest + `","join_time":"2026-10-01T13:25:00Z","leave_time":"2026-10-01T13:30:00Z"},
				{"user_id":"walk-1","name":"Walk In","join_time":"2026-10-01T13:26:00Z","leave_time":"2026-10-01T13:28:00Z"}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(zoomSrv.Close)

	const tokenKey = "0123456789abcdef0123456789abcdef"
	h := newHarness(t, func(cfg *config.Config) {
		cfg.ZoomClientID = "cid"
		cfg.ZoomClientSecret = "sec"
		cfg.ZoomRedirectURL = "https://example.test/api/host/zoom/callback"
		cfg.ZoomTokenKey = tokenKey
		cfg.ZoomWebhookSecret = secret
		cfg.ZoomAPIURL = zoomSrv.URL
		cfg.ZoomOAuthURL = zoomSrv.URL
	})
	host := h.signup("Zoom Host", "zoom-end-host@test.dev", true)
	key, err := zoom.ParseKey(tokenKey)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := zoom.Seal(key, "refresh-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveZoomConnection(context.Background(), store.ZoomConnection{
		UserID: host.ID, ZoomUserID: "zhost", Email: "zoom-end-host@test.dev", Refresh: blob,
	}); err != nil {
		t.Fatal(err)
	}

	wb := h.newWebinar("Test Zoom Meeting", nil)
	if err := h.store.SetWebinarZoom(context.Background(), wb.ID, zoom.VenueMeeting, meetingID, "https://zoom.us/s/host", ""); err != nil {
		t.Fatal(err)
	}
	h.registerAs(wb.ID, guest)

	res, raw := postZoom(t, h, secret, []byte(`{"event":"meeting.ended","payload":{"object":{"id":9999}}}`))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("unknown meeting: status %d body %s", res.StatusCode, raw)
	}

	res, raw = postZoom(t, h, "wrong-secret", []byte(`{"event":"meeting.ended","payload":{"object":{"id":`+meetingID+`}}}`))
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad signature: status %d body %s", res.StatusCode, raw)
	}
	if got := h.webinarStatus(wb.ID); got != string(types.StatusScheduled) {
		t.Fatalf("status after a rejected webhook = %q", got)
	}

	res, raw = postZoom(t, h, secret, []byte(`{"event":"meeting.participant_joined","payload":{"object":{"id":`+meetingID+`,"host_id":"zhost","participant":{"user_name":"Test User","email":"`+guest+`","user_id":"guest-1","join_time":"2026-10-01T13:25:00Z"}}}}`))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}

	res, raw = postZoom(t, h, secret, []byte(`{"event":"meeting.ended","payload":{"object":{"id":`+meetingID+`,"host_id":"zhost","start_time":"2026-10-01T13:25:00Z","end_time":"2026-10-01T13:30:00Z"}}}`))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ended: status %d body %s", res.StatusCode, raw)
	}
	if got := h.webinarStatus(wb.ID); got != string(types.StatusEnded) {
		t.Fatalf("status = %q, want ended", got)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/report", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("report: status %d body %s", res.StatusCode, raw)
	}
	var rep types.SessionReport
	h.decode(raw, &rep)
	if rep.Attended != 2 {
		t.Fatalf("attended = %d, want 2 (registrant and walk-in, not the host)\n%+v", rep.Attended, rep.Attendees)
	}
	var guestVisits, hostRole int
	names := map[string]bool{}
	for _, a := range rep.Attendees {
		names[a.Name] = true
		if a.Email == guest {
			guestVisits = len(a.Visits)
		}
		if a.Role == "host" {
			hostRole++
		}
	}
	if !names["Test User"] || !names["Walk In"] || !names["Zoom Host"] {
		t.Fatalf("names = %v", names)
	}
	if guestVisits != 1 {
		t.Fatalf("registrant visits = %d, want 1 (join plus the report must not double)", guestVisits)
	}
	if hostRole != 1 {
		t.Fatalf("host rows = %d", hostRole)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement/attendees", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("attendees: status %d body %s", res.StatusCode, raw)
	}
	var page types.EngagementAttendeePage
	h.decode(raw, &page)
	if page.Total != 2 {
		t.Fatalf("engagement attendees = %d, want 2\n%s", page.Total, raw)
	}

	res, raw = postZoom(t, h, secret, []byte(`{"event":"meeting.ended","payload":{"object":{"id":`+meetingID+`,"start_time":"2026-10-01T13:25:00Z","end_time":"2026-10-01T13:30:00Z"}}}`))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ended again: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/report", nil)
	h.decode(raw, &rep)
	for _, a := range rep.Attendees {
		if a.Email == guest && len(a.Visits) != 1 {
			t.Fatalf("after a second ended event, visits = %d", len(a.Visits))
		}
	}
}

func (h *harness) webinarStatus(slug string) string {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("load webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return string(wb.Status)
}

func postZoom(t *testing.T, h *harness, secret string, body []byte) (*http.Response, []byte) {
	t.Helper()
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v0:" + ts + ":"))
	mac.Write(body)
	req, err := http.NewRequest(http.MethodPost, h.srv.URL+"/api/webhooks/zoom", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-zm-request-timestamp", ts)
	req.Header.Set("x-zm-signature", "v0="+hex.EncodeToString(mac.Sum(nil)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}
