package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Recording.
 *
 * Who: the host and the panelists. Not the audience — recording is a publishing
 * act, and an attendee's token forbids publishing for the same reason.
 * Everything below is behind requireStage, which is that rule in one place.
 *
 * Where the bytes come from: the browser of whoever pressed record. It composites
 * the stage onto a canvas, mixes the audio, and uploads the encoder's output in
 * chunks as it is produced. That is a deliberate first implementation, not an
 * accident of scope:
 *
 *   - It records what a viewer actually saw, including the screen share, with no
 *     second rendering pipeline to keep in step with the room's layout.
 *   - It needs no new infrastructure. The server-side alternative is LiveKit
 *     Egress, which is a separate service plus Redis plus a headless renderer.
 *   - The seam is here, not in the browser: start / chunk / complete / list /
 *     download is the same API whichever side produces the bytes. Moving to
 *     Egress later replaces the chunk upload with a webhook and changes nothing
 *     a host or a panelist sees.
 *
 * Its honest limitation is that the recording stops if the recorder closes their
 * tab, and its quality depends on their machine. Zoom's local recording has
 * exactly the same property. The room shows who is recording, and an abandoned
 * recording is finalised rather than left half-open.
 */

// allowedMimes are the containers a browser may claim to be producing.
//
// An allowlist because the value ends up in a Content-Type header on the way back
// out, and reflecting an arbitrary client string into a response header is how
// content-type confusion bugs start. Codec parameters are checked separately.
var allowedMimes = map[string]bool{
	"video/webm": true,
	"video/mp4":  true,
	"audio/webm": true,
	"audio/mp4":  true,
}

// Codec parameters are limited to the shapes browsers actually emit, so nothing
// exotic reaches a response header.
var codecParams = regexp.MustCompile(`^[a-zA-Z0-9 ,.="';:*/+-]{0,120}$`)

// chunkLimit is the largest single upload accepted. The recorder sends a few
// seconds at a time, so anything approaching this is a bug or an attack.
const chunkLimit = 32 << 20 // 32 MiB

// downloadWindow is how long a single download may take. Generous because the
// alternative — inheriting an API-sized write deadline — truncates the file.
const downloadWindow = 4 * time.Hour

func (s *Server) handleStartRecording(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	user := userFromContext(r.Context())

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "recording_disabled",
			"Recording is turned off on this instance.")
		return
	}

	var body types.StartRecordingRequest
	_ = httpx.DecodeJSON(w, r, &body)

	mime := "video/mp4"
	if s.cfg.RecordingsMode == "client" {
		var ok bool
		mime, ok = normalizeMime(body.Mime)
		if !ok {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_mime",
				"That recording format isn't supported. Try a current version of Chrome, Edge or Safari.")
			return
		}
	} else if body.Mime != "" {
		if m, ok := normalizeMime(body.Mime); ok {
			mime = m
		}
	}

	// The same rule the join path uses: anything but ended or draft. Deliberately
	// not "must be live" — a host who walks into the room to rehearse has not
	// pressed Start yet, and refusing to record a practice run is the kind of
	// restriction that only makes sense to whoever wrote it.
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "start recording: load webinar", err)
		return
	}
	if wb.Status == types.StatusEnded || wb.Status == types.StatusDraft {
		httpx.Error(w, http.StatusConflict, "not_recordable",
			"This webinar isn't running, so there's nothing to record.")
		return
	}

	// The key is ours, derived from the recording's own id — never from the slug, a
	// topic or anything else a person typed. Two levels of fan-out so a directory
	// listing stays usable after a few thousand recordings.
	id := uuid.NewString()
	key := fmt.Sprintf("%s/%s/%s.%s", id[0:2], id[2:4], id, store.ExtForMime(mime))

	rec, err := s.store.StartRecording(r.Context(), slug, id, user.ID, user.Name, mime, key)
	switch {
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "already_recording",
			"This webinar is already being recorded.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	case err != nil:
		s.fail(w, r, "start recording", err)
		return
	}
	rec.Topic = wb.Topic
	rec.Ext = store.ExtForMime(mime)

	sfu, sfuErr := s.sfuFor(r.Context(), wb)

	if s.cfg.RecordingsMode == "egress" {
		if sfuErr != nil {
			_, _ = s.store.FinishRecording(r.Context(), id, 0)
			s.fail(w, r, "start egress: sfu lookup", sfuErr)
			return
		}
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
		roomName := lk.RoomName(slug)
		info, err := sfu.StartRoomCompositeEgress(r.Context(), roomName, key, s3Opts, s.cfg.RecordingsEgressTemplateURL, preset)
		if err != nil {
			_, _ = s.store.FinishRecording(r.Context(), id, 0)
			s.fail(w, r, "start egress", err)
			return
		}
		if err := s.store.SetEgressID(r.Context(), id, info.EgressId); err != nil {
			s.log.Warn("start egress: record egress id", "id", id, "egress", info.EgressId, "error", err)
		}
		rec.EgressID = info.EgressId
	}

	// Tell the room. Being recorded without being told is not acceptable, and the
	// indicator has to come from the server so it reaches every browser rather
	// than only the one that pressed the button.
	if sfuErr != nil {
		s.log.Warn("recording started but the indicator could not be broadcast",
			"slug", slug, "error", sfuErr)
	} else {
		s.pushRoomMetadata(r, sfu, wb)
	}

	s.log.Info("recording started", "slug", slug, "recording", rec.ID,
		"by", user.ID, "mime", mime, "mode", s.cfg.RecordingsMode)
	httpx.JSON(w, http.StatusCreated, rec)
}

