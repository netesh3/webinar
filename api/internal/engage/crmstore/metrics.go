package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

// MetricsTotals is the outbound aggregate for one host and window.
type MetricsTotals struct {
	Sent          int
	Delivered     int
	Read          int
	Failed        int
	CostMicros    int64
	CostEstimated bool
}

// FailureCount is one stored error string and how many failed messages share it.
type FailureCount struct {
	Error string
	Count int
}

// KindBreakdown is how a webinar's sent messages split, plus how many people
// they went to. Follow-ups are drip steps and broadcasts for that webinar.
type KindBreakdown struct {
	Confirmation int
	Reminders    int
	Replay       int
	FollowUps    int
	People       int
}

/* MessageMetrics counts outbound WhatsApp messages in [from, to).
 *
 * A nil bound is open. Sent is every message Meta has reported on. Delivered
 * includes read, matching the status bar (read + delivered-but-not-read +
 * failed, plus anything still only "sent"). Queued rows are not sent yet.
 * Inbound rows are excluded: they are stored as delivered and would inflate
 * the numbers.
 */
func (s *Store) MessageMetrics(ctx context.Context, hostID string, from, to *time.Time) (MetricsTotals, []FailureCount, error) {
	return s.messageMetrics(ctx, hostID, from, to, "")
}

/* WebinarMessageMetrics is MessageMetrics for one of this host's webinars,
 * with no time window, plus the by-kind split.
 */
func (s *Store) WebinarMessageMetrics(ctx context.Context, hostID, slug string) (MetricsTotals, []FailureCount, KindBreakdown, error) {
	var webinarID string
	err := s.pool.QueryRow(ctx, `
		SELECT id::text FROM webinars WHERE slug = $1 AND host_id = $2::uuid`,
		strings.TrimSpace(slug), hostID).Scan(&webinarID)
	if noRows(err) {
		return MetricsTotals{}, nil, KindBreakdown{}, store.ErrNotFound
	}
	if err != nil {
		return MetricsTotals{}, nil, KindBreakdown{}, err
	}
	totals, failures, err := s.messageMetrics(ctx, hostID, nil, nil, webinarID)
	if err != nil {
		return MetricsTotals{}, nil, KindBreakdown{}, err
	}
	var kinds KindBreakdown
	err = s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT m.contact_id) FILTER (WHERE m.status IN ('sent','delivered','read','failed')),
		       count(*) FILTER (WHERE m.status IN ('sent','delivered','read','failed')
		                         AND n.kind = 'wa_registration_confirmed'),
		       count(*) FILTER (WHERE m.status IN ('sent','delivered','read','failed')
		                         AND n.kind = 'wa_reminder'),
		       count(*) FILTER (WHERE m.status IN ('sent','delivered','read','failed')
		                         AND n.kind = 'wa_replay'),
		       count(*) FILTER (WHERE m.status IN ('sent','delivered','read','failed')
		                         AND n.kind IN ('wa_drip','wa_broadcast'))
		  FROM crm_messages m
		  LEFT JOIN notifications n ON n.id = m.notification_id
		 WHERE m.host_id = $1::uuid
		   AND m.webinar_id = $2::uuid
		   AND m.direction = 'out'`,
		hostID, webinarID).Scan(&kinds.People, &kinds.Confirmation, &kinds.Reminders, &kinds.Replay, &kinds.FollowUps)
	if err != nil {
		return MetricsTotals{}, nil, KindBreakdown{}, err
	}
	return totals, failures, kinds, nil
}

func (s *Store) messageMetrics(ctx context.Context, hostID string, from, to *time.Time, webinarID string) (MetricsTotals, []FailureCount, error) {
	where := `
		 WHERE host_id = $1::uuid
		   AND direction = 'out'
		   AND ($2::timestamptz IS NULL OR created_at >= $2)
		   AND ($3::timestamptz IS NULL OR created_at < $3)`
	args := []any{hostID, from, to}
	if webinarID != "" {
		where += ` AND webinar_id = $4::uuid`
		args = append(args, webinarID)
	}
	var out MetricsTotals
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status IN ('sent','delivered','read','failed')),
		       count(*) FILTER (WHERE status IN ('delivered','read')),
		       count(*) FILTER (WHERE status = 'read'),
		       count(*) FILTER (WHERE status = 'failed'),
		       COALESCE(sum(cost_micros), 0),
		       COALESCE(bool_or(cost_estimated) FILTER (WHERE cost_micros IS NOT NULL), false)
		  FROM crm_messages`+where, args...,
	).Scan(&out.Sent, &out.Delivered, &out.Read, &out.Failed, &out.CostMicros, &out.CostEstimated)
	if err != nil {
		return MetricsTotals{}, nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(NULLIF(error, ''), 'Unknown'), count(*)
		  FROM crm_messages`+where+`
		   AND status = 'failed'
		 GROUP BY 1
		 ORDER BY count(*) DESC, 1`,
		args...)
	if err != nil {
		return MetricsTotals{}, nil, err
	}
	defer rows.Close()
	var failures []FailureCount
	for rows.Next() {
		var f FailureCount
		if err := rows.Scan(&f.Error, &f.Count); err != nil {
			return MetricsTotals{}, nil, err
		}
		failures = append(failures, f)
	}
	if err := rows.Err(); err != nil {
		return MetricsTotals{}, nil, err
	}
	return out, failures, nil
}

/* SetMessagePricing records Meta's pricing on the message with this wamid.
 *
 * A later exact amount replaces an estimate. An estimate does not replace an
 * amount Meta already sent. A nil micros leaves the stored cost alone, so a
 * callback that only names the category does not wipe a charge. A missing
 * message is not an error: statuses arrive for sends this server never stored.
 */
func (s *Store) SetMessagePricing(ctx context.Context, hostID, wamid, category string, micros *int64, estimated bool) error {
	wamid = strings.TrimSpace(wamid)
	if wamid == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_messages
		   SET pricing_category = CASE WHEN $3 <> '' THEN $3 ELSE pricing_category END,
		       cost_micros = CASE
		           WHEN $4::bigint IS NULL THEN cost_micros
		           WHEN NOT $5 THEN $4
		           WHEN cost_micros IS NULL OR cost_estimated THEN $4
		           ELSE cost_micros
		       END,
		       cost_estimated = CASE
		           WHEN $4::bigint IS NULL THEN cost_estimated
		           WHEN NOT $5 THEN false
		           WHEN cost_micros IS NULL OR cost_estimated THEN true
		           ELSE cost_estimated
		       END,
		       updated_at = now()
		 WHERE host_id = $1::uuid AND wamid = $2`,
		hostID, wamid, category, micros, estimated)
	return err
}
