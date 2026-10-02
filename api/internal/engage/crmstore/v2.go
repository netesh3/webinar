package crmstore

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Engage v2: the numbers behind the journey, the profile panel and the home card.
 * See docs/engage/V2.md. Everything here is read from rows v1 already writes. */

// ContactHistory is a person's webinars with this host, newest first.
func (s *Store) ContactHistory(ctx context.Context, hostID, contactID string) ([]types.CRMThreadWebinar, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug, topic, starts_at, duration_min, ended, joined, watch_min FROM (
			SELECT DISTINCT ON (w.id)
			       w.slug, w.topic, w.starts_at, w.duration_min,
			       (w.status = 'ended' OR w.ended_at IS NOT NULL) AS ended,
			       wt.rid IS NOT NULL AS joined, COALESCE(wt.watch_min, 0) AS watch_min
			  FROM registrations r
			  JOIN webinars w ON w.id = r.webinar_id
			  LEFT JOIN (`+store.WatchByRegistrationSQL(`w.host_id = $1::uuid`)+`) wt ON wt.rid = r.id
			  CROSS JOIN LATERAL (`+pickContactForRegistration+`) pick
			 WHERE w.host_id = $1::uuid AND r.state <> 'declined' AND pick.id = $2::uuid
			 ORDER BY w.id, COALESCE(wt.watch_min, -1) DESC
		) h
		 ORDER BY starts_at DESC
		 LIMIT 20`, hostID, contactID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.CRMThreadWebinar{}
	for rows.Next() {
		var (
			h  types.CRMThreadWebinar
			at time.Time
		)
		if err := rows.Scan(&h.ID, &h.Topic, &at, &h.DurationMin, &h.Ended, &h.Joined, &h.WatchMin); err != nil {
			return nil, err
		}
		h.StartsAt = at.Format(time.RFC3339)
		out = append(out, h)
	}
	return out, rows.Err()
}

/* WebinarResults is what WhatsApp did for one webinar.
 *
 * "Reminded" is a registration a WhatsApp reminder was actually sent to — not one that
 * could have been — so the show-up comparison is between people who got the message and
 * people who didn't.
 */
func (s *Store) WebinarResults(ctx context.Context, hostID, slug string) (types.CRMWebinarResults, error) {
	var out types.CRMWebinarResults
	err := s.pool.QueryRow(ctx, `
		WITH regs AS (
			SELECT r.id, wt.rid IS NOT NULL AS joined, COALESCE(wt.watch_min, 0) AS watch_min,
			       EXISTS (SELECT 1 FROM notifications n
			                WHERE n.registration_id = r.id AND n.channel = 'whatsapp'
			                  AND n.kind = 'wa_reminder' AND n.delivery = 'sent') AS reminded
			  FROM registrations r
			  JOIN webinars w ON w.id = r.webinar_id
			  LEFT JOIN (`+store.WatchByRegistrationSQL(`w.slug = $1`)+`) wt ON wt.rid = r.id
			 WHERE w.slug = $1 AND w.host_id = $2::uuid AND r.state <> 'declined'
		)
		SELECT count(*),
		       count(*) FILTER (WHERE joined),
		       COALESCE(round(avg(watch_min) FILTER (WHERE joined)), 0)::int,
		       count(*) FILTER (WHERE reminded),
		       count(*) FILTER (WHERE reminded AND joined),
		       count(*) FILTER (WHERE NOT reminded),
		       count(*) FILTER (WHERE NOT reminded AND joined)
		  FROM regs`, slug, hostID).Scan(&out.Registered, &out.Joined, &out.AvgWatchMin,
		&out.Reminded, &out.RemindedJoined, &out.Others, &out.OthersJoined)
	if err != nil {
		return out, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE m.status IN ('sent','delivered','read')),
		       count(*) FILTER (WHERE m.status = 'read'),
		       count(*) FILTER (WHERE m.status IN ('sent','delivered','read') AND t.category = 'MARKETING'),
		       count(*) FILTER (WHERE m.status IN ('sent','delivered','read') AND t.category = 'UTILITY')
		  FROM crm_messages m
		  JOIN webinars w ON w.id = m.webinar_id
		  LEFT JOIN LATERAL (
		        SELECT category FROM crm_templates t
		         WHERE t.host_id = m.host_id AND t.name = m.template_name LIMIT 1) t ON true
		 WHERE w.slug = $1 AND w.host_id = $2::uuid AND m.host_id = $2::uuid
		   AND m.direction = 'out'`, slug, hostID).Scan(&out.Sent, &out.Read, &out.Marketing, &out.Utility)
	if err != nil {
		return out, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT c.id)
		  FROM crm_contacts c
		  JOIN crm_messages m ON m.contact_id = c.id AND m.direction = 'in'
		 WHERE c.host_id = $2::uuid AND `+contactRegisteredFor(`$1`)+`
		   AND m.created_at >= (
		        SELECT min(o.created_at) FROM crm_messages o
		          JOIN webinars w ON w.id = o.webinar_id
		         WHERE w.slug = $1 AND o.host_id = $2::uuid)`, slug, hostID).Scan(&out.Replied)
	return out, err
}

/* Summary is the Hosting home's "WhatsApp this week" card: the last `days` days. */
func (s *Store) Summary(ctx context.Context, hostID string, days int) (types.CRMSummaryResponse, error) {
	out := types.CRMSummaryResponse{Days: days}
	since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE direction = 'out' AND status IN ('sent','delivered','read')),
		       count(*) FILTER (WHERE direction = 'out' AND status = 'read'),
		       count(DISTINCT contact_id) FILTER (WHERE direction = 'in')
		  FROM crm_messages
		 WHERE host_id = $1::uuid AND created_at >= $2`, hostID, since).
		Scan(&out.Sent, &out.Read, &out.Replied)
	if err != nil {
		return out, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM crm_contacts c
		 WHERE c.host_id = $1::uuid AND `+optedInNow+` AND c.whatsapp_opt_in_at >= $2`,
		hostID, since).Scan(&out.NewOptIns); err != nil {
		return out, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM crm_contacts c WHERE c.host_id = $1::uuid AND `+needsReply,
		hostID).Scan(&out.NeedsReply); err != nil {
		return out, err
	}

	// The next send: the earliest pending WhatsApp notification or scheduled broadcast.
	var (
		at    *time.Time
		label string
	)
	err = s.pool.QueryRow(ctx, `
		SELECT at, label FROM (
			SELECT n.due_at AS at,
			       CASE n.kind WHEN 'wa_reminder' THEN 'Reminder · ' || w.topic
			                   WHEN 'wa_replay' THEN 'Replay · ' || w.topic
			                   ELSE 'Confirmation · ' || w.topic END AS label
			  FROM notifications n
			  JOIN webinars w ON w.id = n.webinar_id
			 WHERE w.host_id = $1::uuid AND n.channel = 'whatsapp' AND n.delivery = 'pending'
			   AND n.due_at > now()
			UNION ALL
			SELECT b.scheduled_at, b.name
			  FROM crm_broadcasts b
			 WHERE b.host_id = $1::uuid AND b.canceled_at IS NULL AND b.deleted_at IS NULL AND b.scheduled_at > now()
		) x ORDER BY at LIMIT 1`, hostID).Scan(&at, &label)
	if err != nil && !noRows(err) {
		return out, err
	}
	if at != nil {
		out.NextSendAt = at.Format(time.RFC3339)
		out.NextSendLabel = label
	}
	return out, nil
}

// WebinarScored is whether a webinar's engagement has been computed, so tiers mean anything.
func (s *Store) WebinarScored(ctx context.Context, hostID, slug string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM engagement_scores es
		                 JOIN webinars w ON w.id = es.webinar_id
		                WHERE w.slug = $1 AND w.host_id = $2::uuid)`, slug, hostID).Scan(&ok)
	return ok, err
}
