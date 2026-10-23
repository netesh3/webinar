package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The host in a simulive's room before it starts.
 *
 * The host or a co-host may enter a scheduled simulive's room at any time (handleHostJoin):
 * entering never starts it. A manual one waits for them; an automatic one still goes live at
 * starts_at, not earlier. Before the doors open the room is the host team's alone — the
 * audience is told when it opens (audienceBarrier) — unless they press "Open doors now".
 *
 * From the room they then:
 *
 *   start-now    POST   /simulive/start-now   live at once, its shared clock starting now.
 *   start-at     PUT    /simulive/start-at    a pending start: "Start in 2/5/10 min" (inMin),
 *                                             "Delay 5 min" (delayMin) or an exact moment.
 *                                             It replaces starts_at as the moment — for a
 *                                             manual simulive as for an automatic one — and
 *                                             is honoured by the same lazy due-check and
 *                                             sweeper (store.simuliveTargetSQL), the clock
 *                                             starting at that moment.
 *   cancel       DELETE /simulive/start-at    back to the schedule.
 *   open doors   POST   /simulive/open-doors
 *   end          POST   /simulive/end
 *   go live      POST   /simulive/go-live     end the replay early and carry on live with
 *                                             the audience (live after, below), now.
 *
 * Each change is told to the room (room metadata), so every waiting screen's countdown
 * follows it at once; a viewer not yet connected reads it from the webinar on its next poll.
 * Each is idempotent, and each is logged with who did it.
 *
 * The whole life of a simulive, one state machine, every step a guarded UPDATE in the store:
 *
 *   scheduled ─(doors: options.simuliveDoorsOpenMin before the start, or Open doors now)─┐
 *   scheduled ─(starts_at for auto / the pending start / Start now)→ playing             │
 *   playing ─(the recording's end, nobody of the host team in the room)→ ended            │
 *   playing ─(the recording's end, the host or a co-host in the room)→ live after         │
 *   live after ─(End webinar, or simuliveLiveAfterGrace after the host team left)→ ended  │
 *
 * Live after is the session carrying on as a live Q&A: the host team re-joins on an ordinary
 * publishing grant (mic and camera off to begin with), the audience re-joins the ordinary
 * live room (a simulive is never Edge, edge.go), and the replay's machinery stops — no more
 * replayed polls, no Auto mode answers. Never recorded: refuseSimuliveRecording is by kind. */

// simuliveLiveAfterGrace is how long a live-after simulive waits for its host team to come
// back before it ends.
const simuliveLiveAfterGrace = 2 * time.Minute

// simuliveReplaying: a simulive that plays (or will play) its recording, as opposed to one
// live with its host team after it.
func simuliveReplaying(wb types.Webinar) bool {
	return wb.Kind == types.KindSimulive && wb.SimuliveLiveAt == ""
}

// simuliveLiveWith is the host's first name while a simulive is live after its recording.
func simuliveLiveWith(wb types.Webinar) string {
	if wb.Kind != types.KindSimulive || wb.SimuliveLiveAt == "" {
		return ""
	}
	if f := strings.Fields(wb.Host.Name); len(f) > 0 {
		return f[0]
	}
	return ""
}

// simuliveLiveAfterGraceOver: the host team has been gone from a live-after simulive long
// enough for it to end.
func (s *Server) simuliveLiveAfterGraceOver(wb types.Webinar, now time.Time) bool {
	gone, err := time.Parse(time.RFC3339, wb.SimuliveHostGoneAt)
	return err == nil && !now.Before(gone.Add(simuliveLiveAfterGrace))
}

/* goSimuliveLiveIfOver makes the recording's end the start of the live part, and tells the
 * room: every client then re-joins for the live room (the host team on the stage). */
func (s *Server) goSimuliveLiveIfOver(ctx context.Context, slug string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), simuliveStartBudget)
	defer cancel()
	claimed, err := s.store.GoSimuliveLiveIfOver(ctx, slug)
	if err != nil {
		s.log.Warn("simulive: could not go live after the recording", "slug", slug, "error", err)
		return
	}
	if !claimed {
		return
	}
	simuliveEndCache.Delete(slug)
	replayPollCache.Delete(slug)
	s.log.Info("simulive: recording over, live with the host team", "slug", slug)
	if wb, err := s.store.WebinarBySlug(ctx, slug); err == nil {
		s.tellSimuliveRoom(ctx, wb)
	}
}

