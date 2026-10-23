package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/mp4probe"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Uploaded videos: a host's own file, to play as a Simulive (migrations/0153).
 *
 * The browser sends the bytes straight to the bucket — gigabytes never pass through Cloud
 * Run — as an S3 multipart upload, one presigned PUT per part:
 *
 *   POST   /api/host/videos/uploads               start: size checked against the quota
 *   GET    /api/host/videos/uploads/{id}          what the bucket has (resume after a reload)
 *   POST   /api/host/videos/uploads/{id}/parts    presigned URLs for some parts
 *   POST   /api/host/videos/uploads/{id}/complete stitch, check the size, probe, list it
 *   DELETE /api/host/videos/uploads/{id}          cancel
 *
 * On complete the file is probed (mp4probe: the moov box, by ranged reads) and refused unless
 * it is an MP4/MOV with H.264 video and AAC or no audio, the one combination every browser
 * plays. It then becomes a ready recording of the host's with no webinar (source 'upload'),
 * which the Simulive picker lists, the storage meter counts, and retention treats like any
 * other: the host's retention days from now, "Keep longer" for 3 more months, repeatable.
 *
 *   GET    /api/host/videos/{id}/file             play it (the host's own preview)
 *   PATCH  /api/host/videos/{id}                  rename
 *   DELETE /api/host/videos/{id}
 *   POST   /api/host/videos/{id}/keep | let-expire
 *
 * The bucket must let the web origin PUT (a CORS rule on the R2 bucket; parts are read back
 * with ListParts, so the browser never needs to see an ETag). An upload left unfinished is
 * aborted after videoUploadAbandonAfter, which frees the quota it was holding.
 */

const (
	videoUploadPartURLTTL   = time.Hour
	videoUploadMaxPartURLs  = 100
	videoUploadMaxParts     = 10000
	videoUploadAbandonAfter = 24 * time.Hour
	// The longest simulive (maxDurationMin in host.go).
	videoUploadMaxDuration = 24 * time.Hour
)

const unsupportedVideoHint = "Export it as an MP4 with H.264 video and AAC audio (often called \"H.264 MP4\" or \"MP4 for web\") and upload that."

// multipart is the recordings store's browser-upload capability, or nil without one.
func (s *Server) multipart() media.MultipartUploader {
	if s.recordings == nil {
		return nil
	}
	m, _ := s.recordings.(media.MultipartUploader)
	return m
}

func (s *Server) videoUploadEnabled() bool { return s.multipart() != nil }

// videoPartSize cuts size into at most videoUploadMaxParts parts, whole MiB, at least the minimum.
func videoPartSize(size int64) int64 {
	part := types.VideoUploadMinPartBytes
	if need := (size + videoUploadMaxParts - 1) / videoUploadMaxParts; need > part {
		const mib = 1 << 20
		part = (need + mib - 1) / mib * mib
	}
	return part
}

// videoTitle is the title an upload starts with: the one given, else the file's name.
func videoTitle(title, filename string) string {
	t := strings.TrimSpace(title)
	if t == "" {
		t = strings.TrimSpace(strings.TrimSuffix(filename, path.Ext(filename)))
	}
	if t == "" {
		t = "Uploaded video"
	}
	if r := []rune(t); len(r) > types.VideoUploadMaxTitle {
		t = string(r[:types.VideoUploadMaxTitle])
	}
	return t
}

// videoExtOK is the file names offered: what the probe can read. The probe decides.
func videoExtOK(filename string) bool {
	switch strings.ToLower(path.Ext(filename)) {
	case ".mp4", ".m4v", ".mov":
		return true
	}
	return false
}

func (s *Server) videoUploadOff(w http.ResponseWriter) bool {
	if s.videoUploadEnabled() {
		return false
	}
	httpx.Error(w, http.StatusServiceUnavailable, "upload_disabled",
		"Uploading videos needs cloud storage, which isn't set up on this server.")
	return true
}

func (s *Server) handleStartVideoUpload(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if s.videoUploadOff(w) {
		return
	}
	if !s.requireHostFeature(w, r, user.ID, types.FeatureSimulive) {
		return
	}
	var body types.StartVideoUploadRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	body.Filename = strings.TrimSpace(path.Base(strings.ReplaceAll(body.Filename, "\\", "/")))
	switch {
	case !videoExtOK(body.Filename):
		httpx.Error(w, http.StatusUnprocessableEntity, "unsupported_video",
			"Upload an MP4 or MOV file. "+unsupportedVideoHint)
		return
	case body.SizeBytes <= 0:
		httpx.Error(w, http.StatusUnprocessableEntity, "empty_file", "That file is empty.")
		return
	case body.SizeBytes > types.MaxVideoUploadBytes:
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large",
			fmt.Sprintf("Videos can be up to %s. Export a smaller file (a lower bitrate or resolution) and try again.",
				gbText(types.MaxVideoUploadBytes)))
		return
	}

	id := uuid.NewString()
	key := fmt.Sprintf("uploads/%s/%s.mp4", user.ID, id)
	uploadID, err := s.multipart().CreateMultipart(r.Context(), key, "video/mp4")
	if err != nil {
		s.fail(w, r, "video upload: create", err)
		return
	}
	up, err := s.store.CreateVideoUpload(r.Context(), store.VideoUpload{
		ID: id, OwnerID: user.ID, StorageKey: key, UploadID: uploadID, Filename: body.Filename,
		Title: videoTitle(body.Title, body.Filename), Mime: "video/mp4",
		SizeBytes: body.SizeBytes, PartSize: videoPartSize(body.SizeBytes),
	})
	if err != nil {
		_ = s.multipart().AbortMultipart(context.WithoutCancel(r.Context()), key, uploadID)
		if errors.Is(err, store.ErrStorageFull) {
			s.refuseVideoForStorage(w, r, user.ID, body.SizeBytes)
			return
		}
		s.fail(w, r, "video upload: record", err)
		return
	}
	s.log.Info("video upload started", "host", user.ID, "upload", id, "bytes", body.SizeBytes)
	httpx.JSON(w, http.StatusCreated, videoUploadView(up, nil))
}

