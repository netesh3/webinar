package api_test

/* The attendee list export: GET /api/host/webinars/{slug}/attendees.csv.
 *
 * Set TEST_DATABASE_URL to run; skipped otherwise, like every test in this package. */

import (
	"bytes"
	"context"
	"encoding/csv"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/engagement/capture"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func readAttendeeCSV(t *testing.T, h *harness, slug, scope string) (*http.Response, [][]string) {
	t.Helper()
	path := "/api/host/webinars/" + slug + "/attendees.csv"
	if scope != "" {
		path += "?scope=" + scope
	}
	res, raw := h.do(http.MethodGet, path, nil)
	if res.StatusCode != http.StatusOK {
		return res, nil
	}
	if !bytes.HasPrefix(raw, []byte("\xEF\xBB\xBF")) {
		t.Fatalf("no UTF-8 BOM: %q", raw[:min(len(raw), 10)])
	}
	if !bytes.Contains(raw, []byte("\r\n")) {
		t.Errorf("rows are not CRLF-terminated")
	}
	records, err := csv.NewReader(bytes.NewReader(raw[3:])).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v\n%s", err, raw)
	}
	return res, records
}

func TestAttendeeCSVExport(t *testing.T) {
	h := newHarness(t)
	h.signup("Export Host", "export-host@test.dev", true)
	wb := h.newWebinar("Export", func(in *types.WebinarInput) {
		in.TimeZone = "Asia/Kolkata"
		in.CustomQuestions = []types.CustomQuestion{
			{Label: "Company size", Type: "text"},
			{Label: "Role", Type: "select", Options: []string{"Engineer", "Manager"}},
		}
	})
	size, role := wb.CustomQuestions[0], wb.CustomQuestions[1]
	ctx := context.Background()

	// Before the session has ended there is nothing to export.
	if res, _ := readAttendeeCSV(t, h, wb.ID, ""); res.StatusCode != http.StatusConflict {
		t.Fatalf("before the end: status %d, want 409", res.StatusCode)
	}

	attendee := h.finishRegistration(wb.ID, "ada@test.dev", h.postRegister(wb.ID, "ada@test.dev",
		"Ada", `Lovelace, "Countess"`, map[string]string{size.ID: "=1+1", role.ID: "Manager"}))
	h.finishRegistration(wb.ID, "noshow@test.dev", h.postRegister(wb.ID, "noshow@test.dev",
		"Nora", "Noshow", map[string]string{size.ID: "10, maybe 20", role.ID: "Engineer"}))

	h.goLive(wb.ID)
	live := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Hour)
	end := live.Add(time.Hour)

	identity := "att_" + attendee.JoinKey
	mustOpen(t, h, ctx, wb.ID, identity, "Ada", live.Add(5*time.Minute))
	mustClose(t, h, ctx, wb.ID, identity, live.Add(35*time.Minute))
	if _, err := h.store.AppendChat(ctx, store.ChatEntry{
		ID: "c-export-1", Slug: wb.ID, SenderID: identity, SenderName: "Ada",
		SenderRole: types.RoleAttendee, Type: types.ChatMessageType("text"),
		Destination: types.ChatDestination("everyone"), Content: "hello",
	}); err != nil {
		t.Fatalf("chat: %v", err)
	}
	if err := h.store.UpsertSessionQuestion(ctx, wb.ID, types.SessionQuestion{
		ID: "q-export-1", Identity: identity, Name: "Ada", Text: "When?",
	}); err != nil {
		t.Fatalf("question: %v", err)
	}
	if _, err := h.store.Pool().Exec(ctx, `
		WITH p AS (INSERT INTO polls (webinar_id, question, options, state)
		           SELECT id, 'Q?', '["a","b"]', 'closed' FROM webinars WHERE slug = $1 RETURNING id)
		INSERT INTO poll_votes (poll_id, identity, choice) SELECT id, $2, 0 FROM p`, wb.ID, identity); err != nil {
		t.Fatalf("poll vote: %v", err)
	}
	if err := h.store.InsertEngagementEvents(ctx, []capture.Event{
		{Slug: wb.ID, Identity: identity, Kind: capture.HandRaise, At: live.Add(10 * time.Minute)},
	}); err != nil {
		t.Fatalf("hand: %v", err)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: %d %s", res.StatusCode, raw)
	}
	pinSessionWindow(t, wb.ID, live, end)

	res, recs := readAttendeeCSV(t, h, wb.ID, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("export: status %d", res.StatusCode)
	}
	cd := res.Header.Get("Content-Disposition")
	wantName := wb.ID + "-attendees-" + live.In(mustLoc(t, "Asia/Kolkata")).Format("2006-01-02") + ".csv"
	if !strings.Contains(cd, wantName) {
		t.Errorf("Content-Disposition = %q, want filename %s", cd, wantName)
	}
	wantHeader := []string{
		"name", "email", "phone", "registered_at", "attended", "first_joined_at", "last_left_at",
		"total_minutes", "watch_percent", "joined_via", "questions_asked", "chat_messages",
		"polls_answered", "raised_hand", "Company size", "Role",
	}
	if strings.Join(recs[0], "|") != strings.Join(wantHeader, "|") {
		t.Fatalf("header = %v\nwant     %v", recs[0], wantHeader)
	}
	if len(recs) != 2 {
		t.Fatalf("attended only: %d rows, want header + 1: %v", len(recs), recs)
	}
	col := map[string]int{}
	for i, c := range recs[0] {
		col[c] = i
	}
	row := recs[1]
	if row[col["name"]] != `Ada Lovelace, "Countess"` {
		t.Errorf("name = %q (quoting lost)", row[col["name"]])
	}
	if row[col["Company size"]] != "'=1+1" {
		t.Errorf("formula not guarded: %q", row[col["Company size"]])
	}
	if p := row[col["phone"]]; p != "'"+testPhone && p != testPhone {
		t.Errorf("phone = %q", p)
	}
	checks := map[string]string{
		"email": "ada@test.dev", "attended": "yes", "total_minutes": "30", "watch_percent": "50",
		"joined_via": "webrtc", "questions_asked": "1", "chat_messages": "1", "polls_answered": "1",
		"raised_hand": "yes", "Role": "Manager",
	}
	for c, want := range checks {
		if row[col[c]] != want {
			t.Errorf("%s = %q, want %q", c, row[col[c]], want)
		}
	}
	// Host time zone, ISO offset.
	if got := row[col["first_joined_at"]]; !strings.HasSuffix(got, "+05:30") {
		t.Errorf("first_joined_at = %q, want an IST offset", got)
	}
	sameInstant(t, row[col["first_joined_at"]], live.Add(5*time.Minute), "first_joined_at")
	sameInstant(t, row[col["last_left_at"]], live.Add(35*time.Minute), "last_left_at")

	// All registrants: the no-show is added, with blanks for what they never did.
	_, recs = readAttendeeCSV(t, h, wb.ID, "all")
	if len(recs) != 3 {
		t.Fatalf("all: %d rows, want header + 2: %v", len(recs), recs)
	}
	ns := recs[2]
	if ns[col["name"]] != "Nora Noshow" || ns[col["attended"]] != "no" ||
		ns[col["first_joined_at"]] != "" || ns[col["total_minutes"]] != "" || ns[col["joined_via"]] != "" {
		t.Errorf("no-show row = %v", ns)
	}
	if ns[col["Company size"]] != "10, maybe 20" || ns[col["Role"]] != "Engineer" {
		t.Errorf("no-show answers = %v", ns)
	}
	if ns[col["registered_at"]] == "" {
		t.Errorf("no-show registered_at empty")
	}

	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/attendees.csv?scope=bogus", nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("bad scope: status %d, want 422", res.StatusCode)
	}

	// Access: a co-host may export; another host and an admin who is not on the session may not.
	co := h.signup("Export CoHost", "export-cohost@test.dev", true)
	if err := h.store.SetCoHost(ctx, wb.ID, "user_"+co.ID, "Export CoHost", true); err != nil {
		t.Fatal(err)
	}
	h.login("export-cohost@test.dev")
	if res, _ := readAttendeeCSV(t, h, wb.ID, ""); res.StatusCode != http.StatusOK {
		t.Errorf("co-host: status %d, want 200", res.StatusCode)
	}

	h.signup("Other Host", "export-other@test.dev", true)
	if res, _ := readAttendeeCSV(t, h, wb.ID, ""); res.StatusCode != http.StatusNotFound {
		t.Errorf("another host: status %d, want 404", res.StatusCode)
	}
	if _, err := h.store.Pool().Exec(ctx, `UPDATE users SET is_admin = true WHERE email = 'export-other@test.dev'`); err != nil {
		t.Fatal(err)
	}
	h.login("export-other@test.dev")
	if res, _ := readAttendeeCSV(t, h, wb.ID, ""); res.StatusCode != http.StatusNotFound {
		t.Errorf("admin, not on the session: status %d, want 404", res.StatusCode)
	}
	h.logout()
	if res, _ := readAttendeeCSV(t, h, wb.ID, ""); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: status %d, want 401", res.StatusCode)
	}
}

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	l, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return l
}
