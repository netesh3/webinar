package api

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleAttendeesCSV is GET /api/host/webinars/{slug}/attendees.csv: the attendee list of an
 * ended session, for the host and co-hosts.
 *
 * ?scope=attended (the default) lists the people who joined; ?scope=all adds a row per
 * registrant who never did (attended = no). Streamed as it is read, UTF-8 with a BOM so Excel
 * opens it as UTF-8, CRLF line ends per RFC 4180. Times are in the session's time zone with
 * an explicit offset. Every text cell a person typed is guarded against formula injection.
 *
 * Narrower than the rest of the subtree: requireOwnership lets an admin GET any session, but
 * an attendee list is personal data the host collected, so only the host and co-hosts get it.
 * Every export is logged with who took it. */
func (s *Server) handleAttendeesCSV(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	user := userFromContext(r.Context())
	if trueOwner, _ := r.Context().Value(trueOwnerCtxKey).(bool); !trueOwner {
		coHost, err := s.store.IsCoHost(r.Context(), slug, user.ID)
		if err != nil {
			s.fail(w, r, "attendee export: co-host check", err)
			return
		}
		if !coHost {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return
		}
	}

	var attendedOnly bool
	switch r.URL.Query().Get("scope") {
	case "", "attended":
		attendedOnly = true
	case "all":
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_scope", "scope must be attended or all.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "attendee export: webinar", err)
		return
	}
	if wb.Status != types.StatusEnded && wb.EndedAt == "" {
		httpx.Error(w, http.StatusConflict, "not_ended", "The attendee list is ready once the session has ended.")
		return
	}

	loc := time.UTC
	if wb.TimeZone != "" {
		if l, err := time.LoadLocation(wb.TimeZone); err == nil {
			loc = l
		}
	}
	var sessionSecs int64
	day := time.Now().In(loc)
	if started, err := time.Parse(time.RFC3339, wb.StartedAt); err == nil {
		day = started.In(loc)
		if ended, err := time.Parse(time.RFC3339, wb.EndedAt); err == nil && ended.After(started) {
			sessionSecs = int64(ended.Sub(started).Seconds())
		}
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-attendees-%s.csv"`, slug, day.Format("2006-01-02")))
	w.Header().Set("Cache-Control", "private, no-store")
	_, _ = w.Write([]byte("\xEF\xBB\xBF"))

	cw := csv.NewWriter(w)
	cw.UseCRLF = true
	_ = cw.Write(attendeeCSVHeader(wb.CustomQuestions))
	n := 0
	err = s.store.EachAttendeeExportRow(r.Context(), slug, attendedOnly, func(row store.AttendeeExportRow) error {
		if err := cw.Write(attendeeCSVRecord(row, wb.CustomQuestions, loc, sessionSecs)); err != nil {
			return err
		}
		if n++; n%500 == 0 {
			cw.Flush()
		}
		return cw.Error()
	})
	cw.Flush()
	scope := "attended"
	if !attendedOnly {
		scope = "all"
	}
	if err != nil {
		// Headers are already sent, so this can only be logged.
		s.log.Warn("attendee export: stream ended early", "slug", slug, "rows", n, "error", err)
	}
	s.log.Info("attendee export", "slug", slug, "user_id", user.ID, "scope", scope, "rows", n)
}

// attendeeCSVHeader is the fixed columns, then one per registration question.
func attendeeCSVHeader(questions []types.CustomQuestion) []string {
	header := []string{
		"name", "email", "phone", "registered_at", "attended", "first_joined_at", "last_left_at",
		"total_minutes", "watch_percent", "joined_via", "questions_asked", "chat_messages",
		"polls_answered", "raised_hand",
	}
	for _, q := range questions {
		header = append(header, csvText(q.Label))
	}
	return header
}

// attendeeCSVRecord is one row. sessionSecs is the live window's length; 0 leaves
// watch_percent empty.
func attendeeCSVRecord(row store.AttendeeExportRow, questions []types.CustomQuestion, loc *time.Location, sessionSecs int64) []string {
	stamp := func(t *time.Time) string {
		if t == nil {
			return ""
		}
		return t.In(loc).Format("2006-01-02T15:04:05-07:00")
	}
	yesNo := func(b bool) string {
		if b {
			return "yes"
		}
		return "no"
	}
	rec := []string{
		csvText(row.Name), csvText(row.Email), csvText(row.Phone), stamp(row.RegisteredAt),
		yesNo(row.Attended),
	}
	if row.Attended {
		percent := ""
		if sessionSecs > 0 {
			percent = strconv.FormatInt(min(100, (row.WatchSeconds*100+sessionSecs/2)/sessionSecs), 10)
		}
		rec = append(rec,
			stamp(row.FirstJoinedAt), stamp(row.LastLeftAt),
			strconv.FormatInt((row.WatchSeconds+30)/60, 10), percent, row.JoinedVia,
			strconv.Itoa(row.Questions), strconv.Itoa(row.Chats), strconv.Itoa(row.PollsAnswered),
			yesNo(row.RaisedHand))
	} else {
		// A no-show did none of it: blanks, not zeros, so a sum or average over the column
		// is not dragged down by people who were never there.
		rec = append(rec, "", "", "", "", "", "", "", "", "")
	}
	for _, q := range questions {
		rec = append(rec, csvText(row.Answers[q.ID]))
	}
	return rec
}