func (s *Server) refuseVideoForStorage(w http.ResponseWriter, r *http.Request, hostID string, size int64) {
	st, err := s.store.RecordingStorageFor(r.Context(), hostID, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "video upload: storage", err)
		return
	}
	free := max(st.QuotaBytes-st.UsedBytes, 0)
	httpx.JSON(w, http.StatusConflict, types.RecordingQuotaError{
		Error: "quota_exceeded",
		Message: fmt.Sprintf("This video is %s, and your recording storage has %s free of %s (uploads still in progress count too). "+
			"Delete recordings or videos you no longer need, or upgrade your plan for more space.",
			sizeText(size), sizeText(free), gbText(st.QuotaBytes)),
		UsedBytes: st.UsedBytes, QuotaBytes: st.QuotaBytes,
	})
}

// sizeText is a byte count for a message: MB under a gigabyte, else GB.
func sizeText(n int64) string {
	if n < 1<<30 {
		return strconv.FormatInt((n+(1<<20)-1)>>20, 10) + " MB"
	}
	return gbText(n)
}

func videoUploadView(u store.VideoUpload, parts []media.UploadedPart) types.VideoUpload {
	done := make([]int, 0, len(parts))
	for _, p := range parts {
		done = append(done, int(p.Number))
	}
	sort.Ints(done)
	return types.VideoUpload{
		ID: u.ID, Filename: u.Filename, Title: u.Title, SizeBytes: u.SizeBytes, PartSize: u.PartSize,
		PartCount: u.PartCount(), UploadedParts: done, CreatedAt: u.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// videoUploadHere loads the caller's upload in the URL, writing the refusal otherwise.
func (s *Server) videoUploadHere(w http.ResponseWriter, r *http.Request) (store.VideoUpload, bool) {
	if s.videoUploadOff(w) {
		return store.VideoUpload{}, false
	}
	user := userFromContext(r.Context())
	up, err := s.store.VideoUploadFor(r.Context(), user.ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) || isBadUUID(err) {
		httpx.Error(w, http.StatusNotFound, "not_found",
			"That upload isn't in progress any more. It may have finished, been cancelled, or expired — start it again.")
		return store.VideoUpload{}, false
	}
	if err != nil {
		s.fail(w, r, "video upload: load", err)
		return store.VideoUpload{}, false
	}
	return up, true
}

// isBadUUID is Postgres refusing an id that is not a uuid: the same as no such row here.
func isBadUUID(err error) bool {
	return err != nil && strings.Contains(err.Error(), "invalid input syntax for type uuid")
}

func (s *Server) handleVideoUploadStatus(w http.ResponseWriter, r *http.Request) {
	up, ok := s.videoUploadHere(w, r)
	if !ok {
		return
	}
	parts, err := s.multipart().ListUploadedParts(r.Context(), up.StorageKey, up.UploadID)
	if errors.Is(err, media.ErrNotFound) {
		// The bucket no longer has it (aborted by a lifecycle rule): forget it here too.
		_ = s.store.DeleteVideoUpload(r.Context(), up.ID)
		httpx.Error(w, http.StatusNotFound, "not_found", "That upload expired. Start it again.")
		return
	}
	if err != nil {
		s.fail(w, r, "video upload: list parts", err)
		return
	}
	httpx.JSON(w, http.StatusOK, videoUploadView(up, completeParts(up, parts)))
}

// completeParts keeps the parts that are the size they should be: a part cut short is sent again.
func completeParts(up store.VideoUpload, parts []media.UploadedPart) []media.UploadedPart {
	n := up.PartCount()
	out := make([]media.UploadedPart, 0, len(parts))
	for _, p := range parts {
		if int(p.Number) >= 1 && int(p.Number) <= n && p.Size == expectedPartSize(up, int(p.Number)) {
			out = append(out, p)
		}
	}
	return out
}

func expectedPartSize(up store.VideoUpload, part int) int64 {
	if part < up.PartCount() {
		return up.PartSize
	}
	return up.SizeBytes - int64(up.PartCount()-1)*up.PartSize
}

func (s *Server) handleVideoUploadParts(w http.ResponseWriter, r *http.Request) {
	up, ok := s.videoUploadHere(w, r)
	if !ok {
		return
	}
	var body types.VideoUploadPartsRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if len(body.Parts) == 0 || len(body.Parts) > videoUploadMaxPartURLs {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_parts",
			fmt.Sprintf("Ask for 1 to %d parts at a time.", videoUploadMaxPartURLs))
		return
	}
	out := types.VideoUploadPartsResponse{URLs: make([]types.VideoUploadPartURL, 0, len(body.Parts))}
	for _, n := range body.Parts {
		// 10,000 is S3's part-number ceiling (and keeps the int32 conversion below in range).
		if n < 1 || n > up.PartCount() || n > 10000 {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_parts",
				fmt.Sprintf("This upload has parts 1 to %d.", up.PartCount()))
			return
		}
		u, err := s.multipart().PresignUploadPart(r.Context(), up.StorageKey, up.UploadID, int32(n), videoUploadPartURLTTL)
		if err != nil {
			s.fail(w, r, "video upload: presign part", err)
			return
		}
		out.URLs = append(out.URLs, types.VideoUploadPartURL{Part: n, URL: u})
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) handleCancelVideoUpload(w http.ResponseWriter, r *http.Request) {
	up, ok := s.videoUploadHere(w, r)
	if !ok {
		return
	}
	if err := s.multipart().AbortMultipart(r.Context(), up.StorageKey, up.UploadID); err != nil {
		s.log.Warn("video upload: abort failed", "upload", up.ID, "error", err)
	}
	if err := s.store.DeleteVideoUpload(r.Context(), up.ID); err != nil {
		s.fail(w, r, "video upload: cancel", err)
		return
	}
	s.log.Info("video upload cancelled", "upload", up.ID)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "cancelled"})
}

