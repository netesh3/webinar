package store

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* ExpectedAudience is how many attendees a webinar admits at once: its own attendee_limit,
 * under the ceiling it is held to. `ceiling` is the plan's (api.attendeeCeiling: the plan cap,
 * under MAX_ATTENDEES); an admin's AudienceCapOverride replaces it.
 *
 * The one number the join check counts against, the host sees as "N / limit", and the video
 * box placement (a webinar's share of what one box serves) reads as the webinar's size. Never
 * below 1, so a zero in either input cannot produce a webinar that turns everyone away. */
func ExpectedAudience(wb types.Webinar, ceiling int) int {
	if wb.AudienceCapOverride > 0 {
		ceiling = wb.AudienceCapOverride
	}
	limit := wb.AttendeeLimit
	if ceiling > 0 && (limit <= 0 || limit > ceiling) {
		limit = ceiling
	}
	return max(1, limit)
}

/* SetAudienceCap writes an admin's per-webinar ceiling and the webinar's attendee_limit in one
 * statement. `override` nil takes the override off. The caller works out attendeeLimit (the new
 * ceiling when one is set, the old limit clamped to the usual ceiling when it is cleared), so
 * the limit is never left above whatever now applies. ErrNotFound when there is no webinar. */
func (s *Store) SetAudienceCap(ctx context.Context, slug string, override *int, attendeeLimit int) (types.Webinar, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET audience_cap_override = $2, attendee_limit = $3, updated_at = now()
		 WHERE slug = $1`, slug, override, max(1, attendeeLimit))
	if err != nil {
		return types.Webinar{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Webinar{}, ErrNotFound
	}
	return s.WebinarBySlug(ctx, slug)
}

/* audienceAdmittedRecently is how long somebody let in counts against the limit before their
 * visit is there to count them. Only until then: once this run has a visit for them, open or
 * closed, the visit decides, so somebody who leaves frees their seat at once. An edge viewer's visit opens when their event stream connects
 * and a WebRTC attendee's when LiveKit's participant_joined webhook arrives, a few seconds after
 * the join either way. Counting only open visits, three hundred people arriving at the top of
 * the hour would all be let in before the first of them was counted; their attendance row is
 * written at the join itself, so it is counted from that moment instead. */
const audienceAdmittedRecently = 90 * time.Second

// AudienceCount is the join check's view of one webinar's audience.
type AudienceCount struct {
	// Count is the attendees holding a seat now. Nobody on the stage, and no host or panelist.
	Count int
	// Admitted is whether this identity was already let in during this run: a reconnect or a
	// rejoin, which the limit never turns away.
	Admitted bool
}

/* AudienceAdmission reads, in one round trip, who holds a seat in a webinar and whether
 * `identity` already had one this run.
 *
 * A seat is an attendee identity (att_) that has an open visit still believable (liveEdgeVisit:
 * a WebRTC visit the webhooks own, or an edge visit that beat recently), or that was let in
 * within audienceAdmittedRecently and has had no visit this run yet. Anyone with a stage grant is left out: a promoted attendee
 * or a co-host is on the stage, which has its own cap (types.PlanStageCap). Hosts and panelists
 * join as user_ identities and are never counted.
 *
 * Both halves read rows written this run only (since started_at), so the attendance of an
 * earlier occurrence of a recurring webinar neither fills seats nor waves anyone through.
 * Cheap at any size this runs at: both tables are reached by their (webinar_id, identity) keys. */
func (s *Store) AudienceAdmission(ctx context.Context, slug, identity string) (AudienceCount, error) {
	var out AudienceCount
	err := s.pool.QueryRow(ctx, `
		WITH w AS (SELECT id, started_at FROM webinars WHERE slug = $1),
		seats AS (
			SELECT v.identity FROM attendance_visits v, w
			 WHERE v.webinar_id = w.id AND `+liveEdgeVisit+`
			   AND v.identity LIKE 'att\_%'
			UNION
			SELECT a.identity FROM attendance a, w
			 WHERE a.webinar_id = w.id AND a.identity LIKE 'att\_%'
			   AND a.last_seen_at >= now() - $3::interval
			   AND (w.started_at IS NULL OR a.last_seen_at >= w.started_at)
			   AND NOT EXISTS (SELECT 1 FROM attendance_visits v
			                    WHERE v.webinar_id = w.id AND v.identity = a.identity
			                      AND (w.started_at IS NULL OR v.joined_at >= w.started_at))
		)
		SELECT
			(SELECT count(*) FROM seats s, w
			  WHERE NOT EXISTS (SELECT 1 FROM webinar_stage_grants g
			                     WHERE g.webinar_id = w.id AND g.identity = s.identity))::int,
			EXISTS (SELECT 1 FROM attendance a, w
			         WHERE a.webinar_id = w.id AND a.identity = $4
			           AND (w.started_at IS NULL OR a.last_seen_at >= w.started_at))`,
		slug, edgeVisitStale, audienceAdmittedRecently, identity).Scan(&out.Count, &out.Admitted)
	return out, err
}
