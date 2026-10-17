package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

/* Files for WhatsApp template headers (migration 0110). The bytes live in the media
 * store under StorageKey; these rows say whose they are and how to serve them. */

// MediaFile is one uploaded header file.
type MediaFile struct {
	ID         string
	HostID     string
	StorageKey string
	Mime       string
	Filename   string
	Bytes      int64
	// Token is the unguessable path segment of its public link.
	Token string
	// ThumbKey, Width and Height are set for images (migration 0113); zero otherwise.
	ThumbKey string
	Width    int
	Height   int
}

const mediaFileColumns = `f.id::text, f.host_id::text, f.storage_key, f.mime, f.filename, f.bytes, f.public_token`

func scanMediaFile(row scanner) (MediaFile, error) {
	var m MediaFile
	err := row.Scan(&m.ID, &m.HostID, &m.StorageKey, &m.Mime, &m.Filename, &m.Bytes, &m.Token)
	return m, err
}

// CreateMediaFile records a file already written to the media store.
func (s *Store) CreateMediaFile(ctx context.Context, m MediaFile) (MediaFile, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO crm_media_files (id, host_id, storage_key, mime, filename, bytes, public_token,
		                             thumb_key, width, height)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id::text`,
		m.ID, m.HostID, m.StorageKey, m.Mime, m.Filename, m.Bytes, m.Token,
		m.ThumbKey, m.Width, m.Height).Scan(&m.ID)
	return m, err
}

// MediaFileForHost is one of this host's files. Another host's id is ErrNotFound.
func (s *Store) MediaFileForHost(ctx context.Context, hostID, id string) (MediaFile, error) {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return MediaFile{}, store.ErrNotFound
	}
	m, err := scanMediaFile(s.pool.QueryRow(ctx, `
		SELECT `+mediaFileColumns+` FROM crm_media_files f
		 WHERE f.id = $1::uuid AND f.host_id = $2::uuid`, id, hostID))
	if noRows(err) {
		return MediaFile{}, store.ErrNotFound
	}
	return m, err
}

// MediaFileByToken is the file behind a public link, for serving it.
func (s *Store) MediaFileByToken(ctx context.Context, token string) (MediaFile, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return MediaFile{}, store.ErrNotFound
	}
	m, err := scanMediaFile(s.pool.QueryRow(ctx, `
		SELECT `+mediaFileColumns+` FROM crm_media_files f WHERE f.public_token = $1`, token))
	if noRows(err) {
		return MediaFile{}, store.ErrNotFound
	}
	return m, err
}

// SetTemplateMedia makes a file the default header of one of the host's templates.
// An empty fileID clears it.
func (s *Store) SetTemplateMedia(ctx context.Context, hostID, name, language, fileID string) error {
	name, language = strings.TrimSpace(name), strings.TrimSpace(language)
	if fileID == "" {
		_, err := s.pool.Exec(ctx, `
			DELETE FROM crm_template_media WHERE host_id = $1::uuid AND name = $2 AND language = $3`,
			hostID, name, language)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO crm_template_media (host_id, name, language, file_id)
		VALUES ($1::uuid, $2, $3, $4::uuid)
		ON CONFLICT (host_id, name, language) DO UPDATE
		   SET file_id = EXCLUDED.file_id, updated_at = now()`,
		hostID, name, language, fileID)
	return err
}

// BroadcastHeader is one broadcast's header choice; zero means the template's default.
type BroadcastHeader struct {
	File     *MediaFile
	UseCover bool
	// Coupon, OfferExpiresAt and CardFiles are the broadcast's own copy-code coupon,
	// limited-time offer end, and carousel pictures (migration 0112).
	Coupon         string
	OfferExpiresAt *time.Time
	CardFiles      []MediaFile
}

// BroadcastHeaderInput is what a broadcast chooses beyond its template's defaults.
type BroadcastHeaderInput struct {
	FileID         string
	UseCover       bool
	Coupon         string
	OfferExpiresAt *time.Time
	CardFileIDs    []string
}

func (in BroadcastHeaderInput) empty() bool {
	return in.FileID == "" && !in.UseCover && in.Coupon == "" && in.OfferExpiresAt == nil && len(in.CardFileIDs) == 0
}