func (s *Server) handleCompleteVideoUpload(w http.ResponseWriter, r *http.Request) {
	up, ok := s.videoUploadHere(w, r)
	if !ok {
		return
	}
	var body types.CompleteVideoUploadRequest
	_ = httpx.DecodeJSON(w, r, &body)
	if strings.TrimSpace(body.Title) != "" {
		up.Title = videoTitle(body.Title, up.Filename)
	}
	ctx := r.Context()
	mp := s.multipart()

	parts, err := mp.ListUploadedParts(ctx, up.StorageKey, up.UploadID)
	if errors.Is(err, media.ErrNotFound) {
		_ = s.store.DeleteVideoUpload(ctx, up.ID)
		httpx.Error(w, http.StatusNotFound, "not_found", "That upload expired. Start it again.")
		return
	}
	if err != nil {
		s.fail(w, r, "video upload: list parts", err)
		return
	}
	good := completeParts(up, parts)
	if len(good) != up.PartCount() {
		have := map[int32]bool{}
		for _, p := range good {
			have[p.Number] = true
		}
		missing := []int{}
		for n := 1; n <= up.PartCount(); n++ {
			if !have[int32(n)] {
				missing = append(missing, n)
			}
		}
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"error":   "incomplete",
			"message": "Some of the file hasn't arrived yet. Keep the page open and it will carry on.",
			"missing": missing,
		})
		return
	}
	sort.Slice(good, func(i, j int) bool { return good[i].Number < good[j].Number })
	if err := mp.CompleteMultipart(ctx, up.StorageKey, up.UploadID, good); err != nil {
		s.fail(w, r, "video upload: complete", err)
		return
	}

	// From here the object exists: refusing it means deleting it, and forgetting the upload.
	refuse := func(status int, code, msg string) {
		bg := context.WithoutCancel(ctx)
		if err := s.recordings.Delete(bg, up.StorageKey); err != nil {
			s.log.Warn("video upload: refused file left behind", "key", up.StorageKey, "error", err)
		}
		_ = s.store.DeleteVideoUpload(bg, up.ID)
		s.log.Info("video upload refused", "upload", up.ID, "reason", code)
		httpx.Error(w, status, code, msg)
	}
	size := up.SizeBytes
	if st, ok := s.recordings.(media.Stater); ok {
		got, err := st.Stat(ctx, up.StorageKey)
		if err != nil {
			s.fail(w, r, "video upload: stat", err)
			return
		}
		size = got
	}
	if size != up.SizeBytes {
		refuse(http.StatusUnprocessableEntity, "size_mismatch",
			"The uploaded file isn't the size it was meant to be. Try uploading it again.")
		return
	}
	file, _, err := s.recordings.Open(ctx, up.StorageKey)
	if err != nil {
		s.fail(w, r, "video upload: open for probe", err)
		return
	}
	info, perr := mp4probe.Probe(file, size)
	_ = file.Close()
	if perr != nil {
		refuse(http.StatusUnprocessableEntity, "unsupported_video", probeMessage(perr))
		return
	}
	if time.Duration(info.DurationMs)*time.Millisecond > videoUploadMaxDuration {
		refuse(http.StatusUnprocessableEntity, "too_long", "A Simulive can be up to 24 hours. Upload a shorter video.")
		return
	}

	id, err := s.store.FinishVideoUpload(ctx, up, "video/mp4", size, info.DurationMs)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusConflict, "already_done", "That upload has already finished.")
		return
	}
	if err != nil {
		s.fail(w, r, "video upload: finish", err)
		return
	}
	s.log.Info("video uploaded", "host", up.OwnerID, "recording", id, "bytes", size,
		"durationMs", info.DurationMs, "container", info.Container, "video", info.VideoCodec,
		"audio", info.AudioCodec, "fastStart", info.FastStart)
	s.respondVideo(w, r, up.OwnerID, id, http.StatusCreated)
}

