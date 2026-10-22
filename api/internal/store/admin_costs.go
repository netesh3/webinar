package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The usage behind the admin "Cost by host" report (api/admin_costs.go). Everything is
 * summed here, in SQL, per session or per host; the API only splits the video server by
 * concurrency and groups by provider. Hours are float hours, sizes bytes. */

// CostSession is one session that started in the range, with its attendance and recordings
// summed.
type CostSession struct {
	WebinarID string
	Slug      string
	Topic     string
	Kind      string
	Delivery  string
	Venue     string
	HostID    string
	HostName  string
	HostEmail string
	// Project is the video server it ran on: its own pin, else its host's, else the default.
	Project   string
	StartedAt time.Time
	// EndedAt is ended_at; now() while live; else the scheduled length.
	EndedAt time.Time
	// ServerCaptions is captions run on the server for this session.
	ServerCaptions bool
	Transcribed    bool

	Audience int
	// Stage is distinct people on the stage: everyone not in the audience, plus an Edge
	// attendee brought up (their visit is the video server's, not the beats').
	Stage int
	// EdgeHours is Edge viewers' watch time (visits kept by the browser's beats).
	EdgeHours float64
	// RTCAudienceHours is audience watch time on the video server (standard delivery).
	RTCAudienceHours float64
	// AllHours is every visit's time, for meetings, simulives and Zoom.
	AllHours float64

	CompositeRecHours float64
	MixRecHours       float64
	BrowserRecHours   float64
	RecordedBytes     int64
}