// handleRecordingChunk appends the next few seconds of the recording.
//
// The body is raw bytes rather than multipart: this is a byte stream being
// appended to a file, and multipart would buy a filename we would have to ignore.
func (s *Server) handleRecordingChunk(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "recording_disabled",
			"Recording is turned off on this instance.")
		return
	}

	rec, err := s.store.RecordingFor(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
		return
	}
	if err != nil {
		s.fail(w, r, "recording chunk: lookup", err)
		return
	}
	if rec.Status != types.RecordingActive {
		// Late chunks from a recorder that was already stopped, or from a second
		// tab. Refused rather than appended: a finished file must stay finished.
		httpx.Error(w, http.StatusConflict, "not_recording",
			"That recording has already finished.")
		return
	}

	// Cap the total as well as the chunk. Without a ceiling a forgotten recording
	// fills the disk and takes the API down with it.
	maxBytes := int64(s.cfg.MaxRecordingMB) << 20
	if rec.SizeBytes >= maxBytes {
		if _, err := s.store.FinishRecording(r.Context(), id, 0); err != nil {
			s.log.Warn("recording chunk: could not close oversized recording",
				"recording", id, "error", err)
		}
		s.log.Warn("recording hit its size limit", "slug", slug, "recording", id,
			"limitMB", s.cfg.MaxRecordingMB)
		httpx.Error(w, http.StatusRequestEntityTooLarge, "recording_full",
			fmt.Sprintf("This recording reached the %d MB limit and was closed.", s.cfg.MaxRecordingMB))
		return
	}

	// Refuse an oversized chunk before reading it rather than after. LimitReader
	// below is the backstop for a client that lies about its length.
	if r.ContentLength > chunkLimit {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "chunk_too_large",
			"That upload is too large for one chunk.")
		return
	}

	size, err := s.recordings.Append(r.Context(), rec.StorageKey,
		io.LimitReader(r.Body, chunkLimit))
	if err != nil {
		s.fail(w, r, "recording chunk: write", err)
		return
	}
	if err := s.store.RecordedBytes(r.Context(), id, size); err != nil {
		// The bytes are on disk; only the bookkeeping failed. Reporting an error
		// would make the recorder retry and duplicate them.
		s.log.Warn("recording chunk: could not record size",
			"recording", id, "error", err)
	}

	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

