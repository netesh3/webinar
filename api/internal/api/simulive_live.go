package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/replay"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* A simulive runs itself, without a scheduler (store/simulive_live.go has the rules).
 *
 * The API is on Cloud Run: CPU only while a request is being answered, and the sweeper's tick
 * may not come every minute. So the transitions are LAZY — every request that touches a
 * simulive brings it up to date before answering (syncSimulive): its public page and
 * registration page, join (attendee, guest and host), /say, the polls, the replay timeline,
 * the host's page. The sweeper does the same, so a tick that does come keeps doing it too.
 *
 *   start   an automatic simulive whose starts_at has come goes live, its clock starting at
 *           starts_at, and its room is made and told (room metadata) so every waiting
 *           player begins at the shared position at once. A manual one never starts here,
 *           unless the host set a start from the room (simulive_host.go: "Start in 5 min",
 *           "Delay"), which replaces starts_at as the moment for either kind.
 *   end     once the original session's length has played (plus a grace), the recording is
 *           over for everyone. With nobody of the host team in the room the session ends.
 *           With the host or a co-host there it carries on LIVE with them (live after,
 *           simulive_host.go): the host team gets the stage, the audience the ordinary live
 *           room, and it ends with End webinar — or simuliveLiveAfterGrace after the last of
 *           the host team leaves (the participant_left webhook, the sweeper and the next
 *           request all ask).
 *   polls   the replay's polls open and close at the original's moments (syncReplayPolls).
 *
 * Each transition is a guarded UPDATE in the store, so two instances, two requests or a
 * request and the sweeper racing make it once, and only that caller does what follows.
 *
 * Mail: nothing is sent on a simulive's start, here or in the sweeper — reminders are rows
 * queued at registration with their own due times and go out from the outbox, which skips a
 * webinar only once it has ended. The end does what every end does (afterSessionEnded): the
 * survey on end, follow-ups, the report and the recap.
 */

// simuliveEndCache remembers when a live simulive is over, per slug and start, so a busy
// live session costs /say and join no extra query until that moment.
var simuliveEndCache sync.Map // slug → simuliveEnd

type simuliveEnd struct {
	startedAt string
	at        time.Time
}

// Budgets for the work a transition does inside somebody else's request.
const (
	simuliveStartBudget = 15 * time.Second
	simuliveEndBudget   = 60 * time.Second
)

// simuliveDoorsOpen is how long before its start a simulive's audience may come in.
func simuliveDoorsOpen(wb types.Webinar) time.Duration {
	m := types.DefaultSimuliveDoorsOpenMin
	if d := wb.Options.SimuliveDoorsOpenMin; d != nil {
		m = min(max(*d, 0), types.MaxSimuliveDoorsOpenMin)
	}
	return time.Duration(m) * time.Minute
}

func simuliveManual(wb types.Webinar) bool {
	return wb.Options.SimuliveStart == types.SimuliveStartManual
}

/* simuliveTarget is when a scheduled simulive goes live by itself: the start the host set
 * from the room (Webinar.SimuliveStartAt), else starts_at for an automatic one. False for a
 * manual one with nothing pending. The Go twin of store.simuliveTargetSQL. */
func simuliveTarget(wb types.Webinar) (time.Time, bool) {
	if wb.SimuliveStartAt != "" {
		if at, err := time.Parse(time.RFC3339, wb.SimuliveStartAt); err == nil {
			return at, true
		}
	}
	if simuliveManual(wb) {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339, wb.StartsAt)
	return at, err == nil
}

/* simuliveDoorsOpenAt is when a scheduled simulive's audience may come in: doors-open minutes
 * before the earlier of starts_at and a pending start (a host who says "Start in 2 min" ten
 * minutes early brings the doors forward with it). Zero once the host opened them by hand. */
func simuliveDoorsOpenAt(wb types.Webinar) (time.Time, error) {
	if wb.SimuliveDoorsOpen {
		return time.Time{}, nil
	}
	startsAt, err := time.Parse(time.RFC3339, wb.StartsAt)
	if err != nil {
		return time.Time{}, err
	}
	if at, err := time.Parse(time.RFC3339, wb.SimuliveStartAt); err == nil && at.Before(startsAt) {
		startsAt = at
	}
	return startsAt.Add(-simuliveDoorsOpen(wb)), nil
}

