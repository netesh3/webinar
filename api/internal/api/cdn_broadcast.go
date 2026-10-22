package api

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/streamdest"
	"github.com/netkumar/webcast/api/types"
)

var (
	broadcastMu      sync.Mutex
	activeBroadcasts = make(map[string]string) // slug -> egressID or "starting"
	/* startOwner says which start attempt holds a "starting" mark, so a failed attempt clears
	 * only its own. Without it, one attempt timing out deleted the mark of another still in
	 * flight, the sweeper saw an empty slot and started more, and a worker pool with one free
	 * worker got a stream of starts that could only time out (2026-10-20). */
	startOwner   = make(map[string]uint64)
	startCounter uint64
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
	// A meeting has no audience to feed and no stream destinations: never a mix, and never an
	// egress worker booted for one (meeting.go).
	// Nor a simulive: no mix and no egress, ever (mixPlan, refuseSimuliveRecording).
	if sfu == nil || isMeeting(wb) || wb.Kind == types.KindSimulive {
		return
	}
	// On a project with an egress pool, the mix runs on a worker VM: make sure one is up.
	s.ensureEgressWorker(ctx, wb)
	origin, dests := s.mixPlan(ctx, wb)
	startURL, startDest, rest := firstOutput(origin, dests)
	if startURL == "" {
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
	startCounter++
	attempt := startCounter
	startOwner[wb.ID] = attempt
	broadcastMu.Unlock()

	/* 720p mix on purpose: this stream is copied once per attendee on the same
	 * NIC as the SFU. 1080p × a few hundred viewers does not fit a CX33. */
	preset := livekit.EncodingOptionsPreset_H264_720P_30

	/* Started on one output only — our origin, or the first platform when there is none —
	 * and the rest attached after it, so that one refused stream key cannot fail the whole
	 * mix. See mix_destinations.go. */
	noteMixStart(wb.ID, time.Now())
	var info *livekit.EgressInfo
	var err error
	if wb.Delivery == types.DeliveryEdge {
		// Edge webinars' mix encoding is configurable (EDGE_ENCODING_*); defaults match the preset.
		info, err = sfu.StartBroadcastEgressEncoded(ctx, lk.RoomName(wb.ID), s.mixTemplateURL(wb), s.edgeEncoding(), startURL, nil)
	} else {
		info, err = sfu.StartBroadcastEgress(ctx, lk.RoomName(wb.ID), s.mixTemplateURL(wb), preset, startURL, nil)
	}
	if err != nil {
		s.log.Warn("cdn broadcast: could not start egress", "slug", wb.ID, "error", redactErr(err, startURL))
		broadcastMu.Lock()
		if startOwner[wb.ID] == attempt {
			delete(activeBroadcasts, wb.ID)
			delete(startOwner, wb.ID)
		}
		broadcastMu.Unlock()
		return
	}

	broadcastMu.Lock()
	activeBroadcasts[wb.ID] = info.EgressId
	delete(startOwner, wb.ID)
	broadcastMu.Unlock()
	noteEgressStartDest(info.EgressId, startDest)

	s.log.Info("cdn broadcast started", "slug", wb.ID, "egress", info.EgressId)
	s.attachDestinations(ctx, wb.ID, sfu, info.EgressId, rest)
	// A recording taken from the mix this one replaces carries on in it.
	s.reattachMixRecording(ctx, wb, sfu, info.EgressId)
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
		case livekit.EgressStatus_EGRESS_STARTING:
			/* A start that never became active is a job whose worker died under it (a
			 * restarted container, a stopped VM). LiveKit keeps it STARTING for good and
			 * cannot stop it, so counting it as running would leave the room without a mix
			 * forever; past egressStartingDead it is ignored and a new mix is started. */
			if egressStartingTooLong(info, time.Now()) {
				s.log.Warn("cdn broadcast: egress stuck starting, treating it as gone",
					"slug", slug, "egress", info.GetEgressId())
				continue
			}
			ids = append(ids, info.GetEgressId())
		case livekit.EgressStatus_EGRESS_ACTIVE:
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

/* errRecordingNoRoom is a recording LiveKit would not start beside the attendee mix: the
 * video server has no room for a second compositor. The mix is left exactly as it was. */
var errRecordingNoRoom = errors.New("no room for a recording beside the attendee mix")

/* startEgressRecording begins a server-side recording. It never touches a running mix.
 *
 * It used to: with a mix running, the recording stopped it and started one egress carrying
 * both outputs (one compositor fits on the box, not two — see StartCombinedEgress), then put
 * the stream-only one back when recording stopped. Production, 2026-10-22
 * (instant-webinar-0375, DigitalOcean BLR): the edge mix ended the moment Record was pressed,
 * every edge viewer's LL-HLS went to "reconnecting" until the replacement's Chrome was up, and
 * the replacement loaded the plain template rather than <template>/edge, so the audience's
 * picture changed layout too. Stopping did it all again. LiveKit cannot add a file output to a
 * running egress (UpdateStream takes RTMP URLs only), so a recording cannot be folded into a
 * mix without restarting it.
 *
 * So with a mix running (or starting) the recording is its own compositor, on the same
 * template path and room metadata (audienceLayout) as the mix, so it records what the
 * audience sees. If LiveKit will not admit it — a box with one compositor's worth of CPU will
 * not — the host is told and the audience keeps watching: errRecordingNoRoom.
 *
 * Reports whether the returned egress also carries the mix: only when there was no mix to
 * protect and the room has somewhere to push (an edge origin, a saved platform), where one
 * compositor for both is what keeps the mix from being refused later. */
func (s *Server) startEgressRecording(
	ctx context.Context,
	wb types.Webinar,
	sfu RoomManager,
	recordingID string,
	storageKey string,
	s3Opts lk.EgressS3Options,
) (info *livekit.EgressInfo, carriesMix bool, err error) {
	running, listErr := s.broadcastEgressIDs(ctx, wb.ID, sfu)
	broadcastMu.Lock()
	starting := activeBroadcasts[wb.ID] == "starting"
	broadcastMu.Unlock()

	/* A mix is (or may be) feeding the audience. Not knowing — the egress list failed — counts
	 * as one: a recording that cannot start is a message to the host, an audience cut off is
	 * a room full of people on a spinner. */
	if listErr != nil || len(running) > 0 || starting {
		/* First choice with an edge mix running: record that mix, no second compositor
		 * (mixrec.go). Unavailable — not configured, the recorder down, the mix refusing the
		 * extra output — falls through to a compositor of the recording's own. */
		if listErr == nil && len(running) > 0 && s.mixRecorderFor(ctx, wb) != "" {
			info, err = s.startMixRecording(ctx, wb, sfu, recordingID, running)
			if err == nil {
				return info, false, nil
			}
			s.log.Warn("recording: could not record from the mix, starting its own compositor",
				"slug", wb.ID, "error", err)
		}
		// 720p, as the file was while folded into the mix: the lighter second compositor is
		// the one more likely to fit beside the first.
		info, err = sfu.StartRoomCompositeEgress(ctx, lk.RoomName(wb.ID), storageKey, s3Opts,
			s.recordingTemplateURL(wb), livekit.EncodingOptionsPreset_H264_720P_30)
		if err != nil {
			s.log.Warn("recording: refused beside the attendee mix; the mix is untouched",
				"slug", wb.ID, "mix", running, "error", err)
			return nil, false, fmt.Errorf("%w: %w", errRecordingNoRoom, err)
		}
		s.log.Info("recording started beside the attendee mix", "slug", wb.ID,
			"egress", info.GetEgressId(), "mix", running)
		return info, false, nil
	}

	origin, dests := s.mixPlan(ctx, wb)
	startURL, startDest, rest := firstOutput(origin, dests)
	if startURL != "" {
		/* No mix yet, but the room has somewhere to push — the host set up YouTube before
		 * pressing Record, or an edge mix that has not come up. One compositor for both, on
		 * the mix's own template, so the picture is the one the audience would get anyway. */
		info, err = sfu.StartCombinedEgress(ctx, lk.RoomName(wb.ID), s.mixTemplateURL(wb),
			livekit.EncodingOptionsPreset_H264_720P_30, startURL, storageKey, s3Opts, nil)
		if err != nil {
			return nil, false, err
		}
		broadcastMu.Lock()
		activeBroadcasts[wb.ID] = info.EgressId
		broadcastMu.Unlock()
		noteEgressStartDest(info.EgressId, startDest)
		s.attachDestinations(ctx, wb.ID, sfu, info.EgressId, rest)
		return info, true, nil
	}

	// Nothing to protect and nowhere to push: the recording gets the whole box and the
	// quality that goes with it.
	preset := livekit.EncodingOptionsPreset_H264_1080P_30
	if s.cfg.RecordingsEgressPreset == "720p" {
		preset = livekit.EncodingOptionsPreset_H264_720P_30
	}
	info, err = sfu.StartRoomCompositeEgress(ctx, lk.RoomName(wb.ID), storageKey, s3Opts,
		s.recordingTemplateURL(wb), preset)
	return info, false, err
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
		origin, dests := s.mixPlan(ctx, wb)
		if origin == "" && len(dests) == 0 {
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

		/* A mix that keeps dying straight after it starts is not restarted at this pace
		 * forever: each attempt is a Chromium boot on the SFU box. See mixBackoff. */
		if !mixRestartAllowed(slug, time.Now()) {
			continue
		}
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

// mixDestinations is mixPlan as plain URLs: the attendee origin (when there is
// one) and the host's own destinations not refused this session. Both empty
// means do not start a compositor at all.
func (s *Server) mixDestinations(ctx context.Context, wb types.Webinar) (origin string, extras []string) {
	origin, dests := s.mixPlan(ctx, wb)
	return origin, destURLs(dests)
}

/* platformIngestFor is the URL this webinar should push to one platform right
 * now: the host's saved destination, unless the host paused it in this room.
 * Empty on any error — a missing push is better than a failed encoder. */
func (s *Server) platformIngestFor(ctx context.Context, wb types.Webinar, platform string) string {
	if wb.Kind == types.KindSimulive {
		return ""
	}
	ingest, _, err := s.store.StreamDestination(ctx, wb.Host.ID, platform)
	if err != nil || ingest == "" {
		return ""
	}
	paused, err := s.store.WebinarStreamPaused(ctx, wb.ID, platform)
	if err != nil || paused {
		return ""
	}
	return streamdest.FixDoubledKey(ingest)
}

/* syncStreamDest adds or replaces the host's RTMP destination on a running mix.
 *
 * One compositor, extra URL — that is the whole point of not starting a second
 * Chromium for YouTube. If nothing is encoding yet and the webinar is live,
 * startBroadcastIfEnabled is what creates the job.
 *
 * platform names the destination for logs and for the host's "refused" notice.
 * A destination the host has just saved or resumed gets a fresh try even if its
 * URL was refused earlier in the session. */
func (s *Server) syncStreamDest(ctx context.Context, wb types.Webinar, sfu RoomManager, platform, oldURL, newURL string) {
	if sfu == nil || oldURL == newURL {
		return
	}
	if oldURL != "" {
		destFailures.forget(wb.ID, oldURL)
	}
	if newURL != "" {
		destFailures.forget(wb.ID, newURL)
	}
	if wb.Status != types.StatusLive {
		return
	}

	/* Every compositor on the room, not just the ones already streaming: when
	 * the host pressed Record first, the only one running is the recording, and
	 * that is the one that has to carry YouTube too. Starting a second is what
	 * LiveKit refuses. */
	/* The broadcast when there is one: a recording running beside it has an empty RTMP
	 * output too, and attaching the destination there as well would push it twice. */
	ids, err := s.broadcastEgressIDs(ctx, wb.ID, sfu)
	if err != nil || len(ids) == 0 {
		ids = s.mixEgressIDs(ctx, wb.ID, sfu)
	}
	if len(ids) == 0 {
		if newURL != "" {
			s.startBroadcastIfEnabled(ctx, wb, sfu)
		}
		return
	}

	for _, id := range ids {
		if oldURL != "" {
			if _, err := sfu.UpdateStream(ctx, id, nil, []string{oldURL}); err != nil {
				s.log.Warn("stream dest: could not detach the old destination",
					"slug", wb.ID, "egress", id, "platform", platform, "error", redactErr(err, oldURL))
			}
		}
		if newURL != "" {
			s.attachDestinations(ctx, wb.ID, sfu, id, []mixDest{{Platform: platform, URL: newURL}})
		}
	}
}

// egressStartingDead is how long an egress may sit in STARTING before it is presumed dead. A
// healthy one goes ACTIVE in a few seconds, or ~40s when its worker VM is booting.
const egressStartingDead = 90 * time.Second

func egressStartingTooLong(info *livekit.EgressInfo, now time.Time) bool {
	since := max(info.GetStartedAt(), info.GetUpdatedAt())
	if since == 0 {
		return false
	}
	return now.Sub(time.Unix(0, since)) > egressStartingDead
}
