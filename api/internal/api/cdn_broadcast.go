package api

import (
	"context"
	"fmt"
	"sync"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

var (
	broadcastMu      sync.Mutex
	activeBroadcasts = make(map[string]string) // slug -> egressID
)

func (s *Server) startHlsBroadcastIfEnabled(ctx context.Context, wb types.Webinar, sfu RoomManager) {
	if sfu == nil {
		return
	}
	canBroadcast, err := s.store.HostCanCdnBroadcast(ctx, wb.Host.ID)
	if err != nil || !canBroadcast {
		return
	}

	roomName := lk.RoomName(wb.ID)
	prefix := fmt.Sprintf("broadcast/%s/chunk-", wb.ID)
	playlistName := "index.m3u8"

	preset := livekit.EncodingOptionsPreset_H264_1080P_30
	if s.cfg.RecordingsEgressPreset == "720p" {
		preset = livekit.EncodingOptionsPreset_H264_720P_30
	}

	s3Opts := lk.EgressS3Options{
		Endpoint:  s.cfg.RecordingsS3Endpoint,
		Bucket:    s.cfg.RecordingsS3Bucket,
		Region:    s.cfg.RecordingsS3Region,
		AccessKey: s.cfg.RecordingsS3AccessKey,
		SecretKey: s.cfg.RecordingsS3SecretKey,
	}

	info, err := sfu.StartHlsBroadcastEgress(ctx, roomName, prefix, playlistName, s3Opts, s.cfg.RecordingsEgressTemplateURL, preset)
	if err != nil {
		s.log.Warn("cdn broadcast: could not start egress", "slug", wb.ID, "error", err)
		return
	}

	broadcastMu.Lock()
	activeBroadcasts[wb.ID] = info.EgressId
	broadcastMu.Unlock()

	s.log.Info("cdn broadcast started", "slug", wb.ID, "egress", info.EgressId)
}

func (s *Server) stopHlsBroadcastIfActive(ctx context.Context, slug string, sfu RoomManager) {
	broadcastMu.Lock()
	egressID, ok := activeBroadcasts[slug]
	if ok {
		delete(activeBroadcasts, slug)
	}
	broadcastMu.Unlock()

	if !ok || egressID == "" || sfu == nil {
		return
	}

	if _, err := sfu.StopEgress(ctx, egressID); err != nil {
		s.log.Warn("cdn broadcast: could not stop egress", "slug", slug, "egress", egressID, "error", err)
	} else {
		s.log.Info("cdn broadcast stopped", "slug", slug, "egress", egressID)
	}
}
