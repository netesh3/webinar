package api

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* "Record automatically" (Options.AutoRecord): a cloud recording the host does not have to
 * press Record for.
 *
 * It starts once the session is live AND somebody on the stage is publishing — a recording
 * of an empty room is minutes of nothing in front of the part worth keeping. Three paths try,
 * because none of them alone sees every case:
 *
 *   - the LiveKit webhook's track_published: the moment the host's camera or mic goes up in
 *     a live room;
 *   - Go live: a host who was already on camera in the room before pressing it;
 *   - the sweeper (sweepAutoRecordings, every tick): the on-demand box or the egress worker
 *     was still booting, a webhook was lost, or a start failed and is due a retry.
 *
 * Exactly once per webinar: the claim is a column on the webinar row (store.ClaimAutoRecording),
 * so the three paths and every API instance agree. A start that failed gives the claim back.
 * A host who stops the automatic recording is not overruled, the claim stays — pressing
 * Record again is theirs to do.
 *
 * The recording itself is beginRecording, the same path as Record: a LiveKit composite on a
 * standard webinar, the edge mix's own recording (mixrec.go) when an edge mix is running.
 *
 * Only in egress mode: in client mode a cloud recording is a host's browser compositing the
 * room, which the server cannot start. Never for a simulive (refuseSimuliveRecording), nor
 * for a host without cloud recording (the form hides the option and saving refuses it; a
 * webinar saved before the switch was taken away is ignored here). A meeting records like a
 * webinar (Record works in one), so a meeting with the option on is recorded too. */

// autoRecordRetry is how long after a failed automatic start the next one is tried, so a
// video server that keeps refusing a recorder is not asked every tick.
var autoRecordRetry = time.Minute

var (
	autoRecordMu     sync.Mutex
	autoRecordFailed = map[string]time.Time{} // slug -> last failed start
	// autoRecordDone is the slugs this process has seen claimed: a cheap way for the webhook,
	// which fires on every track published, not to ask the video server again. The claim in
	// the database is what makes it once; this only saves the lookups.
	autoRecordDone = map[string]bool{}
)

// sweepAutoRecordings starts the automatic recording of every live webinar still waiting
// for one. See the comment above.
func (s *Server) sweepAutoRecordings(ctx context.Context) {
	if !s.autoRecordAvailable() {
		return
	}
	slugs, err := s.store.AutoRecordPending(ctx)
	if err != nil {
		s.log.Error("auto record sweeper: query failed", "error", err)
		return
	}
	for _, slug := range slugs {
		if ctx.Err() != nil {
			return
		}
		s.maybeAutoRecord(ctx, slug)
	}
}

// autoRecordSoon is maybeAutoRecord off the caller's request, for the webhook and Go live:
// a recorder's start can take seconds and neither should wait on it.
func (s *Server) autoRecordSoon(wb types.Webinar) {
	if !wb.Options.AutoRecord || wb.Kind == types.KindSimulive || wb.Status != types.StatusLive ||
		!s.autoRecordAvailable() {
		return
	}
	go func() { // #nosec G118 -- background work that must outlive the request; it carries its own timeout
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.maybeAutoRecord(ctx, wb.ID)
	}()
}

func (s *Server) autoRecordAvailable() bool {
	return s.recordings != nil && s.cfg.RecordingsMode == "egress"
}

/* maybeAutoRecord starts slug's automatic recording if it is due: live, the option on, the
 * host's cloud recording on, somebody publishing on the stage, and not claimed yet. Safe to
 * call from anywhere, any number of times. Reports whether this call started it. */
