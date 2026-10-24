package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/netkumar/webcast/api/types"
)

/* The admin's "Delete all recordings" (migrations/0165, api/recording_purge.go): the job row,
 * and the SQL each of its steps runs. Everything here is scoped to rows created at or before
 * the run's started_at — the recordings that existed when the admin pressed the button — so a
 * recording somebody starts while the run is going is not deleted out from under them. */

// RecordingPurgeJob is a recording_purges row.
type RecordingPurgeJob struct {
	ID             string
	RequestedBy    string
	RequestedEmail string
	Phase          types.RecordingPurgePhase
	SweepAfter     string
	SettleUntil    *time.Time
	Summary        types.RecordingPurgeSummary
	LastError      string
	StartedAt      time.Time
	FinishedAt     *time.Time
}

// Wire is the job as the admin page reads it.
func (j RecordingPurgeJob) Wire() types.RecordingPurge {
	out := types.RecordingPurge{
		ID: j.ID, Phase: j.Phase, RequestedBy: j.RequestedEmail,
		StartedAt: j.StartedAt.UTC().Format(time.RFC3339),
		LastError: j.LastError, Summary: j.Summary,
	}
	if j.FinishedAt != nil {
		out.FinishedAt = j.FinishedAt.UTC().Format(time.RFC3339)
	}
	if j.SettleUntil != nil && j.SettleUntil.After(time.Now()) {
		out.SettleUntil = j.SettleUntil.UTC().Format(time.RFC3339)
	}
	return out
}

const recordingPurgeCols = `id::text, coalesce(requested_by::text, ''), requested_email, phase, sweep_after,
	settle_until, recordings, files, bytes, uploads_aborted, clips, simulives_affected,
	recordings_stopped, last_error, started_at, finished_at`

func scanRecordingPurge(row pgx.Row) (RecordingPurgeJob, error) {
	var j RecordingPurgeJob
	err := row.Scan(&j.ID, &j.RequestedBy, &j.RequestedEmail, &j.Phase, &j.SweepAfter,
		&j.SettleUntil, &j.Summary.Recordings, &j.Summary.Files, &j.Summary.Bytes,
		&j.Summary.UploadsAborted, &j.Summary.Clips, &j.Summary.SimulivesAffected,
		&j.Summary.RecordingsStopped, &j.LastError, &j.StartedAt, &j.FinishedAt)
	if noRows(err) {
		return RecordingPurgeJob{}, ErrNotFound
	}
	return j, err
}

// LatestRecordingPurge is the most recent run, finished or not (ErrNotFound: none yet).
func (s *Store) LatestRecordingPurge(ctx context.Context) (RecordingPurgeJob, error) {
	return scanRecordingPurge(s.pool.QueryRow(ctx, `
		SELECT `+recordingPurgeCols+` FROM recording_purges ORDER BY started_at DESC LIMIT 1`))
}

// UnfinishedRecordingPurge is the run in progress (ErrNotFound: none).
func (s *Store) UnfinishedRecordingPurge(ctx context.Context) (RecordingPurgeJob, error) {
	return scanRecordingPurge(s.pool.QueryRow(ctx, `
		SELECT `+recordingPurgeCols+` FROM recording_purges WHERE phase <> 'done'`))
}

/* StartRecordingPurge returns the run in progress, or starts one (started true). Two admins
 * pressing at once get the same run: the partial unique index lets one insert win. */
func (s *Store) StartRecordingPurge(ctx context.Context, adminID, adminEmail string) (RecordingPurgeJob, bool, error) {
	if j, err := s.UnfinishedRecordingPurge(ctx); err == nil || !errors.Is(err, ErrNotFound) {
		return j, false, err
	}
	j, err := scanRecordingPurge(s.pool.QueryRow(ctx, `
		INSERT INTO recording_purges (requested_by, requested_email)
		VALUES (NULLIF($1, '')::uuid, $2)
		RETURNING `+recordingPurgeCols, adminID, adminEmail))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		j, err = s.UnfinishedRecordingPurge(ctx)
		return j, false, err
	}
	return j, err == nil, err
}

