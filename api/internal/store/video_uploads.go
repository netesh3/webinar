package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

/* Uploaded videos (migrations/0153): a multipart upload in flight (video_uploads), and the
 * recordings row it becomes once complete — source 'upload', owner_id the host, no webinar.
 * The handler is api/internal/api/video_upload.go. */

// ErrStorageFull is a new upload that would take the host past their recording storage quota.
var ErrStorageFull = errors.New("recording storage full")

// VideoUpload is one multipart upload from a host's browser, still arriving.
type VideoUpload struct {
	ID         string
	OwnerID    string
	StorageKey string
	UploadID   string
	Filename   string
	Title      string
	Mime       string
	SizeBytes  int64
	PartSize   int64
	CreatedAt  time.Time
}

// PartCount is how many parts the file is cut into: every part PartSize but the last.
func (u VideoUpload) PartCount() int {
	if u.PartSize <= 0 {
		return 0
	}
	return int((u.SizeBytes + u.PartSize - 1) / u.PartSize)
}

/* CreateVideoUpload records a new upload, unless its size on top of what the host already
 * stores and is already uploading would pass their quota (ErrStorageFull). The host's row is
 * locked for the check, so two uploads started at once are counted one after the other. */
func (s *Store) CreateVideoUpload(ctx context.Context, u VideoUpload) (VideoUpload, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VideoUpload{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var used, pending, quota int64
	err = tx.QueryRow(ctx, `
		SELECT recording_used_bytes(u.id), video_upload_pending_bytes(u.id), recording_quota_bytes(u.id)
		  FROM users u WHERE u.id = $1::uuid FOR UPDATE`, u.OwnerID).Scan(&used, &pending, &quota)
	if noRows(err) {
		return VideoUpload{}, ErrNotFound
	}
	if err != nil {
		return VideoUpload{}, err
	}
	if used+pending+u.SizeBytes > quota {
		return VideoUpload{}, ErrStorageFull
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO video_uploads (id, owner_id, storage_key, upload_id, filename, title, mime, size_bytes, part_size)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
		RETURNING created_at`,
		u.ID, u.OwnerID, u.StorageKey, u.UploadID, u.Filename, u.Title, u.Mime, u.SizeBytes, u.PartSize,
	).Scan(&u.CreatedAt)
	if err != nil {
		return VideoUpload{}, err
	}
	return u, tx.Commit(ctx)
}

const videoUploadCols = `id::text, owner_id::text, storage_key, upload_id, filename, title, mime, size_bytes, part_size, created_at`

func scanVideoUpload(row pgx.Row) (VideoUpload, error) {
	var u VideoUpload
	err := row.Scan(&u.ID, &u.OwnerID, &u.StorageKey, &u.UploadID, &u.Filename, &u.Title, &u.Mime,
		&u.SizeBytes, &u.PartSize, &u.CreatedAt)
	if noRows(err) {
		return VideoUpload{}, ErrNotFound
	}
	return u, err
}

// VideoUploadFor is one of ownerID's uploads in flight.
func (s *Store) VideoUploadFor(ctx context.Context, ownerID, id string) (VideoUpload, error) {
	return scanVideoUpload(s.pool.QueryRow(ctx, `
		SELECT `+videoUploadCols+` FROM video_uploads
		 WHERE id = $1::uuid AND owner_id = $2::uuid`, id, ownerID))
}

// DeleteVideoUpload forgets an upload in flight (cancelled, failed, or finished).
func (s *Store) DeleteVideoUpload(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM video_uploads WHERE id = $1::uuid`, id)
	return err
}

// StaleVideoUploads lists uploads started before before: abandoned, to be aborted.
func (s *Store) StaleVideoUploads(ctx context.Context, before time.Time, limit int) ([]VideoUpload, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+videoUploadCols+` FROM video_uploads
		 WHERE created_at < $1 ORDER BY created_at LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (VideoUpload, error) {
		return scanVideoUpload(row)
	})
}

/* FinishVideoUpload turns a complete, probed upload into a ready recording of its owner's —
 * the upload row goes in the same transaction, so it is never both — and returns the
 * recording's id, which is the upload's (so its storage key names it). Kept from now for the owner's retention days (recording_expires_at counts
 * from stopped_at). */
func (s *Store) FinishVideoUpload(ctx context.Context, u VideoUpload, mime string, sizeBytes, durationMs int64) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM video_uploads WHERE id = $1::uuid`, u.ID)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		// Finished (or cancelled) by another request first.
		return "", ErrNotFound
	}
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO recordings (id, webinar_id, owner_id, source, title, started_by, started_by_name,
		                        status, mime, storage_key, size_bytes, duration_ms, uploaded_to_s3,
		                        upload_percent, stopped_at, last_chunk_at)
		SELECT $7::uuid, NULL, u.id, 'upload', $2, u.id, u.name, 'ready', $3, $4, $5, $6, true, 100, now(), now()
		  FROM users u WHERE u.id = $1::uuid
		RETURNING id::text`,
		u.OwnerID, u.Title, mime, u.StorageKey, sizeBytes, durationMs, u.ID).Scan(&id)
	if noRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

// UploadedVideoFor is one of ownerID's uploaded videos.
func (s *Store) UploadedVideoFor(ctx context.Context, ownerID, id string) (RecordingFile, error) {
	f, err := s.RecordingFileByID(ctx, id)
	if err != nil {
		return RecordingFile{}, err
	}
	if f.Source != RecordingSourceUpload || f.OwnerID != ownerID {
		return RecordingFile{}, ErrNotFound
	}
	return f, nil
}

// UploadedVideo is ownerID's uploaded video id as the library lists it.
func (s *Store) UploadedVideo(ctx context.Context, ownerID, id string) (types.Recording, error) {
	list, err := s.HostReadyRecordings(ctx, ownerID)
	if err != nil {
		return types.Recording{}, err
	}
	for _, rec := range list {
		if rec.ID == id && rec.Source == RecordingSourceUpload {
			return rec, nil
		}
	}
	return types.Recording{}, ErrNotFound
}

// RenameUploadedVideo sets an uploaded video's title.
func (s *Store) RenameUploadedVideo(ctx context.Context, ownerID, id, title string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE recordings SET title = $3
		 WHERE id = $1::uuid AND owner_id = $2::uuid AND source = 'upload'`, id, ownerID, strings.TrimSpace(title))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* DeleteUploadedVideo removes an uploaded video's row and returns its storage key. ownerID
 * scopes it to that host; empty is the retention sweep, which deletes whoever's it is. A
 * simulive playing it loses its recording (simulive_recording_id ON DELETE SET NULL). */
func (s *Store) DeleteUploadedVideo(ctx context.Context, ownerID, id string) (string, error) {
	var key string
	err := s.pool.QueryRow(ctx, `
		DELETE FROM recordings
		 WHERE id = $1::uuid AND source = 'upload' AND ($2 = '' OR owner_id::text = $2)
		 RETURNING storage_key`, id, ownerID).Scan(&key)
	if noRows(err) {
		return "", ErrNotFound
	}
	return key, err
}
