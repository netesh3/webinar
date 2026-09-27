package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/survey"
	"github.com/netkumar/webcast/api/types"
)

/* Post-event surveys.
 *
 * The host (and co-hosts: the requireOwnership group) configures one survey per webinar and
 * either sends it by hand or lets it go out when the webinar ends. The audience reads its own
 * narrowed copy and answers once. The rules are in internal/survey; the storage in
 * store/surveys*.go. Launching and closing are announced on the data channel as a bare nudge,
 * exactly like polls, and every client re-reads its own view.
 */

const (
	defaultSurveyTextPage = 20
	maxSurveyTextPage     = 100
)

// ---------------------------------------------------------------- the host

func (s *Server) handleGetSurvey(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	out := types.HostSurvey{}
	sv, err := s.store.HostSurvey(r.Context(), slug)
	switch {
	case err == nil:
		out.Survey = &sv
	case !errors.Is(err, store.ErrNotFound):
		s.fail(w, r, "get survey", err)
		return
	}
	if out.Attended, err = s.store.SurveyAttended(r.Context(), slug); err != nil {
		s.fail(w, r, "get survey: attended", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) handlePutSurvey(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	var in types.SurveyInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	cfg, err := survey.Normalize(in)
	if s.surveyInvalid(w, err) {
		return
	}
	sv, err := s.store.SaveSurvey(r.Context(), slug, cfg)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "locked",
			"People have already answered, so the questions can't change. You can still edit the title, button, link and timing.")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "save survey", err)
		return
	}
	// An edit to a live survey changes what the room should be showing.
	if sv.Status == types.SurveyLive {
		s.announceSurvey(r.Context(), slug)
	}
	s.log.Info("survey saved", "slug", slug, "mode", sv.Mode, "questions", len(sv.Questions))
	httpx.JSON(w, http.StatusOK, sv)
}

func (s *Server) handleDeleteSurvey(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	err := s.store.DeleteSurvey(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "There's no survey to remove.")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "has_responses",
			"People have already answered this survey. Close it instead, so their answers are kept.")
		return
	}
	if err != nil {
		s.fail(w, r, "delete survey", err)
		return
	}
	s.announceSurvey(r.Context(), slug)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

// handleLaunchSurvey is "Send now": the survey goes live for everyone, in the room or not.
func (s *Server) handleLaunchSurvey(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "launch survey: webinar", err)
		return
	}
	// Before the start there is nobody to ask and nothing to rate.
	if wb.Status != types.StatusLive && wb.Status != types.StatusEnded {
		httpx.Error(w, http.StatusConflict, "not_started", "You can send the survey once the webinar has started.")
		return
	}
	s.setSurveyStatus(w, r, types.SurveyLive)
}

func (s *Server) handleCloseSurvey(w http.ResponseWriter, r *http.Request) {
	s.setSurveyStatus(w, r, types.SurveyClosed)
}

func (s *Server) setSurveyStatus(w http.ResponseWriter, r *http.Request, status types.SurveyStatus) {
	slug := slugFromContext(r.Context())
	sv, err := s.store.SetSurveyStatus(r.Context(), slug, status)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "Set up the survey first.")
		return
	}
	if err != nil {
		s.fail(w, r, "set survey status", err)
		return
	}
	s.announceSurvey(r.Context(), slug)
	s.log.Info("survey status changed", "slug", slug, "status", sv.Status)
	httpx.JSON(w, http.StatusOK, sv)
}

func (s *Server) handleSurveyResults(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	tally, err := s.store.SurveyTally(r.Context(), slug)
	w.Header().Set("Cache-Control", "private, no-store")
	if errors.Is(err, store.ErrNotFound) {
		attended, aerr := s.store.SurveyAttended(r.Context(), slug)
		if aerr != nil {
			s.fail(w, r, "survey results: attended", aerr)
			return
		}
		httpx.JSON(w, http.StatusOK, types.SurveyResults{
			Attended: attended, ResponseRatePct: -1, ClickThroughPct: -1, AverageRating: -1,
			RatingDistribution: []int{0, 0, 0, 0, 0}, Questions: []types.SurveyQuestionResult{},
			Comments: []types.SurveyComment{},
		})
		return
	}
	if err != nil {
		s.fail(w, r, "survey results", err)
		return
	}
	httpx.JSON(w, http.StatusOK, survey.Aggregate(tally))
}