func (s *Server) handleCompleteRecording(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	// The browser knows how long it recorded; the server only knows when the
	// requests arrived, which includes every upload delay.
	durationMs, _ := strconv.ParseInt(r.URL.Query().Get("durationMs"), 10, 64)
	if durationMs < 0 || durationMs > 24*int64(time.Hour/time.Millisecond) {
		durationMs = 0
	}

	// Looked up before FinishRecording, and kept regardless of which branch
	// below runs: Finalize needs the storage key whether this call is the one
	// that actually closes the row or arrives after something else already
	// did (the size cap, in handleRecordingChunk) — a still-staged S3 upload
	// does not care which of those closed it, only that it is closed now.
	rec, lookupErr := s.store.RecordingFor(r.Context(), slug, id)
	if lookupErr == nil && rec.EgressID != "" {
		if wb, err := s.store.WebinarBySlug(r.Context(), slug); err == nil {
			if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
				if _, err := sfu.StopEgress(r.Context(), rec.EgressID); err != nil {
					s.log.Warn("stop egress: request failed", "egress", rec.EgressID, "error", err)
				}
				s.pushRoomMetadata(r, sfu, wb)
			}
		}
		s.log.Info("egress recording stopping", "slug", slug, "recording", id, "egress", rec.EgressID)
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "stopping"})
		return
	}

	status, err := s.store.MarkRecordingProcessing(r.Context(), id, durationMs)
	if errors.Is(err, store.ErrNotFound) {
		// Already closed — by the size cap, by the webinar ending, or by a second
		// click. The requested end state, so not an error — but still the moment
		// to finalize storage if nothing has yet: the size-cap path in
		// handleRecordingChunk closes the row without doing that itself.
		go s.finalizeRecording(r, slug, id, lookupErr, rec)
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "closed"})
		return
	}
	if err != nil {
		s.fail(w, r, "complete recording", err)
		return
	}
	go s.finalizeRecording(r, slug, id, lookupErr, rec)

	if wb, err := s.store.WebinarBySlug(r.Context(), slug); err == nil {
		// Clears the room's recording indicator. Best-effort: the row is closed either way.
		if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
			s.pushRoomMetadata(r, sfu, wb)
		} else {
			s.log.Warn("recording finished but the indicator could not be cleared",
				"slug", slug, "error", err)
		}
	}

	s.log.Info("recording finished, finalizing upload", "slug", slug, "recording", id,
		"status", status, "durationMs", durationMs)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: string(status)})
}

// finalizeRecording pushes a completed recording to its backend's permanent
// storage — a no-op for Disk, and for S3 the one point where the staged file
// is actually uploaded to the bucket; see Store.Finalize's own comment.
func (s *Server) finalizeRecording(
	_ *http.Request, slug, id string, lookupErr error, rec store.RecordingFile,
) {
	if s.recordings == nil || lookupErr != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Hour)
	defer cancel()

	err := s.recordings.FinalizeWithProgress(ctx, rec.StorageKey, func(percent int) {
		_ = s.store.UpdateUploadProgress(context.Background(), id, percent)
	})
	if err != nil {
		s.log.Warn("complete recording: finalize storage failed",
			"slug", slug, "recording", id, "error", err)
		_ = s.store.MarkRecordingFailed(context.Background(), id)
		return
	}
	if err := s.store.MarkRecordingUploaded(context.Background(), id); err != nil {
		s.log.Warn("complete recording: mark uploaded failed",
			"slug", slug, "recording", id, "error", err)
	} else {
		s.log.Info("complete recording: finalized and uploaded to s3",
			"slug", slug, "recording", id)
	}
}

