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
		 WHERE w.id = r.webinar_id AND (w.slug = $1 OR w.id::text = $1)
		   AND r.status = 'recording'
		   AND (r.egress_id IS NULL OR r.egress_id = '')
		   AND r.last_chunk_at < now() - $2::interval`,
		slug, staleAfter.String()); err != nil {
		return types.Recording{}, err
	}

	// A webinar has one session. The first press of Record creates it; later
	// presses add a part hanging off that row. Egress and MediaRecorder both
	// finalise a container on stop, so a new file is unavoidable — hiding it
	// behind the original row is what stops the host's list from growing by one
	// every time they pause.
	parentID, err := s.sessionParentID(ctx, slug)
	if err != nil {
		return types.Recording{}, err
	}

	var (
		rec       types.Recording
		createdAt time.Time
	)
	err = s.pool.QueryRow(ctx, `
		INSERT INTO recordings (
		         id, webinar_id, started_by, started_by_name, mime, storage_key,
		         uploaded_to_s3, parent_id, is_public, passcode)
		SELECT $2::uuid, w.id, $3::uuid, $4, $5, $6, false,
		       NULLIF($7, '')::uuid,
		       COALESCE(p.is_public, true),
		       COALESCE(p.passcode, '')
		  FROM webinars w
		  LEFT JOIN recordings p ON p.id = NULLIF($7, '')::uuid
		 WHERE (w.slug = $1 OR w.id::text = $1)
		RETURNING id::text, status, mime, size_bytes, duration_ms, started_by_name, created_at, COALESCE(uploaded_to_s3, false)`,
		slug, id, nullUUID(userID), userName, mime, storageKey, parentID,
	).Scan(&rec.ID, &rec.Status, &rec.Mime, &rec.SizeBytes, &rec.DurationMs,
		&rec.StartedBy, &createdAt, &rec.UploadedToS3)

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

// sessionParentID is the first recording on a webinar, if any. Later takes hang
// off it. Empty string means this start will create the session itself.
func (s *Store) sessionParentID(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		SELECT r.id::text
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE (w.slug = $1 OR w.id::text = $1) AND r.parent_id IS NULL
		 ORDER BY r.created_at ASC, r.id ASC
		 LIMIT 1`, slug).Scan(&id)
	if noRows(err) {
		return "", nil
	}
	return id, err
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
	UploadedToS3    bool
	UploadPercent   int
	ParentID        string
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
		       COALESCE(u.name, 'Host'), COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0)
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE (w.slug = $1 OR w.id::text = $1) AND r.id = $2::uuid`, slug, id,
	).Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
		&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
		&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName, &f.UploadedToS3, &f.UploadPercent)
	if noRows(err) {
		return RecordingFile{}, ErrNotFound
	}
	if err != nil {
		return RecordingFile{}, err
	}
	return f, nil
}

// ActiveRecordingFile returns the active recording file for a webinar if one exists.
func (s *Store) ActiveRecordingFile(ctx context.Context, slug string) (RecordingFile, error) {
	var f RecordingFile
	err := s.pool.QueryRow(ctx, `
		SELECT r.id::text, r.storage_key, r.mime, r.status, r.size_bytes, r.duration_ms,
		       r.started_by_name, w.topic, r.created_at, COALESCE(r.egress_id, ''), w.slug,
		       COALESCE(r.is_public, true), COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(u.name, 'Host'), COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0)
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE (w.slug = $1 OR w.id::text = $1) AND r.status = 'recording'
		 ORDER BY r.created_at DESC
		 LIMIT 1`, slug,
	).Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
		&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
		&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName, &f.UploadedToS3, &f.UploadPercent)
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

// UpdateUploadProgress updates the upload percentage of a recording being uploaded to S3.
func (s *Store) UpdateUploadProgress(ctx context.Context, id string, percent int) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings
		   SET upload_percent = $2
		 WHERE id = $1::uuid AND status IN ('recording', 'processing')`, id, percent)
	return err
}

// MarkRecordingProcessing moves a recording from recording to processing while S3 upload finalizes.
func (s *Store) MarkRecordingProcessing(ctx context.Context, id string, durationMs int64) (types.RecordingStatus, error) {
	var status types.RecordingStatus
	err := s.pool.QueryRow(ctx, `
		UPDATE recordings
		   SET status = CASE WHEN size_bytes > 0 OR egress_id IS NOT NULL THEN 'processing' ELSE 'failed' END,
		       duration_ms = GREATEST(duration_ms, $2),
		       stopped_at = now()
		 WHERE id = $1::uuid AND status = 'recording'
		 RETURNING status`, id, durationMs).Scan(&status)
	if noRows(err) {
		return "", ErrNotFound
	}
	return status, err
}

