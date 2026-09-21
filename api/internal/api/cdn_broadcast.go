package api

import (
	"context"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

var (
	broadcastMu      sync.Mutex
	activeBroadcasts = make(map[string]string) // slug -> egressID or "starting"
)

/* How long to wait before putting the mix back after a combined egress stops.
 *
 * LiveKit only admits a room composite when the node has three idle cores, and
 * a compositor that has just been told to stop is still holding them while it
 * finalises. Asking immediately is how the replacement gets refused. A var so
 * tests do not sleep. */
var broadcastRestartDelay = 3 * time.Second

/* startBroadcastIfEnabled starts the one-way attendee feed: Egress composites
 * the room and pushes RTMP to MediaMTX, which serves WHEP.
 *
 * Does nothing without a configured RTMP origin. That is not a degraded mode —
 * the egress has no other output, so starting it would burn a Chromium job
 * encoding into nowhere. Join treats the same missing config as "CDN broadcast
 * is off" and keeps attendees on the SFU. */
func (s *Server) startBroadcastIfEnabled(ctx context.Context, wb types.Webinar, sfu RoomManager) {
	if sfu == nil {
		return
	}
	origin, extra := s.mixDestinations(ctx, wb)
	if origin == "" && extra == "" {
		return
	}

	broadcastMu.Lock()
	status, running := activeBroadcasts[wb.ID]
	if running && status != "" {
		broadcastMu.Unlock()
		/* "starting" is a genuine in-flight start; leave it alone rather than
		 * queue a second Chromium for the same room. Anything else is an egress
		 * id this process recorded, which is only evidence that a broadcast was
		 * started once — not that it is still encoding. */
		if status == "starting" || s.broadcastEgressRunning(ctx, wb.ID, sfu) {
			return
		}
		broadcastMu.Lock()
		if activeBroadcasts[wb.ID] != status {
			// Someone else reconciled while we were asking LiveKit.
			broadcastMu.Unlock()
			return
		}
		s.log.Warn("cdn broadcast: recorded egress is gone, starting a new one",
			"slug", wb.ID, "egress", status)
	}
	// Mark as starting to prevent concurrent duplicate invocations
	activeBroadcasts[wb.ID] = "starting"
	broadcastMu.Unlock()

	/* 720p mix on purpose: this stream is copied once per attendee on the same
	 * NIC as the SFU. 1080p × a few hundred viewers does not fit a CX33. */
	preset := livekit.EncodingOptionsPreset_H264_720P_30

	info, err := sfu.StartBroadcastEgress(ctx, lk.RoomName(wb.ID), s.cfg.RecordingsEgressTemplateURL, preset, origin, extraSlice(extra))
	if err != nil {
		s.log.Warn("cdn broadcast: could not start egress", "slug", wb.ID, "error", err)
		broadcastMu.Lock()
		delete(activeBroadcasts, wb.ID)
		broadcastMu.Unlock()
		return
	}

	broadcastMu.Lock()
	activeBroadcasts[wb.ID] = info.EgressId
	broadcastMu.Unlock()

	s.log.Info("cdn broadcast started", "slug", wb.ID, "egress", info.EgressId)
}

/* broadcastEgressRunning asks LiveKit whether this room still has a live mix.
 *
 * A broadcast is the egress with stream (RTMP) results; a recording writes a
 * file and must not be mistaken for one, or a room that is only being recorded
 * would look like it were already broadcasting.
 *
 * An unreachable egress API returns true — "keep the current state" — because
 * the failure mode of guessing wrong the other way is a second encoder for a
 * room that already has one, on the box whose NIC is the reason this path
 * exists. */
func (s *Server) broadcastEgressRunning(ctx context.Context, slug string, sfu RoomManager) bool {
	ids, err := s.broadcastEgressIDs(ctx, slug, sfu)
	if err != nil {
		return true
	}
	return len(ids) > 0
}

// broadcastEgressIDs is the same question as broadcastEgressRunning, answered
// with the ids: taking the mix over for a recording has to stop the encoder
// LiveKit actually has, which after a redeploy of this process is not
// necessarily the one activeBroadcasts remembers.
func (s *Server) broadcastEgressIDs(ctx context.Context, slug string, sfu RoomManager) ([]string, error) {
	infos, err := sfu.ListEgress(ctx, lk.RoomName(slug))
	if err != nil {
		s.log.Warn("cdn broadcast: could not list egress", "slug", slug, "error", err)
		return nil, err
	}
	var ids []string
	for _, info := range infos {
		if len(info.GetStreamResults()) == 0 {
			continue
		}
		switch info.GetStatus() {
		case livekit.EgressStatus_EGRESS_STARTING, livekit.EgressStatus_EGRESS_ACTIVE:
			ids = append(ids, info.GetEgressId())
		}
	}
	return ids, nil
}

/* mixEgressIDs is every compositor running on this room, whether or not it is
 * pushing RTMP yet.
 *
 * Wider than broadcastEgressIDs on purpose. A recording is started with an
 * empty RTMP output precisely so a destination can be attached to it later, and
 * until that happens it has no stream results — so the question "is anything
 * broadcasting" and the question "is there a compositor I can hand a URL to"
 * have different answers, and adding a YouTube destination needs the second. */
func (s *Server) mixEgressIDs(ctx context.Context, slug string, sfu RoomManager) []string {
	infos, err := sfu.ListEgress(ctx, lk.RoomName(slug))
	if err != nil {
		s.log.Warn("stream dest: could not list egress", "slug", slug, "error", err)
		return nil
	}
	var ids []string
	for _, info := range infos {
		switch info.GetStatus() {
		case livekit.EgressStatus_EGRESS_STARTING, livekit.EgressStatus_EGRESS_ACTIVE:
			ids = append(ids, info.GetEgressId())
		}
	}
	return ids
}

/* startEgressRecording begins a server-side recording, folding it into the
 * attendee mix when there is one.
 *
 * The box cannot run two room composites — see StartCombinedEgress for the
 * measurements — so when a broadcast is already encoding this room, the
 * recording replaces it with one egress carrying both outputs rather than
 * asking LiveKit for a second compositor it will refuse.
 *
 * Reports whether the returned egress is also carrying the mix, because that is
 * what stopping it later has to know: an egress that was only ever a recording
 * is finished when it stops, and one that took the broadcast's place leaves the
 * room without a mix until it is put back. */
func (s *Server) startEgressRecording(
	ctx context.Context,
	wb types.Webinar,
	sfu RoomManager,
	storageKey string,
	s3Opts lk.EgressS3Options,
) (info *livekit.EgressInfo, carriesMix bool, err error) {
	origin, extra := s.mixDestinations(ctx, wb)

	running, listErr := s.broadcastEgressIDs(ctx, wb.ID, sfu)
	if listErr != nil || len(running) == 0 {
		/* No mix to fold into, but a destination is already on file — the host
		 * set up YouTube before pressing Record. Carry it from the start rather
		 * than leaving it for a second compositor that will be refused. */
		if origin != "" || extra != "" {
			info, err = sfu.StartCombinedEgress(ctx, lk.RoomName(wb.ID), s.cfg.RecordingsEgressTemplateURL,
				livekit.EncodingOptionsPreset_H264_720P_30, origin, storageKey, s3Opts, extraSlice(extra))
			if err != nil {
				return nil, false, err
			}
			broadcastMu.Lock()
			activeBroadcasts[wb.ID] = info.EgressId
			broadcastMu.Unlock()
			return info, true, nil
		}

		// Nothing to fold into, so the recording gets the whole box and the
		// quality that goes with it.
		preset := livekit.EncodingOptionsPreset_H264_1080P_30
		if s.cfg.RecordingsEgressPreset == "720p" {
			preset = livekit.EncodingOptionsPreset_H264_720P_30
		}
		info, err = sfu.StartRoomCompositeEgress(ctx, lk.RoomName(wb.ID), storageKey, s3Opts,
			s.cfg.RecordingsEgressTemplateURL, preset)
		return info, false, err
	}

	/* Claim the slot before stopping anything. The sweeper restarts a mix it
	 * finds missing, and between the stop below and the start after it there is
	 * a window where that is exactly what this room looks like. */
	broadcastMu.Lock()
	activeBroadcasts[wb.ID] = "starting"
	broadcastMu.Unlock()

	for _, id := range running {
		if _, stopErr := sfu.StopEgress(ctx, id); stopErr != nil {
			s.log.Warn("recording: could not stop the mix it is taking over",
				"slug", wb.ID, "egress", id, "error", stopErr)
		}
	}

	info, err = sfu.StartCombinedEgress(ctx, lk.RoomName(wb.ID), s.cfg.RecordingsEgressTemplateURL,
		livekit.EncodingOptionsPreset_H264_720P_30, origin, storageKey, s3Opts, extraSlice(extra))
	if err != nil {
		// The room now has no mix and no recording. Releasing the slot is what
		// lets the sweeper notice and put the mix back.
		broadcastMu.Lock()
		delete(activeBroadcasts, wb.ID)
		broadcastMu.Unlock()
		return nil, false, err
	}

	broadcastMu.Lock()
	activeBroadcasts[wb.ID] = info.EgressId
	broadcastMu.Unlock()

	s.log.Info("recording folded into the attendee mix",
		"slug", wb.ID, "egress", info.EgressId, "replaced", running)
	return info, true, nil
}

/* restoreBroadcastAfterRecording puts the attendee mix back once a combined
 * egress has been stopped.
 *
 * Only when the egress that stopped is the one holding the slot: a recording
 * that was never folded into the mix has nothing to restore, and a mix that has
 * already been replaced by someone else is not this call's to touch. */
func (s *Server) restoreBroadcastAfterRecording(ctx context.Context, wb types.Webinar, sfu RoomManager, egressID string) {
	if sfu == nil || egressID == "" {
		return
	}

	broadcastMu.Lock()
	if activeBroadcasts[wb.ID] != egressID {
		broadcastMu.Unlock()
		return
	}
	delete(activeBroadcasts, wb.ID)
	broadcastMu.Unlock()

	if wb.Status != types.StatusLive {
		// Ending the webinar stops the mix on purpose; do not start another.
		return
	}

	s.log.Info("restoring the attendee mix after recording", "slug", wb.ID, "egress", egressID)
	s.startBroadcastIfEnabled(ctx, wb, sfu)
}

/* sweepBroadcasts restarts the mix for a live webinar that has lost it.
 *
 * Nothing else notices. An attendee whose WHEP offer gets "no stream is
 * available" retries against MediaMTX, which never talks to this server, so a
 * dead encoder is invisible until someone joins again — and a redeploy of the
 * egress container mid-session kills every encoder at once. That is exactly how
 * a room full of people ended up watching a spinner while the API believed the
 * broadcast was running.
 *
 * Only rooms already past their scheduled start are candidates, matching the
 * empty-room sweep: a host waiting in an early room does not need an encoder. */
func (s *Server) sweepBroadcasts(ctx context.Context) {
	slugs, err := s.store.LiveWebinarsPastStart(ctx)
	if err != nil {
		s.log.Error("cdn broadcast sweeper: query failed", "error", err)
		return
	}

	for _, slug := range slugs {
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if err != nil || wb.Kind == types.KindSimulive {
			continue
		}
		origin, extra := s.mixDestinations(ctx, wb)
		if origin == "" && extra == "" {
			continue
		}
		sfu, err := s.sfuFor(ctx, wb)
		if err != nil {
			continue
		}
		if s.broadcastEgressRunning(ctx, slug, sfu) {
			continue
		}
		broadcastMu.Lock()
		if activeBroadcasts[slug] == "starting" {
			broadcastMu.Unlock()
			continue
		}
		delete(activeBroadcasts, slug)
		broadcastMu.Unlock()

		s.log.Warn("cdn broadcast sweeper: live room has no mix, restarting", "slug", slug)
		s.startBroadcastIfEnabled(ctx, wb, sfu)
	}
}

func (s *Server) stopBroadcastIfActive(ctx context.Context, slug string, sfu RoomManager) {
	broadcastMu.Lock()
	egressID, ok := activeBroadcasts[slug]
	if ok {
		delete(activeBroadcasts, slug)
	}
	broadcastMu.Unlock()

	if !ok || egressID == "" || egressID == "starting" || sfu == nil {
		return
	}

	if _, err := sfu.StopEgress(ctx, egressID); err != nil {
		s.log.Warn("cdn broadcast: could not stop egress", "slug", slug, "egress", egressID, "error", err)
	} else {
		s.log.Info("cdn broadcast stopped", "slug", slug, "egress", egressID)
	}
}

// mixDestinations is the RTMP URLs this room's compositor should push: the
// attendee origin (when this host is on CDN broadcast) and the host's own
// destination (YouTube, …). Either may be empty. Both empty means do not start
// a compositor.
func (s *Server) mixDestinations(ctx context.Context, wb types.Webinar) (origin, extra string) {
	if can, err := s.store.HostCanCdnBroadcast(ctx, wb.Host.ID); err == nil && can {
		origin = s.cfg.BroadcastRTMPURL(wb.ID)
	}
	extra, on, err := s.store.WebinarStreamIngest(ctx, wb.ID)
	if err != nil {
		s.log.Warn("stream dest: could not load ingest", "slug", wb.ID, "error", err)
		return origin, ""
	}
	// A saved-but-stopped destination is not one to push to.
	if !on {
		return origin, ""
	}
	return origin, extra
}

func extraSlice(u string) []string {
	if u == "" {
		return nil
	}
	return []string{u}
}

/* syncStreamDest adds or replaces the host's RTMP destination on a running mix.
 *
 * One compositor, extra URL — that is the whole point of not starting a second
 * Chromium for YouTube. If nothing is encoding yet and the webinar is live,
 * startBroadcastIfEnabled is what creates the job. */
func (s *Server) syncStreamDest(ctx context.Context, wb types.Webinar, sfu RoomManager, oldURL, newURL string) {
	if sfu == nil || oldURL == newURL {
		return
	}
	if wb.Status != types.StatusLive {
		return
	}

	/* Every compositor on the room, not just the ones already streaming: when
	 * the host pressed Record first, the only one running is the recording, and
	 * that is the one that has to carry YouTube too. Starting a second is what
	 * LiveKit refuses. */
	ids := s.mixEgressIDs(ctx, wb.ID, sfu)
	if len(ids) == 0 {
		if newURL != "" {
			s.startBroadcastIfEnabled(ctx, wb, sfu)
		}
		return
	}

	var add, remove []string
	if oldURL != "" {
		remove = []string{oldURL}
	}
	if newURL != "" {
		add = []string{newURL}
	}
	for _, id := range ids {
		if _, err := sfu.UpdateStream(ctx, id, add, remove); err != nil {
			s.log.Warn("stream dest: update stream failed",
				"slug", wb.ID, "egress", id, "error", err)
		}
	}
}
