package api

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/engagement"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const (
	defaultAttendeePage = 50
	maxAttendeePage     = 200
)

/* The engagement endpoints sit in the webinar's requireOwnership group: the host and the
 * webinar's co-hosts, nobody else. Every store read below is keyed by the id resolved from
 * that slug, so a request can only ever reach its own webinar's rows. */

func (s *Server) engagementWebinar(w http.ResponseWriter, r *http.Request) (store.EngagementWebinar, bool) {
	wb, err := s.store.EngagementWebinar(r.Context(), slugFromContext(r.Context()))
	if err != nil {
		s.fail(w, r, "engagement: webinar", err)
		return wb, false
	}
	return wb, true
}

func (s *Server) writeSummary(w http.ResponseWriter, r *http.Request, payload []byte, err error) {
	if err != nil {
		s.fail(w, r, "engagement: summary", err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	_, _ = w.Write(payload)
}

func (s *Server) handleEngagementSummary(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.engagementWebinar(w, r)
	if !ok {
		return
	}
	payload, err := s.engagement.Summary(r.Context(), wb)
	s.writeSummary(w, r, payload, err)
}

// handleRecomputeEngagement is the host's "refresh" — for late corrections after the end.
func (s *Server) handleRecomputeEngagement(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.engagementWebinar(w, r)
	if !ok {
		return
	}
	if wb.StartedAt == nil {
		payload, err := s.engagement.Summary(r.Context(), wb)
		s.writeSummary(w, r, payload, err)
		return
	}
	payload, err := s.engagement.Compute(r.Context(), wb)
	s.writeSummary(w, r, payload, err)
}

// parseAttendeeQuery reads sort, dir, tier (comma separated), q, cursor and limit.
func parseAttendeeQuery(r *http.Request) (store.AttendeeQuery, error) {
	v := r.URL.Query()
	q := store.AttendeeQuery{Sort: types.SortScore, Desc: true, Limit: defaultAttendeePage}
	if sort := v.Get("sort"); sort != "" {
		q.Sort = types.EngagementSort(sort)
		switch q.Sort {
		case types.SortScore, types.SortWatch, types.SortName, types.SortJoin:
		default:
			return q, fmt.Errorf("unknown sort %q", sort)
		}
		q.Desc = q.Sort == types.SortScore || q.Sort == types.SortWatch
	}
	switch v.Get("dir") {
	case "asc":
		q.Desc = false
	case "desc":
		q.Desc = true
	case "":
	default:
		return q, fmt.Errorf("dir must be asc or desc")
	}
	for _, t := range strings.Split(v.Get("tier"), ",") {
		switch tier := types.EngagementTier(strings.TrimSpace(t)); tier {
		case "":
		case types.TierHigh, types.TierEngaged, types.TierPassive, types.TierRisk:
			q.Tiers = append(q.Tiers, tier)
		default:
			return q, fmt.Errorf("unknown tier %q", t)
		}
	}
	q.Search = strings.TrimSpace(v.Get("q"))
	if len(q.Search) > 100 {
		q.Search = q.Search[:100]
	}
	if c := v.Get("cursor"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 0 {
			return q, fmt.Errorf("bad cursor")
		}
		q.Offset = n
	}
	if l := v.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			return q, fmt.Errorf("bad limit")
		}
		q.Limit = min(n, maxAttendeePage)
	}
	return q, nil
}

/* handleEngagementAttendees is one sorted, filtered page of the per-person table. It makes
 * sure the stored rows are current first (the same freshness rule and single-flight as the
 * summary), then pages them with an index-backed ORDER BY … OFFSET/LIMIT. The cursor is
 * the next offset: a webinar's rows are bounded, and they only change on recompute. */
func (s *Server) handleEngagementAttendees(w http.ResponseWriter, r *http.Request) {
	q, err := parseAttendeeQuery(r)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	wb, ok := s.engagementWebinar(w, r)
	if !ok {
		return
	}
	page := types.EngagementAttendeePage{Rows: []types.EngagementAttendeeRow{}}
	if wb.StartedAt == nil {
		httpx.JSON(w, http.StatusOK, page)
		return
	}
	payload, err := s.engagement.Summary(r.Context(), wb)
	if err != nil {
		s.fail(w, r, "engagement: refresh", err)
		return
	}
	var head struct {
		Axis types.EngagementAxis `json:"axis"`
	}
	if err := json.Unmarshal(payload, &head); err != nil {
		s.fail(w, r, "engagement: summary axis", err)
		return
	}
	page.Axis = head.Axis
	rows, total, err := s.store.EngagementAttendees(r.Context(), wb.ID, q)
	if err != nil {
		s.fail(w, r, "engagement: attendees", err)
		return
	}
	page.Rows, page.Total = rows, total
	if next := q.Offset + len(rows); next < total {
		page.NextCursor = strconv.Itoa(next)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, page)
}

