package api

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Recording from the audience mix.
 *
 * An edge webinar already has one compositor: the mix, pushing RTMP to MediaMTX on the SFU
 * box for the audience's LL-HLS. A cloud recording started beside it used to need a second
 * Chrome (startEgressRecording), which a box with one compositor's worth of CPU refuses — so
 * on DigitalOcean an edge session could not be recorded in the cloud at all.
 *
 * Instead the running mix is given a second RTMP output, rtmp://<origin>/rec/{slug}
 * (Config.MixRecRTMPURL). It is the same encoded stream, so this costs no encode: egress
 * tees it to one more RTMP sink, exactly as it does when a host adds YouTube mid-session
 * (attachDestinations), and the audience's output is not touched. MediaMTX records every
 * rec/* path to fMP4 segments (mediamtx.yml.template). The mix recorder, a sidecar next to
 * MediaMTX (deploy/livekit-box/mixrec), joins those segments into one MP4 when the
 * recording stops and PUTs it to the recording's storage key through a URL this API signs,
 * then reports size and duration here. From then on it is an ordinary recording row.
 *
 * Why not MediaMTX's own API, toggling record on live/{slug}: that path is served by
 * all_others, so recording it alone means adding a named path config, and MediaMTX closes a
 * path whose config name changes, which drops the egress's publish: the audience's stream.
 * Toggling record on all_others records every webinar on the box. A separate path the mix
 * pushes to only while recording has neither problem.
 *
 * The row is marked as this kind of recording by its egress id, mixRecPrefix + its own id,
 * which no LiveKit egress id can collide with (theirs start EG_). Every path that treats a
 * row with an egress id as "the server is producing this file, wait for it" (processing on
 * stop, the room's REC indicator, the storage reconciler) is then right for it as well, and
 * the two places that would hand the id to LiveKit (stop, end webinar) route here instead.
 *
 * Fallback: no MIXREC_SECRET, no live origin, a storage backend that cannot sign uploads, a
 * recorder that does not answer, or a mix that will not take the extra output — and the
 * recording is started exactly as before (its own compositor, or recording_no_capacity).
 */

const mixRecPrefix = "MIXREC_"

// mixRecUploadWindow is how long the recorder's signed upload URL is good for: a multi-hour
// recording on the box's uplink, with room to retry.
const mixRecUploadWindow = 6 * time.Hour

var errMixRecUnavailable = errors.New("record-from-mix unavailable")

func mixRecEgressID(recordingID string) string { return mixRecPrefix + recordingID }

func isMixRecording(egressID string) bool { return strings.HasPrefix(egressID, mixRecPrefix) }

// mixRecJob is what the recorder is told on start, stop and cancel.
type mixRecJob struct {
	RecordingID string `json:"recordingId"`
	Slug        string `json:"slug"`
}

/* mixRecorderFor is the recorder that can record this webinar's mix, or "" when
 * record-from-mix does not apply: off, not an edge webinar (only the edge mix goes through
 * MediaMTX), no RTMP origin, or storage the recorder cannot upload to. */
func (s *Server) mixRecorderFor(ctx context.Context, wb types.Webinar) string {
	if s.cfg.MixRecSecret == "" || wb.Delivery != types.DeliveryEdge {
		return ""
	}
	if _, ok := s.recordings.(media.PutPresigner); !ok {
		return ""
	}
	if s.cfg.MixRecRTMPURL(wb.ID) == "" {
		return ""
	}
	return s.cfg.MixRecorderURLFor(s.pinnedProject(ctx, wb))
}

var mixRecClient = &http.Client{Timeout: 10 * time.Second}

