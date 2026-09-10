package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Polls and quizzes.
 *
 * Two views of the same rows, and which one you get is decided here rather than by
 * the client asking:
 *
 *   the host    every question including the drafts, every tally, and the correct
 *               answer to every quiz.
 *   the audience the open poll and the closed ones, a tally only where the host
 *               shared it, and a quiz answer only once voting has ended.
 *
 * That narrowing is the reason there are two endpoints instead of one with a flag.
 * The answers to a live quiz must not be sitting in five hundred browsers while the
 * room is still answering — reading them out of a network response takes no skill at
 * all — so the audience's response is built without them.
 *
 * Opening and closing a poll is broadcast on the data channel as a bare nudge, and
 * every client re-reads its own view. The alternative is putting the poll in the
 * packet, which would mean building the audience's narrowed copy and the host's full
 * copy and shipping both to a room containing both — the exact mistake the two
 * endpoints exist to avoid.
 *
 * Votes are NOT broadcast. Five hundred people answering would be five hundred
 * broadcasts to five hundred recipients; the host's panel re-reads on a timer
 * instead, which is one request per host.
 */

// handleListPolls is the host's view: drafts, tallies and answers.
func (s *Server) handleListPolls(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	polls, err := s.store.Polls(r.Context(), slug, "", true)
	if err != nil {
		s.fail(w, r, "list polls", err)
		return
	}
	httpx.JSON(w, http.StatusOK, polls)
}

func (s *Server) handleCreatePoll(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	var in types.PollInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if in.Kind == "" {
		in.Kind = types.PollOpinion
	}

	poll, err := s.store.CreatePoll(r.Context(), slug, in)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "create poll", err)
		return
	}
	s.log.Info("poll created", "slug", slug, "poll", poll.ID, "kind", poll.Kind)
	httpx.JSON(w, http.StatusCreated, poll)
}

func (s *Server) handleDeletePoll(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	err := s.store.DeletePoll(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That poll doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "delete poll", err)
		return
	}
	// Broadcast: somebody may have had it on screen.
	s.announcePolls(r, slug)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

// handleOpenPoll starts voting. Whatever was open closes, because launching the
// next question means the host is done with the last one.
func (s *Server) handleOpenPoll(w http.ResponseWriter, r *http.Request) {
	s.setPollState(w, r, true)
}

func (s *Server) handleClosePoll(w http.ResponseWriter, r *http.Request) {
	s.setPollState(w, r, false)
}

func (s *Server) setPollState(w http.ResponseWriter, r *http.Request, open bool) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	var (
		poll types.Poll
		err  error
	)
	if open {
		poll, err = s.store.OpenPoll(r.Context(), slug, id)
	} else {
		poll, err = s.store.ClosePoll(r.Context(), slug, id)
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That poll doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "set poll state", err)
		return
	}

	s.announcePolls(r, slug)
	s.log.Info("poll state changed", "slug", slug, "poll", poll.ID, "state", poll.State)
	httpx.JSON(w, http.StatusOK, poll)
}

// ---------------------------------------------------------------- the audience

// handleAudiencePolls is what an attendee or a panelist sees.
//
// Same rows, narrowed: no drafts, no unshared tallies, and no answer to a quiz that
// is still open. The caller's own vote is included, which is what stops a client
// offering to vote in a poll it has already answered — and it survives a reload,
// because the vote is keyed on the participant identity we minted rather than on
// anything the browser is holding.
func (s *Server) handleAudiencePolls(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	from, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey"))
	if !ok {
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "audience polls: load webinar", err)
		return
	}

	onStage := from.Role == types.RoleHost || from.Role == types.RolePanelist
	// The control governs the audience. The stage can always see the questions —
	// a panelist reading the room's answers out loud is the point of running one.
	if !wb.Controls.PollsEnabled && !onStage {
		httpx.JSON(w, http.StatusOK, []types.Poll{})
		return
	}

	polls, err := s.store.Polls(r.Context(), slug, from.Identity, onStage)
	if err != nil {
		s.fail(w, r, "audience polls", err)
		return
	}

	// Drafts are the host's notes. Filtered here rather than in SQL so the store has
	// one read used by both views and the disclosure rule stays in one place.
	visible := make([]types.Poll, 0, len(polls))
	for _, p := range polls {
		if p.State == types.PollDraft && !onStage {
			continue
		}
		visible = append(visible, p)
	}
	httpx.JSON(w, http.StatusOK, visible)
}

// handleVote casts one answer.
func (s *Server) handleVote(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id := chi.URLParam(r, "id")

	var req types.PollVoteRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	from, ok := s.resolveSender(w, r, slug, req.JoinKey)
	if !ok {
		return
	}
	// The same per-person budget the realtime relay uses. Voting is cheap, but an
	// endpoint that writes a row on every call should not be free to hammer.
	if allowed, retry := s.sayLimit.Allow(from.Identity); !allowed {
		w.Header().Set("Retry-After", retryAfterSeconds(retry))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
			"You're sending too many requests. Give it a moment.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "vote: load webinar", err)
		return
	}
	onStage := from.Role == types.RoleHost || from.Role == types.RolePanelist
	if !wb.Controls.PollsEnabled && !onStage {
		httpx.Error(w, http.StatusForbidden, "closed", "The host has turned off polls.")
		return
	}

	err = s.store.Vote(r.Context(), slug, id, from.Identity, req.Choice)
	if errors.Is(err, store.ErrConflict) {
		// Already answered, or the poll is not open. Both are a 409 and both are
		// worth distinguishing in the message, because the fix differs.
		httpx.Error(w, http.StatusConflict, "already_voted",
			"Your answer is already in, or voting has closed.")
		return
	}
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That poll doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "vote", err)
		return
	}

	// Read back through the audience's own narrowing, so a voter sees exactly what
	// they are entitled to see and not a byte more.
	poll, err := s.store.Poll(r.Context(), slug, id, from.Identity, onStage)
	if err != nil {
		s.fail(w, r, "vote: read back", err)
		return
	}
	httpx.JSON(w, http.StatusOK, poll)
}

// announcePolls tells the room that the set of polls changed.
//
// A bare nudge with no payload, deliberately. Every client re-reads its own view,
// which is the only way the host's copy and the audience's copy can differ — and
// they must differ, because one of them contains the answers.
//
// Best-effort: the database is the source of truth, and a client that misses the
// nudge picks the change up on its next read.
func (s *Server) announcePolls(r *http.Request, slug string) {
	body, err := json.Marshal(wirePacket{Kind: pollsChangedKind})
	if err != nil {
		s.log.Warn("announce polls: marshal", "slug", slug, "error", err)
		return
	}
	// Resolves the project itself rather than taking one, because all three callers are host
	// clicks that have no other reason to hold a client, and a poll nudge is best-effort: a
	// client that misses it re-reads on its next poll.
	sfu, err := s.sfuForSlug(r.Context(), slug)
	if err != nil {
		s.log.Warn("announce polls: resolve project", "slug", slug, "error", err)
		return
	}
	if err := sfu.SendData(r.Context(), lk.RoomName(slug), dataTopic, body, nil); err != nil {
		s.log.Warn("announce polls: send", "slug", slug, "error", err)
	}
}