// probeMessage is mp4probe's refusal in the host's words, always ending in what to do.
func probeMessage(err error) string {
	var codec *mp4probe.UnsupportedCodecError
	switch {
	case errors.Is(err, mp4probe.ErrWebM):
		return "That's a WebM or MKV file, which not every browser can play. " + unsupportedVideoHint
	case errors.Is(err, mp4probe.ErrNotMP4):
		return "That file isn't an MP4 or MOV video. " + unsupportedVideoHint
	case errors.Is(err, mp4probe.ErrNoMovie):
		return "We couldn't read this video's header, so the file may be incomplete or damaged. " + unsupportedVideoHint
	case errors.Is(err, mp4probe.ErrNoVideo):
		return "This file has no video track. " + unsupportedVideoHint
	case errors.Is(err, mp4probe.ErrNoLength):
		return "We couldn't tell how long this video is. " + unsupportedVideoHint
	case errors.As(err, &codec):
		return fmt.Sprintf("This video's %s is %s, which not every browser can play. %s",
			codec.Kind, codecName(codec.Codec), unsupportedVideoHint)
	}
	return "We couldn't read this video. " + unsupportedVideoHint
}

func codecName(fourcc string) string {
	switch fourcc {
	case "hvc1", "hev1":
		return "HEVC (H.265)"
	case "av01":
		return "AV1"
	case "vp09":
		return "VP9"
	case "mp4v":
		return "MPEG-4 Part 2"
	case "ap4h", "apch", "apcn", "apcs", "apco":
		return "Apple ProRes"
	case "ac-3":
		return "Dolby Digital (AC-3)"
	case "ec-3":
		return "Dolby Digital Plus (E-AC-3)"
	case "Opus", "opus":
		return "Opus"
	case "lpcm", "sowt", "twos", "ipcm":
		return "uncompressed PCM"
	case "encv", "enca":
		return "encrypted (DRM)"
	}
	return strings.TrimSpace(fourcc)
}

