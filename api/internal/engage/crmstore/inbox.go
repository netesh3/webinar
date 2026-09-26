package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The Messages tab: conversations, and which of them are waiting on the host.
 *
 * Needs reply is derived, never stored: the newest inbound message is later than both
 * the host's newest manual reply and Mark done. So a reply typed on the phone
 * (Coexistence echo) answers it, a new message after Mark done reopens it, and an
 * automatic reminder that happens to go out after a question does not count as an
 * answer — `manual` is false on those.
 */

const (
	lastManualReplyAt = `(SELECT max(o.created_at) FROM crm_messages o
	 WHERE o.contact_id = c.id AND o.direction = 'out' AND o.manual)`

	needsReply = `(` + lastInboundAt + ` IS NOT NULL
	 AND ` + lastInboundAt + ` > COALESCE(` + lastManualReplyAt + `, '-infinity'::timestamptz)
	 AND ` + lastInboundAt + ` > COALESCE(c.inbox_done_at, '-infinity'::timestamptz))`

	hasThread = `EXISTS (SELECT 1 FROM crm_messages t WHERE t.contact_id = c.id)`

	// inboxScope narrows to one webinar's people when $2 is set.
	inboxScope = ` AND ($2 = '' OR ` + "%REG%" + `)`

	// threadWebinar is the webinar of the newest message tied to one, as (slug, topic).
	threadWebinar = `LEFT JOIN LATERAL (
		SELECT w.slug, w.topic FROM crm_messages tm JOIN webinars w ON w.id = tm.webinar_id
		 WHERE tm.contact_id = c.id AND tm.webinar_id IS NOT NULL
		 ORDER BY tm.created_at DESC LIMIT 1
	) tw ON true`
)

func inboxScoped() string {
	return strings.Replace(inboxScope, "%REG%", contactRegisteredFor(`$2`), 1)
}

func inboxViewPredicate(view string) (string, error) {
	switch view {
	case "", types.InboxNeedsReply:
		return ` AND ` + needsReply, nil
	case types.InboxAll:
		return ` AND ` + hasThread, nil
	case types.InboxDone:
		return ` AND ` + contactReplied + ` AND NOT ` + needsReply, nil
	}
	return "", store.ErrInvalid
}

// Inbox is the Messages tab's list.
func (s *Store) Inbox(ctx context.Context, hostID, view, webinarSlug string) (types.CRMInboxResponse, error) {
	out := types.CRMInboxResponse{Threads: []types.CRMInboxThread{}, View: view}
	if out.View == "" {
		out.View = types.InboxNeedsReply
	}
	pred, err := inboxViewPredicate(view)
	if err != nil {
		return out, err
	}
	slug := strings.TrimSpace(webinarSlug)
	scope := inboxScoped()

	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE `+needsReply+`),
		       count(*) FILTER (WHERE `+hasThread+`),
		       count(*) FILTER (WHERE `+contactReplied+` AND NOT `+needsReply+`)
		  FROM crm_contacts c
		 WHERE c.host_id = $1::uuid`+scope, hostID, slug).Scan(
		&out.Counts.NeedsReply, &out.Counts.All, &out.Counts.Done); err != nil {
		return out, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT `+crmContactColumns+`, `+lastInboundAt+`, `+needsReply+`,
		       COALESCE(tw.slug, ''), COALESCE(tw.topic, ''),
		       m.id::text, m.direction, m.body, m.kind, m.template_name, m.status, m.created_at
		  FROM crm_contacts c
		  `+threadWebinar+`
		  JOIN LATERAL (
		       SELECT id, direction, body, kind, template_name, status, created_at
		         FROM crm_messages WHERE contact_id = c.id
		        ORDER BY created_at DESC, id DESC LIMIT 1
		  ) m ON true
		 WHERE c.host_id = $1::uuid`+scope+pred+`
		 ORDER BY m.created_at DESC, c.id
		 LIMIT 200`, hostID, slug)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			t                                  types.CRMInboxThread
			optIn, optOut, lastSeen, botPaused *time.Time
			created                            time.Time
			inbound                            *time.Time
			m                                  types.CRMMessage
			mAt                                time.Time
		)
		c := &t.Contact
		if err := rows.Scan(&c.ID, &c.Phone, &c.Email, &c.Name, &c.Company, &c.Source,
			&optIn, &optOut, &lastSeen, &created, &botPaused,
			&inbound, &t.NeedsReply, &t.WebinarID, &t.Webinar,
			&m.ID, &m.Direction, &m.Body, &m.Kind, &m.TemplateName, &m.Status, &mAt); err != nil {
			return out, err
		}
		fillContactTimes(c, optIn, optOut, lastSeen, created, botPaused)
		if inbound != nil {
			c.LastInboundAt = inbound.Format(time.RFC3339)
		}
		m.ContactID = c.ID
		m.CreatedAt = mAt.Format(time.RFC3339)
		t.LastMessage = &m
		out.Threads = append(out.Threads, t)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	out.Webinars, err = s.webinarRefs(ctx, hostID)
	return out, err
}

