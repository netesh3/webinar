package api

import (
	"context"
	"errors"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* "Delete all recordings": an admin's one-time purge of every recording of every host, from
 * the bucket and from the database (migrations/0165, store/recording_purge.go).
 *
 *   GET  /api/admin/recordings/purge   totals and the latest run
 *   POST /api/admin/recordings/purge   {"confirm":"DELETE ALL RECORDINGS"}: start or continue
 *
 * A run is a job row worked in bounded steps: each POST does one (purgeStepBudget, well
 * inside the request timeout), and so does every maintenance pass while one is unfinished,
 * so the admin can close the page. A lease keeps two steps from overlapping. Every step is
 * safe to cut off and run again: files are deleted before their rows, and a row's batch is
 * counted in the transaction that deletes it.
 *
 * What a run deletes is everything that existed when it started (started_at is the cutoff):
 *
 *   1. stopping  recordings in progress are stopped by the paths the host's Stop uses (an
 *                edge mix keeps running: only its recording output comes off), live simulives
 *                playing a recording are ended, clip renders are cancelled, browser uploads
 *                are aborted (the video_uploads rows, then every unfinished multipart upload
 *                the bucket lists under a recording prefix), and the replay and expiry
 *                messages still waiting to go out are dropped.
 *   2. deleting  each recording session's files (every take, an uploaded video, its clips),
 *                then its rows: the clips, plans, reels, highlights and expiry reminders go
 *                by their foreign keys. A scheduled or draft simulive of it becomes a draft
 *                with "recording deleted" (store.DeletePurgeBatch); an ended one keeps its
 *                history.
 *   3. sweeping  after stopped recorders have had purgeSettle to upload their last file, the
 *                bucket is listed and every recording-shaped object no row points at is
 *                deleted (purgeableKey), plus the clip files left in clip_blob_deletions.
 *
 * Recording-shaped means one of the prefixes recordings live under, and nothing else:
 *
 *   ab/cd/<id>.<ext>     a recording's take (beginRecording; Egress and the mix recorder
 *                        write the same key, Egress perhaps a manifest beside it)
 *   uploads/<host>/<id>  an uploaded video (video_upload.go)
 *   clips/ab/<id>.mp4    a clip or reel (clipStorageKey)
 *
 * Kept: covers/ and avatars/ (images.go), chat/ (chat images), wa/ (the CRM's WhatsApp media
 * and its thumbnails) — everything that is not a recording. */

const (
	purgeLease       = "recording-purge"
	purgeLeaseTTL    = 2 * time.Minute
	purgeStepBudget  = 12 * time.Second
	purgeBatch       = 20
	purgeListPage    = 500
	purgeSettle      = 5 * time.Minute
	purgeUploadBatch = 100
)

// recordingTakeKey is beginRecording's key: two levels of fan-out from the recording's id.
var recordingTakeKey = regexp.MustCompile(`^[0-9a-f]{2}/[0-9a-f]{2}/[^/]+$`)

/* purgeableKey reports whether a storage key is a recording's file, a clip's or an uploaded
 * video's — the only objects a purge may delete by listing — and the row id its name carries
 * ("" when the name is not one). */
func purgeableKey(key string) (bool, string) {
	ok := recordingTakeKey.MatchString(key) ||
		(strings.HasPrefix(key, "uploads/") && strings.Count(key, "/") == 2) ||
		(strings.HasPrefix(key, "clips/") && strings.Count(key, "/") == 2)
	if !ok || strings.Contains(key, "..") {
		return false, ""
	}
	name := path.Base(key)
	if i := strings.IndexByte(name, '.'); i >= 0 {
		name = name[:i]
	}
	if _, err := uuid.Parse(name); err != nil || len(name) != 36 {
		return true, ""
	}
	return true, name
}

func (s *Server) recordingPurgeStatus(ctx context.Context) (types.RecordingPurgeStatus, error) {
	var out types.RecordingPurgeStatus
	totals, err := s.store.RecordingStorageTotals(ctx)
	if err != nil {
		return out, err
	}
	out.Totals = totals
	job, err := s.store.LatestRecordingPurge(ctx)
	switch {
	case errors.Is(err, store.ErrNotFound):
	case err != nil:
		return out, err
	default:
		wire := job.Wire()
		out.Latest = &wire
	}
	return out, nil
}