// respondVideo writes one of hostID's uploaded videos as the library lists it.
func (s *Server) respondVideo(w http.ResponseWriter, r *http.Request, hostID, id string, status int) {
	rec, err := s.store.UploadedVideo(r.Context(), hostID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such video.")
		return
	}
	if err != nil {
		s.fail(w, r, "video: reload", err)
		return
	}
	list := []types.Recording{rec}
	s.stampHostRecordings(r.Context(), hostID, list)
	httpx.JSON(w, status, list[0])
}

// videoHere loads the caller's uploaded video in the URL, writing the refusal otherwise.
func (s *Server) videoHere(w http.ResponseWriter, r *http.Request) (store.RecordingFile, bool) {
	user := userFromContext(r.Context())
	f, err := s.store.UploadedVideoFor(r.Context(), user.ID, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) || isBadUUID(err) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such video.")
		return store.RecordingFile{}, false
	}
	if err != nil {
		s.fail(w, r, "video: load", err)
		return store.RecordingFile{}, false
	}
	return f, true
}

// handleVideoFile is the host's own playback of an uploaded video.
func (s *Server) handleVideoFile(w http.ResponseWriter, r *http.Request) {
	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "recording_disabled", "Recording is turned off on this instance.")
		return
	}
	f, ok := s.videoHere(w, r)
	if !ok {
		return
	}
	s.serveRecordingFile(w, r, f, r.URL.Query().Get("download") != "1")
}