// SetInboxDone marks a conversation done, or reopens it.
func (s *Store) SetInboxDone(ctx context.Context, hostID, contactID string, done bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_contacts
		   SET inbox_done_at = CASE WHEN $3 THEN now() ELSE NULL END
		 WHERE id = $1::uuid AND host_id = $2::uuid`, contactID, hostID, done)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ThreadMeta is the thread header's summary of a person.
func (s *Store) ThreadMeta(ctx context.Context, hostID, contactID string) (types.CRMThreadMeta, error) {
	var meta types.CRMThreadMeta
	err := s.pool.QueryRow(ctx, `
		SELECT `+needsReply+` FROM crm_contacts c
		 WHERE c.id = $1::uuid AND c.host_id = $2::uuid`, contactID, hostID).Scan(&meta.NeedsReply)
	if noRows(err) {
		return meta, store.ErrNotFound
	}
	if err != nil {
		return meta, err
	}
	err = s.pool.QueryRow(ctx, peopleWith()+`
		SELECT COALESCE(per.webinars, 0), COALESCE(per.watch_min, 0)
		  FROM per WHERE per.contact_id = $3::uuid`, hostID, "", contactID).Scan(&meta.Webinars, &meta.WatchMin)
	if noRows(err) {
		return meta, nil
	}
	return meta, err
}

// Replies is the bell's view of the inbox.
func (s *Store) Replies(ctx context.Context, hostID string) (types.CRMRepliesResponse, error) {
	out := types.CRMRepliesResponse{Recent: []types.CRMReplyAlert{}, ByWebinar: map[string]int{}}
	rows, err := s.pool.Query(ctx, `
		SELECT c.id::text, c.name, c.phone, COALESCE(tw.slug, ''), COALESCE(tw.topic, ''), `+lastInboundAt+`
		  FROM crm_contacts c
		  `+threadWebinar+`
		 WHERE c.host_id = $1::uuid AND `+needsReply+`
		 ORDER BY 6 DESC
		 LIMIT 500`, hostID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			a     types.CRMReplyAlert
			phone string
			at    time.Time
		)
		if err := rows.Scan(&a.ContactID, &a.Name, &phone, &a.WebinarID, &a.Webinar, &at); err != nil {
			return out, err
		}
		if a.Name == "" {
			a.Name = phone
		}
		a.At = at.Format(time.RFC3339)
		out.NeedsReply++
		if a.WebinarID != "" {
			out.ByWebinar[a.WebinarID]++
		}
		if len(out.Recent) < 8 {
			out.Recent = append(out.Recent, a)
		}
	}
	return out, rows.Err()
}

// WebinarWaiting is the replies waiting from one webinar's people, newest first.
func (s *Store) WebinarWaiting(ctx context.Context, hostID, slug string) ([]types.CRMReplyAlert, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.id::text, COALESCE(NULLIF(c.name, ''), c.phone), `+lastInboundAt+`
		  FROM crm_contacts c
		 WHERE c.host_id = $1::uuid AND `+contactRegisteredFor(`$2`)+` AND `+needsReply+`
		 ORDER BY 3 DESC LIMIT 50`, hostID, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.CRMReplyAlert{}
	for rows.Next() {
		var (
			a  types.CRMReplyAlert
			at time.Time
		)
		if err := rows.Scan(&a.ContactID, &a.Name, &at); err != nil {
			return nil, err
		}
		a.WebinarID = slug
		a.At = at.Format(time.RFC3339)
		out = append(out, a)
	}
	return out, rows.Err()
}

/* ReplyDigest is one host owed an email about replies waiting. */
type ReplyDigest struct {
	HostID  string
	Email   string
	Name    string
	Waiting int
	Names   []string
}

/* ReplyDigestsDue finds hosts with replies that arrived since their last email, once the
 * newest has been sitting quiet for `quiet` (so a burst is one email) and at most once
 * per `every`.
 */
func (s *Store) ReplyDigestsDue(ctx context.Context, quiet, every time.Duration) ([]ReplyDigest, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id::text, u.email, u.name, count(*),
		       (array_agg(COALESCE(NULLIF(c.name, ''), c.phone) ORDER BY `+lastInboundAt+` DESC))[1:3]
		  FROM users u
		  JOIN crm_contacts c ON c.host_id = u.id
		 WHERE u.email <> '' AND u.whatsapp_phone_number_id <> ''
		   AND (u.whatsapp_reply_digest_at IS NULL OR u.whatsapp_reply_digest_at < now() - $2::interval)
		   AND `+needsReply+`
		 GROUP BY u.id, u.email, u.name
		HAVING max(`+lastInboundAt+`) > COALESCE(max(u.whatsapp_reply_digest_at), '-infinity'::timestamptz)
		   AND max(`+lastInboundAt+`) < now() - $1::interval
		 LIMIT 100`, quiet.String(), every.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReplyDigest{}
	for rows.Next() {
		var d ReplyDigest
		if err := rows.Scan(&d.HostID, &d.Email, &d.Name, &d.Waiting, &d.Names); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// MarkReplyDigestSent records that the host was emailed, so the next goes after new replies.
func (s *Store) MarkReplyDigestSent(ctx context.Context, hostID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET whatsapp_reply_digest_at = now() WHERE id = $1::uuid`, hostID)
	return err
}

// Coexistence reports whether the host's number is also on the WhatsApp Business app.
func (s *Store) Coexistence(ctx context.Context, hostID string) (bool, error) {
	var on bool
	err := s.pool.QueryRow(ctx,
		`SELECT whatsapp_coexistence FROM users WHERE id = $1::uuid`, hostID).Scan(&on)
	if noRows(err) {
		return false, nil
	}
	return on, err
}