// handleSurveyAnswers pages one text question's answers: ?question=&cursor=&limit=.
func (s *Server) handleSurveyAnswers(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	q := r.URL.Query()
	question := strings.TrimSpace(q.Get("question"))
	limit := defaultSurveyTextPage
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "limit must be a positive number.")
			return
		}
		limit = min(n, maxSurveyTextPage)
	}
	offset := 0
	if v := q.Get("cursor"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "That cursor isn't valid.")
			return
		}
		offset = n
	}
	page, err := s.store.SurveyTextAnswers(r.Context(), slug, question, offset, limit)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That question doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "survey answers", err)
		return
	}
	if next := offset + len(page.Answers); next < page.Total {
		page.NextCursor = strconv.Itoa(next)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, page)
}

// ---------------------------------------------------------------- the audience

/* respondent resolves who is answering. Only attendees answer — the host and panelists
 * signed in as themselves are presenting, not rating — so a stage identity gets ok=false
 * with no response written, and the caller decides what that means. */
func (s *Server) respondent(w http.ResponseWriter, r *http.Request, slug, joinKey string) (identity, registrationID string, attendee, ok bool) {
	from, ok := s.resolveSender(w, r, slug, joinKey)
	if !ok {
		return "", "", false, false
	}
	key := joinKeyFromIdentity(from.Identity)
	if key == "" {
		return from.Identity, "", false, true
	}
	if reg, err := s.store.ByJoinKey(r.Context(), key); err == nil {
		registrationID = reg.ID
	}
	return from.Identity, registrationID, true, true
}

