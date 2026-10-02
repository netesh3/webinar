package crmstore

import (
	"context"
	"encoding/json"
	"math"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The Audience rollup: engagement across webinars, per person. See migrations/0065.
 *
 * refreshSQL recomputes the rows for the contacts in `affected` (a CTE the caller writes,
 * with $1 the host) from every one of their registrations with this host. One statement,
 * upserted, so two refreshes racing converge on the same answer. */
var refreshSQL = `
	, regs AS (
		SELECT DISTINCT ON (pick.id, w.id)
		       pick.id AS contact_id, w.id AS webinar_id, w.starts_at,
		       (wt.rid IS NOT NULL OR es.score IS NOT NULL) AS joined,
		       es.score, es.tier, COALESCE(wt.watch_min, es.watch_seconds / 60, 0) AS watch_min
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id AND w.host_id = $1::uuid
		  CROSS JOIN LATERAL (` + pickContactForRegistration + `) pick
		  LEFT JOIN (` + store.WatchByRegistrationSQL(`w.host_id = $1::uuid`) + `) wt ON wt.rid = r.id
		  LEFT JOIN engagement_scores es ON es.registration_id = r.id AND es.webinar_id = w.id
		 WHERE r.state <> 'declined' AND pick.id IN (SELECT contact_id FROM affected)
		 ORDER BY pick.id, w.id, joined DESC, es.score DESC NULLS LAST
	), agg AS (
		SELECT contact_id,
		       count(*) AS registered,
		       count(*) FILTER (WHERE joined) AS attended,
		       COALESCE(round(avg(score) FILTER (WHERE score IS NOT NULL)), 0)::smallint AS avg_score,
		       COALESCE((array_agg(score ORDER BY starts_at DESC) FILTER (WHERE score IS NOT NULL))[1], 0)::smallint AS last_score,
		       COALESCE((array_agg(tier ORDER BY starts_at DESC) FILTER (WHERE score IS NOT NULL))[1], '') AS last_tier,
		       COALESCE((array_agg(tier ORDER BY score DESC) FILTER (WHERE score IS NOT NULL))[1], '') AS best_tier,
		       COALESCE(sum(watch_min), 0)::int AS watch_min,
		       (array_agg(webinar_id ORDER BY starts_at DESC))[1] AS last_webinar_id,
		       max(starts_at) FILTER (WHERE joined) AS last_attended_at
		  FROM regs GROUP BY contact_id
	)
	INSERT INTO crm_contact_engagement AS ce
	       (host_id, contact_id, registered, attended, avg_score, last_score, last_tier, best_tier,
	        watch_min, last_webinar_id, last_attended_at, updated_at)
	SELECT $1::uuid, contact_id, registered, attended, avg_score, last_score, last_tier, best_tier,
	       watch_min, last_webinar_id, last_attended_at, now()
	  FROM agg
	ON CONFLICT (host_id, contact_id) DO UPDATE SET
	       registered = EXCLUDED.registered, attended = EXCLUDED.attended,
	       avg_score = EXCLUDED.avg_score, last_score = EXCLUDED.last_score,
	       last_tier = EXCLUDED.last_tier, best_tier = EXCLUDED.best_tier,
	       watch_min = EXCLUDED.watch_min, last_webinar_id = EXCLUDED.last_webinar_id,
	       last_attended_at = EXCLUDED.last_attended_at, updated_at = now()`

// RefreshEngagementForWebinar refreshes everyone registered for one webinar.
func (s *Store) RefreshEngagementForWebinar(ctx context.Context, hostID, slug string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		WITH affected AS (
			SELECT DISTINCT pick.id AS contact_id
			  FROM registrations r
			  JOIN webinars w ON w.id = r.webinar_id
			  CROSS JOIN LATERAL (`+pickContactForRegistration+`) pick
			 WHERE w.slug = $2 AND w.host_id = $1::uuid AND r.state <> 'declined'
		)`+refreshSQL, hostID, slug)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// RefreshEngagementForContact refreshes one person, e.g. when they register again.
func (s *Store) RefreshEngagementForContact(ctx context.Context, hostID, contactID string) error {
	_, err := s.pool.Exec(ctx, `
		WITH affected AS (SELECT $2::uuid AS contact_id)`+refreshSQL, hostID, contactID)
	return err
}

// RefreshEngagementForHost refreshes every contact: the one-time backfill.
func (s *Store) RefreshEngagementForHost(ctx context.Context, hostID string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		WITH affected AS (SELECT id AS contact_id FROM crm_contacts WHERE host_id = $1::uuid)`+refreshSQL, hostID)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// HasEngagementRollup is whether the host's rollup has been filled at least once.
func (s *Store) HasEngagementRollup(ctx context.Context, hostID string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM crm_contact_engagement WHERE host_id = $1::uuid)`, hostID).Scan(&ok)
	return ok, err
}

/* Audience is the Audience tab's summary: the numbers, the webinar-by-webinar chart from the
 * saved engagement snapshots, and the two short lists — all reads, nothing computed. */
func (s *Store) Audience(ctx context.Context, hostID string, lastN int) (types.CRMAudienceSummary, error) {
	out := types.CRMAudienceSummary{Webinars: []types.CRMAudienceWebinar{},
		Best: []types.CRMAudiencePerson{}, Slipping: []types.CRMAudiencePerson{}}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE ce.registered > 0),
		       count(*) FILTER (WHERE ce.attended >= 2),
		       count(*) FILTER (WHERE ce.attended >= 2 AND ce.avg_score >= 50),
		       count(*) FILTER (WHERE ce.registered >= 2 AND ce.attended = 0),
		       count(*) FILTER (WHERE ce.last_attended_at >= now() - interval '30 days')
		  FROM crm_contact_engagement ce
		 WHERE ce.host_id = $1::uuid`+excludeOwnAccountEngagement, hostID).
		Scan(&out.People, &out.CameBack, &out.BestCount, &out.SlippingCount, &out.ActiveMonth); err != nil {
		return out, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.topic, w.starts_at, sn.payload
		  FROM webinars w
		  JOIN LATERAL (SELECT payload FROM engagement_snapshots es
		                 WHERE es.webinar_id = w.id ORDER BY formula_version DESC LIMIT 1) sn ON true
		 WHERE w.host_id = $1::uuid AND (w.status = 'ended' OR w.ended_at IS NOT NULL)
		 ORDER BY w.starts_at DESC LIMIT $2`, hostID, lastN)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var (
			wb      types.CRMAudienceWebinar
			at      time.Time
			payload []byte
			sum     struct {
				Index int `json:"index"`
				KPIs  struct {
					Registered int `json:"registered"`
					Attended   int `json:"attended"`
				} `json:"kpis"`
			}
		)
		if err := rows.Scan(&wb.ID, &wb.Topic, &at, &payload); err != nil {
			rows.Close()
			return out, err
		}
		_ = json.Unmarshal(payload, &sum)
		wb.StartsAt = at.Format(time.RFC3339)
		wb.Registered, wb.Attended, wb.Index = sum.KPIs.Registered, sum.KPIs.Attended, sum.Index
		out.Webinars = append(out.Webinars, wb)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	// Oldest first, as a chart reads.
	for i, j := 0, len(out.Webinars)-1; i < j; i, j = i+1, j-1 {
		out.Webinars[i], out.Webinars[j] = out.Webinars[j], out.Webinars[i]
	}
	seats, err := s.hostSeats(ctx, hostID)
	if err != nil {
		return out, err
	}
	var reg, came, indexSum int
	for i := range out.Webinars {
		if seat, ok := seats[out.Webinars[i].ID]; ok {
			adjustAudienceWebinar(&out.Webinars[i], seat)
		}
		reg += out.Webinars[i].Registered
		came += out.Webinars[i].Attended
		indexSum += out.Webinars[i].Index
	}
	if reg > 0 {
		out.ShowUpPct = came * 100 / reg
	}
	if n := len(out.Webinars); n > 0 {
		out.AvgIndex = indexSum / n
	}

	list := func(where, order string) ([]types.CRMAudiencePerson, error) {
		rs, err := s.pool.Query(ctx, `
			SELECT c.id::text, c.name, ce.registered, ce.attended, ce.avg_score, ce.last_tier
			  FROM crm_contact_engagement ce JOIN crm_contacts c ON c.id = ce.contact_id
			 WHERE ce.host_id = $1::uuid AND `+where+excludeOwnAccount+`
			 ORDER BY `+order+` LIMIT 5`, hostID)
		if err != nil {
			return nil, err
		}
		defer rs.Close()
		people := []types.CRMAudiencePerson{}
		for rs.Next() {
			var p types.CRMAudiencePerson
			if err := rs.Scan(&p.ContactID, &p.Name, &p.Registered, &p.Attended, &p.AvgScore, &p.Tier); err != nil {
				return nil, err
			}
			people = append(people, p)
		}
		return people, rs.Err()
	}
	if out.Best, err = list(`ce.attended >= 2 AND ce.avg_score >= 50`, `ce.avg_score DESC, ce.attended DESC`); err != nil {
		return out, err
	}
	out.Slipping, err = list(`ce.registered >= 2 AND ce.attended = 0`, `ce.registered DESC, c.name`)
	return out, err
}

/* hostSeat is the host's own registration on one webinar, read so the audience chart
 * can drop that seat from the saved snapshot. The snapshot itself is the engagement
 * record and is left as it was written. */
type hostSeat struct {
	attended bool
	score    *int
}

/* hostSeats is the host's own non-declined registration on each of their webinars.
 *
 * Same three keys as ownAccountContactIDs, applied to the registration rather than
 * the contact: user id when the registration is bound to the account, otherwise the
 * account email, otherwise the account phone. A seat with no score did not join.
 */
func (s *Store) hostSeats(ctx context.Context, hostID string) (map[string]hostSeat, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug,
		       bool_or(wt.rid IS NOT NULL OR es.score IS NOT NULL),
		       max(es.score)
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		  JOIN users u ON u.id = w.host_id
		  LEFT JOIN (`+store.WatchByRegistrationSQL(`w.host_id = $1::uuid`)+`) wt ON wt.rid = r.id
		  LEFT JOIN engagement_scores es ON es.registration_id = r.id AND es.webinar_id = w.id
		 WHERE w.host_id = $1::uuid AND r.state <> 'declined'
		   AND (
		        r.user_id = u.id
		        OR (u.email <> '' AND lower(r.email) = lower(u.email))
		        OR (u.phone <> '' AND r.phone <> ''
		            AND regexp_replace(r.phone, '[^0-9]', '', 'g')
		              = regexp_replace(u.phone, '[^0-9]', '', 'g'))
		   )
		 GROUP BY w.slug`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]hostSeat{}
	for rows.Next() {
		var (
			slug     string
			attended bool
			score    *int
		)
		if err := rows.Scan(&slug, &attended, &score); err != nil {
			return nil, err
		}
		out[slug] = hostSeat{attended: attended, score: score}
	}
	return out, rows.Err()
}

/* adjustAudienceWebinar drops the host's seat from one chart column.
 *
 * Registered and attended are headcounts, so the host is one seat. The session
 * index is the average of the scores of people who joined; when the host joined
 * and has a score, that average is rebuilt without them. A host who only registered
 * never entered the average, and the stored snapshot is not rewritten.
 */
func adjustAudienceWebinar(wb *types.CRMAudienceWebinar, seat hostSeat) {
	origAttended, origIndex := wb.Attended, wb.Index
	if wb.Registered > 0 {
		wb.Registered--
	}
	if seat.attended && wb.Attended > 0 {
		wb.Attended--
	}
	if !seat.attended || seat.score == nil || origAttended <= 0 {
		return
	}
	if wb.Attended == 0 {
		wb.Index = 0
		return
	}
	sum := origIndex*origAttended - *seat.score
	wb.Index = int(math.Round(float64(sum) / float64(wb.Attended)))
	if wb.Index < 0 {
		wb.Index = 0
	}
}
