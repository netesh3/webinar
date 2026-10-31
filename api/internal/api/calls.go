package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/realtime"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Calling (31 Oct 2026). A host rings another Webinar Liv account into a meeting; the callee's
 * open tabs, browsers and phones ring, and Accept takes them into the room. docs/calling.md is
 * the reference, and the contract the web app and the mobile apps rely on.
 *
 * A call is a row (store/calls.go) that rings for types.CallRingSeconds and ends once: accepted,
 * declined, cancelled or missed. The callee is given a seat on the meeting's panel for the
 * ring, which is how anybody invited by name reaches a meeting's stage (POST
 * /api/host/webinars/{slug}/join, no lobby); a call that is not accepted gives it back.
 *
 * The ring goes three ways at once, the same payload on each (types.IncomingCallEvent):
 *   - the callee's open tabs, on any page, through their own event stream (GET /api/me/events,
 *     the edge viewers' SSE and the Postgres bus reused with a per-account topic);
 *   - their browsers through Web Push, and their app installs through FCM as a data message
 *     (store.PushMessage.DataOnly), both through the push outbox the other notifications use;
 *   - iOS VoIP (CallKit), through pushVoIP, which the native work fills in (call_voip.go).
 * The end goes the same three ways (types.CallEndedEvent), so every other device stops ringing.
 */

const (
	callRing = types.CallRingSeconds * time.Second
	// callsPerHour is how many calls one caller may place in an hour, to anybody.
	callsPerHour = 10
	// callDeclineStreak declines of the same caller in a row keep them from ringing this
	// callee for callDeclineRest.
	callDeclineStreak = 3
	callDeclineRest   = time.Hour
	// callSweepBatch is how many expired calls one sweep ends.
	callSweepBatch = 200
)

func (s *Server) mountCalls(r chi.Router) {
	// Per account, inside the handler: one person's searches, wherever they come from.
	s.contactsLimit = httpx.NewRateLimiter(30, time.Minute)
	r.With(s.requireHost).Post("/calls", s.handleStartCall)
	r.With(s.requireUser).Get("/calls/{id}", s.handleGetCall)
	r.With(s.requireUser).Post("/calls/{id}/accept", s.handleCallAnswer(types.CallAccepted))
	r.With(s.requireUser).Post("/calls/{id}/decline", s.handleCallAnswer(types.CallDeclined))
	r.With(s.requireUser).Post("/calls/{id}/cancel", s.handleCallAnswer(types.CallCancelled))
	r.With(s.requireHost).Get("/contacts", s.handleContacts)
	r.With(s.requireUser).Get("/me/events", s.handleMeEvents)
}

// callJoinURL is the callee's way into the meeting: the stage door a panelist uses, which a
// signed-in callee passes because the call gave them a seat on the panel.
func callJoinURL(slug string) string { return "/host/" + url.PathEscape(slug) + "/room" }

func callOut(c store.Call, viewer string) types.Call {
	role := "callee"
	if viewer == c.CallerID {
		role = "caller"
	}
	return types.Call{
		CallID: c.ID, State: c.State, MeetingSlug: c.Slug, Topic: c.Topic,
		JoinURL: callJoinURL(c.Slug), ExpiresAt: c.ExpiresAt.UTC().Format(time.RFC3339),
		CallerName: c.CallerName, CalleeName: c.CalleeName, Role: role,
	}
}

