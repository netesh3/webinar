package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/netkumar/webcast/api/types"
)

/* Recording metadata.
 *
 * The bytes are in object storage; these rows are what make them findable and
 * accountable. Two invariants live in the database rather than in a handler:
 * only one recording per webinar may be active (a partial unique index), and a
 * recording always belongs to a webinar (a cascading foreign key, so deleting a
 * webinar cannot leave orphans nobody will ever look at).
 */

// staleAfter is how long a recording may go without receiving bytes before it is
// treated as abandoned. The recorder uploads every few seconds, so a gap this
// long means the tab is gone — closed, crashed, or asleep on a laptop lid.
const staleAfter = 90 * time.Second

// StartRecording claims the single active slot for a webinar.
//
// Returns ErrConflict when somebody else is already recording, which is the
// database's answer and not a guess: two panelists pressing record in the same
// second both reach the unique index, and exactly one of them wins.
// The id is supplied by the caller rather than defaulted by the database, so the
// storage key can be derived from it before the row exists — one value, one place,
// no follow-up UPDATE to keep them in step.
func (s *Store) StartRecording(
	ctx context.Context, slug, id, userID, userName, mime, storageKey string,
) (types.Recording, error) {
	// An abandoned recording holds the slot forever otherwise. Marked failed
	// rather than deleted: the partial file is worth keeping for triage, and a
	// host who sees "failed" learns something a missing row would not tell them.
	if _, err := s.pool.Exec(ctx, `
		UPDATE recordings r SET status = 'failed', stopped_at = now()
		  FROM webinars w
		 WHERE w.id = r.webinar_id AND w.slug = $1
		   AND r.status = 'recording'
		   AND (r.egress_id IS NULL OR r.egress_id = '')
		   AND r.last_chunk_at < now() - $2::interval`,
		slug, staleAfter.String()); err != nil {
		return types.Recording{}, err
	}

	var (
		rec       types.Recording
		createdAt time.Time
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO recordings (id, webinar_id, started_by, started_by_name, mime, storage_key)
		SELECT $2::uuid, w.id, $3::uuid, $4, $5, $6 FROM webinars w WHERE w.slug = $1
		RETURNING id::text, status, mime, size_bytes, duration_ms, started_by_name, created_at`,
		slug, id, nullUUID(userID), userName, mime, storageKey,
	).Scan(&rec.ID, &rec.Status, &rec.Mime, &rec.SizeBytes, &rec.DurationMs,
		&rec.StartedBy, &createdAt)

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
		return types.Recording{}, ErrConflict
	}
	if noRows(err) {
		// The INSERT ... SELECT found no webinar with that slug.
		return types.Recording{}, ErrNotFound
	}
	if err != nil {
		return types.Recording{}, err
	}
	rec.Webinar = slug
	rec.CreatedAt = createdAt.Format(time.RFC3339)
	rec.IsPublic = true
	return rec, nil
}

// RecordingFile is the little that a chunk upload or a download needs: where the
// bytes go, whether this recording is still open, and how big it already is.
type RecordingFile struct {
	ID              string
	StorageKey      string
	Mime            string
	Status          types.RecordingStatus
	SizeBytes       int64
	DurationMs      int64
	StartedBy       string
	Topic           string
	CreatedAt       time.Time
	EgressID        string
	Webinar         string
	IsPublic        bool
	Passcode        string
	WebinarPasscode string
	HostName        string
}

// RecordingFor loads one recording, scoped to the webinar in the URL.
//
// The slug is part of the query rather than checked afterwards: an id from one
// webinar must not be usable against another, and the safest way to guarantee
// that is to make the database enforce it.
func (s *Store) RecordingFor(ctx context.Context, slug, id string) (RecordingFile, error) {
	var f RecordingFile
	err := s.pool.QueryRow(ctx, `
		SELECT r.id::text, r.storage_key, r.mime, r.status, r.size_bytes, r.duration_ms,
		       r.started_by_name, w.topic, r.created_at, COALESCE(r.egress_id, ''), w.slug,
		       COALESCE(r.is_public, true), COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(u.name, 'Host')
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE w.slug = $1 AND r.id = $2::uuid`, slug, id,
	).Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
		&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
		&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName)
	if noRows(err) {
		return RecordingFile{}, ErrNotFound
	}
	if err != nil {
		return RecordingFile{}, err
	}
	return f, nil
}

// RecordedBytes records that a chunk landed. size is the object's new total,
// reported by the storage backend, so the row cannot drift from the file.
func (s *Store) RecordedBytes(ctx context.Context, id string, size int64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings SET size_bytes = $2, last_chunk_at = now()
		 WHERE id = $1::uuid AND status = 'recording'`, id, size)
	return err
}

