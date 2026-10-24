package store

import (
	"context"
	"encoding/json"
	"time"
)

/* Clip jobs (migrations/0157): the clips and reels made from a recording, rendered on the video
 * server. See api/internal/api/clip_jobs.go.
 *
 * The queue is the table: the video server claims the oldest job (rushed ones first) with
 * FOR UPDATE SKIP LOCKED, holds it on a lease it renews with every progress report, and
 * finishes or fails it. A lease that runs out (the server went away mid-render) is claimable
 * again until attempts reaches the cap; past it the job fails. */

// Clip job statuses, as stored.
const (
	ClipQueued     = "queued"
	ClipProcessing = "processing"
	ClipReady      = "ready"
	ClipFailed     = "failed"
)

// ClipJobRow is one clip job as stored.
type ClipJobRow struct {
	ID          string
	RecordingID string
	Kind        string
	SourceID    string
	Title       string
	Format      string
	Framing     string
	Captions    bool
	Hook        string
	Segments    json.RawMessage
	DurationSec float64
	Subtitles   string
	Posts       json.RawMessage
	PostStatus  string
	Status      string
	Error       string
	Attempts    int
	Progress    int
	LeaseUntil  *time.Time
	RushUntil   *time.Time
	StorageKey  string
	SizeBytes   int64
	DurationMs  int64
	CreatedAt   time.Time
	StartedAt   *time.Time
	FinishedAt  *time.Time
}

const clipJobCols = `id::text, recording_id::text, kind, source_id, title, format, framing, captions, hook,
	segments, duration_sec, subtitles, posts, post_status, status, error, attempts, progress,
	lease_until, rush_until, storage_key, size_bytes, duration_ms, created_at, started_at, finished_at`

func scanClipJob(row rowScanner) (ClipJobRow, error) {
	var j ClipJobRow
	var segs, posts []byte
	err := row.Scan(&j.ID, &j.RecordingID, &j.Kind, &j.SourceID, &j.Title, &j.Format, &j.Framing, &j.Captions, &j.Hook,
		&segs, &j.DurationSec, &j.Subtitles, &posts, &j.PostStatus, &j.Status, &j.Error, &j.Attempts, &j.Progress,
		&j.LeaseUntil, &j.RushUntil, &j.StorageKey, &j.SizeBytes, &j.DurationMs, &j.CreatedAt, &j.StartedAt, &j.FinishedAt)
	j.Segments, j.Posts = segs, posts
	return j, err
}

// NewClipJob is one job to create. ID is chosen by the caller (the storage key is made from it).
type NewClipJob struct {
	ID          string
	RecordingID string
	CreatedBy   string
	Kind        string
	SourceID    string
	Title       string
	Format      string
	Framing     string
	Captions    bool
	Hook        string
	Segments    any
	DurationSec float64
	Subtitles   string
	PostStatus  string
	StorageKey  string
}

// CreateClipJobs inserts the jobs, queued, in one transaction.
func (s *Store) CreateClipJobs(ctx context.Context, jobs []NewClipJob) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, j := range jobs {
		segs, err := json.Marshal(j.Segments)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO clip_jobs (id, recording_id, created_by, kind, source_id, title, format, framing, captions,
			                       hook, segments, duration_sec, subtitles, post_status, storage_key)
			VALUES ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)`,
			j.ID, j.RecordingID, j.CreatedBy, j.Kind, j.SourceID, j.Title, j.Format, j.Framing, j.Captions,
			j.Hook, string(segs), j.DurationSec, j.Subtitles, j.PostStatus, j.StorageKey); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ClipJobs is the recording session's jobs, newest first.
func (s *Store) ClipJobs(ctx context.Context, recordingID string) ([]ClipJobRow, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+clipJobCols+` FROM clip_jobs
		 WHERE recording_id = $1::uuid ORDER BY created_at DESC, format`, recordingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClipJobRow
	for rows.Next() {
		j, err := scanClipJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// ClipJob is one job of the recording session; ErrNotFound when it is not one of its.
func (s *Store) ClipJob(ctx context.Context, recordingID, id string) (ClipJobRow, error) {
	j, err := scanClipJob(s.pool.QueryRow(ctx, `SELECT `+clipJobCols+` FROM clip_jobs
		 WHERE id = $1::uuid AND recording_id = $2::uuid`, id, recordingID))
	if noRows(err) {
		return j, ErrNotFound
	}
	return j, err
}

// ClipJobByID is a job by its id alone (the video server's calls); ErrNotFound when gone.
func (s *Store) ClipJobByID(ctx context.Context, id string) (ClipJobRow, error) {
	j, err := scanClipJob(s.pool.QueryRow(ctx, `SELECT `+clipJobCols+` FROM clip_jobs WHERE id = $1::uuid`, id))
	if noRows(err) {
		return j, ErrNotFound
	}
	return j, err
}

// DeleteClipJob deletes a job of the recording session. Its file, if any, is left to the
// sweep by the trigger; the key is returned for the caller to delete now as well.
func (s *Store) DeleteClipJob(ctx context.Context, recordingID, id string) (string, error) {
	var key string
	err := s.pool.QueryRow(ctx, `DELETE FROM clip_jobs WHERE id = $1::uuid AND recording_id = $2::uuid
		RETURNING storage_key`, id, recordingID).Scan(&key)
	if noRows(err) {
		return "", ErrNotFound
	}
	return key, err
}

// UnfinishedClipJobs is how many of the recording session's jobs are queued or processing.
func (s *Store) UnfinishedClipJobs(ctx context.Context, recordingID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM clip_jobs
		 WHERE recording_id = $1::uuid AND status IN ('queued', 'processing')`, recordingID).Scan(&n)
	return n, err
}

