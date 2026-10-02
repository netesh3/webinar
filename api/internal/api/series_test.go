package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func seriesStart(t *testing.T) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	// Far enough ahead that the one-hour lead accepts it, and late enough in
	// the day that the clock assertion is not "midnight in UTC".
	day := time.Now().In(loc).Add(50 * time.Hour)
	return time.Date(day.Year(), day.Month(), day.Day(), 23, 15, 0, 0, loc)
}

func seriesBody(topic string, start time.Time, count int) types.WebinarInput {
	return types.WebinarInput{
		Topic:                topic,
		Summary:              "A repeating session",
		StartsAt:             start.Format(time.RFC3339),
		Duration:             60,
		TimeZone:             "Asia/Kolkata",
		Kind:                 types.KindRecurring,
		Status:               types.StatusScheduled,
		RegistrationRequired: true,
		Approval:             types.ApprovalAutomatic,
		AttendeeLimit:        50,
		Recurrence: &types.RecurrenceInput{
			Pattern: "daily", Interval: 1, End: "after_count", EndCount: count,
		},
		Controls: types.SessionControls{
			HideAttendees: true, MuteOnEntry: true, AllowUnmute: true,
			ChatEnabled: true, QAEnabled: true, RaiseHandEnabled: true,
			ReactionsEnabled: true, PollsEnabled: true,
		},
	}
}

func inputFromWebinar(wb types.Webinar, count int) types.WebinarInput {
	in := seriesBody(wb.Topic, time.Time{}, count)
	in.Summary = wb.Summary
	in.Descript = wb.Descript
	in.Track = wb.Track
	in.Duration = wb.Duration
	in.StartsAt = wb.StartsAt
	in.TimeZone = wb.TimeZone
	in.RegistrationRequired = wb.RegistrationRequired
	in.Approval = wb.Approval
	in.AttendeeLimit = wb.AttendeeLimit
	in.Agenda = wb.Agenda
	in.Takeaways = wb.Takeaways
	in.CustomQuestions = wb.CustomQuestions
	in.Options = wb.Options
	in.Controls = wb.Controls
	in.Venue = wb.Venue
	if wb.Series != nil {
		in.Recurrence = &types.RecurrenceInput{
			Pattern:  wb.Series.Pattern,
			Interval: wb.Series.Interval,
			Weekdays: wb.Series.Weekdays,
			End:      wb.Series.End,
			EndDate:  wb.Series.EndDate,
			EndCount: count,
		}
		if wb.Series.End == "by_date" {
			in.Recurrence.EndCount = 0
			in.Recurrence.EndDate = wb.Series.EndDate
		}
	}
	return in
}

type seriesRow struct {
	slug      string
	starts    time.Time
	seriesID  string
	index     int
	exception bool
	topic     string
	duration  int
	status    string
}

func (h *harness) seriesRows(seriesID string) []seriesRow {
	h.t.Helper()
	rows, err := h.store.Pool().Query(context.Background(), `
		SELECT slug, starts_at, series_id::text, coalesce(occurrence_index, 0),
		       series_exception, topic, duration_min, status
		  FROM webinars
		 WHERE series_id = $1::uuid
		 ORDER BY starts_at ASC`, seriesID)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	var out []seriesRow
	for rows.Next() {
		var row seriesRow
		if err := rows.Scan(&row.slug, &row.starts, &row.seriesID, &row.index, &row.exception, &row.topic, &row.duration, &row.status); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		h.t.Fatal(err)
	}
	return out
}

func TestCreateSeriesPersistsLinkedWebinars(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "series-host@test.dev", true)
	start := seriesStart(t)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", seriesBody("Daily stand-up", start, 7))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create series: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if wb.SeriesID == "" || wb.Series == nil {
		t.Fatalf("first session missing series: %+v", wb.Series)
	}
	if wb.Kind != types.KindRecurring {
		t.Fatalf("kind %s", wb.Kind)
	}
	rows := h.seriesRows(wb.SeriesID)
	if len(rows) != 7 {
		t.Fatalf("sessions %d, want 7", len(rows))
	}
	loc, _ := time.LoadLocation("Asia/Kolkata")
	for i, row := range rows {
		if row.seriesID != wb.SeriesID {
			t.Fatalf("session %d series %s", i, row.seriesID)
		}
		local := row.starts.In(loc)
		if local.Hour() != 23 || local.Minute() != 15 {
			t.Fatalf("session %d clock %s, want 23:15 IST", i, local.Format("15:04"))
		}
		wantDay := start.In(loc).AddDate(0, 0, i)
		if local.Year() != wantDay.Year() || local.Month() != wantDay.Month() || local.Day() != wantDay.Day() {
			t.Fatalf("session %d date %s, want %s", i, local.Format("2006-01-02"), wantDay.Format("2006-01-02"))
		}
	}
	if wb.Series.Summary == "" || wb.Series.OccurrenceCount != 7 {
		t.Fatalf("summary %q count %d", wb.Series.Summary, wb.Series.OccurrenceCount)
	}
}