func (s *Server) handleRenameVideo(w http.ResponseWriter, r *http.Request) {
	f, ok := s.videoHere(w, r)
	if !ok {
		return
	}
	var body types.RenameVideoRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	title := strings.TrimSpace(body.Title)
	if title == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "title_required", "Give the video a title.")
		return
	}
	if len([]rune(title)) > types.VideoUploadMaxTitle {
		httpx.Error(w, http.StatusUnprocessableEntity, "title_too_long",
			fmt.Sprintf("Keep the title to %d characters.", types.VideoUploadMaxTitle))
		return
	}
	if err := s.store.RenameUploadedVideo(r.Context(), f.OwnerID, f.ID, title); err != nil {
		s.fail(w, r, "video: rename", err)
		return
	}
	s.respondVideo(w, r, f.OwnerID, f.ID, http.StatusOK)
}

func (s *Server) handleDeleteVideo(w http.ResponseWriter, r *http.Request) {
	f, ok := s.videoHere(w, r)
	if !ok {
		return
	}
	key, err := s.store.DeleteUploadedVideo(r.Context(), f.OwnerID, f.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
		return
	}
	if err != nil {
		s.fail(w, r, "video: delete", err)
		return
	}
	if s.recordings != nil && key != "" {
		if err := s.recordings.Delete(r.Context(), key); err != nil {
			s.log.Warn("video: file left behind", "recording", f.ID, "key", key, "error", err)
		}
	}
	s.log.Info("uploaded video deleted", "host", f.OwnerID, "recording", f.ID)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

// videoOwned is RecordingOwnerOf for the caller's uploaded video in the URL.
func (s *Server) videoOwned(w http.ResponseWriter, r *http.Request) (store.RecordingOwner, bool) {
	f, ok := s.videoHere(w, r)
	if !ok {
		return store.RecordingOwner{}, false
	}
	own, err := s.store.RecordingOwnerOf(r.Context(), f.ID, s.cfg.RecordingsRetentionDays)
	if err != nil {
		s.fail(w, r, "video retention: owner", err)
		return store.RecordingOwner{}, false
	}
	return own, true
}

func (s *Server) handleKeepVideo(w http.ResponseWriter, r *http.Request) {
	own, ok := s.videoOwned(w, r)
	if !ok {
		return
	}
	if _, _, ok := s.keepRecording(w, r, own, nil); !ok {
		return
	}
	s.respondVideo(w, r, own.HostID, own.SessionID, http.StatusOK)
}

func (s *Server) handleLetVideoExpire(w http.ResponseWriter, r *http.Request) {
	own, ok := s.videoOwned(w, r)
	if !ok {
		return
	}
	if s.cfg.RecordingsRetentionDays <= 0 || own.ExpiresAt == nil {
		httpx.Error(w, http.StatusConflict, "no_expiry", "Recordings on this server are kept until you delete them.")
		return
	}
	if _, err := s.store.LetRecordingExpire(r.Context(), own.SessionID, s.cfg.RecordingsRetentionDays); err != nil {
		s.fail(w, r, "let video expire", err)
		return
	}
	s.respondVideo(w, r, own.HostID, own.SessionID, http.StatusOK)
}

/* sweepAbandonedVideoUploads aborts uploads started more than videoUploadAbandonAfter ago and
 * never finished: the parts are thrown away and the quota they held is free again. */
func (s *Server) sweepAbandonedVideoUploads(ctx context.Context) {
	mp := s.multipart()
	stale, err := s.store.StaleVideoUploads(ctx, time.Now().Add(-videoUploadAbandonAfter), 100)
	if err != nil {
		s.log.Error("video uploads: stale query failed", "error", err)
		return
	}
	for _, up := range stale {
		if mp != nil {
			if err := mp.AbortMultipart(ctx, up.StorageKey, up.UploadID); err != nil {
				s.log.Warn("video uploads: abort failed", "upload", up.ID, "error", err)
				continue
			}
		}
		if err := s.store.DeleteVideoUpload(ctx, up.ID); err != nil {
			s.log.Warn("video uploads: forget failed", "upload", up.ID, "error", err)
			continue
		}
		s.log.Info("video uploads: abandoned upload aborted", "upload", up.ID, "host", up.OwnerID)
	}
}