// endSimuliveIfHostGone ends a live-after simulive the host team has left, once.
func (s *Server) endSimuliveIfHostGone(ctx context.Context, wb types.Webinar) {
	if s.simuliveHostPresent(ctx, wb, "") {
		_ = s.store.ClearSimuliveHostGone(ctx, wb.ID)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), simuliveEndBudget)
	defer cancel()
	serverCaptions, _ := s.store.ServerCaptionsRequested(ctx, wb.ID)
	claimed, err := s.store.EndSimuliveHostGone(ctx, wb.ID, simuliveLiveAfterGrace)
	if err != nil || !claimed {
		return
	}
	ended, err := s.store.WebinarBySlug(ctx, wb.ID)
	if err != nil {
		return
	}
	s.log.Info("simulive ended: the host team left the live part", "slug", wb.ID)
	s.afterSessionEnded(ctx, wb.ID, ended, serverCaptions)
}

// simuliveForHost loads the simulive the request is about, brought up to date, or answers.
func (s *Server) simuliveForHost(w http.ResponseWriter, r *http.Request) (types.Webinar, bool) {
	wb, err := s.loadSynced(r.Context(), slugFromContext(r.Context()))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return wb, false
	}
	if err != nil {
		s.fail(w, r, "simulive host: load", err)
		return wb, false
	}
	if wb.Kind != types.KindSimulive {
		httpx.Error(w, http.StatusNotFound, "not_simulive", "This isn't a simulive session.")
		return wb, false
	}
	return wb, true
}

// simuliveAudit is the audit line for a host's start control.
func (s *Server) simuliveAudit(r *http.Request, action string, args ...any) {
	user := userFromContext(r.Context())
	s.log.Info("simulive host control",
		append([]any{"action", action, "slug", slugFromContext(r.Context()), "user", user.ID}, args...)...)
}

// tellSimuliveRoom pushes the webinar as it now is into its room's metadata. Best-effort:
// a room nobody has joined yet has nothing to tell, and the waiting screens also poll.
func (s *Server) tellSimuliveRoom(ctx context.Context, wb types.Webinar) {
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	if meta, err := s.roomMetadata(ctx, wb); err == nil {
		_ = sfu.SetMetadata(ctx, lk.RoomName(wb.ID), meta)
	}
}

// reloadAndAnswer reads the webinar fresh, tells the room, and answers with it.
func (s *Server) reloadAndAnswer(w http.ResponseWriter, r *http.Request, slug string, tell bool) {
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "simulive host: reload", err)
		return
	}
	if tell {
		s.tellSimuliveRoom(r.Context(), wb)
	}
	httpx.JSON(w, http.StatusOK, wb)
}

func simuliveNotScheduled(w http.ResponseWriter, wb types.Webinar) {
	if wb.Status == types.StatusLive {
		httpx.Error(w, http.StatusConflict, "started", "This session has already started.")
		return
	}
	httpx.Error(w, http.StatusConflict, "ended", "This session is over.")
}

// handleSimuliveStartNow: live now. Already live answers with it as it is.
func (s *Server) handleSimuliveStartNow(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.simuliveForHost(w, r)
	if !ok {
		return
	}
	switch {
	case wb.Status == types.StatusLive:
		httpx.JSON(w, http.StatusOK, wb)
		return
	case wb.Status != types.StatusScheduled || wb.DidntGoLive:
		simuliveNotScheduled(w, wb)
		return
	}
	claimed, err := s.store.StartSimuliveNow(r.Context(), wb.ID)
	if err != nil {
		s.fail(w, r, "simulive start now", err)
		return
	}
	if claimed {
		s.simuliveAudit(r, "start_now")
		s.afterSimuliveStarted(r.Context(), wb.ID)
	}
	s.reloadAndAnswer(w, r, wb.ID, false)
}

