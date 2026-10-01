package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
)

/* ZoomWebinar is the row a Zoom webhook has to find.
 *
 * Looked up by Zoom's meeting or webinar id, which is what every session
 * event carries. Slug is the id the rest of the API uses.
 */
type ZoomWebinar struct {
	Slug     string
	HostID   string
	Venue    string
	Status   string
	StartsAt time.Time
}

func (s *Store) WebinarByZoomID(ctx context.Context, zoomID string) (ZoomWebinar, error) {
	zoomID = strings.TrimSpace(zoomID)
	if zoomID == "" {
		return ZoomWebinar{}, ErrNotFound
	}
	var w ZoomWebinar
	err := s.pool.QueryRow(ctx, `
		SELECT slug, host_id::text, venue, status, starts_at
		  FROM webinars
		 WHERE zoom_id = $1
		   AND venue IN ('zoom_meeting', 'zoom_webinar')
		 ORDER BY updated_at DESC
		 LIMIT 1`, zoomID).Scan(&w.Slug, &w.HostID, &w.Venue, &w.Status, &w.StartsAt)
	if noRows(err) {
		return ZoomWebinar{}, ErrNotFound
	}
	return w, err
}

/* NoteZoomStarted stamps when Zoom says the meeting actually began.
 *
 * Engagement refuses to list anyone until started_at is set, and a Zoom
 * session never goes through the in-app Go live path that would have set it.
 * A second call does not move a start that is already recorded.
 */
func (s *Store) NoteZoomStarted(ctx context.Context, slug string, at time.Time) error {
	if slug == "" || at.IsZero() {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE webinars SET started_at = $2
		 WHERE slug = $1 AND started_at IS NULL`, slug, at)
	return err
}

/* RecordZoomPerson writes one stay into the attendance tables the host page
 * already reads.
 *
 * A registrant is stored as att_ plus their join key, so the attended count
 * and the Results list include them. The host is stored as user_ plus their
 * id, so they show on the stage list and are not counted as audience. Anyone
 * else is att_zoom_ plus a Zoom id, which is enough for the same lists to
 * show their name.
 *
 * left nil means they are still in. A later leave closes that open visit
 * instead of inserting a second one.
 */
func (s *Store) RecordZoomPerson(
	ctx context.Context,
	slug, name, email, registrantID, zoomUserID, meetingUserID string,
	joined time.Time,
	left *time.Time,
) error {
	identity, regID, err := s.resolveZoomPerson(ctx, slug, email, registrantID, zoomUserID, meetingUserID)
	if err != nil || identity == "" {
		return err
	}
	if joined.IsZero() {
		joined = time.Now()
	}
	if left != nil && left.Before(joined) {
		joined = *left
	}
	if err := s.TouchAttendance(ctx, slug, identity, regID, name); err != nil {
		return err
	}
	if left == nil || left.IsZero() {
		return s.OpenVisit(ctx, slug, identity, name, joined)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = $3
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1
		   AND v.identity = $2 AND v.left_at IS NULL`,
		slug, identity, *left)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at)
		SELECT w.id, $2, $3, $4
		  FROM webinars w
		 WHERE w.slug = $1
		   AND NOT EXISTS (
		     SELECT 1 FROM attendance_visits v
		      WHERE v.webinar_id = w.id AND v.identity = $2 AND v.joined_at = $3
		   )`,
		slug, identity, joined, *left)
	return err
}

func (s *Store) resolveZoomPerson(ctx context.Context, slug, email, registrantID, zoomUserID, meetingUserID string) (identity, registrationID string, err error) {
	email = strings.TrimSpace(email)
	registrantID = strings.TrimSpace(registrantID)
	zoomUserID = strings.TrimSpace(zoomUserID)
	if registrantID != "" || email != "" {
		err = s.pool.QueryRow(ctx, `
			SELECT 'att_' || r.join_key, r.id::text
			  FROM registrations r
			  JOIN webinars w ON w.id = r.webinar_id
			 WHERE w.slug = $1
			   AND r.join_key <> ''
			   AND (
			     ($2 <> '' AND r.zoom_registrant_id = $2)
			     OR ($3 <> '' AND lower(r.email) = lower($3))
			   )
			 ORDER BY CASE WHEN $2 <> '' AND r.zoom_registrant_id = $2 THEN 0 ELSE 1 END
			 LIMIT 1`, slug, registrantID, email).Scan(&identity, &registrationID)
		if err == nil {
			return identity, registrationID, nil
		}
		if !noRows(err) {
			return "", "", err
		}
	}
	if zoomUserID != "" || email != "" {
		var hostIdent string
		err = s.pool.QueryRow(ctx, `
			SELECT 'user_' || u.id::text
			  FROM webinars w
			  JOIN users u ON u.id = w.host_id
			  LEFT JOIN zoom_connections z ON z.user_id = u.id
			 WHERE w.slug = $1
			   AND (
			     ($2 <> '' AND z.zoom_user_id = $2)
			     OR ($3 <> '' AND (lower(u.email) = lower($3) OR lower(coalesce(z.email, '')) = lower($3)))
			   )`, slug, zoomUserID, email).Scan(&hostIdent)
		if err == nil {
			return hostIdent, "", nil
		}
		if !noRows(err) {
			return "", "", err
		}
	}
	key := zoomKey(zoomUserID)
	if key == "" {
		key = zoomKey(meetingUserID)
	}
	if key == "" {
		key = zoomKey(registrantID)
	}
	if key == "" && email != "" {
		sum := sha256.Sum256([]byte(strings.ToLower(email)))
		key = hex.EncodeToString(sum[:8])
	}
	if key == "" {
		return "", "", nil
	}
	return "att_zoom_" + key, "", nil
}

func zoomKey(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= 80 {
			break
		}
	}
	return b.String()
}
