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

	broadcastMu.Lock()
	if _, running := activeBroadcasts[wb.ID]; running {
		broadcastMu.Unlock()
		return
	}
	broadcastMu.Unlock()

	roomName := lk.RoomName(wb.ID)
	prefix := fmt.Sprintf("broadcast/%s/chunk", wb.ID)
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

	// Schedule asynchronous cleanup of temporary HLS chunks from storage after a short buffer drain period
	go func() {
		time.Sleep(30 * time.Second)
		s.cleanupBroadcastStorage(context.Background(), slug)
	}()
}

// cleanupBroadcastStorage deletes all temporary HLS chunks (.ts and .m3u8) for a webinar from S3/disk storage.
func (s *Server) cleanupBroadcastStorage(ctx context.Context, slug string) {
	if s.recordings == nil || strings.TrimSpace(slug) == "" {
		return
	}
	prefix := fmt.Sprintf("broadcast/%s/", slug)
	if err := s.recordings.DeletePrefix(ctx, prefix); err != nil {
		s.log.Warn("cdn broadcast: could not clean temporary files", "slug", slug, "prefix", prefix, "error", err)
	} else {
		s.log.Info("cdn broadcast: temporary files deleted from storage", "slug", slug, "prefix", prefix)
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

	// Set CORS headers so web HLS player can load segments across origins
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	// Set appropriate Content-Type and Cache-Control
	if strings.HasSuffix(file, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	} else if strings.HasSuffix(file, ".ts") {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	// If CDN base URL is configured, redirect directly to CDN edge
	if s.cfg.RecordingsCDNBaseURL != "" {
		s3Key := fmt.Sprintf("broadcast/%s/%s", slug, file)
		cdnURL := fmt.Sprintf("%s/%s", strings.TrimRight(s.cfg.RecordingsCDNBaseURL, "/"), s3Key)
		http.Redirect(w, r, cdnURL, http.StatusTemporaryRedirect)
		return
	}

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Storage backend not available.")
		return
	}

	// Determine candidate keys for S3 lookup
	var candidateKeys []string
	primaryKey := fmt.Sprintf("broadcast/%s/%s", slug, file)
	candidateKeys = append(candidateKeys, primaryKey)

	if strings.HasSuffix(file, ".m3u8") {
		candidateKeys = append(candidateKeys,
			fmt.Sprintf("broadcast/%s/live.m3u8", slug),
			fmt.Sprintf("broadcast/%s/index.m3u8", slug),
			fmt.Sprintf("broadcast/%s/chunk-live.m3u8", slug),
			fmt.Sprintf("broadcast/%s/chunk-index.m3u8", slug),
			fmt.Sprintf("broadcast/%s/chunk_live.m3u8", slug),
			fmt.Sprintf("broadcast/%s/chunk_index.m3u8", slug),
			fmt.Sprintf("broadcast/%s/chunk.m3u8", slug),
		)
	} else if strings.HasSuffix(file, ".ts") {
		if strings.Contains(file, "-") {
			candidateKeys = append(candidateKeys, fmt.Sprintf("broadcast/%s/%s", slug, strings.ReplaceAll(file, "-", "_")))
		}
		if strings.Contains(file, "_") {
			candidateKeys = append(candidateKeys, fmt.Sprintf("broadcast/%s/%s", slug, strings.ReplaceAll(file, "_", "-")))
		}
	}

	// Open the object from storage (S3/Disk)
	var reader io.ReadSeekCloser
	var size int64
	var openErr error

	for _, k := range candidateKeys {
		reader, size, openErr = s.recordings.Open(r.Context(), k)
		if openErr == nil {
			break
		}
	}

	if openErr != nil {
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

