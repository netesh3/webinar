package crmstore

import (
	"context"
	"fmt"
)

/* The media library's space (migration 0113): the stored bytes of a host's library
 * files against a limit — the account's media_quota_bytes, or the deployment default.
 * Only crm_media_files rows count, so inbound WhatsApp media copies, recordings, chat
 * images and covers never do, and thumbnails (not rows of their own) do not either. */

// MediaSpace is how much of the library's space a host uses, of how much.
type MediaSpace struct {
	Used, Limit int64
}

// Remaining is what still fits; never negative.
func (m MediaSpace) Remaining() int64 {
	if m.Used >= m.Limit {
		return 0
	}
	return m.Limit - m.Used
}

// QuotaError is an upload refused because it does not fit.
type QuotaError struct {
	MediaSpace
	File int64
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("media quota: %d used of %d, file %d", e.Used, e.Limit, e.File)
}

const mediaSpaceSQL = `
	SELECT coalesce((SELECT sum(f.bytes) FROM crm_media_files f WHERE f.host_id = u.id), 0)::bigint,
	       coalesce(u.media_quota_bytes, $2)
	  FROM users u WHERE u.id = $1::uuid`

// MediaSpace is this host's use of the library, with their limit (defaultLimit unless overridden).
func (s *Store) MediaSpace(ctx context.Context, hostID string, defaultLimit int64) (MediaSpace, error) {
	var m MediaSpace
	err := s.pool.QueryRow(ctx, mediaSpaceSQL, hostID, defaultLimit).Scan(&m.Used, &m.Limit)
	return m, err
}

/* CreateMediaFileWithinQuota records an uploaded file if it fits, or returns a
 * *QuotaError. Uploads by one host take a per-host lock for the check and the insert,
 * so two racing past the limit cannot both get in: the second sees the first's bytes. */
func (s *Store) CreateMediaFileWithinQuota(ctx context.Context, m MediaFile, defaultLimit int64) (MediaFile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return m, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('crm_media_quota:' || $1, 0))`, m.HostID); err != nil {
		return m, err
	}
	var space MediaSpace
	if err := tx.QueryRow(ctx, mediaSpaceSQL, m.HostID, defaultLimit).Scan(&space.Used, &space.Limit); err != nil {
		return m, err
	}
	if space.Used+m.Bytes > space.Limit {
		return m, &QuotaError{MediaSpace: space, File: m.Bytes}
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO crm_media_files (id, host_id, storage_key, mime, filename, bytes, public_token,
		                             thumb_key, width, height)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`,
		m.ID, m.HostID, m.StorageKey, m.Mime, m.Filename, m.Bytes, m.Token,
		m.ThumbKey, m.Width, m.Height).Scan(&m.ID); err != nil {
		return m, err
	}
	return m, tx.Commit(ctx)
}