func incomingCallEvent(c store.Call) types.IncomingCallEvent {
	ev := types.IncomingCallEvent{
		Type: types.CallEventIncoming, CallID: c.ID, CallerName: clip(c.CallerName, 80),
		MeetingSlug: c.Slug, Topic: clip(strings.TrimSpace(c.Topic), 120),
		JoinURL: callJoinURL(c.Slug), ExpiresAt: c.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if c.CallerAvatar != "" {
		avatar := c.CallerAvatar
		ev.CallerAvatarURL = &avatar
	}
	return ev
}

func callEndedEvent(c store.Call) types.CallEndedEvent {
	return types.CallEndedEvent{Type: types.CallEventEnded, CallID: c.ID, State: c.State}
}

// ------------------------------------------------------------------ start

/* handleStartCall is POST /api/calls.
 *
 * Calling is for a host who may hold meetings (requireHost, then the meetings switch, the
 * same gate a meeting's create has). It does not need the instant switch "Start a meeting"
 * does: a call without a meeting makes its own instant meeting through the create path, with
 * every other check that path makes. */
func (s *Server) handleStartCall(w http.ResponseWriter, r *http.Request) {
	var req types.StartCallRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	user := userFromContext(r.Context())
	calleeID := strings.TrimSpace(req.CalleeUserID)
	if _, err := uuid.Parse(calleeID); err != nil {
		httpx.Fields(w, map[string]string{"calleeUserId": "Choose somebody to call."})
		return
	}
	if calleeID == user.ID {
		httpx.Fields(w, map[string]string{"calleeUserId": "You can't call yourself."})
		return
	}
	callee, err := s.store.UserByID(r.Context(), calleeID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "callee_not_found", "That person doesn't have an account.")
		return
	}
	if err != nil {
		s.fail(w, r, "start call: callee", err)
		return
	}
	if !s.requireHostFeature(w, r, user.ID, types.FeatureMeetings) {
		return
	}

	slug := strings.TrimSpace(req.MeetingSlug)
	if slug != "" {
		if !s.callableMeeting(w, r, user, slug) {
			return
		}
		// Pressing Call twice rings once.
		if c, err := s.store.RingingCall(r.Context(), user.ID, callee.ID, slug); err == nil {
			httpx.JSON(w, http.StatusOK, startCallOut(c, false))
			return
		}
	}

	limits, err := s.store.CallLimitsFor(r.Context(), user.ID, callee.ID)
	if err != nil {
		s.fail(w, r, "start call: limits", err)
		return
	}
	if limits.LastHour >= callsPerHour {
		w.Header().Set("Retry-After", "3600")
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
			fmt.Sprintf("You've placed %d calls in the last hour. Try again later.", callsPerHour))
		return
	}
	// TODO(calling): let a callee block a caller outright (Settings → Notifications), checked here.
	if limits.DeclinedInARow >= callDeclineStreak && time.Since(limits.LastDeclinedAt) < callDeclineRest {
		httpx.Error(w, http.StatusTooManyRequests, "callee_unavailable",
			"They can't take your call right now. Try again later.")
		return
	}

	created := false
	if slug == "" {
		wb, ok := s.createWebinarWith(w, r, user, callMeetingInput(user, callee), createOptions{forCall: true})
		if !ok {
			return
		}
		s.boxWarmFor(r.Context(), wb)
		slug, created = wb.ID, true
	}
	c, err := s.store.CreateCall(r.Context(), user.ID, callee.ID, slug, callRing)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That meeting doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "start call", err)
		return
	}
	s.log.Info("call placed", "call", c.ID, "meeting", c.Slug, "instant", created)
	s.ringCall(r.Context(), c)
	httpx.JSON(w, http.StatusCreated, startCallOut(c, created))
}

func startCallOut(c store.Call, created bool) types.StartCallResponse {
	return types.StartCallResponse{
		CallID: c.ID, MeetingSlug: c.Slug, JoinURL: callJoinURL(c.Slug),
		ExpiresAt: c.ExpiresAt.UTC().Format(time.RFC3339), MeetingCreated: created,
	}
}

/* callableMeeting is whether user may ring somebody into slug: a meeting (not a webinar, whose
 * people are an audience rather than a room), not over, that they host or co-host. A meeting
 * they have nothing to do with is a 404, as requireOwnership answers. */
func (s *Server) callableMeeting(w http.ResponseWriter, r *http.Request, user store.User, slug string) bool {
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That meeting doesn't exist.")
		return false
	}
	if err != nil {
		s.fail(w, r, "start call: meeting", err)
		return false
	}
	if wb.Host.ID != user.ID {
		coHost, err := s.store.IsCoHost(r.Context(), slug, user.ID)
		if err != nil {
			s.fail(w, r, "start call: co-host", err)
			return false
		}
		if !coHost {
			httpx.Error(w, http.StatusNotFound, "not_found", "That meeting doesn't exist.")
			return false
		}
	}
	if !isMeeting(wb) {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_meeting",
			"Calls ring people into a meeting. Invite people to a webinar with its link.")
		return false
	}
	if wb.Status == types.StatusEnded || wb.DidntGoLive {
		writeMeetingEnded(w)
		return false
	}
	return true
}

/* callMeetingInput is the instant meeting a call without one makes: the request "Start a
 * meeting" sends (web/lib/meeting-create.ts instantMeetingInput), named for the two people. */
func callMeetingInput(caller, callee store.User) types.WebinarInput {
	name := func(u store.User) string {
		if n := strings.TrimSpace(u.Name); n != "" {
			return n
		}
		return store.NameFromEmail(u.Email)
	}
	return types.WebinarInput{
		Topic:    clip(name(caller)+" and "+name(callee), 120),
		StartsAt: time.Now().UTC().Format(time.RFC3339),
		Duration: 60, TimeZone: "UTC",
		Status: types.StatusScheduled, Instant: true,
		Kind: types.KindMeeting, Venue: "app", Delivery: types.DeliveryStandard,
		Approval: types.ApprovalAutomatic, AttendeeLimit: 10,
		Options: types.WebinarOptions{QAndA: true, AttendeeChat: true, RaiseHand: true, Reminders: []int{}},
		Controls: types.SessionControls{
			AllowUnmute: true, ChatEnabled: true, ChatDestination: types.ChatToEveryone,
			PollsEnabled: true, QAEnabled: true, RaiseHandEnabled: true, ReactionsEnabled: true,
			AudienceLayout: types.AudienceLayoutAuto,
		},
	}
}