// handleSimuliveStartAt sets or moves the pending start.
func (s *Server) handleSimuliveStartAt(w http.ResponseWriter, r *http.Request) {
	var body types.SimuliveScheduleRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	wb, ok := s.simuliveForHost(w, r)
	if !ok {
		return
	}
	if wb.Status != types.StatusScheduled || wb.DidntGoLive {
		simuliveNotScheduled(w, wb)
		return
	}
	now := time.Now()
	at, msg := simulivePendingStart(wb, body, now)
	if msg != "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", msg)
		return
	}
	err := s.store.SetSimulivePendingStart(r.Context(), wb.ID, &at)
	if errors.Is(err, store.ErrConflict) {
		simuliveNotScheduled(w, wb)
		return
	}
	if err != nil {
		s.fail(w, r, "simulive start at", err)
		return
	}
	s.simuliveAudit(r, "start_at", "at", at.Format(time.RFC3339), "in", at.Sub(now).Round(time.Second).String())
	s.reloadAndAnswer(w, r, wb.ID, true)
}

/* simulivePendingStart is the moment a start-at request asks for, or the sentence refusing it.
 * In the future, at most a day ahead, and before the session's scheduled end — past that the
 * webinar reads as not having gone live (store.markLapsed), so a later start is a reschedule. */
func simulivePendingStart(wb types.Webinar, body types.SimuliveScheduleRequest, now time.Time) (time.Time, string) {
	set := 0
	for _, on := range []bool{body.At != "", body.InMin != 0, body.DelayMin != 0} {
		if on {
			set++
		}
	}
	if set != 1 {
		return time.Time{}, "Say when: a time, minutes from now, or a delay."
	}
	maxMin := types.MaxSimulivePendingStartMin
	var at time.Time
	switch {
	case body.At != "":
		t, err := time.Parse(time.RFC3339, body.At)
		if err != nil {
			return time.Time{}, "That isn't a time."
		}
		at = t
	case body.InMin != 0:
		if body.InMin < 1 || body.InMin > maxMin {
			return time.Time{}, fmt.Sprintf("Start between 1 and %d minutes from now.", maxMin)
		}
		at = now.Add(time.Duration(body.InMin) * time.Minute)
	default:
		if body.DelayMin < 1 || body.DelayMin > maxMin {
			return time.Time{}, fmt.Sprintf("Delay by 1 to %d minutes.", maxMin)
		}
		// After the start it would otherwise have: the pending one, or starts_at.
		base := now
		if t, ok := simuliveTarget(wb); ok && t.After(now) {
			base = t
		}
		at = base.Add(time.Duration(body.DelayMin) * time.Minute)
	}
	at = at.Truncate(time.Second)
	if !at.After(now) {
		return time.Time{}, "Pick a start in the future."
	}
	if at.After(now.Add(time.Duration(maxMin) * time.Minute)) {
		return time.Time{}, "Pick a start within the next 24 hours."
	}
	if startsAt, err := time.Parse(time.RFC3339, wb.StartsAt); err == nil {
		if end := startsAt.Add(time.Duration(wb.Duration) * time.Minute); !at.Before(end) {
			return time.Time{}, "That's after this session's scheduled end. Edit its time to start later."
		}
	}
	return at.UTC(), ""
}

/* handleSimuliveCancelStart drops the pending start: a manual simulive waits for the host
 * again, an automatic one goes back to starts_at. Not when that would start an automatic one
 * this instant — the host meant to hold it, so they pick Start now or a new time instead. */