func (s *Server) maybeAutoRecord(ctx context.Context, slug string) bool {
	if !s.autoRecordAvailable() {
		return false
	}
	autoRecordMu.Lock()
	failedAt, failed := autoRecordFailed[slug]
	done := autoRecordDone[slug]
	autoRecordMu.Unlock()
	if done || (failed && time.Since(failedAt) < autoRecordRetry) {
		return false
	}

	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return false
	}
	if !wb.Options.AutoRecord || wb.Status != types.StatusLive || wb.Kind == types.KindSimulive {
		return false
	}
	if !s.hostCloudRecording(ctx, wb.Host.ID) {
		return false
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		// The box is still booting: the next tick asks again.
		return false
	}
	if !stageIsPublishing(ctx, sfu, wb.ID) {
		return false
	}
	if !s.mixSettled(ctx, wb, sfu) {
		return false
	}

	id := uuid.NewString()
	claimed, err := s.store.ClaimAutoRecording(ctx, wb.ID, id)
	if err != nil {
		s.log.Warn("auto record: claim failed", "slug", wb.ID, "error", err)
		return false
	}
	if !claimed {
		markAutoRecordDone(slug)
		return false
	}

	rec, err := s.beginRecording(ctx, wb, id, wb.Host.ID, wb.Host.Name, "video/mp4", true)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			// Somebody pressed Record first: the session is being recorded, which is all the
			// option asks for. The claim stays, so it is not started again after they stop.
			markAutoRecordDone(slug)
			return false
		}
		if errors.Is(err, errStorageFull) {
			// The host's storage is full (1 Nov 2026): not retried, it would only fail again.
			s.log.Info("auto record: storage full, not recording", "slug", wb.ID, "host", wb.Host.ID)
			markAutoRecordDone(slug)
			return false
		}
		s.log.Warn("auto record: could not start; retrying later", "slug", wb.ID, "error", err)
		if relErr := s.store.ReleaseAutoRecording(ctx, wb.ID, id); relErr != nil {
			s.log.Warn("auto record: release claim", "slug", wb.ID, "error", relErr)
		}
		autoRecordMu.Lock()
		autoRecordFailed[slug] = time.Now()
		autoRecordMu.Unlock()
		return false
	}
	markAutoRecordDone(slug)
	s.log.Info("recording started automatically", "slug", wb.ID, "recording", rec.ID,
		"egress", rec.EgressID)
	return true
}

func markAutoRecordDone(slug string) {
	autoRecordMu.Lock()
	delete(autoRecordFailed, slug)
	autoRecordDone[slug] = true
	autoRecordMu.Unlock()
}

// autoRecordMixWait is how long after going live an automatic recording waits for the
// attendee mix to come up before it starts without one.
var autoRecordMixWait = 3 * time.Minute

/* mixSettled is whether the room's attendee mix, if it has one, is up — or has had long
 * enough. Go live starts the mix in the background at the same moment, and a recording
 * started while that is in flight would be a second compositor beside it (or a combined one
 * racing it) on a box that may only fit one. Once the mix is running, an edge webinar
 * records from it with no extra compositor (mixrec.go). A room with nowhere to push has no
 * mix to wait for. */
func (s *Server) mixSettled(ctx context.Context, wb types.Webinar, sfu RoomManager) bool {
	if isMeeting(wb) {
		return true
	}
	origin, dests := s.mixPlan(ctx, wb)
	if origin == "" && len(dests) == 0 {
		return true
	}
	broadcastMu.Lock()
	starting := activeBroadcasts[wb.ID] == "starting"
	broadcastMu.Unlock()
	if !starting {
		if ids, err := s.broadcastEgressIDs(ctx, wb.ID, sfu); err == nil && len(ids) > 0 {
			return true
		}
	}
	// No mix yet. Past the wait, record anyway: startEgressRecording handles a room whose mix
	// never came up.
	started, err := time.Parse(time.RFC3339, wb.StartedAt)
	return err == nil && time.Since(started) > autoRecordMixWait && !starting
}

// stageIsPublishing is whether anybody in the room is sending a track. Only the stage can:
// an attendee has no publish grant until brought on stage, and the recorder, egress and
// caption agent are left out of Participants.
func stageIsPublishing(ctx context.Context, sfu RoomManager, slug string) bool {
	list, err := sfu.Participants(ctx, lk.RoomName(slug))
	if err != nil {
		return false
	}
	for _, p := range list {
		if len(p.Publishing) > 0 {
			return true
		}
	}
	return false
}