// callMixRecorder posts one job to the recorder: start, stop or cancel.
func (s *Server) callMixRecorder(ctx context.Context, base, op string, job mixRecJob) error {
	body, err := json.Marshal(job)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/"+op, bytes.NewReader(body)) // #nosec G704 -- base is the operator's recorder URL from config, op a constant
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Mixrec-Secret", s.cfg.MixRecSecret)
	res, err := mixRecClient.Do(req) // #nosec G704 -- the operator's own recorder URL, from config
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("mix recorder %s: %d %s", op, res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

/* startMixRecording records the running mix: the recorder is told first, so that nothing is
 * pushed to rec/{slug} unless something will collect it, then the mix gets its second output.
 * Any failure is errMixRecUnavailable, and the caller falls back to a compositor of its own. */
func (s *Server) startMixRecording(
	ctx context.Context, wb types.Webinar, sfu RoomManager, recordingID string, mixIDs []string,
) (*livekit.EgressInfo, error) {
	base := s.mixRecorderFor(ctx, wb)
	if base == "" || len(mixIDs) == 0 {
		return nil, errMixRecUnavailable
	}
	job := mixRecJob{RecordingID: recordingID, Slug: wb.ID}
	if err := s.callMixRecorder(ctx, base, "start", job); err != nil {
		return nil, fmt.Errorf("%w: %w", errMixRecUnavailable, err)
	}
	mix := mixIDs[0]
	broadcastMu.Lock()
	for _, id := range mixIDs {
		if id == activeBroadcasts[wb.ID] {
			mix = id
		}
	}
	broadcastMu.Unlock()
	if _, err := sfu.UpdateStream(ctx, mix, []string{s.cfg.MixRecRTMPURL(wb.ID)}, nil); err != nil {
		if cerr := s.callMixRecorder(ctx, base, "cancel", job); cerr != nil {
			s.log.Warn("mix recording: could not cancel the recorder job", "slug", wb.ID, "error", cerr)
		}
		return nil, fmt.Errorf("%w: attach to mix: %w", errMixRecUnavailable, err)
	}
	s.log.Info("recording from the audience mix", "slug", wb.ID, "recording", recordingID, "mix", mix)
	return &livekit.EgressInfo{EgressId: mixRecEgressID(recordingID), Status: livekit.EgressStatus_EGRESS_ACTIVE}, nil
}

/* stopMixRecording takes the second output off the mix, which ends MediaMTX's recording of
 * rec/{slug}, and tells the recorder to finish. The mix itself carries on.
 *
 * Neither step has to succeed for the file to arrive: the recorder also finishes a job whose
 * segments have stopped growing (deploy/livekit-box/mixrec), and a mix that has already
 * ended — the webinar ending — has nothing to detach. */
func (s *Server) stopMixRecording(ctx context.Context, wb types.Webinar, sfu RoomManager, recordingID string) {
	recURL := s.cfg.MixRecRTMPURL(wb.ID)
	if sfu != nil && recURL != "" {
		ids, _ := s.broadcastEgressIDs(ctx, wb.ID, sfu)
		for _, id := range ids {
			if _, err := sfu.UpdateStream(ctx, id, nil, []string{recURL}); err != nil {
				s.log.Info("mix recording: detach from mix", "slug", wb.ID, "mix", id, "error", err)
			}
		}
	}
	base := s.mixRecorderFor(ctx, wb)
	if base == "" {
		return
	}
	if err := s.callMixRecorder(ctx, base, "stop", mixRecJob{RecordingID: recordingID, Slug: wb.ID}); err != nil {
		s.log.Warn("mix recording: recorder did not take the stop; it finishes idle jobs itself",
			"slug", wb.ID, "recording", recordingID, "error", err)
	}
}

/* reattachMixRecording gives a replacement mix the recording output too. A mix that dies
 * mid-recording is restarted by the sweeper (or onBroadcastEgressEnded) with only the
 * audience's output; without this the recording would silently end there. MediaMTX writes
 * the new push as new segments of the same path, and the recorder joins them all. */
func (s *Server) reattachMixRecording(ctx context.Context, wb types.Webinar, sfu RoomManager, egressID string) {
	if s.cfg.MixRecSecret == "" || wb.Delivery != types.DeliveryEdge {
		return
	}
	rec, err := s.store.ActiveRecordingFile(ctx, wb.ID)
	if err != nil || !isMixRecording(rec.EgressID) {
		return
	}
	recURL := s.cfg.MixRecRTMPURL(wb.ID)
	if recURL == "" {
		return
	}
	if _, err := sfu.UpdateStream(ctx, egressID, []string{recURL}, nil); err != nil {
		s.log.Warn("mix recording: could not re-attach to the new mix", "slug", wb.ID,
			"recording", rec.ID, "mix", egressID, "error", err)
		return
	}
	s.log.Info("mix recording: re-attached to the new mix", "slug", wb.ID, "recording", rec.ID, "mix", egressID)
}

// ------------------------------------------------------------- recorder endpoints

func (s *Server) requireMixRecSecret(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Mixrec-Secret")
		if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.MixRecSecret)) != 1 {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Bad mix recorder secret.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// mountMixRecInternal adds the recorder's endpoints. Not mounted without MIXREC_SECRET.
func (s *Server) mountMixRecInternal(r chi.Router) {
	if s.cfg.MixRecSecret == "" {
		return
	}
	r.Group(func(r chi.Router) {
		r.Use(s.requireMixRecSecret)
		r.Post("/internal/mix-recordings/{id}/upload-url", s.handleMixRecUploadURL)
		r.Post("/internal/mix-recordings/{id}/complete", s.handleMixRecComplete)
	})
}

// mixRecRow loads a recording the recorder may act on: one recorded from a mix.
func (s *Server) mixRecRow(w http.ResponseWriter, r *http.Request) (store.RecordingFile, bool) {
	id := chi.URLParam(r, "id")
	rec, err := s.store.RecordingFileByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && rec.EgressID != mixRecEgressID(id)) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such mix recording.")
		return store.RecordingFile{}, false
	}
	if err != nil {
		s.fail(w, r, "mix recording: lookup", err)
		return store.RecordingFile{}, false
	}
	return rec, true
}

