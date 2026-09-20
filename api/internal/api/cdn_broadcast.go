package api

import (
	"context"
	"sync"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

var (
	broadcastMu      sync.Mutex
	activeBroadcasts = make(map[string]string) // slug -> egressID or "starting"
)

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
	rtmpURL := s.cfg.BroadcastRTMPURL(wb.ID)
	if rtmpURL == "" {
		return
	}
	canBroadcast, err := s.store.HostCanCdnBroadcast(ctx, wb.Host.ID)
	if err != nil || !canBroadcast {
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

	info, err := sfu.StartBroadcastEgress(ctx, lk.RoomName(wb.ID), s.cfg.RecordingsEgressTemplateURL, preset, rtmpURL)
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
	infos, err := sfu.ListEgress(ctx, lk.RoomName(slug))
	if err != nil {
		s.log.Warn("cdn broadcast: could not list egress", "slug", slug, "error", err)
		return true
	}
	for _, info := range infos {
		if len(info.GetStreamResults()) == 0 {
			continue
		}
		switch info.GetStatus() {
		case livekit.EgressStatus_EGRESS_STARTING, livekit.EgressStatus_EGRESS_ACTIVE:
			return true
		}
	}
	return false
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
	if s.cfg.BroadcastRTMPURL("probe") == "" {
		return
	}

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
		can, err := s.store.HostCanCdnBroadcast(ctx, wb.Host.ID)
		if err != nil || !can {
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