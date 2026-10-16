package store

import (
	"context"
	"errors"
	"strings"
	"time"
)

// ErrExpired is stored media whose file has been deleted by retention.
var ErrExpired = errors.New("expired")

// CaptionRetention is how long after a webinar ends its caption rows are kept
// before the transcript is archived and the rows deleted.
const CaptionRetention = 30 * 24 * time.Hour

// maxTranscriptLines caps one transcript. Captions are at most 280 characters,
// so this is a few MB, and over five hours at one segment a second.
const maxTranscriptLines = 20000

const transcriptTruncated = "[transcript truncated]\n"

// webinarEnd is when a webinar finished: ended_at, or its scheduled end when it
// never went live.
func webinarEnd(alias string) string {
	return `COALESCE(` + alias + `.ended_at, ` + alias + `.starts_at + make_interval(mins => COALESCE(` + alias + `.duration_min, 0)))`
}

// ExpiredChatImage is a stored chat image past retention.
type ExpiredChatImage struct {
	ID  string
	Key string
}

// ChatImagesEndedBefore lists stored chat images whose webinar ended before the cutoff.
func (s *Store) ChatImagesEndedBefore(ctx context.Context, before time.Time, limit int) ([]ExpiredChatImage, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.media_key
		  FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id
		 WHERE m.media_key IS NOT NULL AND m.media_key <> '' AND m.media_expired_at IS NULL
		   AND `+webinarEnd("w")+` < $1
		 LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ExpiredChatImage
	for rows.Next() {
		var e ExpiredChatImage
		if err := rows.Scan(&e.ID, &e.Key); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkChatImageExpired records that a chat image's file was deleted.
func (s *Store) MarkChatImageExpired(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE chat_messages SET media_expired_at = now() WHERE id = $1`, id)
	return err
}

// WebinarsWithCaptionsEndedBefore lists webinars past caption retention that
// still have caption rows.
func (s *Store) WebinarsWithCaptionsEndedBefore(ctx context.Context, before time.Time, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.id::text FROM webinars w
		 WHERE `+webinarEnd("w")+` < $1
		   AND EXISTS (SELECT 1 FROM session_captions c WHERE c.webinar_id = w.id)
		 LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

/* ArchiveCaptions stores one webinar's transcript and deletes its caption rows in
 * batches. The stored text is written once (ON CONFLICT DO NOTHING) and committed
 * before any row goes, so a sweep interrupted half-way never rebuilds the archive
 * from what is left. */
func (s *Store) ArchiveCaptions(ctx context.Context, webinarID string, batch int) (int64, error) {
	text, truncated, err := s.buildTranscript(ctx, webinarID)
	if err != nil {
		return 0, err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_transcripts (webinar_id, body, truncated)
		VALUES ($1::uuid, $2, $3)
		ON CONFLICT (webinar_id) DO NOTHING`, webinarID, text, truncated); err != nil {
		return 0, err
	}
	var total int64
	for {
		tag, err := s.pool.Exec(ctx, `
			DELETE FROM session_captions WHERE id IN (
			  SELECT id FROM session_captions WHERE webinar_id = $1::uuid LIMIT $2)`, webinarID, batch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < int64(batch) || ctx.Err() != nil {
			return total, nil
		}
	}
}

func (s *Store) buildTranscript(ctx context.Context, webinarID string) (string, bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(at, 'HH24:MI:SS'), identity, body
		  FROM session_captions
		 WHERE webinar_id = $1::uuid
		 ORDER BY at, id
		 LIMIT $2`, webinarID, maxTranscriptLines+1)
	if err != nil {
		return "", false, err
	}
	defer rows.Close()
	var b strings.Builder
	n := 0
	truncated := false
	for rows.Next() {
		if n == maxTranscriptLines {
			truncated = true
			break
		}
		var at, identity, body string
		if err := rows.Scan(&at, &identity, &body); err != nil {
			return "", false, err
		}
		b.WriteString(at)
		b.WriteString(" ")
		b.WriteString(identity)
		b.WriteString(": ")
		b.WriteString(body)
		b.WriteByte('\n')
		n++
	}
	if err := rows.Err(); err != nil {
		return "", false, err
	}
	if truncated {
		b.WriteString(transcriptTruncated)
	}
	return b.String(), truncated, nil
}
