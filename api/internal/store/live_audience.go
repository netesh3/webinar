package store

import (
	"context"
)

// LiveAudience is the cluster-wide count of what is live right now, for the telemetry gauges
// (observe.RegisterAudienceGauges). Nothing in it names a webinar or a person.
type LiveAudience struct {
	// SessionsByKind is live sessions by webinars.kind: live, recurring, simulive, meeting.
	SessionsByKind map[string]int
	/* EdgeViewers is attendees watching the edge feed of a live webinar: open visits whose
	 * browser beat within edgeVisitStale, the same rule as OpenEdgeVisits. Unlike that count
	 * it leaves out a promoted viewer whose visit the webhooks now own (seen_at NULL): they
	 * are on the video server, and WebRTCParticipants counts them. */
	EdgeViewers int
	/* WebRTCParticipants is the open visits the LiveKit webhooks own (seen_at NULL) on live
	 * sessions held in the app — not Zoom, whose attendance lands in the same table. People
	 * only (att_ and user_ identities): not the recorder, the caption agent or an egress. */
	WebRTCParticipants int
}

/* LiveAudience reads the snapshot in one round trip. Cheap at any size this runs at: the
 * live webinars are a handful of rows, and their visits are reached through the partial
 * index on open visits (webinar_id, identity) WHERE left_at IS NULL. */
func (s *Store) LiveAudience(ctx context.Context) (LiveAudience, error) {
	out := LiveAudience{SessionsByKind: map[string]int{}}
	rows, err := s.pool.Query(ctx, `
		WITH live AS (SELECT id, kind, venue FROM webinars WHERE status = 'live')
		SELECT 'kind', kind, count(*)::int FROM live GROUP BY kind
		UNION ALL
		SELECT 'edge', '', count(DISTINCT (v.webinar_id, v.identity))::int
		  FROM attendance_visits v JOIN live w ON w.id = v.webinar_id
		 WHERE v.left_at IS NULL AND v.seen_at >= now() - $1::interval
		   AND v.identity LIKE 'att\_%'
		UNION ALL
		SELECT 'webrtc', '', count(DISTINCT (v.webinar_id, v.identity))::int
		  FROM attendance_visits v JOIN live w ON w.id = v.webinar_id
		 WHERE v.left_at IS NULL AND v.seen_at IS NULL AND w.venue = 'app'
		   AND (v.identity LIKE 'att\_%' OR v.identity LIKE 'user\_%')`,
		edgeVisitStale)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var what, kind string
		var n int
		if err := rows.Scan(&what, &kind, &n); err != nil {
			return out, err
		}
		switch what {
		case "kind":
			out.SessionsByKind[kind] = n
		case "edge":
			out.EdgeViewers = n
		case "webrtc":
			out.WebRTCParticipants = n
		}
	}
	return out, rows.Err()
}
