package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
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

// handleBroadcastStreamFile serves HLS playlist and video segments (.m3u8 and .ts) for CDN broadcast.
func (s *Server) handleBroadcastStreamFile(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	file := chi.URLParam(r, "file")

	// Sanitise filename
	if strings.Contains(file, "/") || strings.Contains(file, "\\") || strings.Contains(file, "..") {
		httpx.Error(w, http.StatusBadRequest, "bad_filename", "Invalid stream file requested.")
		return
	}

	s3Key := fmt.Sprintf("broadcast/%s/%s", slug, file)

	// Set CORS headers so web HLS player can load segments across origins
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")

	// Set appropriate Content-Type and Cache-Control
	if strings.HasSuffix(file, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	} else if strings.HasSuffix(file, ".ts") {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	// If CDN base URL is configured, redirect directly to CDN
	if s.cfg.RecordingsCDNBaseURL != "" {
		cdnURL := fmt.Sprintf("%s/%s", strings.TrimRight(s.cfg.RecordingsCDNBaseURL, "/"), s3Key)
		http.Redirect(w, r, cdnURL, http.StatusTemporaryRedirect)
		return
	}

	// If storage backend is S3 with presigner capability, redirect to signed S3 URL
	if presigner, ok := s.recordings.(media.Presigner); ok {
		contentType := "video/mp2t"
		if strings.HasSuffix(file, ".m3u8") {
			contentType = "application/vnd.apple.mpegurl"
		}
		presignedURL, err := presigner.PresignedGetURL(r.Context(), s3Key, file, contentType, true, 10*time.Minute)
		if err == nil && presignedURL != "" {
			http.Redirect(w, r, presignedURL, http.StatusTemporaryRedirect)
			return
		}
	}

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Storage backend not available.")
		return
	}

	reader, size, err := s.recordings.Open(r.Context(), s3Key)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "Broadcast segment not ready or not found.")
		return
	}
	defer reader.Close()

	if seeker, ok := reader.(io.ReadSeeker); ok {
		http.ServeContent(w, r, file, time.Now(), seeker)
	} else {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
		_, _ = io.Copy(w, reader)
	}
}