// simuliveDoorsAreOpen: a scheduled simulive whose doors have opened, so its audience may wait
// in the room and chat before the recording starts.
func simuliveDoorsAreOpen(wb types.Webinar, now time.Time) bool {
	if wb.Kind != types.KindSimulive || wb.Status != types.StatusScheduled || wb.DidntGoLive {
		return false
	}
	opens, err := simuliveDoorsOpenAt(wb)
	return err == nil && !now.Before(opens)
}

/* syncSimulive brings a simulive up to date (see above) and returns it as it now is. Anything
 * else comes back untouched, with no database work. Never fails the caller's request: a
 * transition that cannot be made now is made by the next request or the sweeper. */
func (s *Server) syncSimulive(ctx context.Context, wb types.Webinar) types.Webinar {
	if wb.Kind != types.KindSimulive || wb.SimuliveRecordingID == "" {
		return wb
	}
	now := time.Now()
	slug := wb.ID
	switch {
	case wb.Status == types.StatusScheduled || wb.DidntGoLive:
		// A manual simulive with nothing pending waits for the host: entering the room is
		// not starting it. Nor is anything due before its start.
		startsAt, ok := simuliveTarget(wb)
		// A day past the start is past any recording; the read rewrote it as not having
		// gone live, and asking again on every page view would be a write for nothing.
		if !ok || now.Before(startsAt) || now.After(startsAt.Add(24*time.Hour)) {
			return wb
		}
		claimed, err := s.store.StartSimuliveIfDue(ctx, slug)
		if err != nil {
			s.log.Warn("simulive: lazy start failed", "slug", slug, "error", err)
			return wb
		}
		if claimed {
			s.log.Info("simulive started", "slug", slug)
			s.afterSimuliveStarted(ctx, slug)
		}
	case wb.Status == types.StatusLive && wb.SimuliveLiveAt != "":
		// Live after the recording: it ends a grace after the host team has gone.
		if !s.simuliveLiveAfterGraceOver(wb, now) {
			return wb
		}
		s.endSimuliveIfHostGone(ctx, wb)
	case wb.Status == types.StatusLive:
		if !s.simuliveOver(ctx, wb, now) {
			return wb
		}
		// The recording has played. With the host team in the room the session carries on
		// live with them; without, it is over.
		if s.simuliveHostPresent(ctx, wb, "") {
			s.goSimuliveLiveIfOver(ctx, slug)
		} else {
			s.endSimuliveIfDue(ctx, slug)
		}
	default:
		return wb
	}
	if fresh, err := s.store.WebinarBySlug(ctx, slug); err == nil {
		return fresh
	}
	return wb
}

// simuliveOver reports whether a live simulive's session has played through.
func (s *Server) simuliveOver(ctx context.Context, wb types.Webinar, now time.Time) bool {
	if c, ok := simuliveEndCache.Load(wb.ID); ok {
		if e := c.(simuliveEnd); e.startedAt == wb.StartedAt {
			return !now.Before(e.at)
		}
	}
	at, live, err := s.store.SimuliveEndsAt(ctx, wb.ID)
	if err != nil || !live {
		return false
	}
	simuliveEndCache.Store(wb.ID, simuliveEnd{startedAt: wb.StartedAt, at: at})
	return !now.Before(at)
}

/* simuliveHostPresent reports whether the host or a co-host is in the simulive's room, other
 * than `except` (somebody the SFU is reporting as leaving). An SFU that cannot be asked
 * counts as nobody: the session then ends on time, which is the rule without a host. */
func (s *Server) simuliveHostPresent(ctx context.Context, wb types.Webinar, except string) bool {
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return false
	}
	people, err := sfu.Participants(ctx, lk.RoomName(wb.ID))
	if err != nil {
		s.log.Warn("simulive: could not list the room", "slug", wb.ID, "error", err)
		return false
	}
	for _, p := range people {
		if p.Identity == except || !strings.HasPrefix(p.Identity, "user_") {
			continue
		}
		if p.Role == types.RoleHost || p.CoHost {
			return true
		}
	}
	return false
}