func (s *Server) handleEngagementAttendee(w http.ResponseWriter, r *http.Request) {
	identity := chi.URLParam(r, "identity")
	if !isAttendeeIdentity(identity) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such attendee.")
		return
	}
	wb, ok := s.engagementWebinar(w, r)
	if !ok {
		return
	}
	if wb.StartedAt == nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such attendee.")
		return
	}
	if _, err := s.engagement.Summary(r.Context(), wb); err != nil {
		s.fail(w, r, "engagement: refresh", err)
		return
	}
	row, parts, regID, err := s.store.EngagementScore(r.Context(), wb.ID, identity)
	if err != nil {
		s.fail(w, r, "engagement: attendee", err)
		return
	}
	act, start, err := s.store.EngagementActivity(r.Context(), wb.ID, identity)
	if err != nil {
		s.fail(w, r, "engagement: activity", err)
		return
	}
	consent, err := s.store.WhatsAppConsent(r.Context(), wb.ID, regID)
	if err != nil {
		s.log.Warn("engagement: consent lookup failed", "slug", wb.Slug, "error", err)
	}
	timeline, truncated := engagement.Timeline(*start, act)
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, types.EngagementAttendeeDetail{
		Row:           row,
		Components:    parts,
		Visits:        engagement.Spans(*start, act.Visits),
		Timeline:      timeline,
		Truncated:     truncated,
		SessionMin:    sessionMinutes(wb, time.Now()),
		Reactions:     engagement.ReactionTotals(act.Events),
		WhatsAppOptIn: consent,
	})
}

/* handleEngagementCSV streams one row per registrant and per scored guest. It reads the
 * stored scores after making them current, and writes as it reads. */
func (s *Server) handleEngagementCSV(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.engagementWebinar(w, r)
	if !ok {
		return
	}
	if wb.StartedAt != nil {
		if _, err := s.engagement.Summary(r.Context(), wb); err != nil {
			s.fail(w, r, "engagement: refresh", err)
			return
		}
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-engagement.csv"`, wb.Slug))
	w.Header().Set("Cache-Control", "private, no-store")
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{
		"name", "email", "attended", "score", "tier", "watch_minutes", "join_timing",
		"first_join_min", "last_leave_min", "visits", "chats", "questions", "upvotes",
		"polls_answered", "polls_present", "quiz_correct", "quiz_answered", "reactions", "hand_raises",
	})
	optInt := func(p *int) string {
		if p == nil {
			return ""
		}
		return strconv.Itoa(*p)
	}
	n := 0
	err := s.store.EachEngagementCSVRow(r.Context(), wb.ID, func(c store.EngagementCSVRow) error {
		score := ""
		if c.Attended {
			score = strconv.Itoa(c.Score)
		}
		k := c.Counts
		if err := cw.Write([]string{
			csvText(c.Name), csvText(c.Email), strconv.FormatBool(c.Attended), score, c.Tier,
			strconv.Itoa(c.WatchMin), c.JoinTiming, optInt(c.FirstJoinMin), optInt(c.LastLeaveMin),
			strconv.Itoa(c.Visits), strconv.Itoa(k.Chats), strconv.Itoa(k.Questions), strconv.Itoa(k.Upvotes),
			strconv.Itoa(k.Polls), strconv.Itoa(k.PollsPresent), strconv.Itoa(k.QuizCorrect),
			strconv.Itoa(k.QuizAnswered), strconv.Itoa(k.Reactions), strconv.Itoa(k.Hands),
		}); err != nil {
			return err
		}
		if n++; n%500 == 0 {
			cw.Flush()
		}
		return cw.Error()
	})
	cw.Flush()
	if err != nil {
		s.log.Warn("engagement csv: stream ended early", "slug", wb.Slug, "rows", n, "error", err)
	}
}

// csvText stops a spreadsheet from reading a name like "=HYPERLINK(…)" as a formula.
func csvText(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func sessionMinutes(wb store.EngagementWebinar, now time.Time) int {
	if wb.StartedAt == nil {
		return 0
	}
	end := now
	if wb.EndedAt != nil {
		end = *wb.EndedAt
	}
	return max(1, int(math.Ceil(end.Sub(*wb.StartedAt).Minutes())))
}
