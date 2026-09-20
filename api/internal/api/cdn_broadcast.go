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
	if status, running := activeBroadcasts[wb.ID]; running && status != "" {
		broadcastMu.Unlock()
		return
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