// handleAdminRecordingPurgeStatus is GET /api/admin/recordings/purge.
func (s *Server) handleAdminRecordingPurgeStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.recordingPurgeStatus(r.Context())
	if err != nil {
		s.fail(w, r, "recording purge: status", err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

// handleAdminRecordingPurge is POST /api/admin/recordings/purge: start a run, or do the next
// step of the one in progress.
func (s *Server) handleAdminRecordingPurge(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	var body types.RecordingPurgeRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil || body.Confirm != types.RecordingPurgeConfirm {
		httpx.Error(w, http.StatusBadRequest, "confirm_required",
			"Type "+types.RecordingPurgeConfirm+" exactly to delete every recording.")
		return
	}
	job, started, err := s.store.StartRecordingPurge(r.Context(), admin.ID, admin.Email)
	if err != nil {
		s.fail(w, r, "recording purge: start", err)
		return
	}
	if started {
		s.logAdminAction(admin.ID, "purge recordings: start", "", "purge", job.ID, "email", admin.Email)
	}
	// Not the request's own context: a closed tab must not cut a batch's transaction short.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), purgeStepBudget)
	defer cancel()
	s.stepRecordingPurge(ctx, job)

	st, err := s.recordingPurgeStatus(r.Context())
	if err != nil {
		s.fail(w, r, "recording purge: status", err)
		return
	}
	httpx.JSON(w, http.StatusOK, st)
}

// continueRecordingPurge is the maintenance lane's share: a step of the unfinished run, if any.
func (s *Server) continueRecordingPurge(ctx context.Context) {
	job, err := s.store.UnfinishedRecordingPurge(ctx)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.log.Warn("recording purge: could not read the run", "error", err)
		}
		return
	}
	s.stepRecordingPurge(ctx, job)
}

/* stepRecordingPurge works on the run until it is done or ctx runs out. Another step already
 * holding the lease means this one does nothing; an error is kept on the row for the admin
 * page and the next step tries again. */
func (s *Server) stepRecordingPurge(ctx context.Context, job store.RecordingPurgeJob) {
	release, ok, err := s.store.TryLease(ctx, purgeLease, purgeLeaseTTL)
	if err != nil || !ok {
		return
	}
	defer release()

	for ctx.Err() == nil {
		// Re-read: another instance's step may have moved it on before this one took the lease.
		job, err = s.store.UnfinishedRecordingPurge(ctx)
		if err != nil {
			return
		}
		var next types.RecordingPurgePhase
		switch job.Phase {
		case types.PurgeStopping:
			next, err = s.purgeStop(ctx, job)
		case types.PurgeDeleting:
			next, err = s.purgeDelete(ctx, job)
		case types.PurgeSweeping:
			if job.SettleUntil != nil && time.Now().Before(*job.SettleUntil) {
				return // the stopped recorders are still uploading; a later step sweeps
			}
			next, err = s.purgeSweep(ctx, job)
		default:
			return
		}
		if err != nil {
			if ctx.Err() == nil {
				s.log.Error("recording purge: step failed", "purge", job.ID, "phase", job.Phase, "error", err)
				_ = s.store.SetRecordingPurgeError(context.WithoutCancel(ctx), job.ID, err.Error())
			}
			return
		}
		if next == job.Phase {
			return // out of time part way through; the next step carries on
		}
		if err := s.store.SetRecordingPurgePhase(ctx, job.ID, next); err != nil {
			return
		}
		if next == types.PurgeDone {
			s.finishRecordingPurge(ctx, job.ID)
			return
		}
	}
}

func (s *Server) finishRecordingPurge(ctx context.Context, id string) {
	job, err := s.store.LatestRecordingPurge(ctx)
	if err != nil || job.ID != id {
		return
	}
	sum := job.Summary
	s.logAdminAction(job.RequestedBy, "purge recordings: done", "",
		"purge", job.ID, "email", job.RequestedEmail,
		"recordings", sum.Recordings, "files", sum.Files, "bytes", sum.Bytes,
		"uploadsAborted", sum.UploadsAborted, "clips", sum.Clips,
		"simulivesAffected", sum.SimulivesAffected, "recordingsStopped", sum.RecordingsStopped)
}