// FinishRecording closes a recording. An empty one is marked failed: a zero-byte
// file listed as "ready" is a download that disappoints someone later.
func (s *Store) FinishRecording(ctx context.Context, id string, durationMs int64) (types.RecordingStatus, error) {
	var status types.RecordingStatus
	err := s.pool.QueryRow(ctx, `
		UPDATE recordings
		   SET status = CASE WHEN size_bytes > 0 THEN 'ready' ELSE 'failed' END,
		       duration_ms = GREATEST(duration_ms, $2),
		       stopped_at = now()
		 WHERE id = $1::uuid AND status = 'recording'
		 RETURNING status`, id, durationMs).Scan(&status)
	if noRows(err) {
		return "", ErrNotFound
	}
	return status, err
}

// SetEgressID associates a server-side LiveKit Egress ID with a recording.
func (s *Store) SetEgressID(ctx context.Context, id, egressID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings
		   SET egress_id = $2
		 WHERE id = $1::uuid`, id, egressID)
	return err
}

// RecordingByEgressID loads one recording by its LiveKit Egress ID.
func (s *Store) RecordingByEgressID(ctx context.Context, egressID string) (RecordingFile, error) {
	var f RecordingFile
	err := s.pool.QueryRow(ctx, `
		SELECT r.id::text, r.storage_key, r.mime, r.status, r.size_bytes, r.duration_ms,
		       r.started_by_name, w.topic, r.created_at, COALESCE(r.egress_id, ''), w.slug,
		       COALESCE(r.is_public, true), COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(u.name, 'Host')
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE r.egress_id = $1`, egressID,
	).Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
		&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
		&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName)
	if noRows(err) {
		return RecordingFile{}, ErrNotFound
	}
	if err != nil {
		return RecordingFile{}, err
	}
	return f, nil
}

// FinishRecordingWithStats closes a recording with explicit size and duration from Egress.
func (s *Store) FinishRecordingWithStats(ctx context.Context, id string, sizeBytes, durationMs int64) (types.RecordingStatus, error) {
	var status types.RecordingStatus
	err := s.pool.QueryRow(ctx, `
		UPDATE recordings
		   SET status = CASE WHEN $2 > 0 OR size_bytes > 0 THEN 'ready' ELSE 'failed' END,
		       size_bytes = GREATEST(size_bytes, $2),
		       duration_ms = GREATEST(duration_ms, $3),
		       stopped_at = now()
		 WHERE id = $1::uuid AND status IN ('recording', 'failed')
		 RETURNING status`, id, sizeBytes, durationMs).Scan(&status)
	if noRows(err) {
		return "", ErrNotFound
	}
	return status, err
}

// FinishActiveRecordings closes whatever is still open on a webinar. Called when
// the session ends: the room is about to be deleted, so nothing more is coming.
func (s *Store) FinishActiveRecordings(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings r
		   SET status = CASE WHEN r.size_bytes > 0 THEN 'ready' ELSE 'failed' END,
		       stopped_at = now()
		  FROM webinars w
		 WHERE w.id = r.webinar_id AND w.slug = $1 AND r.status = 'recording'`, slug)
	return err
}

// ActiveRecording reports whether a webinar is being recorded right now.
//
// Used to build the room metadata every client reads, so the "recording"
// indicator is the server's answer rather than each browser's guess. A recording
// whose uploader vanished does not count.
func (s *Store) ActiveRecording(ctx context.Context, slug string) (bool, error) {
	var live bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM recordings r JOIN webinars w ON w.id = r.webinar_id
		   WHERE w.slug = $1 AND r.status = 'recording'
		     AND (r.egress_id IS NOT NULL OR r.last_chunk_at > now() - $2::interval))`,
		slug, staleAfter.String()).Scan(&live)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	return live, nil
}

// Recordings lists a webinar's recordings, newest first.
func (s *Store) Recordings(ctx context.Context, slug string) ([]types.Recording, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, w.slug, w.topic, r.status, r.mime, r.size_bytes,
		       r.duration_ms, r.started_by_name, r.created_at, r.stopped_at,
		       COALESCE(r.egress_id, ''), COALESCE(r.is_public, true),
		       COALESCE(r.passcode, ''), COALESCE(w.passcode, '')
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1
		 ORDER BY r.created_at DESC
		 LIMIT 200`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.Recording{}
	for rows.Next() {
		var (
			rec             types.Recording
			createdAt       time.Time
			stoppedAt       *time.Time
			webinarPasscode string
		)
		if err := rows.Scan(&rec.ID, &rec.Webinar, &rec.Topic, &rec.Status, &rec.Mime,
			&rec.SizeBytes, &rec.DurationMs, &rec.StartedBy, &createdAt, &stoppedAt,
			&rec.EgressID, &rec.IsPublic, &rec.Passcode, &webinarPasscode); err != nil {
			return nil, err
		}
		rec.CreatedAt = createdAt.Format(time.RFC3339)
		if stoppedAt != nil {
			rec.StoppedAt = stoppedAt.Format(time.RFC3339)
		}
		rec.Ext = ExtForMime(rec.Mime)
		effectivePass := strings.TrimSpace(rec.Passcode)
		if effectivePass == "" {
			effectivePass = strings.TrimSpace(webinarPasscode)
		}
		rec.PasscodeRequired = effectivePass != ""
		out = append(out, rec)
	}
	return out, rows.Err()
}