// SetRecordingPurgePhase moves a run on, clearing its last error.
func (s *Store) SetRecordingPurgePhase(ctx context.Context, id string, phase types.RecordingPurgePhase) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recording_purges
		   SET phase = $2, last_error = '', updated_at = now(),
		       finished_at = CASE WHEN $2 = 'done' THEN now() ELSE finished_at END
		 WHERE id = $1::uuid AND phase <> 'done'`, id, string(phase))
	return err
}

// SetRecordingPurgeError keeps what stopped the last step, for the admin page.
func (s *Store) SetRecordingPurgeError(ctx context.Context, id, msg string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recording_purges SET last_error = $2, updated_at = now() WHERE id = $1::uuid`, id, msg)
	return err
}

// SetRecordingPurgeSettle makes the bucket sweep wait until at least until.
func (s *Store) SetRecordingPurgeSettle(ctx context.Context, id string, until time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recording_purges SET settle_until = GREATEST(coalesce(settle_until, $2), $2), updated_at = now()
		 WHERE id = $1::uuid`, id, until)
	return err
}

// AddRecordingPurgeCounts adds a step's work to the run's totals, and moves the sweep's place.
func (s *Store) AddRecordingPurgeCounts(ctx context.Context, id string, d types.RecordingPurgeSummary, sweepAfter string) error {
	return addRecordingPurgeCounts(ctx, s.pool, id, d, sweepAfter)
}

type purgeExecer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func addRecordingPurgeCounts(ctx context.Context, db purgeExecer, id string, d types.RecordingPurgeSummary, sweepAfter string) error {
	_, err := db.Exec(ctx, `
		UPDATE recording_purges SET
		       recordings = recordings + $2, files = files + $3, bytes = bytes + $4,
		       uploads_aborted = uploads_aborted + $5, clips = clips + $6,
		       simulives_affected = simulives_affected + $7, recordings_stopped = recordings_stopped + $8,
		       sweep_after = CASE WHEN $9 = '' THEN sweep_after ELSE $9 END,
		       updated_at = now()
		 WHERE id = $1::uuid`, id, d.Recordings, d.Files, d.Bytes, d.UploadsAborted, d.Clips,
		d.SimulivesAffected, d.RecordingsStopped, sweepAfter)
	return err
}

// RecordingStorageTotals is what the database says is stored, across every host.
func (s *Store) RecordingStorageTotals(ctx context.Context) (types.RecordingStorageTotals, error) {
	var t types.RecordingStorageTotals
	err := s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM recordings)::int,
		       ((SELECT coalesce(sum(greatest(size_bytes, 0)), 0) FROM recordings)
		      + (SELECT coalesce(sum(greatest(size_bytes, 0)), 0) FROM clip_jobs))::bigint,
		       (SELECT count(*) FROM clip_jobs)::int,
		       (SELECT count(*) FROM video_uploads)::int`).
		Scan(&t.Recordings, &t.Bytes, &t.Clips, &t.Uploads)
	return t, err
}

// PurgeActiveRecording is a recording still being recorded when the run started.
type PurgeActiveRecording struct {
	ID       string
	Webinar  string // the webinar's id (its slug)
	EgressID string
}

// PurgeActiveRecordings lists recordings in progress (status recording) created by cutoff.
func (s *Store) PurgeActiveRecordings(ctx context.Context, cutoff time.Time) ([]PurgeActiveRecording, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, coalesce(r.webinar_id::text, ''), coalesce(r.egress_id, '')
		  FROM recordings r
		 WHERE r.status = 'recording' AND r.created_at <= $1
		 ORDER BY r.created_at`, cutoff)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (PurgeActiveRecording, error) {
		var a PurgeActiveRecording
		err := row.Scan(&a.ID, &a.Webinar, &a.EgressID)
		return a, err
	})
}

// PlayingSimulives lists live simulives still playing a recording created by cutoff.
func (s *Store) PlayingSimulives(ctx context.Context, cutoff time.Time) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.id::text FROM webinars w JOIN recordings r ON r.id = w.simulive_recording_id
		 WHERE w.kind = 'simulive' AND w.status = 'live' AND w.simulive_live_at IS NULL
		   AND r.created_at <= $1`, cutoff)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

/* CancelPurgedClipJobs fails every clip render still queued or in progress for a recording
 * created by cutoff, so the video server stops claiming them; the rows go with their recording. */