// purgeStop is phase 1: nothing still writing a recording, a clip or an upload.
func (s *Server) purgeStop(ctx context.Context, job store.RecordingPurgeJob) (types.RecordingPurgePhase, error) {
	cutoff := job.StartedAt
	if n, err := s.store.ForgetPurgedNotices(ctx, cutoff); err != nil {
		return job.Phase, err
	} else if n > 0 {
		s.log.Info("recording purge: dropped replay and expiry messages", "purge", job.ID, "messages", n)
	}

	settle := false
	active, err := s.store.PurgeActiveRecordings(ctx, cutoff)
	if err != nil {
		return job.Phase, err
	}
	stopped := 0
	for _, a := range active {
		if ctx.Err() != nil {
			return job.Phase, nil
		}
		if s.stopRecordingForPurge(ctx, a) {
			settle = true
		}
		stopped++
	}

	playing, err := s.store.PlayingSimulives(ctx, cutoff)
	if err != nil {
		return job.Phase, err
	}
	ended := 0
	for _, slug := range playing {
		if ctx.Err() != nil {
			return job.Phase, nil
		}
		if _, err := s.endWebinarSession(ctx, slug); err != nil {
			s.log.Warn("recording purge: could not end a simulive", "slug", slug, "error", err)
			continue
		}
		simuliveEndCache.Delete(slug)
		replayPollCache.Delete(slug)
		ended++
	}

	cancelled, err := s.store.CancelPurgedClipJobs(ctx, cutoff)
	if err != nil {
		return job.Phase, err
	}
	if cancelled > 0 {
		settle = true // a render already under way may still upload its file
	}
	if err := s.store.AddRecordingPurgeCounts(ctx, job.ID,
		types.RecordingPurgeSummary{RecordingsStopped: stopped, SimulivesAffected: ended}, ""); err != nil {
		return job.Phase, err
	}

	aborted, err := s.abortPurgedUploads(ctx, job)
	if err != nil || ctx.Err() != nil {
		return job.Phase, err
	}
	if settle {
		if err := s.store.SetRecordingPurgeSettle(ctx, job.ID, time.Now().Add(purgeSettle)); err != nil {
			return job.Phase, err
		}
	}
	s.log.Info("recording purge: stopped", "purge", job.ID, "recordings", stopped,
		"simulivesEnded", ended, "clipsCancelled", cancelled, "uploadsAborted", aborted)
	return types.PurgeDeleting, nil
}

/* stopRecordingForPurge stops one recording the way handleCompleteRecording does, and reports
 * whether a server-side recorder is still to upload its file. */
func (s *Server) stopRecordingForPurge(ctx context.Context, a store.PurgeActiveRecording) bool {
	_, _ = s.store.MarkRecordingProcessing(ctx, a.ID, 0)
	if a.Webinar == "" {
		return false
	}
	wb, err := s.store.WebinarBySlug(ctx, a.Webinar)
	if err != nil {
		return a.EgressID != ""
	}
	sfu, sfuErr := s.sfuFor(ctx, wb)
	if sfuErr != nil {
		sfu = nil
	}
	switch {
	case isMixRecording(a.EgressID):
		// The audience mix carries on; only its recording output comes off.
		s.stopMixRecording(ctx, wb, sfu, a.ID)
	case a.EgressID != "" && sfu != nil:
		if _, err := sfu.StopEgress(ctx, a.EgressID); err != nil {
			s.log.Warn("recording purge: stop egress", "egress", a.EgressID, "error", err)
		}
		stoppedEgress := a.EgressID
		go func() { // #nosec G118 -- background work that must outlive the step; it carries its own timeout
			time.Sleep(broadcastRestartDelay)
			s.restoreBroadcastAfterRecording(context.Background(), wb, sfu, stoppedEgress)
		}()
	}
	if sfu != nil {
		s.pushRoomMetadataCtx(ctx, sfu, wb)
	}
	s.log.Info("recording purge: stopped a recording", "slug", wb.ID, "recording", a.ID, "egress", a.EgressID)
	return a.EgressID != ""
}

// abortPurgedUploads aborts the browser uploads, then whatever else the bucket has half done.
func (s *Server) abortPurgedUploads(ctx context.Context, job store.RecordingPurgeJob) (int, error) {
	mp := s.multipart()
	total := 0
	for ctx.Err() == nil {
		ups, err := s.store.PurgeVideoUploads(ctx, job.StartedAt, purgeUploadBatch)
		if err != nil {
			return total, err
		}
		n := 0
		for _, up := range ups {
			if mp != nil {
				if err := mp.AbortMultipart(ctx, up.StorageKey, up.UploadID); err != nil {
					return total, err
				}
			}
			if err := s.store.DeleteVideoUpload(ctx, up.ID); err != nil {
				return total, err
			}
			n++
		}
		total += n
		if err := s.store.AddRecordingPurgeCounts(ctx, job.ID, types.RecordingPurgeSummary{UploadsAborted: n}, ""); err != nil {
			return total, err
		}
		if len(ups) < purgeUploadBatch {
			break
		}
	}
	lister, ok := s.recordings.(media.MultipartLister)
	if !ok || mp == nil || ctx.Err() != nil {
		return total, nil
	}
	pending, err := lister.ListMultipartUploads(ctx)
	if err != nil {
		return total, err
	}
	var keys []string
	for _, p := range pending {
		keys = append(keys, p.Key)
	}
	live, err := s.store.LiveStorageKeys(ctx, keys)
	if err != nil {
		return total, err
	}
	n := 0
	for _, p := range pending {
		if ok, _ := purgeableKey(p.Key); !ok || live[p.Key] {
			continue
		}
		if !p.Initiated.IsZero() && p.Initiated.After(job.StartedAt) {
			continue // somebody's new recording or upload, started after the run
		}
		if err := mp.AbortMultipart(ctx, p.Key, p.UploadID); err != nil {
			return total, err
		}
		n++
	}
	total += n
	return total, s.store.AddRecordingPurgeCounts(ctx, job.ID, types.RecordingPurgeSummary{UploadsAborted: n}, "")
}