// SaveClipPosts stores the post text (and its status) of the jobs.
func (s *Store) SaveClipPosts(ctx context.Context, ids []string, posts any, status string) error {
	raw, err := json.Marshal(posts)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE clip_jobs SET posts = $2::jsonb, post_status = $3 WHERE id = ANY($1::uuid[])`,
		ids, string(raw), status)
	return err
}

/* ClaimClipJob gives the next job to the video server for lease: the oldest queued one (or one
 * whose lease ran out), rushed ones first, under maxAttempts tries. false when there is none.
 * Jobs whose lease ran out on their last try are failed first. */
func (s *Store) ClaimClipJob(ctx context.Context, lease time.Duration, maxAttempts int, gaveUp string) (ClipJobRow, bool, error) {
	if _, err := s.FailStaleClipJobs(ctx, maxAttempts, gaveUp); err != nil {
		return ClipJobRow{}, false, err
	}
	j, err := scanClipJob(s.pool.QueryRow(ctx, `
		UPDATE clip_jobs SET status = 'processing', attempts = attempts + 1, progress = 0,
		       lease_until = now() + make_interval(secs => $1), started_at = coalesce(started_at, now())
		 WHERE id = (SELECT id FROM clip_jobs
		              WHERE (status = 'queued' OR (status = 'processing' AND lease_until < now()))
		                AND attempts < $2
		              ORDER BY (rush_until > now()) IS TRUE DESC, created_at
		              LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING `+clipJobCols, lease.Seconds(), maxAttempts))
	if noRows(err) {
		return ClipJobRow{}, false, nil
	}
	if err != nil {
		return ClipJobRow{}, false, err
	}
	return j, true, nil
}

// FailStaleClipJobs fails the jobs whose lease ran out on their last try, with reason.
func (s *Store) FailStaleClipJobs(ctx context.Context, maxAttempts int, reason string) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE clip_jobs SET status = 'failed', error = $2, lease_until = NULL, rush_until = NULL, finished_at = now()
		 WHERE status = 'processing' AND lease_until < now() AND attempts >= $1`, maxAttempts, reason)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ClipJobProgress records progress on a job the video server holds and renews its lease.
// false when the job is gone or no longer processing (deleted, or its lease was lost).
func (s *Store) ClipJobProgress(ctx context.Context, id string, percent int, lease time.Duration) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE clip_jobs SET progress = $2, lease_until = now() + make_interval(secs => $3)
		 WHERE id = $1::uuid AND status = 'processing'`, id, min(max(percent, 0), 100), lease.Seconds())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RequeueClipJob puts a job the video server gave up (a live session started) back in the
// queue, the try not counted.
func (s *Store) RequeueClipJob(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE clip_jobs SET status = 'queued', attempts = greatest(attempts - 1, 0), progress = 0, lease_until = NULL
		 WHERE id = $1::uuid AND status = 'processing'`, id)
	return err
}