func (s *Server) handleListRecordings(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.Recordings(r.Context(), slugFromContext(r.Context()))
	if err != nil {
		s.fail(w, r, "list recordings", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}

// handleDownloadRecording streams the file or redirects to Cloudflare CDN.
//
// http.ServeContent rather than io.Copy, for one reason that matters to anyone
// watching: range requests. Without them a browser cannot seek, so a 40-minute
// recording can only be played from the beginning.
func (s *Server) handleDownloadRecording(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "recording_disabled",
			"Recording is turned off on this instance.")
		return
	}

	rec, err := s.store.RecordingFor(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
		return
	}
	if err != nil {
		s.fail(w, r, "download recording: lookup", err)
		return
	}

	if rec.Status != types.RecordingReady || (s.cfg.RecordingsBackend == "s3" && !rec.UploadedToS3) {
		if rec.Status == types.RecordingProcessing || (rec.Status == types.RecordingReady && !rec.UploadedToS3) {
			httpx.Error(w, http.StatusConflict, "uploading_to_storage",
				"This recording is currently uploading to cloud storage and is not ready yet. Please try again in a moment.")
			return
		}
		if rec.Status == types.RecordingActive {
			httpx.Error(w, http.StatusConflict, "recording_in_progress",
				"This recording is still in progress.")
			return
		}
		httpx.Error(w, http.StatusNotFound, "not_ready", "This recording is not ready.")
		return
	}

	// When Cloudflare CDN is configured and the recording is finalized, redirect
	// directly to the CDN edge. Free egress via Bandwidth Alliance and instant caching.
	if s.cfg.RecordingsCDNBaseURL != "" {
		cdnURL := fmt.Sprintf("%s/%s", strings.TrimRight(s.cfg.RecordingsCDNBaseURL, "/"), strings.TrimPrefix(rec.StorageKey, "/"))
		http.Redirect(w, r, cdnURL, http.StatusTemporaryRedirect)
		return
	}

	// For S3/Backblaze storage, redirect directly to signed S3 URL for fast streaming and seeking
	if ps, ok := s.recordings.(media.Presigner); ok {
		if signedURL, err := ps.PresignedURL(r.Context(), rec.StorageKey, 6*time.Hour); err == nil && signedURL != "" {
			http.Redirect(w, r, signedURL, http.StatusTemporaryRedirect)
			return
		}
	}

	file, size, err := s.recordings.Open(r.Context(), rec.StorageKey)
	if errors.Is(err, media.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "no_file",
			"The file for that recording is missing.")
		return
	}
	if err != nil {
		s.fail(w, r, "download recording: open", err)
		return
	}
	defer file.Close()

	// The server's global WriteTimeout is sized for JSON. A recording is not JSON,
	// and a deadline that kills the connection mid-file presents as a corrupt
	// download rather than as an error, so it is extended for this response only.
	if rc := http.NewResponseController(w); rc != nil {
		if err := rc.SetWriteDeadline(time.Now().Add(downloadWindow)); err != nil {
			s.log.Debug("download recording: could not extend the write deadline",
				"error", err)
		}
	}

	// A recording still in progress is served as far as it has been written. A
	// host who wants to check that it is working should not have to stop it first.
	name := downloadName(rec.Topic, rec.CreatedAt, store.ExtForMime(rec.Mime))
	w.Header().Set("Content-Type", rec.Mime)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=%q", name))
	// Recordings are private to a stage, so no shared cache may keep a copy.
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	http.ServeContent(w, r, name, rec.CreatedAt, file)
}

// handleLiveKitWebhook receives events from LiveKit, including EGRESS_ENDED.
func (s *Server) handleLiveKitWebhook(w http.ResponseWriter, r *http.Request) {
	event, err := webhook.ReceiveWebhookEvent(r, s.sfu.KeyProvider())
	if err != nil {
		s.log.Warn("livekit webhook: auth failed", "error", err)
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Invalid webhook signature.")
		return
	}

	switch event.Event {
	case webhook.EventEgressEnded:
		info := event.EgressInfo
		if info == nil {
			break
		}
		s.log.Info("livekit webhook: egress ended",
			"egress", info.EgressId,
			"status", info.Status.String(),
			"room", info.RoomName,
			"error", info.GetError(),
			"details", info.GetDetails())

		rec, err := s.store.RecordingByEgressID(r.Context(), info.EgressId)
		if err != nil {
			s.log.Warn("livekit webhook: no recording found for egress", "egress", info.EgressId, "error", err)
			break
		}

		var sizeBytes int64
		var durationMs int64
		files := info.GetFileResults()
		if len(files) == 0 && info.GetFile() != nil {
			files = []*livekit.FileInfo{info.GetFile()}
		}
		for _, file := range files {
			if file.Size > sizeBytes {
				sizeBytes = file.Size
			}
			if file.Duration > 0 {
				durationMs = file.Duration / int64(time.Millisecond)
			}
		}

		if info.Status == livekit.EgressStatus_EGRESS_COMPLETE || (sizeBytes > 0 && info.Status != livekit.EgressStatus_EGRESS_FAILED) {
			if _, err := s.store.FinishRecordingWithStats(r.Context(), rec.ID, sizeBytes, durationMs); err != nil {
				s.log.Error("livekit webhook: finish recording failed", "id", rec.ID, "error", err)
			} else {
				s.log.Info("livekit webhook: recording marked ready", "id", rec.ID, "sizeBytes", sizeBytes, "durationMs", durationMs)
			}
		} else {
			s.log.Warn("livekit webhook: recording failed or aborted without output",
				"id", rec.ID, "status", info.Status.String(), "error", info.GetError(), "details", info.GetDetails())
			if _, err := s.store.FinishRecording(r.Context(), rec.ID, 0); err != nil {
				s.log.Error("livekit webhook: mark failed error", "id", rec.ID, "error", err)
			}
		}

		if wb, err := s.store.WebinarBySlug(r.Context(), rec.Webinar); err == nil {
			if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
				s.pushRoomMetadata(r, sfu, wb)
			}
		}
	}

	w.WriteHeader(http.StatusOK)
}