/* afterSimuliveStarted makes the room exist and tells it the session is live, so every player
 * waiting in it starts at the shared position now rather than on its next poll. Best-effort:
 * an SFU still booting gets the room from the first join instead. */
func (s *Server) afterSimuliveStarted(ctx context.Context, slug string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), simuliveStartBudget)
	defer cancel()
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return
	}
	// The registrants who asked to be told (push.go). Before the room, which can fail.
	s.pushWentLive(ctx, wb)
	sfu, _, _, err := s.ensureRoom(ctx, wb, lk.RoomName(slug))
	if err != nil {
		s.log.Warn("simulive: could not make the room on start", "slug", slug, "error", err)
		return
	}
	if meta, err := s.roomMetadata(ctx, wb); err == nil {
		_ = sfu.SetMetadata(ctx, lk.RoomName(slug), meta)
	}
}

// endSimuliveIfDue claims the end and, if this call made it, does what ending does.
func (s *Server) endSimuliveIfDue(ctx context.Context, slug string) bool {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), simuliveEndBudget)
	defer cancel()
	serverCaptions, _ := s.store.ServerCaptionsRequested(ctx, slug)
	claimed, err := s.store.EndSimuliveIfDue(ctx, slug)
	if err != nil {
		s.log.Warn("simulive: lazy end failed", "slug", slug, "error", err)
		return false
	}
	if !claimed {
		return false
	}
	simuliveEndCache.Delete(slug)
	replayPollCache.Delete(slug)
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.log.Warn("simulive: ended, but could not reload it", "slug", slug, "error", err)
		return true
	}
	s.log.Info("simulive ended: its session has played", "slug", slug)
	s.afterSessionEnded(ctx, slug, wb, serverCaptions)
	return true
}

/* simuliveHostLeft is the SFU saying somebody on the host team left. If that was a live
 * simulive past its end, and nobody else on the host team is still there, it ends now; in
 * live-after the grace starts. The leaver is excluded because the SFU may still list them
 * while the webhook is in flight. */
func (s *Server) simuliveHostLeft(ctx context.Context, slug, identity string) {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil || wb.Kind != types.KindSimulive || wb.Status != types.StatusLive {
		return
	}
	if wb.SimuliveLiveAt != "" {
		if !s.simuliveHostPresent(ctx, wb, identity) {
			if err := s.store.MarkSimuliveHostGone(ctx, slug); err != nil {
				s.log.Warn("simulive: could not note the host team leaving", "slug", slug, "error", err)
			}
		}
		return
	}
	if !s.simuliveOver(ctx, wb, time.Now()) || s.simuliveHostPresent(ctx, wb, identity) {
		return
	}
	s.endSimuliveIfDue(ctx, slug)
}

// handleSetSimuliveStart is PUT /api/host/webinars/{slug}/simulive-start: the Setup tab's
// "Start automatically / I'll start it" and doors-open choice, before the session starts.
func (s *Server) handleSetSimuliveStart(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	var body types.SimuliveStartRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	mode := body.SimuliveStart
	if mode == "" {
		mode = types.SimuliveStartAuto
	}
	if mode != types.SimuliveStartAuto && mode != types.SimuliveStartManual {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", "Start it automatically, or start it yourself.")
		return
	}
	if d := body.DoorsOpenMin; d != nil && (*d < 0 || *d > types.MaxSimuliveDoorsOpenMin) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid",
			fmt.Sprintf("Doors can open up to %d minutes before the start.", types.MaxSimuliveDoorsOpenMin))
		return
	}
	err := s.store.SetSimuliveStart(r.Context(), slug, mode, body.DoorsOpenMin)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_simulive", "This isn't a simulive session.")
		return
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "started", "This session has already started.")
		return
	case err != nil:
		s.fail(w, r, "simulive start mode", err)
		return
	}
	wb, err := s.loadSynced(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "simulive start mode: reload", err)
		return
	}
	httpx.JSON(w, http.StatusOK, wb)
}

