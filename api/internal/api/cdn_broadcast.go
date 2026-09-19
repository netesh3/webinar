package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
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
	activeBroadcasts = make(map[string]string) // slug -> egressID or "starting"
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
	if status, running := activeBroadcasts[wb.ID]; running && status != "" {
		broadcastMu.Unlock()
		return
	}
	// Mark as starting to prevent concurrent duplicate invocations
	activeBroadcasts[wb.ID] = "starting"
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

	info, err := sfu.StartHlsBroadcastEgress(ctx, roomName, prefix, playlistName, s3Opts, s.cfg.RecordingsEgressTemplateURL, preset, s.cfg.BroadcastRTMPURL(wb.ID))
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

func (s *Server) stopHlsBroadcastIfActive(ctx context.Context, slug string, sfu RoomManager) {
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
		candidateKeys = append(candidateKeys,
			fmt.Sprintf("broadcast/%s/chunk/%s", slug, file),
			fmt.Sprintf("broadcast/%s/chunk_%s", slug, file),
			fmt.Sprintf("broadcast/%s/chunk-%s", slug, file),
		)
		if strings.Contains(file, "-") {
			candidateKeys = append(candidateKeys,
				fmt.Sprintf("broadcast/%s/%s", slug, strings.ReplaceAll(file, "-", "_")),
				fmt.Sprintf("broadcast/%s/chunk_%s", slug, strings.ReplaceAll(file, "-", "_")),
			)
		}
		if strings.Contains(file, "_") {
			candidateKeys = append(candidateKeys,
				fmt.Sprintf("broadcast/%s/%s", slug, strings.ReplaceAll(file, "_", "-")),
				fmt.Sprintf("broadcast/%s/chunk-%s", slug, strings.ReplaceAll(file, "_", "-")),
			)
		}
	}

	// Open the object from storage (S3/Disk)
	var reader io.ReadSeekCloser
	var size int64
	var openErr error
	var matchedKey string
	var refusal error

	for _, k := range candidateKeys {
		reader, size, openErr = s.recordings.Open(r.Context(), k)
		if openErr == nil {
			matchedKey = k
			break
		}
		if refusal == nil && !errors.Is(openErr, media.ErrNotFound) {
			refusal = openErr
		}
	}

	if openErr != nil {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
		/* A backend that refused us is not a segment the encoder has not written yet,
		 * and reporting both as 404 is why an exhausted bucket presents as a feed that
		 * is merely slow to start. Backblaze answers an exceeded daily cap with 403
		 * download_cap_exceeded or transaction_cap_exceeded — the counters reset at
		 * 00:00 GMT — and the player will retry against that for ever unless somebody
		 * reads this line. */
		if refusal != nil {
			s.log.Error("cdn broadcast: storage refused a segment",
				"slug", slug, "file", file, "error", refusal)
			httpx.Error(w, http.StatusBadGateway, "storage_error",
				"The broadcast storage backend rejected this request.")
			return
		}
		httpx.Error(w, http.StatusNotFound, "not_found", "Broadcast segment not ready or not found.")
		return
	}
	defer reader.Close()

	if strings.HasSuffix(file, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
		w.Header().Set("CDN-Cache-Control", "no-store")
		w.Header().Set("Cloudflare-CDN-Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")

		content, err := io.ReadAll(reader)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "read_error", "Failed to read playlist.")
			return
		}

		/* Where the audience fetches segments from.
		 *
		 * With a CDN configured, absolute edge URLs rather than filenames routed back
		 * through here. An audience is the multiplier that matters: proxying means one
		 * bucket read per viewer per two-second segment, all of it billed egress and a
		 * Class B transaction each, which is what exhausts a daily cap in one session.
		 * Segments are immutable, so the edge serves them from cache and the bucket is
		 * read once no matter how many people are watching.
		 *
		 * The prefix comes from the key the playlist itself was found under, so it is
		 * whatever Egress actually wrote rather than a second guess at its naming.
		 */
		segmentBase := ""
		if cdn := strings.TrimRight(s.cfg.RecordingsCDNBaseURL, "/"); cdn != "" && matchedKey != "" {
			segmentBase = cdn + "/" + path.Dir(matchedKey) + "/"
		}

		// Normalize playlist segment URLs to simple filenames
		lines := strings.Split(string(content), "\n")
		var rewritten []string
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				rewritten = append(rewritten, line)
				continue
			}
			parts := strings.Split(trimmed, "/")
			fileName := parts[len(parts)-1]
			if q := strings.IndexAny(fileName, "?#"); q >= 0 {
				fileName = fileName[:q]
			}
			rewritten = append(rewritten, segmentBase+fileName)
		}

		rewrittenContent := strings.Join(rewritten, "\n")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(rewrittenContent)))
		_, _ = w.Write([]byte(rewrittenContent))
		return
	}

	// For .ts video segments: stream through this API. Do not 307 to a B2
	// presigned URL — that was already tried and broken (CORS on the bucket,
	// and B2 does not honour response-content-type on signed GETs, which
	// produces 403s in hls.js).
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

	if seeker, ok := reader.(io.ReadSeeker); ok {
		http.ServeContent(w, r, file, time.Now(), seeker)
	} else {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
		_, _ = io.Copy(w, reader)
	}
}

