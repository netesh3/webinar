package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

/* The Studio's lists (api/internal/api/studio.go): a host's recording sessions with where
 * their highlights, reels and clips stand, every clip made from them with its plan, and the
 * plans themselves (migrations/0158). One query a page each: no per-row lookups. */

// StudioRecordingRow is one recording session of an ended session, as the Studio lists it.
type StudioRecordingRow struct {
	ID          string
	Slug        string
	Topic       string
	Kind        string
	SessionAt   time.Time
	CreatedAt   time.Time
	DurationMs  int64
	Takes       int
	ThumbPartID string
	// Highlights and Reels are the stored rows; Found is false when there is none.
	Highlights   StudioAIRow
	Reels        StudioAIRow
	ClipsReady   int
	ClipsPending int
	ClipsFailed  int
}

// StudioAIRow is a recording's suggestions row, summed up: its status and how many it holds.
type StudioAIRow struct {
	Found   bool
	Status  string
	Reason  string
	Claimed bool
	Count   int
}

// studioCursor is the keyset after the last item of a page: its time, then its id.
type studioCursor struct {
	At int64  `json:"at"`
	ID string `json:"id"`
}

func encodeStudioCursor(at time.Time, id string) string {
	raw, err := json.Marshal(studioCursor{At: at.UTC().UnixNano(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// decodeStudioCursor reads a cursor; an empty one is the first page (a nil time).
func decodeStudioCursor(raw string) (*time.Time, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", nil
	}
	buf, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(buf) == 0 {
		return nil, "", fmt.Errorf("%w: cursor", ErrInvalid)
	}
	var c studioCursor
	if err := json.Unmarshal(buf, &c); err != nil || c.At == 0 || !uuidLike(c.ID) {
		return nil, "", fmt.Errorf("%w: cursor", ErrInvalid)
	}
	at := time.Unix(0, c.At).UTC()
	return &at, c.ID, nil
}

// uuidLike is a cheap shape check, so a forged cursor is refused rather than a cast failing.
func uuidLike(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch {
		case i == 8 || i == 13 || i == 18 || i == 23:
			if r != '-' {
				return false
			}
		case (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F'):
		default:
			return false
		}
	}
	return true
}

/* StudioRecordings is a page of the host's recording sessions (the parent row of each), of
 * their own ended sessions, newest first, that have a file to play and nothing still
 * recording or uploading. q narrows by the session's title. limit+1 rows are read to know
 * whether there is a next page. */
func (s *Store) StudioRecordings(ctx context.Context, hostID, q, cursor string, limit int) ([]StudioRecordingRow, string, error) {
	after, afterID, err := decodeStudioCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	q = strings.TrimSpace(q)
	pattern := ""
	if q != "" {
		pattern = "%" + likeLiteral(q) + "%"
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, w.slug, w.topic, w.kind, w.starts_at, r.created_at,
		       pt.duration_ms, pt.takes, pt.thumb,
		       h.recording_id IS NOT NULL, COALESCE(h.status, ''), COALESCE(h.reason, ''),
		       COALESCE(h.claimed_until > now(), false),
		       COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(h.body->'highlights') = 'array' THEN h.body->'highlights' END), 0),
		       rr.recording_id IS NOT NULL, COALESCE(rr.status, ''), COALESCE(rr.reason, ''),
		       COALESCE(rr.claimed_until > now(), false),
		       COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(rr.body->'reels') = 'array' THEN rr.body->'reels' END), 0),
		       cj.ready, cj.pending, cj.failed
		  FROM webinars w
		  JOIN recordings r ON r.webinar_id = w.id AND r.parent_id IS NULL
		 CROSS JOIN LATERAL (
		       SELECT count(*) FILTER (WHERE p.status <> 'failed')::int AS takes,
		              COALESCE(sum(p.duration_ms) FILTER (WHERE p.status <> 'failed'), 0)::bigint AS duration_ms,
		              (array_agg(p.id::text ORDER BY p.created_at, p.id)
		                 FILTER (WHERE p.status = 'ready' AND p.size_bytes > 0))[1] AS thumb,
		              COALESCE(bool_or(p.status IN ('recording', 'processing')
		                               OR (p.status = 'ready' AND p.size_bytes <= 0)), false) AS busy
		         FROM recordings p
		        WHERE p.webinar_id = w.id AND (p.id = r.id OR p.parent_id = r.id)) pt
		  LEFT JOIN recording_highlights h ON h.recording_id = r.id
		  LEFT JOIN recording_reels rr ON rr.recording_id = r.id
		 CROSS JOIN LATERAL (
		       SELECT count(*) FILTER (WHERE c.status = 'ready')::int AS ready,
		              count(*) FILTER (WHERE c.status IN ('queued', 'processing'))::int AS pending,
		              count(*) FILTER (WHERE c.status = 'failed')::int AS failed
		         FROM clip_jobs c WHERE c.recording_id = r.id) cj
		 WHERE w.host_id = $1::uuid AND w.status = 'ended'
		   AND pt.thumb IS NOT NULL AND NOT pt.busy
		   AND ($2 = '' OR w.topic ILIKE $2 ESCAPE '\')
		   AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
		 ORDER BY r.created_at DESC, r.id DESC
		 LIMIT $5`, hostID, pattern, after, nullUUID(afterID), limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []StudioRecordingRow
	for rows.Next() {
		var r StudioRecordingRow
		h, rr := &r.Highlights, &r.Reels
		if err := rows.Scan(&r.ID, &r.Slug, &r.Topic, &r.Kind, &r.SessionAt, &r.CreatedAt,
			&r.DurationMs, &r.Takes, &r.ThumbPartID,
			&h.Found, &h.Status, &h.Reason, &h.Claimed, &h.Count,
			&rr.Found, &rr.Status, &rr.Reason, &rr.Claimed, &rr.Count,
			&r.ClipsReady, &r.ClipsPending, &r.ClipsFailed); err != nil {
			return nil, "", err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		next = encodeStudioCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// ClipPlanRow is a clip's plan as stored.
type ClipPlanRow struct {
	Platforms []string
	PlannedOn *time.Time // a day, at midnight UTC
	Status    string
	Note      string
	UpdatedAt time.Time
}

// StudioClipRow is a clip job with the session it came from and its plan (nil when none).
type StudioClipRow struct {
	Job       ClipJobRow
	Slug      string
	Topic     string
	SessionAt time.Time
	Plan      *ClipPlanRow
}

/* StudioClips is a page of the clips and reels made from the host's own sessions' recordings,
 * newest first. status is "" for all, ready, pending (waiting or being made) or failed. */
func (s *Store) StudioClips(ctx context.Context, hostID, status, cursor string, limit int) ([]StudioClipRow, string, error) {
	after, afterID, err := decodeStudioCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	statuses := []string{} // not nil: pgx sends a nil slice as NULL
	switch status {
	case "":
	case "ready":
		statuses = []string{ClipReady}
	case "pending":
		statuses = []string{ClipQueued, ClipProcessing}
	case "failed":
		statuses = []string{ClipFailed}
	default:
		return nil, "", fmt.Errorf("%w: status", ErrInvalid)
	}
	cols := strings.ReplaceAll(clipJobCols, "\n", " ")
	cols = prefixCols(cols, "c.")
	rows, err := s.pool.Query(ctx, `
		SELECT `+cols+`, w.slug, w.topic, w.starts_at,
		       p.clip_id IS NOT NULL, COALESCE(p.platforms, '{}'), p.planned_on, COALESCE(p.status, ''),
		       COALESCE(p.note, ''), COALESCE(p.updated_at, now())
		  FROM webinars w
		  JOIN recordings r ON r.webinar_id = w.id AND r.parent_id IS NULL
		  JOIN clip_jobs c ON c.recording_id = r.id
		  LEFT JOIN clip_plans p ON p.clip_id = c.id
		 WHERE w.host_id = $1::uuid
		   AND (cardinality($2::text[]) = 0 OR c.status = ANY($2::text[]))
		   AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid))
		 ORDER BY c.created_at DESC, c.id DESC
		 LIMIT $5`, hostID, statuses, after, nullUUID(afterID), limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []StudioClipRow
	for rows.Next() {
		var (
			r       StudioClipRow
			j       ClipJobRow
			segs    []byte
			posts   []byte
			hasPlan bool
			plan    ClipPlanRow
		)
		if err := rows.Scan(&j.ID, &j.RecordingID, &j.Kind, &j.SourceID, &j.Title, &j.Format, &j.Framing, &j.Captions, &j.Hook,
			&segs, &j.DurationSec, &j.Subtitles, &posts, &j.PostStatus, &j.Status, &j.Error, &j.Attempts, &j.Progress,
			&j.LeaseUntil, &j.RushUntil, &j.StorageKey, &j.SizeBytes, &j.DurationMs, &j.CreatedAt, &j.StartedAt, &j.FinishedAt,
			&r.Slug, &r.Topic, &r.SessionAt,
			&hasPlan, &plan.Platforms, &plan.PlannedOn, &plan.Status, &plan.Note, &plan.UpdatedAt); err != nil {
			return nil, "", err
		}
		j.Segments, j.Posts = segs, posts
		r.Job = j
		if hasPlan {
			r.Plan = &plan
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1].Job
		next = encodeStudioCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// prefixCols qualifies each column of a comma-separated list ("id::text, kind") with a table.
func prefixCols(cols, prefix string) string {
	parts := strings.Split(cols, ",")
	for i, p := range parts {
		parts[i] = prefix + strings.TrimSpace(p)
	}
	return strings.Join(parts, ", ")
}

// SaveClipPlan writes the plan of a clip of the recording session; ErrNotFound when the clip
// is not one of its.
func (s *Store) SaveClipPlan(ctx context.Context, recordingID, clipID, userID string, p ClipPlanRow) (ClipPlanRow, error) {
	var out ClipPlanRow
	err := s.pool.QueryRow(ctx, `
		INSERT INTO clip_plans (clip_id, platforms, planned_on, status, note, updated_by, updated_at)
		SELECT c.id, $3::text[], $4::date, $5, $6, NULLIF($7, '')::uuid, now()
		  FROM clip_jobs c WHERE c.id = $2::uuid AND c.recording_id = $1::uuid
		ON CONFLICT (clip_id) DO UPDATE
		   SET platforms = EXCLUDED.platforms, planned_on = EXCLUDED.planned_on, status = EXCLUDED.status,
		       note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
		RETURNING platforms, planned_on, status, note, updated_at`,
		recordingID, clipID, p.Platforms, p.PlannedOn, p.Status, p.Note, userID).
		Scan(&out.Platforms, &out.PlannedOn, &out.Status, &out.Note, &out.UpdatedAt)
	if noRows(err) {
		return out, ErrNotFound
	}
	return out, err
}