// loadSynced reads a webinar and, if it is a simulive, brings it up to date first.
func (s *Server) loadSynced(ctx context.Context, slug string) (types.Webinar, error) {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return wb, err
	}
	return s.syncSimulive(ctx, wb), nil
}

// ------------------------------------------------------------------ replayed polls

/* replayPollCache spares the polls endpoints the sync while nothing can have changed: until
 * the next moment a replayed poll opens or closes, and at most replayPollRecheck (the host
 * may hide one; another instance may have synced). Keyed by slug and start, so a restarted
 * clock is never served a stale answer. */
var replayPollCache sync.Map // slug → replayPollState

type replayPollState struct {
	startedAt string
	next      time.Time
	checked   time.Time
}

const replayPollRecheck = 30 * time.Second

/* syncReplayPolls opens and closes a live simulive's replayed polls at the original's moments,
 * by the shared clock (now − started_at). Called before every read of the polls (audience and
 * host), by the replay timeline, and by the sweeper; the room's own timeline re-reads the
 * polls at each poll moment, which is what brings a session with no sweeper to each one on
 * time. Tells the room when something changed. */
func (s *Server) syncReplayPolls(ctx context.Context, wb types.Webinar) {
	if wb.Kind != types.KindSimulive || wb.Status != types.StatusLive || wb.StartedAt == "" || wb.SimuliveRecordingID == "" ||
		wb.SimuliveLiveAt != "" {
		return
	}
	started, err := time.Parse(time.RFC3339, wb.StartedAt)
	if err != nil {
		return
	}
	now := time.Now()
	if c, ok := replayPollCache.Load(wb.ID); ok {
		st := c.(replayPollState)
		if st.startedAt == wb.StartedAt && now.Before(st.next) && now.Sub(st.checked) < replayPollRecheck {
			return
		}
	}
	if !s.replayAvailable(ctx, wb) {
		replayPollCache.Store(wb.ID, replayPollState{startedAt: wb.StartedAt, next: now.Add(replayPollRecheck), checked: now})
		return
	}
	src, err := s.store.ReplayPollSource(ctx, wb.SimuliveRecordingID)
	if err != nil {
		s.log.Warn("replay polls: source", "slug", wb.ID, "error", err)
		return
	}
	hidden, err := s.store.ReplayHidden(ctx, wb.ID)
	if err != nil {
		s.log.Warn("replay polls: hidden", "slug", wb.ID, "error", err)
		return
	}
	sched := replay.Schedule(src)
	pos := now.Sub(started).Milliseconds()
	changed, err := s.store.ApplyReplayPolls(ctx, wb.ID, sched, hidden, pos)
	if err != nil {
		s.log.Warn("replay polls: apply", "slug", wb.ID, "error", err)
		return
	}
	next := now.Add(replayPollRecheck)
	if nb := replay.NextBoundary(sched, pos); nb >= 0 {
		next = started.Add(time.Duration(nb) * time.Millisecond)
	}
	replayPollCache.Store(wb.ID, replayPollState{startedAt: wb.StartedAt, next: next, checked: now})
	if changed {
		s.announcePollsCtx(ctx, wb.ID)
	}
}

// sweepLiveSimulives keeps every live simulive's replayed polls on time when a tick runs.
func (s *Server) sweepLiveSimulives(ctx context.Context) {
	slugs, err := s.store.LiveSimuliveSlugs(ctx)
	if err != nil {
		s.log.Error("simulive sweeper: live query failed", "error", err)
		return
	}
	for _, slug := range slugs {
		if ctx.Err() != nil {
			return
		}
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if err != nil {
			continue
		}
		// A missed participant_left webhook: the tick notices the host team has gone.
		if wb.Status == types.StatusLive && wb.SimuliveLiveAt != "" && wb.SimuliveHostGoneAt == "" &&
			!s.simuliveHostPresent(ctx, wb, "") {
			_ = s.store.MarkSimuliveHostGone(ctx, slug)
			continue
		}
		wb = s.syncSimulive(ctx, wb)
		s.syncReplayPolls(ctx, wb)
	}
}