// CostSessions lists the sessions that started in [from, to), every host's.
func (s *Store) CostSessions(ctx context.Context, from, to time.Time, defaultProject string) ([]CostSession, error) {
	rows, err := s.pool.Query(ctx, `
		WITH s AS (
		  SELECT w.id, w.slug, w.topic, w.kind, coalesce(w.delivery, '') AS delivery,
		         coalesce(w.venue, '') AS venue, w.host_id,
		         coalesce(u.name, '') AS host_name, coalesce(u.email, '') AS host_email,
		         coalesce(NULLIF(w.sfu_project, ''), NULLIF(u.sfu_project, ''), $3) AS project,
		         w.started_at,
		         GREATEST(w.started_at, coalesce(w.ended_at,
		                  CASE WHEN w.status = 'live' THEN now() END,
		                  w.started_at + make_interval(mins => GREATEST(coalesce(w.duration_min, 60), 0))))
		           AS ended_at,
		         coalesce(w.server_captions, false) AS captions
		    FROM webinars w
		    LEFT JOIN users u ON u.id = w.host_id
		   WHERE w.started_at IS NOT NULL AND w.started_at >= $1 AND w.started_at < $2
		), v AS (
		  SELECT v.webinar_id, v.identity,
		         v.identity LIKE 'att\_%' AS att,
		         v.seen_at IS NOT NULL AS beat,
		         s.delivery = 'edge' AS edge,
		         GREATEST(0, EXTRACT(EPOCH FROM coalesce(v.left_at, v.seen_at, s.ended_at) - v.joined_at)) / 3600 AS h
		    FROM attendance_visits v JOIN s ON s.id = v.webinar_id
		   WHERE v.identity NOT LIKE 'CAP\_%' AND v.identity NOT LIKE 'EG\_%'
		), va AS (
		  SELECT webinar_id,
		         count(DISTINCT identity) FILTER (WHERE att) AS audience,
		         count(DISTINCT identity) FILTER (WHERE NOT att OR (edge AND NOT beat)) AS stage,
		         coalesce(sum(h) FILTER (WHERE att AND beat), 0) AS edge_h,
		         coalesce(sum(h) FILTER (WHERE att AND NOT beat AND NOT edge), 0) AS rtc_h,
		         coalesce(sum(h), 0) AS all_h
		    FROM v GROUP BY webinar_id
		), r AS (
		  SELECT r.webinar_id,
		         coalesce(NULLIF(r.duration_ms, 0) / 3600000.0,
		                  EXTRACT(EPOCH FROM coalesce(r.stopped_at, r.last_chunk_at, now()) - r.created_at) / 3600)
		           AS h,
		         coalesce(r.egress_id, '') AS egress, coalesce(r.size_bytes, 0) AS bytes
		    FROM recordings r JOIN s ON s.id = r.webinar_id
		), ra AS (
		  SELECT webinar_id,
		         coalesce(sum(h) FILTER (WHERE egress <> '' AND egress NOT LIKE 'MIXREC\_%'), 0) AS composite_h,
		         coalesce(sum(h) FILTER (WHERE egress LIKE 'MIXREC\_%'), 0) AS mix_h,
		         coalesce(sum(h) FILTER (WHERE egress = ''), 0) AS browser_h,
		         coalesce(sum(bytes), 0)::bigint AS bytes
		    FROM r GROUP BY webinar_id
		)
		SELECT s.id::text, s.slug, s.topic, s.kind, s.delivery, s.venue, coalesce(s.host_id::text, ''),
		       s.host_name, s.host_email, s.project, s.started_at, s.ended_at, s.captions,
		       EXISTS (SELECT 1 FROM session_transcripts t WHERE t.webinar_id = s.id),
		       coalesce(va.audience, 0), coalesce(va.stage, 0),
		       coalesce(va.edge_h, 0)::float8, coalesce(va.rtc_h, 0)::float8, coalesce(va.all_h, 0)::float8,
		       coalesce(ra.composite_h, 0)::float8, coalesce(ra.mix_h, 0)::float8,
		       coalesce(ra.browser_h, 0)::float8, coalesce(ra.bytes, 0)
		  FROM s
		  LEFT JOIN va ON va.webinar_id = s.id
		  LEFT JOIN ra ON ra.webinar_id = s.id
		 ORDER BY s.started_at`, from, to, defaultProject)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostSession, error) {
		var c CostSession
		err := row.Scan(&c.WebinarID, &c.Slug, &c.Topic, &c.Kind, &c.Delivery, &c.Venue, &c.HostID,
			&c.HostName, &c.HostEmail, &c.Project, &c.StartedAt, &c.EndedAt, &c.ServerCaptions,
			&c.Transcribed, &c.Audience, &c.Stage, &c.EdgeHours, &c.RTCAudienceHours, &c.AllHours,
			&c.CompositeRecHours, &c.MixRecHours, &c.BrowserRecHours, &c.RecordedBytes)
		return c, err
	})
}

// CostSpan is a session on a video server, for the concurrency split.
type CostSpan struct {
	WebinarID string
	Project   string
	Edge      bool
	Start     time.Time
	End       time.Time
}

/* CostSpans is every session on a video server that overlaps [from, to), whoever's and
 * whenever it started: a session that started before the range still shares the server
 * with one that started inside it. Simulives and Zoom venues use no server of ours. */
func (s *Store) CostSpans(ctx context.Context, from, to time.Time, defaultProject string) ([]CostSpan, error) {
	rows, err := s.pool.Query(ctx, `
		WITH s AS (
		  SELECT w.id,
		         coalesce(NULLIF(w.sfu_project, ''), NULLIF(u.sfu_project, ''), $3) AS project,
		         coalesce(w.delivery, '') = 'edge' AS edge,
		         w.started_at,
		         GREATEST(w.started_at, coalesce(w.ended_at,
		                  CASE WHEN w.status = 'live' THEN now() END,
		                  w.started_at + make_interval(mins => GREATEST(coalesce(w.duration_min, 60), 0))))
		           AS ended_at
		    FROM webinars w
		    LEFT JOIN users u ON u.id = w.host_id
		   WHERE w.started_at IS NOT NULL AND w.started_at < $2
		     AND w.kind <> 'simulive' AND coalesce(w.venue, '') NOT LIKE 'zoom%'
		)
		SELECT id::text, project, edge, started_at, ended_at FROM s WHERE ended_at > $1`,
		from, to, defaultProject)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostSpan, error) {
		var c CostSpan
		err := row.Scan(&c.WebinarID, &c.Project, &c.Edge, &c.Start, &c.End)
		return c, err
	})
}

