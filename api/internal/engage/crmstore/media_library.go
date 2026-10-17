package crmstore

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

/* The media library: a host's uploaded template files, listed for the gallery
 * (migration 0113), with where each one is still used so deleting it cannot break a
 * template or a broadcast that has not gone out yet. */

// LibraryFile is one file as the gallery lists it.
type LibraryFile struct {
	MediaFile
	CreatedAt time.Time
}

// LibraryQuery narrows a gallery page. Mimes empty means every type.
type LibraryQuery struct {
	Mimes  []string
	Search string
	Cursor string
	Limit  int
}

// LibraryPage is one page, newest first; NextCursor is empty on the last.
type LibraryPage struct {
	Files      []LibraryFile
	NextCursor string
}

// MaxLibraryPage is the most files one gallery request returns.
const MaxLibraryPage = 60

const libraryColumns = mediaFileColumns + `, f.thumb_key, f.width, f.height, f.created_at`

func scanLibraryFile(row scanner) (LibraryFile, error) {
	var f LibraryFile
	err := row.Scan(&f.ID, &f.HostID, &f.StorageKey, &f.Mime, &f.Filename, &f.Bytes, &f.Token,
		&f.ThumbKey, &f.Width, &f.Height, &f.CreatedAt)
	return f, err
}

func encodeLibraryCursor(at time.Time, id string) string {
	raw := strconv.FormatInt(at.UTC().UnixNano(), 10) + "|" + id
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeLibraryCursor(c string) (time.Time, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(c))
	if err != nil {
		return time.Time{}, "", fmt.Errorf("%w: cursor", store.ErrInvalid)
	}
	at, id, ok := strings.Cut(string(raw), "|")
	n, perr := strconv.ParseInt(at, 10, 64)
	if !ok || perr != nil || !uuidPattern.MatchString(id) {
		return time.Time{}, "", fmt.Errorf("%w: cursor", store.ErrInvalid)
	}
	return time.Unix(0, n).UTC(), id, nil
}

// ListLibrary is one page of this host's files, newest first.
func (s *Store) ListLibrary(ctx context.Context, hostID string, q LibraryQuery) (LibraryPage, error) {
	limit := q.Limit
	if limit <= 0 || limit > MaxLibraryPage {
		limit = MaxLibraryPage
	}
	var (
		afterAt *time.Time
		afterID *string
	)
	if strings.TrimSpace(q.Cursor) != "" {
		at, id, err := decodeLibraryCursor(q.Cursor)
		if err != nil {
			return LibraryPage{}, err
		}
		afterAt, afterID = &at, &id
	}
	mimes := q.Mimes
	if mimes == nil {
		mimes = []string{}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+libraryColumns+` FROM crm_media_files f
		 WHERE f.host_id = $1::uuid
		   AND (cardinality($2::text[]) = 0 OR f.mime = ANY($2::text[]))
		   AND ($3 = '' OR f.filename ILIKE '%' || $3 || '%')
		   AND ($4::timestamptz IS NULL OR (f.created_at, f.id) < ($4::timestamptz, $5::uuid))
		 ORDER BY f.created_at DESC, f.id DESC
		 LIMIT $6`,
		hostID, mimes, escapeLike(strings.TrimSpace(q.Search)), afterAt, afterID, limit+1)
	if err != nil {
		return LibraryPage{}, err
	}
	defer rows.Close()
	var page LibraryPage
	for rows.Next() {
		f, err := scanLibraryFile(rows)
		if err != nil {
			return LibraryPage{}, err
		}
		page.Files = append(page.Files, f)
	}
	if err := rows.Err(); err != nil {
		return LibraryPage{}, err
	}
	if len(page.Files) > limit {
		page.Files = page.Files[:limit]
		last := page.Files[limit-1]
		page.NextCursor = encodeLibraryCursor(last.CreatedAt, last.ID)
	}
	return page, nil
}

// escapeLike makes a search term literal inside ILIKE.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// LibraryFileForHost is one of this host's files with its library fields.
func (s *Store) LibraryFileForHost(ctx context.Context, hostID, id string) (LibraryFile, error) {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return LibraryFile{}, store.ErrNotFound
	}
	f, err := scanLibraryFile(s.pool.QueryRow(ctx, `
		SELECT `+libraryColumns+` FROM crm_media_files f
		 WHERE f.id = $1::uuid AND f.host_id = $2::uuid`, id, hostID))
	if noRows(err) {
		return LibraryFile{}, store.ErrNotFound
	}
	return f, err
}

