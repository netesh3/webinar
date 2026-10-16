package crmstore

import (
	"context"
	"errors"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

// MediaFetchWindow is how far back the tick looks for attachments to copy. Meta
// keeps inbound media for about 30 days; past that a download only fails.
const MediaFetchWindow = 25 * 24 * time.Hour

// MediaCopyRetention is how long our copy of an attachment is kept.
const MediaCopyRetention = 90 * 24 * time.Hour

// MaxMediaFetchAttempts is how often a failing download is retried before the
// message is left to the Graph fallback.
const MaxMediaFetchAttempts = 5

// mediaRetryAfter spaces out retries of one attachment.
const mediaRetryAfter = 10 * time.Minute

// MediaFetch is one attachment the tick still has to copy.
type MediaFetch struct {
	MessageID string
	HostID    string
	MediaID   string
	MimeType  string
	Token     string
}

// MediaCopy is what we hold for one message's attachment.
type MediaCopy struct {
	Key      string
	MimeType string
	Bytes    int64
	Expired  bool
}

// PendingMediaFetches lists recent attachments with no finished copy, newest
// first, for hosts whose WhatsApp connection is still good.
func (s *Store) PendingMediaFetches(ctx context.Context, limit int) ([]MediaFetch, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id::text, m.host_id::text, m.media->>'id', COALESCE(m.media->>'mimeType', ''),
		       u.whatsapp_access_token
		  FROM crm_messages m
		  JOIN users u ON u.id = m.host_id
		  LEFT JOIN crm_message_media c ON c.message_id = m.id
		 WHERE m.media ? 'id' AND m.media->>'id' <> ''
		   AND m.created_at > $1
		   AND u.whatsapp_access_token <> '' AND u.whatsapp_token_rejected_at IS NULL
		   AND (c.message_id IS NULL
		        OR (c.storage_key = '' AND c.expired_at IS NULL
		            AND c.attempts < $2 AND c.updated_at < $3))
		 ORDER BY m.created_at DESC
		 LIMIT $4`,
		time.Now().Add(-MediaFetchWindow), MaxMediaFetchAttempts, time.Now().Add(-mediaRetryAfter), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MediaFetch
	for rows.Next() {
		var f MediaFetch
		if err := rows.Scan(&f.MessageID, &f.HostID, &f.MediaID, &f.MimeType, &f.Token); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// MarkMediaStored records a finished copy.
func (s *Store) MarkMediaStored(ctx context.Context, messageID, hostID, key, mime string, bytes int64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO crm_message_media (message_id, host_id, storage_key, mime, bytes, attempts, stored_at, updated_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, 1, now(), now())
		ON CONFLICT (message_id) DO UPDATE
		   SET storage_key = EXCLUDED.storage_key, mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
		       attempts = crm_message_media.attempts + 1, last_error = '',
		       stored_at = now(), expired_at = NULL, updated_at = now()`,
		messageID, hostID, key, mime, bytes)
	return err
}

// MarkMediaFailed records a failed download. gone means Meta no longer has the
// file; final means retrying will not help (too large to copy). Either stops retries.
func (s *Store) MarkMediaFailed(ctx context.Context, messageID, hostID, reason string, gone, final bool) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO crm_message_media (message_id, host_id, attempts, last_error, expired_at, updated_at)
		VALUES ($1::uuid, $2::uuid, CASE WHEN $5 THEN $6 ELSE 1 END, $3, CASE WHEN $4 THEN now() END, now())
		ON CONFLICT (message_id) DO UPDATE
		   SET attempts = CASE WHEN $5 THEN GREATEST(crm_message_media.attempts + 1, $6)
		                       ELSE crm_message_media.attempts + 1 END,
		       last_error = EXCLUDED.last_error,
		       expired_at = COALESCE(crm_message_media.expired_at, EXCLUDED.expired_at),
		       updated_at = now()`,
		messageID, hostID, reason, gone, final, MaxMediaFetchAttempts)
	return err
}

// MessageMediaCopy is this host's copy of one message's attachment. ErrNotFound
// means no row yet (the Graph fallback still applies).
func (s *Store) MessageMediaCopy(ctx context.Context, hostID, messageID string) (MediaCopy, error) {
	var c MediaCopy
	err := s.pool.QueryRow(ctx, `
		SELECT storage_key, mime, bytes, expired_at IS NOT NULL
		  FROM crm_message_media
		 WHERE message_id = $1::uuid AND host_id = $2::uuid`, messageID, hostID).
		Scan(&c.Key, &c.MimeType, &c.Bytes, &c.Expired)
	if noRows(err) {
		return MediaCopy{}, store.ErrNotFound
	}
	return c, err
}

// ExpiredMediaCopy is one stored file past retention.
type ExpiredMediaCopy struct {
	MessageID string
	Key       string
}

// MediaCopiesStoredBefore lists stored files older than the cutoff.
func (s *Store) MediaCopiesStoredBefore(ctx context.Context, before time.Time, limit int) ([]ExpiredMediaCopy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT message_id::text, storage_key FROM crm_message_media
		 WHERE storage_key <> '' AND stored_at < $1
		 ORDER BY stored_at
		 LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ExpiredMediaCopy
	for rows.Next() {
		var e ExpiredMediaCopy
		if err := rows.Scan(&e.MessageID, &e.Key); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkMediaCopyExpired clears the key once its file is deleted.
func (s *Store) MarkMediaCopyExpired(ctx context.Context, messageID string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_message_media
		   SET storage_key = '', expired_at = now(), updated_at = now()
		 WHERE message_id = $1::uuid`, messageID)
	if err == nil && tag.RowsAffected() == 0 {
		return errors.New("media copy row missing")
	}
	return err
}