// handleUpdateRecordingShare updates the sharing settings (isPublic, passcode) for a recording.
func (s *Server) handleUpdateRecordingShare(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	if stageRoleFromContext(r.Context()) != types.RoleHost {
		httpx.Error(w, http.StatusForbidden, "host_only",
			"Only the host can update recording share settings.")
		return
	}

	var body types.ShareRecordingRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return
	}

	rec, err := s.store.UpdateRecordingShareSettings(r.Context(), slug, id, body.IsPublic, body.Passcode)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
		return
	}
	if err != nil {
		s.fail(w, r, "update recording share settings", err)
		return
	}

	s.log.Info("recording share settings updated", "slug", slug, "recording", id, "isPublic", rec.IsPublic, "hasPasscode", rec.Passcode != "")
	httpx.JSON(w, http.StatusOK, rec)
}

// handlePublicRecording returns public metadata about a recording.
func (s *Server) handlePublicRecording(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id := chi.URLParam(r, "id")

	rec, err := s.store.RecordingFor(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) || !rec.IsPublic || rec.Status == types.RecordingFailed {
		httpx.Error(w, http.StatusNotFound, "not_found", "This recording is not publicly available.")
		return
	}
	if err != nil {
		s.fail(w, r, "public recording lookup", err)
		return
	}

	effectivePasscode := strings.TrimSpace(rec.Passcode)
	if effectivePasscode == "" {
		effectivePasscode = strings.TrimSpace(rec.WebinarPasscode)
	}

	providedPasscode := strings.TrimSpace(r.URL.Query().Get("passcode"))
	if providedPasscode == "" {
		providedPasscode = strings.TrimSpace(r.Header.Get("X-Passcode"))
	}

	unlocked := true
	if effectivePasscode != "" {
		unlocked = (providedPasscode == effectivePasscode)
	}

	res := types.PublicRecording{
		ID:               rec.ID,
		Webinar:          rec.Webinar,
		Topic:            rec.Topic,
		Status:           rec.Status,
		HostName:         rec.HostName,
		DurationMs:       rec.DurationMs,
		SizeBytes:        rec.SizeBytes,
		CreatedAt:        rec.CreatedAt.Format(time.RFC3339),
		Ext:              store.ExtForMime(rec.Mime),
		PasscodeRequired: effectivePasscode != "",
		Unlocked:         unlocked,
		UploadedToS3:     rec.UploadedToS3,
		UploadPercent:    rec.UploadPercent,
	}

	httpx.JSON(w, http.StatusOK, res)
}