// LibraryFilesForHost are these of this host's files; ids that are not theirs are left out.
func (s *Store) LibraryFilesForHost(ctx context.Context, hostID string, ids []string) ([]LibraryFile, error) {
	valid := make([]string, 0, len(ids))
	for _, id := range ids {
		if uuidPattern.MatchString(strings.TrimSpace(id)) {
			valid = append(valid, strings.TrimSpace(id))
		}
	}
	if len(valid) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+libraryColumns+` FROM crm_media_files f
		 WHERE f.host_id = $1::uuid AND f.id = ANY($2::uuid[])`, hostID, valid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LibraryFile
	for rows.Next() {
		f, err := scanLibraryFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ThumbKeyByToken is the thumbnail of the file behind a public link, "" for none.
func (s *Store) ThumbKeyByToken(ctx context.Context, token string) (string, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return "", store.ErrNotFound
	}
	var key string
	err := s.pool.QueryRow(ctx,
		`SELECT thumb_key FROM crm_media_files WHERE public_token = $1`, token).Scan(&key)
	if noRows(err) {
		return "", store.ErrNotFound
	}
	return key, err
}

// SetMediaThumb records a thumbnail made after the upload (images from before 0113).
func (s *Store) SetMediaThumb(ctx context.Context, id, thumbKey string, width, height int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_media_files SET thumb_key = $2, width = $3, height = $4 WHERE id = $1::uuid`,
		id, thumbKey, width, height)
	return err
}

// RenameMediaFile changes the name the gallery shows and a document is sent with.
func (s *Store) RenameMediaFile(ctx context.Context, hostID, id, filename string) error {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return store.ErrNotFound
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_media_files SET filename = $3 WHERE id = $1::uuid AND host_id = $2::uuid`,
		id, hostID, filename)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

// DeleteMediaRow removes the record of a file whose bytes are already gone.
func (s *Store) DeleteMediaRow(ctx context.Context, hostID, id string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM crm_media_files WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID)
	return err
}

// MediaUsage is one place a file is still used.
type MediaUsage struct {
	// Kind is template, carousel (a card of a template) or broadcast.
	Kind     string
	Name     string
	Language string
	// ScheduledAt is a broadcast's send time.
	ScheduledAt *time.Time
}

/* unsentBroadcast is a broadcast that can still send: not cancelled or deleted, and
 * either due later or with messages still queued. A sent broadcast's file is history
 * and does not hold the file back. */
const unsentBroadcast = `b.canceled_at IS NULL AND b.deleted_at IS NULL
	AND (b.scheduled_at > now() OR EXISTS (
	     SELECT 1 FROM notifications n WHERE n.broadcast_id = b.id AND n.delivery = 'pending'))`

/* MediaUsages maps each of these file ids to where it is used: a template's default
 * header, a carousel card of a template, or a broadcast that has not gone out. Only
 * templates still in the host's synced list count — a template deleted in WhatsApp
 * Manager no longer sends anything. */
func (s *Store) MediaUsages(ctx context.Context, hostID string, ids []string) (map[string][]MediaUsage, error) {
	out := map[string][]MediaUsage{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT tm.file_id::text, 'template', tm.name, tm.language, NULL::timestamptz
		  FROM crm_template_media tm
		  JOIN crm_templates t ON t.host_id = tm.host_id AND t.name = tm.name AND t.language = tm.language
		 WHERE tm.host_id = $1::uuid AND tm.file_id = ANY($2::uuid[])
		UNION ALL
		SELECT card::text, 'carousel', d.name, d.language, NULL::timestamptz
		  FROM crm_template_defaults d
		  JOIN crm_templates t ON t.host_id = d.host_id AND t.name = d.name AND t.language = d.language
		 CROSS JOIN LATERAL unnest(d.card_file_ids) AS card
		 WHERE d.host_id = $1::uuid AND card = ANY($2::uuid[])
		UNION ALL
		SELECT bh.file_id::text, 'broadcast', b.name, '', b.scheduled_at
		  FROM crm_broadcast_header bh
		  JOIN crm_broadcasts b ON b.id = bh.broadcast_id
		 WHERE b.host_id = $1::uuid AND bh.file_id = ANY($2::uuid[]) AND `+unsentBroadcast+`
		UNION ALL
		SELECT card::text, 'broadcast', b.name, '', b.scheduled_at
		  FROM crm_broadcast_header bh
		  JOIN crm_broadcasts b ON b.id = bh.broadcast_id
		 CROSS JOIN LATERAL unnest(bh.card_file_ids) AS card
		 WHERE b.host_id = $1::uuid AND card = ANY($2::uuid[]) AND `+unsentBroadcast+`
		 ORDER BY 2, 3`, hostID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var u MediaUsage
		if err := rows.Scan(&id, &u.Kind, &u.Name, &u.Language, &u.ScheduledAt); err != nil {
			return nil, err
		}
		out[id] = append(out[id], u)
	}
	return out, rows.Err()
}
