package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The People tab: every contact, and what they did across the host's webinars.
 *
 * Driven from registrations, each filed under one contact exactly as the roster files it
 * (pickContactForRegistration), then grouped per contact. That direction is the fast
 * one (see contactRegisteredFor) and it makes "attended" here the same fact as the
 * Attendees tab's watch column. Contacts with no registration — somebody who only ever
 * wrote in on WhatsApp — are still listed, with zero webinars.
 */

// peopleCTE is `per`: one row per contact with registrations, scoped to webinar $2 when
// it is not empty. Host is $1.
const peopleCTE = `
WITH reg AS (
	SELECT pick.id AS contact_id, w.id AS webinar_id, w.slug, w.topic, w.starts_at,
	       wt.rid IS NOT NULL AS joined, COALESCE(wt.watch_min, 0) AS watch_min
	  FROM registrations r
	  JOIN webinars w ON w.id = r.webinar_id
	  LEFT JOIN (` + "%WATCH%" + `) wt ON wt.rid = r.id
	  CROSS JOIN LATERAL (` + pickContactForRegistration + `) pick
	 WHERE w.host_id = $1::uuid AND r.state <> 'declined'
	   AND ($2 = '' OR w.slug = $2)
), per AS (
	SELECT contact_id,
	       count(DISTINCT webinar_id) AS webinars,
	       count(DISTINCT webinar_id) FILTER (WHERE joined) AS attended_webinars,
	       bool_or(joined) AS attended,
	       sum(watch_min)::int AS watch_min,
	       (array_agg(topic ORDER BY starts_at DESC NULLS LAST))[1] AS last_topic,
	       (array_agg(slug ORDER BY starts_at DESC NULLS LAST))[1] AS last_slug
	  FROM reg GROUP BY contact_id
)`

func peopleWith() string {
	return strings.Replace(peopleCTE, "%WATCH%",
		store.WatchByRegistrationSQL(`w.host_id = $1::uuid AND ($2 = '' OR w.slug = $2)`), 1)
}

// engagementJoin is the Audience rollup for each contact (migrations/0065).
const engagementJoin = `LEFT JOIN crm_contact_engagement ce ON ce.contact_id = c.id AND ce.host_id = c.host_id`

// peopleScope keeps a webinar-filtered list to that webinar's people.
const peopleScope = ` AND ($2 = '' OR per.contact_id IS NOT NULL)`

func peopleFilterPredicate(filter string) (string, error) {
	switch filter {
	case "":
		return "", nil
	case types.PeopleAttended:
		return ` AND COALESCE(per.attended, false)`, nil
	case types.PeopleNeverAttended:
		return ` AND NOT COALESCE(per.attended, false)`, nil
	case types.PeopleReplied:
		return ` AND ` + contactReplied, nil
	case types.PeopleOptedIn:
		return ` AND ` + optedInNow, nil
	case types.PeopleHotLeads:
		return ` AND ` + hotLead, nil
	case types.PeopleHighlyEngaged:
		return ` AND ce.attended >= 2 AND ce.avg_score >= 50`, nil
	case types.PeopleCameBack:
		return ` AND ce.attended >= 2`, nil
	case types.PeopleSlipping:
		return ` AND ce.registered >= 2 AND ce.attended = 0`, nil
	}
	return "", store.ErrInvalid
}

const contactStatusCase = `CASE
	WHEN ` + noNumber + `    THEN '` + types.CRMStatusNoNumber + `'
	WHEN ` + optedInNow + `  THEN '` + types.CRMStatusOptedIn + `'
	WHEN ` + optedOutNow + ` THEN '` + types.CRMStatusOptedOut + `'
	ELSE '` + types.CRMStatusNoOptIn + `'
END`

// PeopleFilter narrows the People list.
type PeopleFilter struct {
	WebinarSlug string
	Filter      string
	Query       string
	Limit       int
	Offset      int
}

const peoplePageMax = 100