func (s *Store) CancelPurgedClipJobs(ctx context.Context, cutoff time.Time) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE clip_jobs c SET status = 'failed', error = 'The recording was deleted.',
		       lease_until = NULL, rush_until = NULL, finished_at = now()
		  FROM recordings r
		 WHERE r.id = c.recording_id AND c.status IN ('queued', 'processing') AND r.created_at <= $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// PurgeVideoUploads lists unfinished browser uploads started by cutoff.
func (s *Store) PurgeVideoUploads(ctx context.Context, cutoff time.Time, limit int) ([]VideoUpload, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+videoUploadCols+` FROM video_uploads
		 WHERE created_at <= $1 ORDER BY created_at LIMIT $2`, cutoff, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (VideoUpload, error) {
		return scanVideoUpload(row)
	})
}

/* ForgetPurgedNotices deletes the messages that would point people at a recording the run
 * deletes: every "your recording will be deleted" email, alert and push, and the replay
 * emails, WhatsApp messages and pushes not yet sent. Sent replay mail stays: it is history. */
func (s *Store) ForgetPurgedNotices(ctx context.Context, cutoff time.Time) (int64, error) {
	var n int64
	for _, q := range []string{
		`DELETE FROM notifications WHERE kind = 'recording_expiring' AND created_at <= $1`,
		`DELETE FROM notifications WHERE kind IN ('replay_ready', 'wa_replay') AND delivery = 'pending' AND created_at <= $1`,
		`DELETE FROM push_messages WHERE kind IN ('recording_expiring', 'replay_ready') AND state = 'pending' AND created_at <= $1`,
	} {
		tag, err := s.pool.Exec(ctx, q, cutoff)
		if err != nil {
			return n, err
		}
		n += tag.RowsAffected()
	}
	return n, nil
}

// PurgeBatch is the next few recording sessions to delete, and every file they hold.
type PurgeBatch struct {
	SessionIDs []string
	// Keys is the recordings' files (every take, and an uploaded video's) and their clips'.
	Keys []string
}

/* NextPurgeBatch is up to limit recording sessions (rows with no parent) created by cutoff,
 * with every storage key under them: each take's file and each clip's. A take whose session is
 * newer than cutoff is left with it. */
func (s *Store) NextPurgeBatch(ctx context.Context, cutoff time.Time, limit int) (PurgeBatch, error) {
	var b PurgeBatch
	rows, err := s.pool.Query(ctx, `
		SELECT id::text FROM recordings
		 WHERE parent_id IS NULL AND created_at <= $1
		 ORDER BY created_at, id LIMIT $2`, cutoff, limit)
	if err != nil {
		return b, err
	}
	b.SessionIDs, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(b.SessionIDs) == 0 {
		return b, err
	}
	rows, err = s.pool.Query(ctx, `
		SELECT storage_key FROM recordings
		 WHERE (id = ANY($1::uuid[]) OR parent_id = ANY($1::uuid[])) AND storage_key <> ''
		UNION
		SELECT c.storage_key FROM clip_jobs c JOIN recordings r ON r.id = c.recording_id
		 WHERE (r.id = ANY($1::uuid[]) OR r.parent_id = ANY($1::uuid[])) AND c.storage_key <> ''
		   AND (c.status IN ('ready', 'processing') OR c.size_bytes > 0)`, b.SessionIDs)
	if err != nil {
		return b, err
	}
	b.Keys, err = pgx.CollectRows(rows, pgx.RowTo[string])
	return b, err
}

/* DeletePurgeBatch deletes the sessions' rows, their files having been deleted already, and
 * adds what went to the run's totals — in one transaction, so a step cut off half way either
 * counted a batch or left it for the next step to do again (deleting a file twice is harmless).
 *
 * Before the delete, which sets simulive_recording_id NULL by its foreign key, every scheduled
 * or draft simulive playing one of them becomes a draft with simulive_recording_deleted_at
 * set: never a scheduled session with nothing to play, and the host is told why. An ended one
 * keeps its history (its report, registrants and replay page) and simply loses the link.
 * Everything else that hangs off a recording goes with it by its foreign key: takes, clips,
 * clip plans, reels, highlights, expiry reminders. The recording_deletions trigger keeps the
 * cost report's line for each. */