// purgeDelete is phase 2: each recording session's files, then its rows, a batch at a time.
func (s *Server) purgeDelete(ctx context.Context, job store.RecordingPurgeJob) (types.RecordingPurgePhase, error) {
	for ctx.Err() == nil {
		b, err := s.store.NextPurgeBatch(ctx, job.StartedAt, purgeBatch)
		if err != nil {
			return job.Phase, err
		}
		if len(b.SessionIDs) == 0 {
			return types.PurgeSweeping, nil
		}
		for _, key := range b.Keys {
			if err := s.deletePurgedObject(ctx, key); err != nil {
				return job.Phase, err
			}
		}
		if _, err := s.store.DeletePurgeBatch(ctx, job.ID, b); err != nil {
			return job.Phase, err
		}
	}
	return job.Phase, nil
}

func (s *Server) deletePurgedObject(ctx context.Context, key string) error {
	if s.recordings == nil || key == "" {
		return nil
	}
	if err := s.recordings.Delete(ctx, key); err != nil && !errors.Is(err, media.ErrNotFound) &&
		!errors.Is(err, media.ErrBadKey) {
		return err
	}
	return nil
}

/* purgeSweep is phase 3: the clip files deleted clip rows left behind, then the bucket, page
 * by page from where the last step stopped, for recording files no row points at. */
func (s *Server) purgeSweep(ctx context.Context, job store.RecordingPurgeJob) (types.RecordingPurgePhase, error) {
	for ctx.Err() == nil {
		keys, err := s.store.ClipBlobDeletionKeys(ctx, purgeListPage)
		if err != nil {
			return job.Phase, err
		}
		if len(keys) == 0 {
			break
		}
		for _, k := range keys {
			if err := s.deletePurgedObject(ctx, k); err != nil {
				return job.Phase, err
			}
		}
		if err := s.store.ForgetClipBlobDeletions(ctx, keys); err != nil {
			return job.Phase, err
		}
		if err := s.store.AddRecordingPurgeCounts(ctx, job.ID, types.RecordingPurgeSummary{Files: len(keys)}, ""); err != nil {
			return job.Phase, err
		}
	}

	lister, ok := s.recordings.(media.Lister)
	if !ok {
		return types.PurgeDone, nil
	}
	after := job.SweepAfter
	for ctx.Err() == nil {
		page, err := lister.ListObjects(ctx, after, purgeListPage)
		if err != nil {
			return job.Phase, err
		}
		var keys, ids []string
		for _, o := range page {
			if ok, id := purgeableKey(o.Key); ok {
				keys = append(keys, o.Key)
				if id != "" {
					ids = append(ids, id)
				}
			}
		}
		liveKeys, err := s.store.LiveStorageKeys(ctx, keys)
		if err != nil {
			return job.Phase, err
		}
		liveIDs, err := s.store.LiveObjectIDs(ctx, ids)
		if err != nil {
			return job.Phase, err
		}
		var d types.RecordingPurgeSummary
		last := after
		for _, o := range page {
			if ctx.Err() != nil {
				break
			}
			ok, id := purgeableKey(o.Key)
			if ok && !liveKeys[o.Key] && (id == "" || !liveIDs[id]) {
				if err := s.deletePurgedObject(ctx, o.Key); err != nil {
					_ = s.store.AddRecordingPurgeCounts(ctx, job.ID, d, last)
					return job.Phase, err
				}
				d.Files++
				d.Bytes += o.Size
			}
			last = o.Key
		}
		if err := s.store.AddRecordingPurgeCounts(ctx, job.ID, d, last); err != nil {
			return job.Phase, err
		}
		after = last
		if ctx.Err() != nil {
			return job.Phase, nil
		}
		if len(page) < purgeListPage {
			return types.PurgeDone, nil
		}
	}
	return job.Phase, nil
}