// People is one page of the People tab, and the chips over it.
func (s *Store) People(ctx context.Context, hostID string, f PeopleFilter) (types.CRMPeopleResponse, error) {
	out := types.CRMPeopleResponse{People: []types.CRMPerson{}, Filter: f.Filter, Offset: f.Offset}
	pred, err := peopleFilterPredicate(f.Filter)
	if err != nil {
		return out, err
	}
	limit := f.Limit
	if limit <= 0 || limit > peoplePageMax {
		limit = 50
	}
	offset := max(f.Offset, 0)
	slug := strings.TrimSpace(f.WebinarSlug)
	q := strings.TrimSpace(f.Query)

	with := peopleWith()
	if err := s.pool.QueryRow(ctx, with+`
		SELECT count(*),
		       count(*) FILTER (WHERE COALESCE(per.attended, false)),
		       count(*) FILTER (WHERE NOT COALESCE(per.attended, false)),
		       count(*) FILTER (WHERE `+contactReplied+`),
		       count(*) FILTER (WHERE `+optedInNow+`),
		       count(*) FILTER (WHERE `+hotLead+`),
		       count(*) FILTER (WHERE ce.attended >= 2 AND ce.avg_score >= 50),
		       count(*) FILTER (WHERE ce.attended >= 2),
		       count(*) FILTER (WHERE ce.registered >= 2 AND ce.attended = 0)
		  FROM crm_contacts c
		  LEFT JOIN per ON per.contact_id = c.id
		  `+engagementJoin+`
		 WHERE c.host_id = $1::uuid`+peopleScope, hostID, slug).Scan(
		&out.Counts.Everyone, &out.Counts.Attended, &out.Counts.NeverAttended,
		&out.Counts.Replied, &out.Counts.OptedIn, &out.Counts.HotLeads,
		&out.Counts.HighlyEngaged, &out.Counts.CameBack, &out.Counts.Slipping); err != nil {
		return out, err
	}

	search := ` AND ($3 = '' OR c.name ILIKE '%' || $3 || '%'
	                  OR c.email ILIKE '%' || $3 || '%'
	                  OR c.phone ILIKE '%' || $3 || '%')`
	if err := s.pool.QueryRow(ctx, with+`
		SELECT count(*) FROM crm_contacts c LEFT JOIN per ON per.contact_id = c.id
		  `+engagementJoin+`
		 WHERE c.host_id = $1::uuid`+peopleScope+pred+search, hostID, slug, q).Scan(&out.Total); err != nil {
		return out, err
	}

	rows, err := s.pool.Query(ctx, with+`
		SELECT `+crmContactColumns+`, `+contactStatusCase+`,
		       COALESCE(per.webinars, 0), COALESCE(per.attended_webinars, 0),
		       COALESCE(per.last_topic, ''), COALESCE(per.last_slug, ''),
		       COALESCE(per.attended, false), COALESCE(per.watch_min, 0),
		       COALESCE(ce.avg_score, 0), COALESCE(ce.last_tier, ''),
		       `+lastInboundAt+`,
		       m.id::text, m.direction, m.body, m.kind, m.template_name, m.status, m.created_at
		  FROM crm_contacts c
		  LEFT JOIN per ON per.contact_id = c.id
		  `+engagementJoin+`
		  LEFT JOIN LATERAL (
		       SELECT id, direction, body, kind, template_name, status, created_at
		         FROM crm_messages WHERE contact_id = c.id
		        ORDER BY created_at DESC, id DESC LIMIT 1
		  ) m ON true
		 WHERE c.host_id = $1::uuid`+peopleScope+pred+search+`
		 ORDER BY coalesce(c.last_seen_at, c.created_at) DESC, c.id DESC
		 LIMIT $4 OFFSET $5`, hostID, slug, q, limit, offset)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			p                                  types.CRMPerson
			optIn, optOut, lastSeen, botPaused *time.Time
			created                            time.Time
			inbound                            *time.Time
			mID, mDir, mBody, mKind, mTemplate *string
			mStatus                            *string
			mAt                                *time.Time
		)
		c := &p.Contact
		if err := rows.Scan(&c.ID, &c.Phone, &c.Email, &c.Name, &c.Company, &c.Source,
			&optIn, &optOut, &lastSeen, &created, &botPaused,
			&p.WhatsAppStatus, &p.Webinars, &p.AttendedWebinars, &p.LastWebinar, &p.LastWebinarID, &p.Attended, &p.WatchMin,
			&p.AvgScore, &p.Tier,
			&inbound, &mID, &mDir, &mBody, &mKind, &mTemplate, &mStatus, &mAt); err != nil {
			return out, err
		}
		fillContactTimes(c, optIn, optOut, lastSeen, created, botPaused)
		if inbound != nil {
			c.LastInboundAt = inbound.Format(time.RFC3339)
		}
		if mID != nil {
			c.LastMessage = &types.CRMMessage{
				ID: *mID, ContactID: c.ID, Direction: derefString(mDir), Body: derefString(mBody),
				Kind: derefString(mKind), TemplateName: derefString(mTemplate), Status: derefString(mStatus),
			}
			if mAt != nil {
				c.LastMessage.CreatedAt = mAt.Format(time.RFC3339)
			}
		}
		out.People = append(out.People, p)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}

	out.Webinars, err = s.webinarRefs(ctx, hostID)
	if err != nil {
		return out, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT w.id) FROM webinars w
		 WHERE w.host_id = $1::uuid AND EXISTS (
		       SELECT 1 FROM registrations r WHERE r.webinar_id = w.id AND r.state <> 'declined')`,
		hostID).Scan(&out.WebinarCount); err != nil {
		return out, err
	}
	return out, nil
}

// PeopleContactIDs is every messageable contact a People filter matches, capped.
func (s *Store) PeopleContactIDs(ctx context.Context, hostID string, f PeopleFilter, limit int) ([]string, error) {
	pred, err := peopleFilterPredicate(f.Filter)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, peopleWith()+`
		SELECT c.id::text FROM crm_contacts c LEFT JOIN per ON per.contact_id = c.id
		 WHERE c.host_id = $1::uuid`+peopleScope+pred+reachable+`
		   AND ($3 = '' OR c.name ILIKE '%' || $3 || '%'
		        OR c.email ILIKE '%' || $3 || '%' OR c.phone ILIKE '%' || $3 || '%')
		 ORDER BY c.created_at, c.id
		 LIMIT $4`, hostID, strings.TrimSpace(f.WebinarSlug), strings.TrimSpace(f.Query), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// webinarRefs lists the host's non-draft webinars, newest first, for filter menus.
func (s *Store) webinarRefs(ctx context.Context, hostID string) ([]types.CRMWebinarRef, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug, topic, starts_at FROM webinars
		 WHERE host_id = $1::uuid AND status <> 'draft'
		 ORDER BY starts_at DESC NULLS LAST LIMIT 100`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.CRMWebinarRef{}
	for rows.Next() {
		var (
			ref types.CRMWebinarRef
			at  *time.Time
		)
		if err := rows.Scan(&ref.ID, &ref.Topic, &at); err != nil {
			return nil, err
		}
		if at != nil {
			ref.StartsAt = at.Format(time.RFC3339)
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

func fillContactTimes(c *types.CRMContact, optIn, optOut, lastSeen *time.Time, created time.Time, botPaused *time.Time) {
	c.CreatedAt = created.Format(time.RFC3339)
	if botPaused != nil {
		c.BotPausedAt = botPaused.Format(time.RFC3339)
	}
	if optIn != nil {
		c.WhatsAppOptInAt = optIn.Format(time.RFC3339)
	}
	if optOut != nil {
		c.WhatsAppOptOutAt = optOut.Format(time.RFC3339)
	}
	if lastSeen != nil {
		c.LastSeenAt = lastSeen.Format(time.RFC3339)
	}
	c.WhatsAppOptIn = optIn != nil && (optOut == nil || optOut.Before(*optIn))
	c.Tags = []types.CRMTag{}
}