// FinishClipJob marks a job made. false when it is gone (deleted while it was being made).
func (s *Store) FinishClipJob(ctx context.Context, id string, sizeBytes, durationMs int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE clip_jobs SET status = 'ready', error = '', progress = 100, size_bytes = $2, duration_ms = $3,
		       lease_until = NULL, rush_until = NULL, finished_at = now()
		 WHERE id = $1::uuid AND status = 'processing'`, id, sizeBytes, durationMs)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* FailClipJob records a failed try: back in the queue while tries remain (retry), else failed
 * with reason, the plain sentence the host sees. */
func (s *Store) FailClipJob(ctx context.Context, id, reason string, retry bool, maxAttempts int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE clip_jobs
		   SET status = CASE WHEN $3 AND attempts < $4 THEN 'queued' ELSE 'failed' END,
		       error = CASE WHEN $3 AND attempts < $4 THEN '' ELSE $2 END,
		       finished_at = CASE WHEN $3 AND attempts < $4 THEN NULL ELSE now() END,
		       rush_until = CASE WHEN $3 AND attempts < $4 THEN rush_until END,
		       progress = 0, lease_until = NULL
		 WHERE id = $1::uuid AND status = 'processing'`, id, reason, retry, maxAttempts)
	return err
}

/* ClipDemand is what clip jobs ask of the on-demand video server: jobs being made (their lease
 * alive), and jobs an admin asked to make now (rushed, still waiting). */
func (s *Store) ClipDemand(ctx context.Context, maxAttempts int) (processing, rushed int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status = 'processing' AND lease_until > now()),
		       count(*) FILTER (WHERE status = 'queued' AND rush_until > now() AND attempts < $1)
		  FROM clip_jobs WHERE status IN ('queued', 'processing')`, maxAttempts).Scan(&processing, &rushed)
	return processing, rushed, err
}

// RushClipJobs is an admin's "Make it now": every queued job keeps the video server wanted
// until until. How many there are.
func (s *Store) RushClipJobs(ctx context.Context, until time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE clip_jobs SET rush_until = $1 WHERE status = 'queued'`, until)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// QueuedClipJobs is how many jobs wait in the whole queue.
func (s *Store) QueuedClipJobs(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM clip_jobs WHERE status = 'queued'`).Scan(&n)
	return n, err
}

// ClipBlobDeletions is up to limit files of deleted clips, for the sweep.
func (s *Store) ClipBlobDeletions(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT storage_key FROM clip_blob_deletions ORDER BY created_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// ForgetClipBlobs drops files the sweep has deleted from the list.
func (s *Store) ForgetClipBlobs(ctx context.Context, keys []string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM clip_blob_deletions WHERE storage_key = ANY($1)`, keys)
	return err
}

// ---------------------------------------------------------------- suggested reels

// RecordingReels reads the suggested reels of the recording session; ErrNotFound when none
// were ever asked for. As RecordingHighlights.
func (s *Store) RecordingReels(ctx context.Context, recordingID string) (HighlightsRow, error) {
	var r HighlightsRow
	var body []byte
	err := s.pool.QueryRow(ctx, `
		SELECT status, reason, body, COALESCE(claimed_until > now(), false), generated_at
		  FROM recording_reels WHERE recording_id = $1::uuid`, recordingID).
		Scan(&r.Status, &r.Reason, &body, &r.Claimed, &r.GeneratedAt)
	if noRows(err) {
		return r, ErrNotFound
	}
	r.Body = body
	return r, err
}

// ClaimRecordingReels is ClaimRecordingHighlights for the reels.
func (s *Store) ClaimRecordingReels(ctx context.Context, recordingID string, rewrite bool, claimFor time.Duration) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO recording_reels (recording_id, status, claimed_until)
		VALUES ($1::uuid, 'pending', now() + make_interval(secs => $3))
		ON CONFLICT (recording_id) DO UPDATE
		   SET status = 'pending', reason = '', claimed_until = EXCLUDED.claimed_until
		 WHERE (recording_reels.status <> 'ready' OR $2)
		   AND (recording_reels.claimed_until IS NULL OR recording_reels.claimed_until < now())`,
		recordingID, rewrite, claimFor.Seconds())
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SaveRecordingReels stores the reels and releases the claim.
func (s *Store) SaveRecordingReels(ctx context.Context, recordingID string, body any, model string) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE recording_reels
		   SET status = 'ready', reason = '', body = $2::jsonb, model = $3, generated_at = now(), claimed_until = NULL
		 WHERE recording_id = $1::uuid`, recordingID, string(raw), model)
	return err
}

// FailRecordingReels is FailRecordingHighlights for the reels.
func (s *Store) FailRecordingReels(ctx context.Context, recordingID, reason string, retryAfter time.Duration) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recording_reels
		   SET status = 'failed', reason = $2, claimed_until = now() + make_interval(secs => $3)
		 WHERE recording_id = $1::uuid AND status = 'pending'`, recordingID, reason, retryAfter.Seconds())
	return err
}