// MarkRecordingUploaded marks a recording as ready and confirmed uploaded to S3.
func (s *Store) MarkRecordingUploaded(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings
		   SET status = 'ready',
		       uploaded_to_s3 = true,
		       upload_percent = 100,
		       stopped_at = COALESCE(stopped_at, now())
		 WHERE id = $1::uuid`, id)
	return err
}

// MarkRecordingFailed marks a recording as failed if upload or processing aborted.
func (s *Store) MarkRecordingFailed(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings
		   SET status = 'failed'
		 WHERE id = $1::uuid`, id)
	return err
}

// FinishRecording closes a recording. An empty one is marked failed: a zero-byte
// file listed as "ready" is a download that disappoints someone later.
//
// A server-side Egress recording is the exception, and the reason this is not a
// two-way switch. Its bytes are uploaded by LiveKit after the egress stops, so
// zero bytes here means "not uploaded yet", not "nothing was captured". Such a
// row goes to processing and waits for the EGRESS_ENDED webhook (or the
// reconciler) to supply the real size — calling it ready at this point is what
// produced rows showing "Ready · 0 MB" with no playable file behind them.
func (s *Store) FinishRecording(ctx context.Context, id string, durationMs int64) (types.RecordingStatus, error) {
	var status types.RecordingStatus
	err := s.pool.QueryRow(ctx, `
		UPDATE recordings
		   SET status = CASE
		                  WHEN size_bytes > 0 THEN 'ready'
		                  WHEN egress_id IS NOT NULL AND egress_id <> '' THEN 'processing'
		                  ELSE 'failed' END,
		       uploaded_to_s3 = (size_bytes > 0),
		       upload_percent = CASE WHEN size_bytes > 0 THEN 100 ELSE upload_percent END,
		       duration_ms = GREATEST(duration_ms, $2),
		       stopped_at = now()
		 WHERE id = $1::uuid AND status IN ('recording', 'processing')
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
		       COALESCE(u.name, 'Host'), COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0)
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE r.egress_id = $1`, egressID,
	).Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
		&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
		&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName, &f.UploadedToS3, &f.UploadPercent)
	if noRows(err) {
		return RecordingFile{}, ErrNotFound
	}
	if err != nil {
		return RecordingFile{}, err
	}
	return f, nil
}

// FinishRecordingWithStats closes a recording with explicit size and duration from Egress.
//
// 'ready' is in the WHERE list on purpose: the row may already have been closed
// by something that did not know the size yet (the webinar ending, a second
// stop), and this call is the one that knows. Without it the real size arrives
// and is silently discarded.
func (s *Store) FinishRecordingWithStats(ctx context.Context, id string, sizeBytes, durationMs int64) (types.RecordingStatus, error) {
	var status types.RecordingStatus
	err := s.pool.QueryRow(ctx, `
		UPDATE recordings
		   SET status = CASE WHEN $2 > 0 OR size_bytes > 0 THEN 'ready' ELSE 'failed' END,
		       uploaded_to_s3 = CASE WHEN $2 > 0 OR size_bytes > 0 THEN true ELSE false END,
		       upload_percent = CASE WHEN $2 > 0 OR size_bytes > 0 THEN 100 ELSE 0 END,
		       size_bytes = GREATEST(size_bytes, $2),
		       duration_ms = GREATEST(duration_ms, $3),
		       stopped_at = COALESCE(stopped_at, now())
		 WHERE id = $1::uuid AND status IN ('recording', 'processing', 'failed', 'ready')
		 RETURNING status`, id, sizeBytes, durationMs).Scan(&status)
	if noRows(err) {
		return "", ErrNotFound
	}
	return status, err
}