func (s *Store) DeletePurgeBatch(ctx context.Context, jobID string, b PurgeBatch) (types.RecordingPurgeSummary, error) {
	var d types.RecordingPurgeSummary
	if len(b.SessionIDs) == 0 {
		return d, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return d, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE webinars w
		   SET status = 'draft', simulive_recording_deleted_at = now(), simulive_start_at = NULL,
		       updated_at = now()
		  FROM recordings r
		 WHERE r.id = w.simulive_recording_id
		   AND (r.id = ANY($1::uuid[]) OR r.parent_id = ANY($1::uuid[]))
		   AND w.status IN ('scheduled', 'draft')`, b.SessionIDs)
	if err != nil {
		return d, err
	}
	d.SimulivesAffected = int(tag.RowsAffected())

	if err := tx.QueryRow(ctx, `
		SELECT count(*)::int, coalesce(sum(greatest(c.size_bytes, 0)), 0)::bigint
		  FROM clip_jobs c JOIN recordings r ON r.id = c.recording_id
		 WHERE r.id = ANY($1::uuid[]) OR r.parent_id = ANY($1::uuid[])`, b.SessionIDs).
		Scan(&d.Clips, &d.Bytes); err != nil {
		return d, err
	}
	var recBytes int64
	if err := tx.QueryRow(ctx, `
		WITH gone AS (
		  DELETE FROM recordings WHERE id = ANY($1::uuid[]) OR parent_id = ANY($1::uuid[])
		  RETURNING greatest(coalesce(size_bytes, 0), 0) AS size_bytes
		)
		SELECT count(*)::int, coalesce(sum(size_bytes), 0)::bigint FROM gone`, b.SessionIDs).
		Scan(&d.Recordings, &recBytes); err != nil {
		return d, err
	}
	d.Bytes += recBytes
	d.Files = len(b.Keys)
	// The clip cascade left their keys for the clip sweep; the files are already gone.
	if _, err := tx.Exec(ctx, `DELETE FROM clip_blob_deletions WHERE storage_key = ANY($1::text[])`, b.Keys); err != nil {
		return d, err
	}
	if err := addRecordingPurgeCounts(ctx, tx, jobID, d, ""); err != nil {
		return d, err
	}
	return d, tx.Commit(ctx)
}

// ClipBlobDeletionKeys is clip files left by deleted clip rows, still to be deleted from storage.
func (s *Store) ClipBlobDeletionKeys(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT storage_key FROM clip_blob_deletions ORDER BY storage_key LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// ForgetClipBlobDeletions drops keys whose files are gone.
func (s *Store) ForgetClipBlobDeletions(ctx context.Context, keys []string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM clip_blob_deletions WHERE storage_key = ANY($1::text[])`, keys)
	return err
}

/* LiveStorageKeys is every storage key a row still points at — recordings, clips, uploads in
 * progress — among keys. The bucket sweep deletes a recording-shaped object only when it is
 * not in here: whatever is left is a recording somebody started after the run began. */
func (s *Store) LiveStorageKeys(ctx context.Context, keys []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(keys) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT storage_key FROM recordings WHERE storage_key = ANY($1::text[])
		UNION SELECT storage_key FROM clip_jobs WHERE storage_key = ANY($1::text[])
		UNION SELECT storage_key FROM video_uploads WHERE storage_key = ANY($1::text[])`, keys)
	if err != nil {
		return nil, err
	}
	live, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	for _, k := range live {
		out[k] = true
	}
	return out, nil
}

// LiveObjectIDs is which of ids is still a recording, a clip or an upload in progress: the
// sweep's second check, for a file named after its row (an Egress manifest beside its video).
func (s *Store) LiveObjectIDs(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text FROM recordings WHERE id = ANY($1::uuid[])
		UNION SELECT id::text FROM clip_jobs WHERE id = ANY($1::uuid[])
		UNION SELECT id::text FROM video_uploads WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	live, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	for _, id := range live {
		out[id] = true
	}
	return out, nil
}

// RecordingWasDeleted reports whether a recording with this id existed and was deleted.
func (s *Store) RecordingWasDeleted(ctx context.Context, id string) bool {
	var gone bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM recording_deletions WHERE recording_id = $1::uuid)`, id).Scan(&gone)
	return err == nil && gone
}