// ------------------------------------------------------------------ answer

// loadCall is the call in the URL for one of its two people; anybody else is told it does
// not exist.
func (s *Server) loadCall(w http.ResponseWriter, r *http.Request) (store.Call, bool) {
	c, err := s.store.CallByID(r.Context(), chi.URLParam(r, "id"))
	user := userFromContext(r.Context())
	if errors.Is(err, store.ErrNotFound) || (err == nil && user.ID != c.CallerID && user.ID != c.CalleeID) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That call doesn't exist.")
		return store.Call{}, false
	}
	if err != nil {
		s.fail(w, r, "call: load", err)
		return store.Call{}, false
	}
	return c, true
}

/* settleExpired ends a call whose ring ran out as missed, if the sweep has not yet, and tells
 * both ends. Reading a call is when an expiry is noticed between sweeps. */
func (s *Server) settleExpired(ctx context.Context, c store.Call) store.Call {
	if c.State != types.CallRinging || time.Now().Before(c.ExpiresAt) {
		return c
	}
	ended, changed, err := s.store.EndCall(ctx, c.ID, types.CallMissed)
	if err != nil {
		s.log.Warn("call: expire", "call", c.ID, "error", err)
		return c
	}
	if changed {
		s.announceCallEnded(ctx, ended)
	}
	return ended
}

// handleGetCall is GET /api/calls/{id}, for the caller or the callee.
func (s *Server) handleGetCall(w http.ResponseWriter, r *http.Request) {
	c, ok := s.loadCall(w, r)
	if !ok {
		return
	}
	c = s.settleExpired(r.Context(), c)
	httpx.JSON(w, http.StatusOK, callOut(c, userFromContext(r.Context()).ID))
}

/* handleCallAnswer is accept and decline (the callee's) and cancel (the caller's).
 *
 * Idempotent: asking for the state the call is already in is a 200 with the call, so a
 * notification's Accept that races the card's Accept is not an error. Any other ended state is
 * 409 call_ended with the state, so the asker can say what happened ("they declined"). */
func (s *Server) handleCallAnswer(to types.CallState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, ok := s.loadCall(w, r)
		if !ok {
			return
		}
		user := userFromContext(r.Context())
		mine := c.CalleeID
		if to == types.CallCancelled {
			mine = c.CallerID
		}
		if user.ID != mine {
			msg := "Only the person being called can answer."
			if to == types.CallCancelled {
				msg = "Only the caller can cancel a call."
			}
			httpx.Error(w, http.StatusForbidden, "forbidden", msg)
			return
		}
		ended, changed, err := s.store.EndCall(r.Context(), c.ID, to)
		if err != nil {
			s.fail(w, r, "call: "+string(to), err)
			return
		}
		if changed {
			s.log.Info("call ended", "call", c.ID, "state", to)
			s.announceCallEnded(r.Context(), ended)
		} else {
			ended = s.settleExpired(r.Context(), ended)
		}
		if ended.State != to {
			httpx.JSON(w, http.StatusConflict, types.CallConflict{
				Error: "call_ended", Message: callEndedMessage(ended.State), Call: callOut(ended, user.ID),
			})
			return
		}
		httpx.JSON(w, http.StatusOK, callOut(ended, user.ID))
	}
}

func callEndedMessage(state types.CallState) string {
	switch state {
	case types.CallAccepted:
		return "This call was already answered."
	case types.CallDeclined:
		return "This call was declined."
	case types.CallCancelled:
		return "The caller hung up."
	case types.CallMissed:
		return "This call wasn't answered in time."
	}
	return "This call is over."
}

// sweepCalls ends the calls whose ring ran out, from the tick's realtime lane.
func (s *Server) sweepCalls(ctx context.Context) {
	ended, err := s.store.ExpireCalls(ctx, callSweepBatch)
	if err != nil {
		s.log.Error("calls: expire", "error", err)
	}
	for _, c := range ended {
		s.announceCallEnded(ctx, c)
	}
}

// ------------------------------------------------------------------ delivery

/* ringCall rings the callee everywhere: their open tabs (the event stream), their browsers and
 * app installs (the push outbox), and iOS VoIP (pushVoIP). */
func (s *Server) ringCall(ctx context.Context, c store.Call) {
	ev := incomingCallEvent(c)
	raw, _ := json.Marshal(ev)
	s.publishToUser(ctx, c.CalleeID, raw)
	s.pushIncomingCall(ctx, c, ev)
	s.pushVoIP(ctx, c.CalleeID, raw)
}

