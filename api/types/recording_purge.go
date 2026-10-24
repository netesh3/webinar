package types

/* The admin's one-time "Delete all recordings" (api/internal/api/recording_purge.go):
 *
 *   GET  /api/admin/recordings/purge   what is stored now, and the latest run
 *   POST /api/admin/recordings/purge   {"confirm": RecordingPurgeConfirm}: start a run, or
 *                                      carry the unfinished one on by one bounded step
 *
 * The admin page calls POST again until the run's phase is done; the maintenance lane also
 * carries an unfinished run on, so closing the page does not leave it half done. */

// RecordingPurgeConfirm is the exact phrase the admin types; anything else is refused.
const RecordingPurgeConfirm = "DELETE ALL RECORDINGS"

// RecordingPurgeRequest is POST /api/admin/recordings/purge.
type RecordingPurgeRequest struct {
	Confirm string `json:"confirm"`
}

// RecordingPurgePhase is how far a run has got.
type RecordingPurgePhase string

const (
	PurgeStopping RecordingPurgePhase = "stopping"
	PurgeDeleting RecordingPurgePhase = "deleting"
	PurgeSweeping RecordingPurgePhase = "sweeping"
	PurgeDone     RecordingPurgePhase = "done"
)

// RecordingPurgeSummary is what a run has done so far (all of it, once Phase is done).
type RecordingPurgeSummary struct {
	// Recordings is recording rows deleted: every take, and uploaded videos.
	Recordings int `json:"recordings"`
	// Files is storage objects deleted: recording files, clip files and orphans.
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
	// UploadsAborted is unfinished multipart uploads aborted (video uploads and any other).
	UploadsAborted int `json:"uploadsAborted"`
	// Clips is clip and reel rows deleted with their recordings.
	Clips int `json:"clips"`
	// SimulivesAffected is simulives that played a deleted recording and were put back to
	// draft (scheduled or draft) or ended (playing it live).
	SimulivesAffected int `json:"simulivesAffected"`
	// RecordingsStopped is recordings that were in progress and were stopped first.
	RecordingsStopped int `json:"recordingsStopped"`
}

// RecordingPurge is one run.
type RecordingPurge struct {
	ID          string              `json:"id"`
	Phase       RecordingPurgePhase `json:"phase"`
	RequestedBy string              `json:"requestedBy"`
	StartedAt   string              `json:"startedAt"`
	FinishedAt  string              `json:"finishedAt,omitempty"`
	// SettleUntil: the sweep waits until then for stopped recorders to upload their last file.
	SettleUntil string                `json:"settleUntil,omitempty"`
	LastError   string                `json:"lastError,omitempty"`
	Summary     RecordingPurgeSummary `json:"summary"`
}

// RecordingStorageTotals is what the database says is stored, across every host.
type RecordingStorageTotals struct {
	Recordings int   `json:"recordings"`
	Bytes      int64 `json:"bytes"`
	Clips      int   `json:"clips"`
	Uploads    int   `json:"uploads"`
}

// RecordingPurgeStatus is GET (and POST) /api/admin/recordings/purge.
type RecordingPurgeStatus struct {
	Totals RecordingStorageTotals `json:"totals"`
	// Latest is the most recent run, finished or not; absent when there has been none.
	Latest *RecordingPurge `json:"latest,omitempty"`
}