// setBroadcastHeader stores a broadcast's header choice in the caller's transaction.
// Neither set removes it.
func setBroadcastHeader(ctx context.Context, q store.Querier, broadcastID string, in BroadcastHeaderInput) error {
	if in.empty() {
		_, err := q.Exec(ctx, `DELETE FROM crm_broadcast_header WHERE broadcast_id = $1::uuid`, broadcastID)
		return err
	}
	cards := in.CardFileIDs
	if cards == nil {
		cards = []string{}
	}
	_, err := q.Exec(ctx, `
		INSERT INTO crm_broadcast_header (broadcast_id, file_id, use_cover, coupon_code, offer_expires_at, card_file_ids)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, $3, $4, $5, $6::uuid[])
		ON CONFLICT (broadcast_id) DO UPDATE
		   SET file_id = EXCLUDED.file_id, use_cover = EXCLUDED.use_cover,
		       coupon_code = EXCLUDED.coupon_code, offer_expires_at = EXCLUDED.offer_expires_at,
		       card_file_ids = EXCLUDED.card_file_ids`,
		broadcastID, in.FileID, in.UseCover, strings.TrimSpace(in.Coupon), in.OfferExpiresAt, cards)
	return err
}

// BroadcastHeaderFor reads one broadcast's header choice.
func (s *Store) BroadcastHeaderFor(ctx context.Context, broadcastID string) (BroadcastHeader, error) {
	var (
		h        BroadcastHeader
		fileID   *string
		m        MediaFile
		key, tok *string
		mime, fn *string
		bytes    *int64
		hostID   *string
	)
	var cardIDs []string
	err := s.pool.QueryRow(ctx, `
		SELECT bh.use_cover, f.id::text, f.host_id::text, f.storage_key, f.mime, f.filename, f.bytes, f.public_token,
		       bh.coupon_code, bh.offer_expires_at, bh.card_file_ids::text[]
		  FROM crm_broadcast_header bh
		  LEFT JOIN crm_media_files f ON f.id = bh.file_id
		 WHERE bh.broadcast_id = $1::uuid`, broadcastID).
		Scan(&h.UseCover, &fileID, &hostID, &key, &mime, &fn, &bytes, &tok,
			&h.Coupon, &h.OfferExpiresAt, &cardIDs)
	if noRows(err) {
		return BroadcastHeader{}, nil
	}
	if err != nil {
		return BroadcastHeader{}, err
	}
	if fileID != nil {
		m = MediaFile{ID: *fileID, HostID: *hostID, StorageKey: *key, Mime: *mime, Filename: *fn, Bytes: *bytes, Token: *tok}
		h.File = &m
	}
	if len(cardIDs) > 0 {
		rows, err := s.pool.Query(ctx, `
			SELECT `+mediaFileColumns+` FROM crm_media_files f WHERE f.id = ANY($1::uuid[])`, cardIDs)
		if err != nil {
			return BroadcastHeader{}, err
		}
		defer rows.Close()
		byID := map[string]MediaFile{}
		for rows.Next() {
			mf, err := scanMediaFile(rows)
			if err != nil {
				return BroadcastHeader{}, err
			}
			byID[mf.ID] = mf
		}
		if err := rows.Err(); err != nil {
			return BroadcastHeader{}, err
		}
		for _, id := range cardIDs {
			if mf, ok := byID[id]; ok {
				h.CardFiles = append(h.CardFiles, mf)
			}
		}
	}
	return h, nil
}

// JoinKey is how to build one registrant's personal join link.
type JoinKey struct {
	JoinKey string
	ZoomURL string
}

/* ContactJoinKeys maps each of this webinar's contacts to their registration's join key,
 * filed the same way the webinar audience files them (pickContactForRegistration), in
 * one query — a broadcast to four thousand people should not do eight thousand
 * single-row lookups for a merge field. */
func (s *Store) ContactJoinKeys(ctx context.Context, hostID, slug string) (map[string]JoinKey, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pick.id::text, r.join_key, coalesce(r.zoom_join_url, '')
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		  CROSS JOIN LATERAL (`+pickContactForRegistration+`) pick
		 WHERE w.slug = $2 AND w.host_id = $1::uuid AND r.state <> 'declined'
		 ORDER BY r.created_at`, hostID, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]JoinKey{}
	for rows.Next() {
		var id string
		var k JoinKey
		if err := rows.Scan(&id, &k.JoinKey, &k.ZoomURL); err != nil {
			return nil, err
		}
		if _, seen := out[id]; !seen {
			out[id] = k
		}
	}
	return out, rows.Err()
}