// FinishActiveRecordings closes whatever is still open on a webinar. Called when
// the session ends: the room is about to be deleted, so nothing more is coming.
func (s *Store) FinishActiveRecordings(ctx context.Context, slug string) error {
	// Egress rows go to processing rather than ready for the reason spelled out
	// on FinishRecording: LiveKit uploads the file after the room is gone.
	_, err := s.pool.Exec(ctx, `
		UPDATE recordings r
		   SET status = CASE
		                  WHEN r.size_bytes > 0 THEN 'ready'
		                  WHEN r.egress_id IS NOT NULL AND r.egress_id <> '' THEN 'processing'
		                  ELSE 'failed' END,
		       uploaded_to_s3 = (r.size_bytes > 0),
		       upload_percent = CASE WHEN r.size_bytes > 0 THEN 100 ELSE r.upload_percent END,
		       stopped_at = now()
		  FROM webinars w
		 WHERE w.id = r.webinar_id AND (w.slug = $1 OR w.id::text = $1) AND r.status = 'recording'`, slug)
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
		   WHERE (w.slug = $1 OR w.id::text = $1) AND r.status = 'recording'
		     AND (r.egress_id IS NOT NULL OR r.last_chunk_at > now() - $2::interval))`,
		slug, staleAfter.String()).Scan(&live)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	return live, nil
}

// Recordings lists a webinar's recording sessions, newest first.
//
// Takes from stop-then-record-again are folded into the session they belong to,
// so a host who paused twice still sees one row. The parts array is the takes
// in order, which is what the player concatenates.
func (s *Store) Recordings(ctx context.Context, slug string) ([]types.Recording, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, w.slug, w.topic, r.status, r.mime, r.size_bytes,
		       r.duration_ms, r.started_by_name, r.created_at, r.stopped_at,
		       COALESCE(r.egress_id, ''), COALESCE(r.is_public, true),
		       COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0),
		       COALESCE(r.parent_id::text, '')
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE (w.slug = $1 OR w.id::text = $1)
		 ORDER BY r.created_at ASC, r.id ASC
		 LIMIT 200`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var all []recordingRow
	for rows.Next() {
		var (
			rec             types.Recording
			createdAt       time.Time
			stoppedAt       *time.Time
			webinarPasscode string
			parentID        string
		)
		if err := rows.Scan(&rec.ID, &rec.Webinar, &rec.Topic, &rec.Status, &rec.Mime,
			&rec.SizeBytes, &rec.DurationMs, &rec.StartedBy, &createdAt, &stoppedAt,
			&rec.EgressID, &rec.IsPublic, &rec.Passcode, &webinarPasscode, &rec.UploadedToS3, &rec.UploadPercent,
			&parentID); err != nil {
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
		all = append(all, recordingRow{rec: rec, parentID: parentID})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return foldRecordingSessions(all), nil
}

type recordingRow struct {
	rec      types.Recording
	parentID string
}

func foldRecordingSessions(all []recordingRow) []types.Recording {
	sessions := map[string]*types.Recording{}
	order := []string{}
	for _, row := range all {
		part := types.RecordingPart{
			ID:         row.rec.ID,
			Status:     row.rec.Status,
			SizeBytes:  row.rec.SizeBytes,
			DurationMs: row.rec.DurationMs,
			CreatedAt:  row.rec.CreatedAt,
		}
		sessionID := row.rec.ID
		if row.parentID != "" {
			sessionID = row.parentID
		}
		sess, ok := sessions[sessionID]
		if !ok {
			copied := row.rec
			if row.parentID != "" {
				// A part arrived before its parent in a truncated listing, or the
				// parent row is missing. Surface the part as a session rather than
				// dropping it.
				copied.Parts = []types.RecordingPart{part}
				sessions[sessionID] = &copied
				order = append(order, sessionID)
				continue
			}
			copied.Parts = []types.RecordingPart{part}
			sessions[sessionID] = &copied
			order = append(order, sessionID)
			continue
		}
		sess.Parts = append(sess.Parts, part)
	}

	out := make([]types.Recording, 0, len(order))
	for _, id := range order {
		sess := sessions[id]
		rollupRecording(sess)
		out = append(out, *sess)
	}
	// Newest session first, matching the list the host already knew.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func rollupRecording(rec *types.Recording) {
	if rec == nil || len(rec.Parts) == 0 {
		return
	}
	var size, duration int64
	hasRecording, hasProcessing, hasReady := false, false, false
	uploaded := true
	for _, p := range rec.Parts {
		switch p.Status {
		case types.RecordingActive:
			hasRecording = true
			uploaded = false
		case types.RecordingProcessing:
			hasProcessing = true
			uploaded = false
		case types.RecordingReady:
			if p.SizeBytes > 0 {
				hasReady = true
			} else {
				hasProcessing = true
				uploaded = false
			}
		default:
			uploaded = false
		}
		if p.Status != types.RecordingFailed {
			size += p.SizeBytes
			duration += p.DurationMs
		}
	}
	rec.SizeBytes = size
	rec.DurationMs = duration
	rec.UploadedToS3 = uploaded && hasReady
	switch {
	case hasRecording:
		rec.Status = types.RecordingActive
	case hasProcessing:
		rec.Status = types.RecordingProcessing
	case hasReady:
		rec.Status = types.RecordingReady
	default:
		rec.Status = types.RecordingFailed
	}
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
		  FROM webinars w, recordings t
		 WHERE w.id = r.webinar_id
		   AND t.id = $2::uuid
		   AND w.id = t.webinar_id
		   AND (w.slug = $1 OR w.id::text = $1)
		   AND (r.id = COALESCE(t.parent_id, t.id) OR r.parent_id = COALESCE(t.parent_id, t.id))`
	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		return types.Recording{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Recording{}, ErrNotFound
	}
	list, err := s.Recordings(ctx, slug)
	if err != nil {
		return types.Recording{}, err
	}
	for _, r := range list {
		if r.ID == id {
			return r, nil
		}
		for _, p := range r.Parts {
			if p.ID == id {
				return r, nil
			}
		}
	}
	return types.Recording{}, ErrNotFound
}

// SessionParts returns every take in the session that contains id, oldest first.
// id may be the session itself or any part of it.
func (s *Store) SessionParts(ctx context.Context, slug, id string) ([]RecordingFile, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.storage_key, r.mime, r.status, r.size_bytes, r.duration_ms,
		       r.started_by_name, w.topic, r.created_at, COALESCE(r.egress_id, ''), w.slug,
		       COALESCE(r.is_public, true), COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(u.name, 'Host'), COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0),
		       COALESCE(r.parent_id::text, '')
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  JOIN recordings t ON t.id = $2::uuid AND t.webinar_id = w.id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE (w.slug = $1 OR w.id::text = $1)
		   AND (r.id = COALESCE(t.parent_id, t.id) OR r.parent_id = COALESCE(t.parent_id, t.id))
		 ORDER BY r.created_at ASC, r.id ASC`, slug, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []RecordingFile{}
	for rows.Next() {
		var f RecordingFile
		if err := rows.Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
			&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
			&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName, &f.UploadedToS3, &f.UploadPercent,
			&f.ParentID); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// DeleteRecording removes the whole session (every take) and reports every
// storage key so the caller can delete the bytes.
func (s *Store) DeleteRecording(ctx context.Context, slug, id string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		WITH t AS (
		  SELECT COALESCE(parent_id, id) AS session_id, webinar_id
		    FROM recordings
		   WHERE id = $2::uuid
		)
		DELETE FROM recordings r
		 USING webinars w, t
		 WHERE w.id = r.webinar_id
		   AND w.id = t.webinar_id
		   AND (w.slug = $1 OR w.id::text = $1)
		   AND (r.id = t.session_id OR r.parent_id = t.session_id)
		 RETURNING r.storage_key`, slug, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		if key != "" {
			keys = append(keys, key)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return nil, ErrNotFound
	}
	return keys, nil
}

// ExpiredRecordings lists finished recordings older than age, oldest first.
// Active in-progress rows (status recording) are left alone so a long session
// is not deleted out from under the encoder.
func (s *Store) ExpiredRecordings(ctx context.Context, age time.Duration, limit int) ([]RecordingFile, error) {
	if age <= 0 {
		return nil, nil
	}
	if limit < 1 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.storage_key, r.mime, r.status, r.size_bytes, r.duration_ms,
		       r.started_by_name, w.topic, r.created_at, COALESCE(r.egress_id, ''), w.slug,
		       COALESCE(r.is_public, true), COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(u.name, 'Host'), COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0)
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE r.parent_id IS NULL
		   AND r.created_at < now() - $1::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM recordings c
		      WHERE (c.id = r.id OR c.parent_id = r.id) AND c.status = 'recording'
		   )
		 ORDER BY r.created_at ASC
		 LIMIT $2`, age.String(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []RecordingFile{}
	for rows.Next() {
		var f RecordingFile
		if err := rows.Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
			&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
			&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName, &f.UploadedToS3, &f.UploadPercent); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// UnaccountedEgressRecordings lists finished Egress recordings whose size the
// database still does not know, oldest first.
//
// Two shapes end up here. A row stuck in processing never saw its EGRESS_ENDED
// webhook — LiveKit retries a few times and then gives up, and Cloud Run can be
// scaled to zero or cold for all of them. A row marked ready with zero bytes is
// the same miss, recorded before this package stopped calling those ready.
// Either way the file itself is the fact of the matter, so the caller checks
// object storage and finishes the row from what it finds.
func (s *Store) UnaccountedEgressRecordings(ctx context.Context, limit int) ([]RecordingFile, error) {
	if limit < 1 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.storage_key, r.mime, r.status, r.size_bytes, r.duration_ms,
		       r.started_by_name, w.topic, r.created_at, COALESCE(r.egress_id, ''), w.slug,
		       COALESCE(r.is_public, true), COALESCE(r.passcode, ''), COALESCE(w.passcode, ''),
		       COALESCE(u.name, 'Host'), COALESCE(r.uploaded_to_s3, false), COALESCE(r.upload_percent, 0)
		  FROM recordings r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE COALESCE(r.egress_id, '') <> ''
		   AND r.size_bytes = 0
		   AND r.status IN ('processing', 'ready')
		 ORDER BY r.created_at ASC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []RecordingFile{}
	for rows.Next() {
		var f RecordingFile
		if err := rows.Scan(&f.ID, &f.StorageKey, &f.Mime, &f.Status, &f.SizeBytes, &f.DurationMs,
			&f.StartedBy, &f.Topic, &f.CreatedAt, &f.EgressID, &f.Webinar,
			&f.IsPublic, &f.Passcode, &f.WebinarPasscode, &f.HostName, &f.UploadedToS3, &f.UploadPercent); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
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
