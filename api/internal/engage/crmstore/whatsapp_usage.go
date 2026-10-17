package crmstore

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* WhatsAppUsage is each WhatsApp host's activity since the cutoff, for the admin
 * dashboard (see types.AdminWhatsAppUsage).
 *
 * The plan comes from effective_plan (migration 0107), the one place it is decided.
 * Messages are read per host through crm_messages_host_created_idx; each row is
 * classified by its outbox kind (notifications.kind) or its broadcast, bot and
 * manual columns. Read-only and bounded by limit. */
func (s *Store) WhatsAppUsage(ctx context.Context, since time.Time, limit int) ([]types.AdminWhatsAppHostUsage, error) {
	rows, err := s.pool.Query(ctx, `
		WITH hosts AS (
		  SELECT u.id, u.name, u.email, effective_plan(u.id) AS plan,
		         (COALESCE(u.whatsapp_access_token, '') <> '' AND u.whatsapp_connected_at IS NOT NULL) AS connected
		    FROM users u
		   WHERE COALESCE(u.whatsapp_access_token, '') <> ''
		      OR effective_plan(u.id) IN ('business', 'enterprise')
		), msgs AS (
		  SELECT m.host_id,
		         count(*) FILTER (WHERE m.direction = 'out'
		           AND n.kind IN ('wa_reminder', 'wa_registration_confirmed', 'wa_replay')) AS reminders,
		         count(*) FILTER (WHERE m.direction = 'out'
		           AND (m.broadcast_id IS NOT NULL OR n.kind = 'wa_broadcast')) AS broadcasts,
		         count(*) FILTER (WHERE m.direction = 'out' AND n.kind = 'wa_drip') AS drips,
		         count(*) FILTER (WHERE m.direction = 'out' AND m.bot_id IS NOT NULL) AS bot_messages,
		         count(*) FILTER (WHERE m.direction = 'out' AND m.manual) AS manual_replies,
		         count(*) FILTER (WHERE m.direction = 'in') AS inbound,
		         max(m.created_at) AS last_at
		    FROM crm_messages m
		    LEFT JOIN notifications n ON n.id = m.notification_id
		   WHERE m.host_id IN (SELECT id FROM hosts) AND m.created_at >= $1
		   GROUP BY m.host_id
		), bots AS (
		  SELECT b.host_id, count(*) AS sessions
		    FROM crm_bot_sessions bs
		    JOIN crm_bots b ON b.id = bs.bot_id
		   WHERE bs.created_at >= $1 AND b.host_id IN (SELECT id FROM hosts)
		   GROUP BY b.host_id
		)
		SELECT h.id::text, h.name, h.email, COALESCE(h.plan, ''), COALESCE(h.connected, false),
		       COALESCE(m.reminders, 0), COALESCE(m.broadcasts, 0), COALESCE(m.drips, 0),
		       COALESCE(b.sessions, 0), COALESCE(m.bot_messages, 0),
		       COALESCE(m.manual_replies, 0), COALESCE(m.inbound, 0), m.last_at
		  FROM hosts h
		  LEFT JOIN msgs m ON m.host_id = h.id
		  LEFT JOIN bots b ON b.host_id = h.id
		 ORDER BY m.last_at DESC NULLS LAST, h.email
		 LIMIT $2`, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.AdminWhatsAppHostUsage{}
	for rows.Next() {
		var (
			u    types.AdminWhatsAppHostUsage
			plan string
			last *time.Time
		)
		if err := rows.Scan(&u.UserID, &u.Name, &u.Email, &plan, &u.Connected,
			&u.Reminders, &u.Broadcasts, &u.Drips, &u.BotSessions, &u.BotMessages,
			&u.ManualReplies, &u.InboundReplies, &last); err != nil {
			return nil, err
		}
		u.Plan = types.Plan(plan)
		if last != nil {
			u.LastActiveAt = last.UTC().Format(time.RFC3339)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
