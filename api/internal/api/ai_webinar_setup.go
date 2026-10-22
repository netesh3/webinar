package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* handleAIWebinarSetup is POST /api/host/ai/webinar-setup: "Write with AI".
 *
 * One line from the host in, a draft out: title, description, registration copy and a
 * post per channel. Nothing is saved here — the schedule form fills in and the host
 * saves, or does not. The account's own switch decides first (FeatureAI), then the
 * monthly caps (aiComplete), then a per-host rate limit so a stuck button cannot spend
 * the month in a minute.
 */
func (s *Server) handleAIWebinarSetup(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAI) {
		return
	}
	var in types.AIWebinarSetupRequest
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	idea := strings.TrimSpace(in.Idea)
	switch {
	case idea == "":
		httpx.Fields(w, map[string]string{"idea": "Tell us what your webinar is about."})
		return
	case utf8.RuneCountInString(idea) > aiwrite.MaxIdeaRunes:
		httpx.Fields(w, map[string]string{"idea": "Keep it under " + strconv.Itoa(aiwrite.MaxIdeaRunes) + " characters."})
		return
	case !aiwrite.ValidLanguage(in.Language):
		httpx.Fields(w, map[string]string{"language": "Choose English, Hinglish or Hindi."})
		return
	}
	if ok, retry := s.aiWriteLimit.Allow(user.ID); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "That's a lot of drafts in a minute. Try again shortly.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 19*time.Second)
	defer cancel()
	reply, err := s.aiComplete(ctx, types.AIFeatureWebinarSetup, user.ID, ai.Request{
		Messages:  aiwrite.SetupMessages(idea, in.Language),
		Schema:    aiwrite.SetupSchema,
		MaxTokens: 2000,
		// Copy, not a sales answer: a little more variety, for the free models that take it.
		Temperature:    0.7,
		AttemptTimeout: 15 * time.Second,
	})
	switch {
	case errors.Is(err, errAILimit):
		httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
		return
	case errors.Is(err, ai.ErrUnavailable):
		// Also what a timeout looks like: the chain stops and reports nobody answered.
		httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
			"AI writing isn't available right now. Try again in a minute, or write it yourself.")
		return
	case err != nil:
		s.fail(w, r, "ai webinar setup", err)
		return
	}
	out, err := aiwrite.ParseSetup(reply.Text)
	if err != nil {
		s.fail(w, r, "ai webinar setup: parse", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