// CostFirstSessions is each video server's first session ever: the box is counted from then.
func (s *Store) CostFirstSessions(ctx context.Context, defaultProject string) (map[string]time.Time, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT coalesce(NULLIF(w.sfu_project, ''), NULLIF(u.sfu_project, ''), $1), min(w.started_at)
		  FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		 WHERE w.started_at IS NOT NULL
		   AND w.kind <> 'simulive' AND coalesce(w.venue, '') NOT LIKE 'zoom%'
		 GROUP BY 1`, defaultProject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var p string
		var t time.Time
		if err := rows.Scan(&p, &t); err != nil {
			return nil, err
		}
		out[p] = t
	}
	return out, rows.Err()
}

// CostFirstSession is the first session anybody started, the start of "all time".
func (s *Store) CostFirstSession(ctx context.Context) (time.Time, bool, error) {
	var t *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT min(started_at) FROM webinars`).Scan(&t); err != nil {
		return time.Time{}, false, err
	}
	if t == nil {
		return time.Time{}, false, nil
	}
	return *t, true, nil
}

// CostAI is one host's spend on one AI feature. HostID is empty for spend with no host.
type CostAI struct {
	HostID           string
	Feature          string
	Calls            int
	PromptTokens     int64
	CompletionTokens int64
	CostUSD          float64
}