func TestSeriesOverSixtyIsRejected(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "series-cap@test.dev", true)
	body := seriesBody("Too many", seriesStart(t), 61)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", body)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status %d, want 422: %s", res.StatusCode, raw)
	}
	if !containsAll(string(raw), "60") {
		t.Fatalf("the refusal should name the cap: %s", raw)
	}
	var n int
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM webinars WHERE topic = 'Too many'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("rejected series still wrote %d webinars", n)
	}
}

func TestRegisterOnceJoinsALaterSession(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "series-join-host@test.dev", true)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", seriesBody("Office hours", seriesStart(t), 3))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var first types.Webinar
	h.decode(raw, &first)
	rows := h.seriesRows(first.SeriesID)
	if len(rows) != 3 {
		t.Fatalf("sessions %d", len(rows))
	}
	h.logout()

	reg := h.registerAs(rows[0].slug, "series-attendee@test.dev")
	again := h.registerAs(rows[1].slug, "series-attendee@test.dev")
	if again.JoinKey != reg.JoinKey {
		t.Fatalf("second session minted a new key %s, first was %s", again.JoinKey, reg.JoinKey)
	}
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.series_id = $1::uuid AND lower(r.email) = 'series-attendee@test.dev'`,
		first.SeriesID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("registration rows %d, want 1", n)
	}

	h.goLive(rows[1].slug)
	res, raw = h.do(http.MethodPost, "/api/webinars/"+rows[1].slug+"/join", types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join session 2: %d %s", res.StatusCode, raw)
	}
	var joined types.JoinResponse
	h.decode(raw, &joined)
	if joined.Token == "" {
		t.Fatalf("join returned no token: %s", raw)
	}

	res, raw = h.do(http.MethodPost, "/api/registrations/lookup", types.LookupRequest{JoinKeys: []string{reg.JoinKey}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("lookup: %d %s", res.StatusCode, raw)
	}
	var mine []types.RegisteredWebinar
	h.decode(raw, &mine)
	if len(mine) != 3 {
		t.Fatalf("my webinars listed %d sessions, want 3", len(mine))
	}
}

func TestSeriesEditScopes(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "series-edit-host@test.dev", true)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", seriesBody("Weekly lab", seriesStart(t), 4))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var first types.Webinar
	h.decode(raw, &first)
	rows := h.seriesRows(first.SeriesID)

	only := inputFromWebinar(first, 4)
	only.Topic = "Only this"
	only.SeriesScope = "this"
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+rows[0].slug+"/", only)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("this-only: %d %s", res.StatusCode, raw)
	}
	var edited types.Webinar
	h.decode(raw, &edited)
	if !edited.SeriesException {
		t.Fatal("this-only edit was not marked as an exception")
	}
	rows = h.seriesRows(first.SeriesID)
	if rows[0].topic != "Only this" || rows[1].topic == "Only this" {
		t.Fatalf("this-only changed a neighbour: %+v", rows)
	}

	if _, err := h.store.SetStatus(context.Background(), rows[2].slug, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	anchor := h.mustWebinar(rows[1].slug)
	follow := inputFromWebinar(anchor, 4)
	follow.Topic = "The rest"
	follow.Duration = 45
	follow.SeriesScope = "following"
	moved, err := time.Parse(time.RFC3339, anchor.StartsAt)
	if err != nil {
		t.Fatal(err)
	}
	follow.StartsAt = moved.Add(30 * time.Minute).Format(time.RFC3339)
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+rows[1].slug+"/", follow)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("following: %d %s", res.StatusCode, raw)
	}

	rows = h.seriesRows(first.SeriesID)
	if rows[0].topic != "Only this" {
		t.Fatalf("exception was overwritten: %s", rows[0].topic)
	}
	if rows[1].topic != "The rest" || rows[1].duration != 45 {
		t.Fatalf("anchor not updated: %+v", rows[1])
	}
	if rows[2].topic == "The rest" || rows[2].status != string(types.StatusEnded) {
		t.Fatalf("ended session was rewritten: %+v", rows[2])
	}
	if rows[3].topic != "The rest" || rows[3].duration != 45 {
		t.Fatalf("later session not updated: %+v", rows[3])
	}
	loc, _ := time.LoadLocation("Asia/Kolkata")
	if rows[1].starts.In(loc).Format("15:04") != rows[3].starts.In(loc).Format("15:04") {
		t.Fatalf("clock did not carry forward: %s vs %s", rows[1].starts, rows[3].starts)
	}
	if rows[3].starts.In(loc).Hour() == rows[0].starts.In(loc).Hour() && rows[3].starts.In(loc).Minute() == rows[0].starts.In(loc).Minute() {
		t.Fatalf("later session kept the old clock %s", rows[3].starts.In(loc).Format("15:04"))
	}
}

func TestSeriesEndCountGrowsAndShrinks(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "series-end-host@test.dev", true)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", seriesBody("Count", seriesStart(t), 3))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var first types.Webinar
	h.decode(raw, &first)
	rows := h.seriesRows(first.SeriesID)
	grow := inputFromWebinar(first, 5)
	grow.SeriesScope = "following"
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+rows[0].slug+"/", grow)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("grow: %d %s", res.StatusCode, raw)
	}
	if got := h.seriesRows(first.SeriesID); len(got) != 5 {
		t.Fatalf("after grow: %d sessions, want 5", len(got))
	}

	rows = h.seriesRows(first.SeriesID)
	current := h.mustWebinar(rows[0].slug)
	shrink := inputFromWebinar(current, 3)
	shrink.SeriesScope = "following"
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+rows[0].slug+"/", shrink)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("shrink: %d %s", res.StatusCode, raw)
	}
	if got := h.seriesRows(first.SeriesID); len(got) != 3 {
		t.Fatalf("after shrink: %d sessions, want 3", len(got))
	}
}

func TestOneOffWebinarCreateAndUpdateStillWorks(t *testing.T) {
	h := newHarness(t)
	h.signup("Plain Host", "one-off-host@test.dev", true)
	wb := h.newWebinar("Just once", nil)
	if wb.SeriesID != "" || wb.Kind != types.KindLive {
		t.Fatalf("one-off came back as a series: kind %s series %s", wb.Kind, wb.SeriesID)
	}
	in := inputFromWebinar(wb, 0)
	in.Kind = types.KindLive
	in.Recurrence = nil
	in.Topic = "Just once, renamed"
	in.Status = types.StatusScheduled
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/", in)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("update one-off: %d %s", res.StatusCode, raw)
	}
	var updated types.Webinar
	h.decode(raw, &updated)
	if updated.Topic != "Just once, renamed" || updated.SeriesID != "" {
		t.Fatalf("one-off update: topic %q series %q", updated.Topic, updated.SeriesID)
	}
	var n int
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM webinars WHERE topic = 'Just once, renamed'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("one-off wrote %d rows", n)
	}
}

func TestSeriesDeleteScopes(t *testing.T) {
	h := newHarness(t)
	h.signup("Series Host", "series-delete-host@test.dev", true)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", seriesBody("Delete me", seriesStart(t), 4))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var first types.Webinar
	h.decode(raw, &first)
	rows := h.seriesRows(first.SeriesID)
	if len(rows) != 4 {
		t.Fatalf("got %d sessions", len(rows))
	}
	if _, err := h.store.SetStatus(context.Background(), rows[0].slug, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+rows[0].slug+"?scope=this", nil)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("ended session delete: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+rows[1].slug+"?scope=this", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("this session: %d %s", res.StatusCode, raw)
	}
	left := h.seriesRows(first.SeriesID)
	if len(left) != 3 {
		t.Fatalf("after this-only, %d sessions", len(left))
	}
	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+rows[2].slug+"?scope=following", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("following: %d %s", res.StatusCode, raw)
	}
	left = h.seriesRows(first.SeriesID)
	if len(left) != 1 || left[0].slug != rows[0].slug {
		t.Fatalf("the ended session should be the only one left, got %+v", left)
	}
}

func (h *harness) mustWebinar(slug string) types.Webinar {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("get %s: %d %s", slug, res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}
