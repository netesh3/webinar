package crmstore

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* WebinarAutomatic counts one webinar's automatic WhatsApp messages: the confirmation,
 * each reminder time, and the replay. Queued/sent/failed/skipped come from the outbox;
 * delivered and read from the conversation rows those sends wrote (notification_id).
 */
func (s *Store) WebinarAutomatic(ctx context.Context, hostID, slug string) ([]types.CRMAutomaticStats, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT n.kind, COALESCE(n.offset_min, 0),
		       min(n.due_at) FILTER (WHERE n.kind = 'wa_reminder'),
		       count(*) FILTER (WHERE n.delivery = 'pending'),
		       count(*) FILTER (WHERE n.delivery = 'sent'),
		       count(*) FILTER (WHERE n.delivery = 'failed'),
		       count(*) FILTER (WHERE n.delivery = 'skipped'),
		       count(m.id) FILTER (WHERE m.status IN ('delivered','read')),
		       count(m.id) FILTER (WHERE m.status = 'read')
		  FROM notifications n
		  JOIN webinars w ON w.id = n.webinar_id
		  LEFT JOIN crm_messages m ON m.notification_id = n.id
		 WHERE w.slug = $1 AND w.host_id = $2::uuid AND n.channel = 'whatsapp'
		   AND n.kind IN ('wa_registration_confirmed','wa_reminder','wa_replay')
		 GROUP BY n.kind, COALESCE(n.offset_min, 0)`, slug, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.CRMAutomaticStats{}
	for rows.Next() {
		var (
			a   types.CRMAutomaticStats
			due *time.Time
		)
		if err := rows.Scan(&a.Kind, &a.OffsetMin, &due, &a.Queued, &a.Sent, &a.Failed,
			&a.Skipped, &a.Delivered, &a.Read); err != nil {
			return nil, err
		}
		if due != nil {
			a.DueAt = due.Format(time.RFC3339)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