// announceCallEnded tells both ends a call is over: the callee's devices stop ringing, and the
// caller's room says how it went.
func (s *Server) announceCallEnded(ctx context.Context, c store.Call) {
	raw, _ := json.Marshal(callEndedEvent(c))
	s.publishToUser(ctx, c.CalleeID, raw)
	s.publishToUser(ctx, c.CallerID, raw)
	s.pushCallEnded(ctx, c)
	s.pushVoIP(ctx, c.CalleeID, raw)
}

// callSSEKind is the SSE event name GET /api/me/events uses for both call events; the payload's
// "type" says which.
const callSSEKind = "call"

// publishToUser sends one event to every tab userID has open, on every instance.
func (s *Server) publishToUser(ctx context.Context, userID string, data []byte) {
	s.rt.Publish(ctx, realtime.Event{Slug: realtime.UserTopic(userID), Kind: callSSEKind, Data: data})
}

// ------------------------------------------------------------------ contacts

/* handleContacts is GET /api/contacts?q=: who this host may call.
 *
 * People they have shared a session with, by name (store.Contacts), and, when q is a whole
 * email address, the account with exactly that address. Nothing else: no prefix search on
 * addresses and no directory, so the endpoint cannot be used to list who has an account, and
 * it is rate-limited per account on top. A contact's address is never returned, except the one
 * the host typed. */
func (s *Server) handleContacts(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if ok, retry := s.contactsLimit.Allow(user.ID); !ok {
		w.Header().Set("Retry-After", fmt.Sprint(int(retry.Seconds())+1))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Too many searches. Wait a moment and try again.")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 200 {
		q = q[:200]
	}
	out := types.ContactsResponse{Contacts: []types.Contact{}}
	if looksLikeEmail(q) {
		c, err := s.store.ContactByEmail(r.Context(), q)
		switch {
		case err == nil && c.UserID != user.ID:
			out.Contacts = append(out.Contacts, c)
		case err != nil && !errors.Is(err, store.ErrNotFound):
			s.fail(w, r, "contacts: email", err)
			return
		}
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	list, err := s.store.Contacts(r.Context(), user.ID, q)
	if err != nil {
		s.fail(w, r, "contacts", err)
		return
	}
	out.Contacts = list
	httpx.JSON(w, http.StatusOK, out)
}

// looksLikeEmail is a whole address: something@domain.tld, no spaces.
func looksLikeEmail(q string) bool {
	at := strings.LastIndex(q, "@")
	if at < 1 || at == len(q)-1 || strings.ContainsAny(q, " \t\r\n,;") {
		return false
	}
	return strings.Contains(q[at+1:], ".")
}

// ------------------------------------------------------------------ the account's event stream

/* handleMeEvents is GET /api/me/events: one signed-in account's live events, for every page.
 *
 * Today that is calls: incoming_call and call_ended, as SSE event "call". It is the edge
 * viewers' event stream (handleEdgeEvents) with a per-account topic instead of a webinar's, so
 * no new infrastructure: the same hub, the same Postgres LISTEN/NOTIFY bus across instances, the
 * same heartbeat and lifetime. The session cookie authorizes it (EventSource sends cookies with
 * withCredentials, and in production the page and /api share an origin). On every (re)connect
 * the calls ringing for this account are sent first, so a tab that opens mid-ring, or
 * reconnects across one, still rings. */
func (s *Server) handleMeEvents(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpx.Error(w, http.StatusInternalServerError, "no_stream", "Streaming isn't available.")
		return
	}
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	sub, cancel := s.rt.Hub().Subscribe(realtime.UserTopic(user.ID), hostIdentity(user.ID))
	defer cancel()

	write := func(kind string, data []byte) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(edgeWriteGrace))
		var err error
		if kind == "" {
			_, err = fmt.Fprint(w, ": ping\n\n")
		} else {
			_, err = io.WriteString(w, sseFrame(edgeEventSeq.Add(1), kind, data))
		}
		if err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	_, _ = fmt.Fprint(w, "retry: 3000\n\n")
	if !write("ready", []byte("{}")) {
		return
	}
	if ringing, err := s.store.RingingCallsFor(r.Context(), user.ID); err == nil {
		for _, c := range ringing {
			raw, _ := json.Marshal(incomingCallEvent(c))
			if !write(callSSEKind, raw) {
				return
			}
		}
	} else {
		s.log.Warn("me events: ringing calls", "error", err)
	}

	beat := time.NewTicker(edgeHeartbeat)
	defer beat.Stop()
	life := time.NewTimer(edgeStreamLife)
	defer life.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-life.C:
			write("reconnect", []byte("{}"))
			return
		case <-beat.C:
			if !write("", nil) {
				return
			}
		case e, open := <-sub.C:
			if !open {
				return
			}
			if !write(e.Kind, e.Data) {
				return
			}
		}
	}
}