// handleMixRecUploadURL signs one PUT of the finished file to the recording's storage key.
func (s *Server) handleMixRecUploadURL(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.mixRecRow(w, r)
	if !ok {
		return
	}
	if rec.Status == types.RecordingReady && rec.SizeBytes > 0 {
		httpx.Error(w, http.StatusConflict, "already_uploaded", "That recording is already stored.")
		return
	}
	signer, ok := s.recordings.(media.PutPresigner)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "no_object_storage",
			"This instance's recording storage cannot take an upload.")
		return
	}
	u, err := signer.PresignedPutURL(r.Context(), rec.StorageKey, rec.Mime, mixRecUploadWindow)
	if err != nil {
		s.fail(w, r, "mix recording: presign", err)
		return
	}
	httpx.JSON(w, http.StatusOK, mixRecUpload{URL: u, ContentType: rec.Mime})
}

type mixRecUpload struct {
	URL         string `json:"url"`
	ContentType string `json:"contentType"`
}

// mixRecResult is the recorder's report once the file is in storage, or once it is not.
type mixRecResult struct {
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

/* handleMixRecComplete is the EGRESS_ENDED webhook of a mix recording (recordings.go): with
 * a size the row is ready, without one it failed. */
func (s *Server) handleMixRecComplete(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.mixRecRow(w, r)
	if !ok {
		return
	}
	var body mixRecResult
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Bad body.")
		return
	}
	if body.SizeBytes < 0 || body.DurationMs < 0 || body.DurationMs > 48*int64(time.Hour/time.Millisecond) {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_stats", "Bad size or duration.")
		return
	}
	size := body.SizeBytes
	if body.Error != "" {
		size = 0
		s.log.Warn("mix recording failed on the recorder", "slug", rec.Webinar, "recording", rec.ID,
			"error", body.Error)
	}
	status, err := s.store.FinishRecordingWithStats(r.Context(), rec.ID, size, body.DurationMs)
	if err != nil {
		s.fail(w, r, "mix recording: finish", err)
		return
	}
	s.log.Info("mix recording finished", "slug", rec.Webinar, "recording", rec.ID,
		"status", status, "sizeBytes", size, "durationMs", body.DurationMs)
	if wb, err := s.store.WebinarBySlug(r.Context(), rec.Webinar); err == nil {
		if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
			s.pushRoomMetadata(r, sfu, wb)
		}
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: string(status)})
}