// UpdateRecordingShareSettings updates public access and optional passcode for a recording.
func (s *Store) UpdateRecordingShareSettings(ctx context.Context, slug, id string, isPublic *bool, passcode *string) (types.Recording, error) {
	setClauses := []string{}
	args := []any{slug, id}

	if isPublic != nil {
		args = append(args, *isPublic)
		setClauses = append(setClauses, "is_public = $"+strconv.Itoa(len(args)))
	}
	if passcode != nil {
		args = append(args, strings.TrimSpace(*passcode))
		setClauses = append(setClauses, "passcode = $"+strconv.Itoa(len(args)))
	}

	if len(setClauses) == 0 {
		list, err := s.Recordings(ctx, slug)
		if err != nil {
			return types.Recording{}, err
		}
		for _, r := range list {
			if r.ID == id {
				return r, nil
			}
		}
		return types.Recording{}, ErrNotFound
	}

	query := `
		UPDATE recordings r
		   SET ` + strings.Join(setClauses, ", ") + `
		  FROM webinars w
		 WHERE w.id = r.webinar_id AND w.slug = $1 AND r.id = $2::uuid
		 RETURNING r.id::text, w.slug, w.topic, r.status, r.mime, r.size_bytes,
		           r.duration_ms, r.started_by_name, r.created_at, r.stopped_at,
		           COALESCE(r.egress_id, ''), COALESCE(r.is_public, true),
		           COALESCE(r.passcode, ''), COALESCE(w.passcode, '')`

	var (
		rec             types.Recording
		createdAt       time.Time
		stoppedAt       *time.Time
		webinarPasscode string
	)
	err := s.pool.QueryRow(ctx, query, args...).Scan(
		&rec.ID, &rec.Webinar, &rec.Topic, &rec.Status, &rec.Mime,
		&rec.SizeBytes, &rec.DurationMs, &rec.StartedBy, &createdAt, &stoppedAt,
		&rec.EgressID, &rec.IsPublic, &rec.Passcode, &webinarPasscode,
	)
	if noRows(err) {
		return types.Recording{}, ErrNotFound
	}
	if err != nil {
		return types.Recording{}, err
	}
	rec.CreatedAt = createdAt.Format(time.RFC3339)
	if stoppedAt != nil {
		rec.StoppedAt = stoppedAt.Format(time.RFC3339)
	}
	rec.Ext = ExtForMime(rec.Mime)
	effectivePass := strings.TrimSpace(rec.Passcode)
	if effectivePass == "" {
		effectivePass = strings.TrimSpace(webinarPasscode)
	}
	rec.PasscodeRequired = effectivePass != ""
	return rec, nil
}

// DeleteRecording removes the row and reports the storage key, so the caller can
// delete the bytes. Row first: an orphaned file wastes disk, an orphaned row is a
// download that 404s halfway through.
func (s *Store) DeleteRecording(ctx context.Context, slug, id string) (string, error) {
	var key string
	err := s.pool.QueryRow(ctx, `
		DELETE FROM recordings r
		 USING webinars w
		 WHERE w.id = r.webinar_id AND w.slug = $1 AND r.id = $2::uuid
		 RETURNING r.storage_key`, slug, id).Scan(&key)
	if noRows(err) {
		return "", ErrNotFound
	}
	return key, err
}

// ExtForMime maps a recording container onto a file extension.
//
// Browsers disagree about what they can record — Safari produces MP4, Chrome
// WebM — so the extension follows the bytes rather than a guess. Anything
// unrecognised gets .bin, which is honest: better a file somebody has to identify
// than one named .mp4 that no player will open.
func ExtForMime(mime string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	switch base {
	case "video/mp4":
		return "mp4"
	case "video/webm":
		return "webm"
	case "audio/webm":
		return "weba"
	case "audio/mp4":
		return "m4a"
	}
	return "bin"
}

// nullUUID turns an empty id into a SQL NULL. A recording started by an account
// that is later deleted keeps its row.
func nullUUID(id string) any {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	return id
}