// CostAIUsage sums ai_usage in [from, to) by host and feature.
func (s *Store) CostAIUsage(ctx context.Context, from, to time.Time) ([]CostAI, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT coalesce(host_id::text, ''), feature, count(*)::int,
		       coalesce(sum(prompt_tokens), 0)::bigint, coalesce(sum(completion_tokens), 0)::bigint,
		       coalesce(sum(cost_usd), 0)::float8
		  FROM ai_usage
		 WHERE created_at >= $1 AND created_at < $2
		 GROUP BY 1, 2 ORDER BY 1, 6 DESC`, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostAI, error) {
		var c CostAI
		err := row.Scan(&c.HostID, &c.Feature, &c.Calls, &c.PromptTokens, &c.CompletionTokens, &c.CostUSD)
		return c, err
	})
}

// CostStorage is one host's storage: GB-days held in the range, and GB held now.
type CostStorage struct {
	HostID          string
	RecordingGBDays float64
	RecordingGB     float64
	MediaGBDays     float64
	MediaGB         float64
	KnowledgeGBDays float64
	KnowledgeGB     float64
}

/* CostStorageUsage is GB × days held inside [from, to) per host. A recording still stored is
 * held from its creation to now; a deleted one (recording_deletions, from 0145) to its
 * deletion. Media and knowledge files that were deleted are not recorded anywhere, so only
 * what is held now counts. HostID is empty for deleted recordings whose host is gone. */
func (s *Store) CostStorageUsage(ctx context.Context, from, to time.Time) ([]CostStorage, error) {
	rows, err := s.pool.Query(ctx, `
		WITH held AS (
		  SELECT w.host_id, 'rec' AS what, r.size_bytes AS bytes, r.created_at AS since, now() AS until, true AS now_held
		    FROM recordings r JOIN webinars w ON w.id = r.webinar_id
		  UNION ALL
		  SELECT host_id, 'rec', size_bytes, created_at, deleted_at, false FROM recording_deletions
		  UNION ALL
		  SELECT host_id, 'media', bytes, created_at, now(), true FROM crm_media_files
		  UNION ALL
		  SELECT host_id, 'doc', bytes, created_at, now(), true FROM knowledge_docs
		), d AS (
		  SELECT host_id, what, now_held, coalesce(bytes, 0) / 1e9 AS gb,
		         GREATEST(0, EXTRACT(EPOCH FROM LEAST(until, $2) - GREATEST(since, $1))) / 86400 AS days
		    FROM held
		)
		SELECT coalesce(host_id::text, ''),
		       coalesce(sum(gb * days) FILTER (WHERE what = 'rec'), 0)::float8,
		       coalesce(sum(gb) FILTER (WHERE what = 'rec' AND now_held), 0)::float8,
		       coalesce(sum(gb * days) FILTER (WHERE what = 'media'), 0)::float8,
		       coalesce(sum(gb) FILTER (WHERE what = 'media'), 0)::float8,
		       coalesce(sum(gb * days) FILTER (WHERE what = 'doc'), 0)::float8,
		       coalesce(sum(gb) FILTER (WHERE what = 'doc'), 0)::float8
		  FROM d GROUP BY 1`, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostStorage, error) {
		var c CostStorage
		err := row.Scan(&c.HostID, &c.RecordingGBDays, &c.RecordingGB, &c.MediaGBDays, &c.MediaGB,
			&c.KnowledgeGBDays, &c.KnowledgeGB)
		return c, err
	})
}

// CostSend is a number of messages one host caused, by channel and kind.
type CostSend struct {
	HostID  string
	Channel string // "email" or "whatsapp"
	Kind    string
	Count   int
}

/* CostSends counts what was sent in [from, to), by the host it was sent for: the outbox
 * (reminders, confirmations, broadcasts, drips, host alerts), follow-ups, recap emails,
 * replies from the email inbox, and WhatsApp messages from the CRM inbox. The outbox row
 * names its host through its webinar, broadcast or contact; a host alert is to the host. */
func (s *Store) CostSends(ctx context.Context, from, to time.Time) ([]CostSend, error) {
	rows, err := s.pool.Query(ctx, `
		WITH sends AS (
		  SELECT coalesce(w.host_id, b.host_id, c.host_id, n.user_id) AS host_id, n.channel, n.kind
		    FROM notifications n
		    LEFT JOIN webinars w ON w.id = n.webinar_id
		    LEFT JOIN crm_broadcasts b ON b.id = n.broadcast_id
		    LEFT JOIN crm_contacts c ON c.id = n.contact_id
		   WHERE n.delivery = 'sent' AND coalesce(n.delivered_at, n.created_at) >= $1
		     AND coalesce(n.delivered_at, n.created_at) < $2
		  UNION ALL
		  SELECT host_id, channel, 'followup' FROM followup_sends
		   WHERE status = 'sent' AND updated_at >= $1 AND updated_at < $2
		  UNION ALL
		  SELECT w.host_id, 'email', 'recap' FROM session_recaps r JOIN webinars w ON w.id = r.webinar_id
		   WHERE r.emailed_at >= $1 AND r.emailed_at < $2
		  UNION ALL
		  SELECT user_id, 'email', 'inbox_reply' FROM host_emails
		   WHERE direction = 'out' AND created_at >= $1 AND created_at < $2
		  UNION ALL
		  SELECT host_id, 'whatsapp', CASE WHEN manual THEN 'inbox_reply' ELSE 'bot' END FROM crm_messages
		   WHERE direction = 'out' AND notification_id IS NULL AND broadcast_id IS NULL
		     AND status IN ('sent', 'delivered', 'read') AND created_at >= $1 AND created_at < $2
		)
		SELECT host_id::text, channel, kind, count(*)::int FROM sends
		 WHERE host_id IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC`, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostSend, error) {
		var c CostSend
		err := row.Scan(&c.HostID, &c.Channel, &c.Kind, &c.Count)
		return c, err
	})
}

// CostHost is a host's name and email, for a host with usage but no session in the range.
type CostHost struct{ ID, Name, Email string }

// CostHosts loads the named users.
func (s *Store) CostHosts(ctx context.Context, ids []string) ([]CostHost, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, coalesce(name, ''), coalesce(email, '') FROM users WHERE id::text = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostHost, error) {
		var c CostHost
		err := row.Scan(&c.ID, &c.Name, &c.Email)
		return c, err
	})
}