// handlePublicStreamRecording streams the recording video to public viewers after passcode check.
func (s *Server) handlePublicStreamRecording(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id := chi.URLParam(r, "id")

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "recording_disabled",
			"Recording is turned off on this instance.")
		return
	}

	rec, err := s.store.RecordingFor(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) || !rec.IsPublic || rec.Status != types.RecordingReady || (s.cfg.RecordingsBackend == "s3" && !rec.UploadedToS3) {
		if rec.Status == types.RecordingProcessing || (rec.Status == types.RecordingReady && !rec.UploadedToS3) {
			httpx.Error(w, http.StatusConflict, "uploading_to_storage",
				"This recording is currently uploading to cloud storage and is not ready yet. Please try again in a moment.")
			return
		}
		httpx.Error(w, http.StatusNotFound, "not_found", "This recording is not publicly available.")
		return
	}
	if err != nil {
		s.fail(w, r, "public stream recording: lookup", err)
		return
	}

	effectivePasscode := strings.TrimSpace(rec.Passcode)
	if effectivePasscode == "" {
		effectivePasscode = strings.TrimSpace(rec.WebinarPasscode)
	}

	if effectivePasscode != "" {
		providedPasscode := strings.TrimSpace(r.URL.Query().Get("passcode"))
		if providedPasscode == "" {
			providedPasscode = strings.TrimSpace(r.Header.Get("X-Passcode"))
		}
		if providedPasscode != effectivePasscode {
			httpx.Error(w, http.StatusUnauthorized, "passcode_required", "Passcode is incorrect or required.")
			return
		}
	}

	// When Cloudflare CDN is configured, redirect directly to the CDN edge.
	if s.cfg.RecordingsCDNBaseURL != "" {
		cdnURL := fmt.Sprintf("%s/%s", strings.TrimRight(s.cfg.RecordingsCDNBaseURL, "/"), strings.TrimPrefix(rec.StorageKey, "/"))
		http.Redirect(w, r, cdnURL, http.StatusTemporaryRedirect)
		return
	}

	// For S3/Backblaze storage, redirect directly to signed S3 URL for fast streaming and seeking
	if ps, ok := s.recordings.(media.Presigner); ok {
		if signedURL, err := ps.PresignedURL(r.Context(), rec.StorageKey, 6*time.Hour); err == nil && signedURL != "" {
			http.Redirect(w, r, signedURL, http.StatusTemporaryRedirect)
			return
		}
	}

	file, size, err := s.recordings.Open(r.Context(), rec.StorageKey)
	if errors.Is(err, media.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "no_file",
			"The file for that recording is missing.")
		return
	}
	if err != nil {
		s.fail(w, r, "public stream recording: open", err)
		return
	}
	defer file.Close()

	if rc := http.NewResponseController(w); rc != nil {
		if err := rc.SetWriteDeadline(time.Now().Add(downloadWindow)); err != nil {
			s.log.Debug("public stream recording: could not extend the write deadline",
				"error", err)
		}
	}

	name := downloadName(rec.Topic, rec.CreatedAt, store.ExtForMime(rec.Mime))
	w.Header().Set("Content-Type", rec.Mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", name))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	http.ServeContent(w, r, name, rec.CreatedAt, file)
}

// handleDeleteRecording is host-only, unlike the rest of this file: a panelist may
// record their own section and take the file, but throwing away the record of a
// session belongs to whoever owns the session.
func (s *Server) handleDeleteRecording(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")

	if stageRoleFromContext(r.Context()) != types.RoleHost {
		httpx.Error(w, http.StatusForbidden, "host_only",
			"Only the host can delete a recording.")
		return
	}

	key, err := s.store.DeleteRecording(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
		return
	}
	if err != nil {
		s.fail(w, r, "delete recording", err)
		return
	}
	if s.recordings != nil {
		if err := s.recordings.Delete(r.Context(), key); err != nil {
			// The row is gone, so nothing points at these bytes any more. Worth a
			// log line for whoever watches the disk, not worth an error response.
			s.log.Warn("delete recording: file left behind",
				"recording", id, "key", key, "error", err)
		}
	}

	s.log.Info("recording deleted", "slug", slug, "recording", id)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

// ------------------------------------------------------------------- helpers

// normalizeMime validates a browser-supplied container string and returns it in
// the form that will be stored and echoed back.
func normalizeMime(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 160 {
		return "", false
	}
	base, params, hasParams := strings.Cut(raw, ";")
	base = strings.ToLower(strings.TrimSpace(base))
	if !allowedMimes[base] {
		return "", false
	}
	if !hasParams {
		return base, true
	}
	params = strings.TrimSpace(params)
	if !codecParams.MatchString(params) {
		// Keep the container, drop parameters we cannot vouch for. A file served
		// as video/webm still plays; a header with an unvalidated string in it is
		// a different kind of problem.
		return base, true
	}
	return base + ";" + params, true
}

// safeName strips everything that would be awkward in a filename across
// operating systems, then trims to something a download dialog can show.
var unsafeName = regexp.MustCompile(`[^a-zA-Z0-9 _.-]+`)

func downloadName(topic string, at time.Time, ext string) string {
	base := strings.TrimSpace(unsafeName.ReplaceAllString(topic, " "))
	base = strings.Join(strings.Fields(base), " ")
	if base == "" {
		base = "webinar"
	}
	if len(base) > 60 {
		base = strings.TrimSpace(base[:60])
	}
	return fmt.Sprintf("%s %s.%s", base, at.UTC().Format("2006-01-02 1504"), ext)
}