func (s *Server) handleAudienceSurvey(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	identity, _, attendee, ok := s.respondent(w, r, slug, r.URL.Query().Get("joinKey"))
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	if !attendee {
		httpx.JSON(w, http.StatusOK, types.AudienceSurvey{})
		return
	}
	out, err := s.store.AudienceSurvey(r.Context(), slug, identity)
	if err != nil {
		s.fail(w, r, "audience survey", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) handleSubmitSurvey(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var req types.SurveySubmitRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	identity, regID, attendee, ok := s.respondent(w, r, slug, req.JoinKey)
	if !ok {
		return
	}
	if !attendee {
		httpx.Error(w, http.StatusForbidden, "stage", "Hosts and panelists don't answer their own survey.")
		return
	}
	if !s.surveyBudget(w, identity) {
		return
	}
	current, err := s.store.AudienceSurvey(r.Context(), slug, identity)
	if err != nil {
		s.fail(w, r, "submit survey: load", err)
		return
	}
	if current.Survey == nil {
		httpx.Error(w, http.StatusConflict, "closed", "This survey isn't accepting answers.")
		return
	}
	if current.Mine.Submitted {
		// Idempotent: the answer is already in, and saying so is the right response to a retry.
		httpx.JSON(w, http.StatusOK, current)
		return
	}
	rating, answers, err := survey.ValidateSubmission(*current.Survey, req)
	if s.surveyInvalid(w, err) {
		return
	}
	already, err := s.store.SubmitSurvey(r.Context(), slug, current.Survey.ID, identity, regID, rating, answers)
	if errors.Is(err, store.ErrConflict) {
		httpx.Error(w, http.StatusConflict, "closed", "This survey isn't accepting answers.")
		return
	}
	if err != nil {
		s.fail(w, r, "submit survey", err)
		return
	}
	if !already {
		s.log.Info("survey submitted", "slug", slug, "answers", len(answers))
	}
	out, err := s.store.AudienceSurvey(r.Context(), slug, identity)
	if err != nil {
		s.fail(w, r, "submit survey: read back", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleSurveyClick notes that an attendee opened a link survey. The link itself is opened
// by the browser; this only records that it happened, once.
func (s *Server) handleSurveyClick(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var req types.SurveyClickRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	identity, regID, attendee, ok := s.respondent(w, r, slug, req.JoinKey)
	if !ok {
		return
	}
	if !attendee {
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ignored"})
		return
	}
	if !s.surveyBudget(w, identity) {
		return
	}
	current, err := s.store.AudienceSurvey(r.Context(), slug, identity)
	if err != nil {
		s.fail(w, r, "survey click: load", err)
		return
	}
	if current.Survey == nil || current.Survey.Mode != types.SurveyLink {
		httpx.Error(w, http.StatusConflict, "closed", "This survey isn't open.")
		return
	}
	if err := s.store.RecordSurveyClick(r.Context(), slug, current.Survey.ID, identity, regID); err != nil {
		if errors.Is(err, store.ErrConflict) {
			httpx.Error(w, http.StatusConflict, "closed", "This survey isn't open.")
			return
		}
		s.fail(w, r, "survey click", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "recorded"})
}

// surveyBudget is the realtime relay's per-person budget, shared rather than separate so an
// attendee cannot spend one allowance hammering the survey and another hammering chat.
func (s *Server) surveyBudget(w http.ResponseWriter, identity string) bool {
	if allowed, retry := s.sayLimit.Allow(identity); !allowed {
		w.Header().Set("Retry-After", retryAfterSeconds(retry))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
			"You're sending too many requests. Give it a moment.")
		return false
	}
	return true
}

// surveyInvalid writes a 422 for a survey.ValidationError, or a 500 for anything else.
func (s *Server) surveyInvalid(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var ve *survey.ValidationError
	if errors.As(err, &ve) {
		httpx.JSON(w, http.StatusUnprocessableEntity, types.APIError{
			Error: "invalid", Message: ve.Message, Fields: map[string]string{ve.Field: ve.Message},
		})
		return true
	}
	httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	return true
}

// ---------------------------------------------------------------- realtime + end

// surveyChangedKind tells the room to re-read the survey. Server-only, like pollsChangedKind.
const surveyChangedKind types.RoomMessageKind = "survey-changed"

// announceSurvey nudges every client to re-read its view of the survey. Best-effort: a client
// that misses it reads the survey on the ended or leave screen anyway.
func (s *Server) announceSurvey(ctx context.Context, slug string) {
	body, err := json.Marshal(wirePacket{Kind: surveyChangedKind})
	if err != nil {
		return
	}
	sfu, err := s.sfuForSlug(ctx, slug)
	if err != nil {
		s.log.Warn("announce survey: resolve project", "slug", slug, "error", err)
		return
	}
	if err := sfu.SendData(ctx, lk.RoomName(slug), dataTopic, body, nil); err != nil {
		s.log.Warn("announce survey: send", "slug", slug, "error", err)
	}
}

/* launchSurveyOnEnd sends an "on end" survey as the webinar ends, before the room is torn
 * down so the people still in it get the nudge. Whoever it misses reads it on the ended
 * screen, which asks for the survey itself. */
func (s *Server) launchSurveyOnEnd(ctx context.Context, slug string) {
	launched, err := s.store.LaunchSurveyOnEnd(ctx, slug)
	if err != nil {
		s.log.Warn("end webinar: could not launch the survey", "slug", slug, "error", err)
		return
	}
	if launched {
		s.announceSurvey(ctx, slug)
		s.log.Info("survey launched on end", "slug", slug)
	}
}

// sweepDueSurveys puts timed surveys on screen once their minute comes. Run by RunTick.
func (s *Server) sweepDueSurveys(ctx context.Context) {
	slugs, err := s.store.LaunchDueSurveys(ctx)
	if err != nil {
		s.log.Error("survey sweeper: launch failed", "error", err)
		return
	}
	for _, slug := range slugs {
		s.announceSurvey(ctx, slug)
		s.log.Info("survey launched at its minute", "slug", slug)
	}
}