func (s *Server) handleSimuliveCancelStart(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.simuliveForHost(w, r)
	if !ok {
		return
	}
	if wb.Status != types.StatusScheduled || wb.DidntGoLive {
		simuliveNotScheduled(w, wb)
		return
	}
	if wb.SimuliveStartAt == "" {
		httpx.JSON(w, http.StatusOK, wb)
		return
	}
	if !simuliveManual(wb) {
		if startsAt, err := time.Parse(time.RFC3339, wb.StartsAt); err == nil && !time.Now().Before(startsAt) {
			httpx.Error(w, http.StatusConflict, "would_start",
				"Its scheduled time has passed, so cancelling would start it now. Start it now, or pick a new time.")
			return
		}
	}
	err := s.store.SetSimulivePendingStart(r.Context(), wb.ID, nil)
	if errors.Is(err, store.ErrConflict) {
		simuliveNotScheduled(w, wb)
		return
	}
	if err != nil {
		s.fail(w, r, "simulive cancel start", err)
		return
	}
	s.simuliveAudit(r, "cancel_start", "was", wb.SimuliveStartAt)
	s.reloadAndAnswer(w, r, wb.ID, true)
}

// handleSimuliveOpenDoors lets the audience in to wait now.
func (s *Server) handleSimuliveOpenDoors(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.simuliveForHost(w, r)
	if !ok {
		return
	}
	if wb.Status == types.StatusLive || wb.SimuliveDoorsOpen {
		httpx.JSON(w, http.StatusOK, wb)
		return
	}
	if wb.Status != types.StatusScheduled || wb.DidntGoLive {
		simuliveNotScheduled(w, wb)
		return
	}
	err := s.store.OpenSimuliveDoors(r.Context(), wb.ID)
	if errors.Is(err, store.ErrConflict) {
		simuliveNotScheduled(w, wb)
		return
	}
	if err != nil {
		s.fail(w, r, "simulive open doors", err)
		return
	}
	s.simuliveAudit(r, "open_doors")
	s.reloadAndAnswer(w, r, wb.ID, true)
}

// handleSimuliveEnd ends a live simulive now, as End does. Already ended answers with it.
func (s *Server) handleSimuliveEnd(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.simuliveForHost(w, r)
	if !ok {
		return
	}
	switch wb.Status {
	case types.StatusEnded:
		httpx.JSON(w, http.StatusOK, wb)
		return
	case types.StatusLive:
	default:
		httpx.Error(w, http.StatusConflict, "not_live", "This session hasn't started.")
		return
	}
	ended, err := s.endWebinarSession(r.Context(), wb.ID)
	if err != nil {
		s.fail(w, r, "simulive end", err)
		return
	}
	simuliveEndCache.Delete(wb.ID)
	replayPollCache.Delete(wb.ID)
	s.simuliveAudit(r, "end")
	httpx.JSON(w, http.StatusOK, ended)
}

/* handleSimuliveGoLive: the host team ends the replay early and goes live with the audience.
 * The same live-after state the recording's end reaches with them in the room — the room is
 * told (room metadata simuliveLiveAt), and every browser in it re-joins: the host team for a
 * stage grant, the audience for the ordinary live room. Nothing of the host team's is ever
 * published over the recording; their camera goes out only on that live stage. Still never
 * recorded (refuseSimuliveRecording is by kind). Already live after answers as it is. */
func (s *Server) handleSimuliveGoLive(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.simuliveForHost(w, r)
	if !ok {
		return
	}
	switch {
	case wb.Status == types.StatusLive && wb.SimuliveLiveAt != "":
		httpx.JSON(w, http.StatusOK, wb)
		return
	case wb.Status == types.StatusEnded:
		httpx.Error(w, http.StatusConflict, "ended", "This session is over.")
		return
	case wb.Status != types.StatusLive:
		httpx.Error(w, http.StatusConflict, "not_live", "The replay hasn't started yet.")
		return
	}
	claimed, err := s.store.GoSimuliveLiveNow(r.Context(), wb.ID)
	if err != nil {
		s.fail(w, r, "simulive go live", err)
		return
	}
	if claimed {
		simuliveEndCache.Delete(wb.ID)
		replayPollCache.Delete(wb.ID)
		s.simuliveAudit(r, "go-live")
	}
	s.reloadAndAnswer(w, r, wb.ID, true)
}
