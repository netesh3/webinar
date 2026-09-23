package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

/* The lead CRM: contacts and the conversation with them, scoped to one host.
 *
 * Every function here takes hostID and every query filters on it. Not because a
 * handler might forget — the handlers are host-only routes — but because the
 * ingest path is different in kind from the rest of this package: it is driven by
 * a webhook from Meta, and the host it belongs to is derived from an id in that
 * payload rather than from a session. Scoping in SQL means the worst a confused
 * webhook can do is write to the wrong host's CRM, not read from every host's.
 */

// ContactInput is the person, as whichever source found them knows them. Every
// field is optional except that one of Phone and Email must be present — a
// contact identified by neither is a row nothing can ever match again, which is
// why the registration path drops guests rather than storing them.
type ContactInput struct {
	Phone   string
	Email   string
	Name    string
	Company string
	// "registration", "whatsapp", "manual". Recorded on creation and then left
	// alone: where a lead came from is history, and the second webinar they
	// register for does not change it.
	Source string
	// The registration that produced this contact, if one did. Stored on first
	// touch only.
	RegistrationID string
	// True when the person actively agreed to WhatsApp messages from this host.
	// False means "did not say yes", never "said no" — opting out is
	// SetContactWhatsAppOptOut, because the two are not each other's absence.
	WhatsAppOptIn bool
	/* Weak marks Name and Company as a guess rather than something the person
	 * typed.
	 *
	 * A WhatsApp profile name is whatever somebody set on their phone once — "Dad",
	 * an emoji, a shop's trading name — and letting it overwrite the name a
	 * registration form collected would make the host's list worse every time a
	 * contact replied to a message. So a weak source fills blanks and nothing more.
	 */
	Weak bool
}

const crmContactColumns = `
	c.id::text, c.phone, c.email, c.name, c.company, c.source,
	c.whatsapp_opt_in_at, c.whatsapp_opt_out_at, c.last_seen_at, c.created_at,
	c.bot_paused_at`

func scanContact(row scanner) (types.CRMContact, error) {
	var (
		c         types.CRMContact
		optIn     *time.Time
		optOut    *time.Time
		lastSeen  *time.Time
		created   time.Time
		botPaused *time.Time
	)
	if err := row.Scan(&c.ID, &c.Phone, &c.Email, &c.Name, &c.Company, &c.Source,
		&optIn, &optOut, &lastSeen, &created, &botPaused); err != nil {
		return types.CRMContact{}, err
	}
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
	/* Sendable, computed from the pair rather than stored.
	 *
	 * Opt-out wins when it is the later of the two, so a contact who replied STOP
	 * and then re-subscribed is reachable again without anybody having to delete
	 * the refusal. Deriving it here is what stops the UI and the send path from
	 * reading the same two timestamps and reaching different conclusions.
	 */
	c.WhatsAppOptIn = optIn != nil && (optOut == nil || optOut.Before(*optIn))
	// Never nil, whether or not the caller goes on to fill them in: see CRMContact.Tags.
	c.Tags = []types.CRMTag{}
	return c, nil
}

/* UpsertContact records a person against a host, or updates the one already
 * there, and returns whichever it ended up being.
 *
 * Matched by phone first and email second, in that order and not the reverse: the
 * phone number is what a WhatsApp message is addressed to, so two rows that share
 * one are the same person by definition. Emails are matched case-insensitively.
 *
 * The merge only ever fills blanks in, with one exception. Name and company from
 * a newer registration replace older ones — somebody who changed jobs between two
 * webinars is telling us something current — while phone and email are only
 * written when the row has none, because changing a contact's identifying number
 * out from under a conversation would silently re-address the thread.
 */
func (s *Store) UpsertContact(ctx context.Context, hostID string, in ContactInput) (types.CRMContact, error) {
	phone := normalisePhone(in.Phone)
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if phone == "" && email == "" {
		return types.CRMContact{}, ErrNotFound
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.CRMContact{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once committed

	id, err := findContactID(ctx, tx, hostID, phone, email)
	if err != nil && err != ErrNotFound {
		return types.CRMContact{}, err
	}

	if err == ErrNotFound {
		var newID string
		err = tx.QueryRow(ctx, `
			INSERT INTO crm_contacts
				(host_id, phone, email, name, company, source, registration_id,
				 whatsapp_opt_in_at, last_seen_at)
			VALUES ($1,$2,$3,$4,$5,$6,nullif($7,'')::uuid,
			        case when $8 then now() else null end, null)
			RETURNING id::text`,
			hostID, phone, email, strings.TrimSpace(in.Name), strings.TrimSpace(in.Company),
			strings.TrimSpace(in.Source), in.RegistrationID, in.WhatsAppOptIn,
		).Scan(&newID)
		switch {
		case isUniqueViolation(err):
			// Two registrations for the same person landed together. The row that
			// won is the contact; fall through and merge into it.
			id, err = findContactID(ctx, tx, hostID, phone, email)
			if err != nil {
				return types.CRMContact{}, err
			}
		case err != nil:
			return types.CRMContact{}, err
		default:
			c, err := contactByID(ctx, tx, hostID, newID)
			if err != nil {
				return types.CRMContact{}, err
			}
			return c, tx.Commit(ctx)
		}
	}

	/* Filling in phone or email is guarded by a NOT EXISTS rather than left to the
	 * unique index, because the index would abort the whole transaction: a contact
	 * matched by phone who turns out to share an email with a DIFFERENT contact is
	 * a real situation (two people, one family address), and the right outcome is
	 * to keep the row we matched and leave the email where it already is — not to
	 * fail a registration over it. */
	if _, err := tx.Exec(ctx, `
		UPDATE crm_contacts c SET
			phone = case
				when c.phone = '' and $2 <> '' and not exists (
					SELECT 1 FROM crm_contacts o
					 WHERE o.host_id = c.host_id AND o.phone = $2 AND o.id <> c.id)
				then $2 else c.phone end,
			email = case
				when c.email = '' and $3 <> '' and not exists (
					SELECT 1 FROM crm_contacts o
					 WHERE o.host_id = c.host_id AND lower(o.email) = $3 AND o.id <> c.id)
				then $3 else c.email end,
			name = case
				when nullif($4,'') is null then c.name
				when c.name = '' then $4
				when $10 then c.name -- a weak source never overwrites
				else $4 end,
			company = case
				when nullif($5,'') is null then c.company
				when c.company = '' then $5
				when $10 then c.company
				else $5 end,
			source  = case when c.source = '' then $6 else c.source end,
			registration_id = coalesce(c.registration_id, nullif($7,'')::uuid),
			whatsapp_opt_in_at = case
				when not $8 then c.whatsapp_opt_in_at
				-- Re-consenting after an opt-out is a new consent, and its date is
				-- the one that would have to stand up to being asked about.
				when c.whatsapp_opt_in_at is null or c.whatsapp_opt_out_at is not null then now()
				else c.whatsapp_opt_in_at end,
			whatsapp_opt_out_at = case when $8 then null else c.whatsapp_opt_out_at end,
			updated_at = now()
		 WHERE c.id = $1::uuid AND c.host_id = $9::uuid`,
		id, phone, email, strings.TrimSpace(in.Name), strings.TrimSpace(in.Company),
		strings.TrimSpace(in.Source), in.RegistrationID, in.WhatsAppOptIn, hostID, in.Weak,
	); err != nil {
		return types.CRMContact{}, err
	}

	c, err := contactByID(ctx, tx, hostID, id)
	if err != nil {
		return types.CRMContact{}, err
	}
	return c, tx.Commit(ctx)
}

// findContactID locks and returns the contact this person already has, phone
// before email. FOR UPDATE so a concurrent upsert of the same person waits rather
// than both of them merging into what they each read a moment ago.
func findContactID(ctx context.Context, tx pgx.Tx, hostID, phone, email string) (string, error) {
	var id string
	if phone != "" {
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM crm_contacts
			 WHERE host_id = $1 AND phone = $2 FOR UPDATE`, hostID, phone).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !noRows(err) {
			return "", err
		}
	}
	if email != "" {
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM crm_contacts
			 WHERE host_id = $1 AND lower(email) = $2 FOR UPDATE`, hostID, email).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !noRows(err) {
			return "", err
		}
	}
	return "", ErrNotFound
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func contactByID(ctx context.Context, q querier, hostID, id string) (types.CRMContact, error) {
	c, err := scanContact(q.QueryRow(ctx, `
		SELECT `+crmContactColumns+`
		  FROM crm_contacts c
		 WHERE c.id = $1::uuid AND c.host_id = $2::uuid`, id, hostID))
	if noRows(err) {
		return types.CRMContact{}, ErrNotFound
	}
	return c, err
}

// Contact reads one of a host's contacts.
func (s *Store) Contact(ctx context.Context, hostID, id string) (types.CRMContact, error) {
	return contactByID(ctx, s.pool, hostID, id)
}

// ContactByPhone finds a host's contact by number, which is what the webhook has
// and nothing else does.
func (s *Store) ContactByPhone(ctx context.Context, hostID, phone string) (types.CRMContact, error) {
	p := normalisePhone(phone)
	if p == "" {
		return types.CRMContact{}, ErrNotFound
	}
	c, err := scanContact(s.pool.QueryRow(ctx, `
		SELECT `+crmContactColumns+`
		  FROM crm_contacts c
		 WHERE c.host_id = $1 AND c.phone = $2`, hostID, p))
	if noRows(err) {
		return types.CRMContact{}, ErrNotFound
	}
	return c, err
}

// crmContactsPageMax caps one page of contacts. A host with ten thousand leads
// does not want them in one response, and neither does the browser that has to
// render them.
const crmContactsPageMax = 200

/* Contacts lists a host's people, most recent activity first, with the last thing
 * said in each thread.
 *
 * The last message comes from a LATERAL rather than a second round of queries,
 * because the inbox is a list of conversations and a list that needs one query
 * per row to say anything useful is a list that gets slower the more it matters.
 *
 * query filters on name, email or phone as a substring — one box, because a host
 * looking for somebody knows one of those three things and should not have to say
 * which.
 */
func (s *Store) Contacts(ctx context.Context, hostID, query string, limit int) ([]types.CRMContact, int, error) {
	if limit <= 0 || limit > crmContactsPageMax {
		limit = crmContactsPageMax
	}
	q := strings.TrimSpace(query)

	var total int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM crm_contacts WHERE host_id = $1`, hostID).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT `+crmContactColumns+`,
		       m.id::text, m.direction, m.body, m.kind, m.template_name, m.status,
		       m.error, m.created_at
		  FROM crm_contacts c
		  LEFT JOIN LATERAL (
		       SELECT id, direction, body, kind, template_name, status, error, created_at
		         FROM crm_messages
		        WHERE contact_id = c.id
		        ORDER BY created_at DESC, id DESC
		        LIMIT 1
		  ) m ON true
		 WHERE c.host_id = $1
		   AND ($2 = '' OR c.name ILIKE '%' || $2 || '%'
		                OR c.email ILIKE '%' || $2 || '%'
		                OR c.phone ILIKE '%' || $2 || '%')
		 ORDER BY coalesce(c.last_seen_at, c.created_at) DESC, c.id DESC
		 LIMIT $3`, hostID, q, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	// Never nil: an empty CRM is an empty list on the wire, not a null the frontend
	// has to guard.
	out := make([]types.CRMContact, 0, 16)
	for rows.Next() {
		var (
			c         types.CRMContact
			optIn     *time.Time
			optOut    *time.Time
			lastSeen  *time.Time
			created   time.Time
			botPaused *time.Time
			// All eight nullable together, from the LEFT JOIN: a contact with no
			// messages yet is the ordinary case on a freshly imported list.
			mID       *string
			mDir      *string
			mBody     *string
			mKind     *string
			mTemplate *string
			mStatus   *string
			mError    *string
			mAt       *time.Time
		)
		if err := rows.Scan(&c.ID, &c.Phone, &c.Email, &c.Name, &c.Company, &c.Source,
			&optIn, &optOut, &lastSeen, &created, &botPaused,
			&mID, &mDir, &mBody, &mKind, &mTemplate, &mStatus, &mError, &mAt); err != nil {
			return nil, 0, err
		}
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
		if mID != nil {
			c.LastMessage = &types.CRMMessage{
				ID:           *mID,
				ContactID:    c.ID,
				Direction:    derefString(mDir),
				Body:         derefString(mBody),
				Kind:         derefString(mKind),
				TemplateName: derefString(mTemplate),
				Status:       derefString(mStatus),
				Error:        derefString(mError),
			}
			if mAt != nil {
				c.LastMessage.CreatedAt = mAt.Format(time.RFC3339)
			}
		}
		out = append(out, c)
	}
	return out, total, rows.Err()
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// crmThreadMax caps one thread read. A conversation that has run for a year is
// not scrolled from the top, and the newest messages are the ones being replied
// to — so this takes the last N and hands them back oldest-first.
const crmThreadMax = 300

// Thread reads the conversation with one contact, oldest message first.
func (s *Store) Thread(ctx context.Context, hostID, contactID string) (types.CRMContact, []types.CRMMessage, error) {
	contact, err := contactByID(ctx, s.pool, hostID, contactID)
	if err != nil {
		return types.CRMContact{}, nil, err
	}

	// The bot's name is joined in rather than left to the caller: a host reading a
	// conversation a bot handed them needs to see which half of it it wrote, and that
	// is the one screen where the question comes up.
	rows, err := s.pool.Query(ctx, `
		SELECT recent.id::text, recent.contact_id::text, recent.direction, recent.body,
		       recent.kind, recent.template_name, recent.status, recent.error,
		       COALESCE(b.name,''), recent.created_at
		  FROM (
		       SELECT * FROM crm_messages
		        WHERE host_id = $1 AND contact_id = $2::uuid
		        ORDER BY created_at DESC, id DESC
		        LIMIT $3
		  ) recent
		  LEFT JOIN crm_bots b ON b.id = recent.bot_id
		 ORDER BY recent.created_at, recent.id`, hostID, contactID, crmThreadMax)
	if err != nil {
		return types.CRMContact{}, nil, err
	}
	defer rows.Close()

	msgs := make([]types.CRMMessage, 0, 32)
	for rows.Next() {
		var (
			m       types.CRMMessage
			created time.Time
		)
		if err := rows.Scan(&m.ID, &m.ContactID, &m.Direction, &m.Body, &m.Kind,
			&m.TemplateName, &m.Status, &m.Error, &m.FromBot, &created); err != nil {
			return types.CRMContact{}, nil, err
		}
		m.CreatedAt = created.Format(time.RFC3339)
		msgs = append(msgs, m)
	}
	return contact, msgs, rows.Err()
}

/* LastInboundAt is when this contact last wrote to the host, or the zero time if
 * they never have.
 *
 * The one fact behind Meta's service window: a business may type its own words
 * for 24 hours after the customer's last message and not a minute longer. The 24
 * lives in the wa package with the rest of Meta's rules; this only reports the
 * timestamp, because how long the window lasts has changed before and where the
 * clock starts has not.
 *
 * Outbound messages are deliberately not considered. A business writing to
 * somebody does not give itself permission to keep writing — that is the entire
 * point of the window.
 */
func (s *Store) LastInboundAt(ctx context.Context, hostID, contactID string) (time.Time, error) {
	var at *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT max(created_at) FROM crm_messages
		 WHERE host_id = $1 AND contact_id = $2::uuid AND direction = 'in'`,
		hostID, contactID).Scan(&at)
	if err != nil || at == nil {
		return time.Time{}, err
	}
	return *at, nil
}

// MessageInput is one message to record. Direction is "in" or "out"; the rest
// depends on which.
type MessageInput struct {
	Direction string
	Body      string
	// Meta's type for an inbound message that is not text — "image", "audio",
	// "location", "button". Empty for text.
	Kind         string
	TemplateName string
	// Meta's message id. Empty is allowed for an outbound row created before Graph
	// has answered; when set, it makes this call idempotent.
	WAMID  string
	Status string
	Error  string
	// BroadcastID ties this row to the broadcast that sent it, which is how
	// delivered and read — reported by webhook against the message, not the outbox —
	// are counted per broadcast. Empty for everything else.
	BroadcastID string
	// BotID says a bot wrote this one. Empty for everything a person sent, which is
	// the default and most of the table.
	BotID string
	// When it was actually said, from Meta's own timestamp. Zero means "use now",
	// which is what an outbound message we are about to send wants — and what a
	// delivery Meta sent no timestamp on has to settle for. Recorded rather than
	// ignored because a batch that reaches us an hour late still belongs where it
	// happened in the conversation.
	At time.Time
}

/* AppendMessage records a message against a contact and bumps their last-seen.
 *
 * Idempotent on WAMID, which is the whole reason it is written this way. Meta
 * retries any delivery it did not see a 2xx for, including one we processed and
 * then failed to acknowledge — so without ON CONFLICT DO NOTHING a working
 * webhook produces a thread with some messages in it twice, and the host has no
 * way to tell which duplicate is real.
 */
func (s *Store) AppendMessage(ctx context.Context, hostID, contactID string, in MessageInput) (types.CRMMessage, error) {
	dir := strings.TrimSpace(in.Direction)
	if dir != "in" && dir != "out" {
		return types.CRMMessage{}, ErrConflict
	}
	status := strings.TrimSpace(in.Status)
	if status == "" {
		// An inbound message has already arrived; there is no further status to
		// report about it. An outbound one starts life queued.
		if dir == "in" {
			status = "delivered"
		} else {
			status = "queued"
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.CRMMessage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		m       types.CRMMessage
		created time.Time
	)
	at := in.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO crm_messages
			(host_id, contact_id, direction, body, kind, template_name, wamid, status,
			 error, created_at, broadcast_id, bot_id)
		VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,'')::uuid,
		        NULLIF($12,'')::uuid)
		ON CONFLICT (host_id, wamid) WHERE wamid <> '' DO NOTHING
		RETURNING id::text, contact_id::text, direction, body, kind, template_name,
		          status, error, created_at`,
		hostID, contactID, dir, in.Body, strings.TrimSpace(in.Kind),
		strings.TrimSpace(in.TemplateName), strings.TrimSpace(in.WAMID), status, in.Error, at,
		in.BroadcastID, in.BotID,
	).Scan(&m.ID, &m.ContactID, &m.Direction, &m.Body, &m.Kind, &m.TemplateName,
		&m.Status, &m.Error, &created)
	if noRows(err) {
		// Already stored, from an earlier delivery of the same message. Return the
		// row that exists so the caller has nothing to special-case, and leave
		// last_seen_at alone: a retry is not new activity.
		existing, gerr := messageByWAMID(ctx, tx, hostID, strings.TrimSpace(in.WAMID))
		if gerr != nil {
			return types.CRMMessage{}, gerr
		}
		return existing, tx.Commit(ctx)
	}
	if err != nil {
		return types.CRMMessage{}, err
	}
	m.CreatedAt = created.Format(time.RFC3339)

	// greatest() so a message that arrives out of order — Meta batches, and a
	// retry can overtake — cannot move a conversation backwards in the inbox.
	if _, err := tx.Exec(ctx, `
		UPDATE crm_contacts
		   SET last_seen_at = greatest(coalesce(last_seen_at, $3), $3), updated_at = now()
		 WHERE id = $1::uuid AND host_id = $2::uuid`, contactID, hostID, created); err != nil {
		return types.CRMMessage{}, err
	}
	return m, tx.Commit(ctx)
}

func messageByWAMID(ctx context.Context, q querier, hostID, wamid string) (types.CRMMessage, error) {
	var (
		m       types.CRMMessage
		created time.Time
	)
	err := q.QueryRow(ctx, `
		SELECT id::text, contact_id::text, direction, body, kind, template_name,
		       status, error, created_at
		  FROM crm_messages WHERE host_id = $1 AND wamid = $2`, hostID, wamid).
		Scan(&m.ID, &m.ContactID, &m.Direction, &m.Body, &m.Kind, &m.TemplateName,
			&m.Status, &m.Error, &created)
	if noRows(err) {
		return types.CRMMessage{}, ErrNotFound
	}
	if err != nil {
		return types.CRMMessage{}, err
	}
	m.CreatedAt = created.Format(time.RFC3339)
	return m, nil
}

/* SetMessageStatus applies one of Meta's delivery statuses to a message.
 *
 * Only ever forwards. Meta does not promise the order its status webhooks arrive
 * in, and a "sent" that lands after the "read" it preceded would otherwise make a
 * message that somebody has already answered look unacknowledged. Failure is the
 * exception and always wins: it is the one status a host has to act on.
 *
 * A status for a message we have no row for is not an error — a host could have
 * disconnected and reconnected, or the send could predate this table — so it
 * reports whether it matched anything and leaves the decision to the caller.
 */
func (s *Store) SetMessageStatus(ctx context.Context, hostID, wamid, status, failure string) (bool, error) {
	wamid = strings.TrimSpace(wamid)
	if wamid == "" {
		return false, nil
	}
	rank := map[string]int{"queued": 0, "sent": 1, "delivered": 2, "read": 3}
	next, ok := rank[status]
	if !ok && status != "failed" {
		return false, nil
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_messages
		   SET status = $3,
		       error = case when $3 = 'failed' then $4 else error end,
		       updated_at = now()
		 WHERE host_id = $1 AND wamid = $2
		   AND ($3 = 'failed' OR status <> 'failed')
		   AND ($3 = 'failed' OR $5 > case status
		         when 'queued' then 0 when 'sent' then 1
		         when 'delivered' then 2 when 'read' then 3 else 0 end)`,
		hostID, wamid, status, failure, next)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

/* SetContactWhatsAppOptOut records that this person no longer wants messages.
 *
 * Written as a timestamp rather than by clearing the opt-in, because "asked us to
 * stop" and "never agreed in the first place" are different facts and only one of
 * them has to be provable later. Idempotent: a contact who sends STOP twice keeps
 * the date of the first one, which is the date that matters.
 *
 * Takes their drip enrollments off with it, in the same transaction. The outbox would
 * refuse to send to them anyway, but refusing leaves the row pending for ever and the
 * host looking at a sequence somebody is apparently still on. "Stop" means stop, and
 * this is the one place that hears it.
 */
func (s *Store) SetContactWhatsAppOptOut(ctx context.Context, hostID, contactID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE crm_contacts
		   SET whatsapp_opt_out_at = coalesce(whatsapp_opt_out_at, now()), updated_at = now()
		 WHERE id = $1::uuid AND host_id = $2::uuid
		   AND (whatsapp_opt_out_at IS NULL
		        OR whatsapp_opt_in_at IS NOT NULL AND whatsapp_opt_in_at > whatsapp_opt_out_at)`,
		contactID, hostID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Already opted out, and their sequences were closed when it happened.
		return tx.Commit(ctx)
	}
	if err := exitDripsForContact(ctx, tx, contactID, "opted out"); err != nil {
		return err
	}
	// And any bot conversation, for the same reason: a flow asleep on a wait node would
	// otherwise wake up tomorrow and carry on talking to somebody who said stop.
	if err := stopBotsForContact(ctx, tx, contactID, "opted_out"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* ContactFromRegistration copies a registrant into the host's CRM.
 *
 * The join between the two halves of this feature, and the only place that knows
 * both. It looks the host up from the webinar rather than taking one, so a caller
 * cannot file somebody else's registrant under the wrong CRM.
 *
 * Returns ErrNotFound for a registrant with neither a phone number nor an email —
 * a guest, in practice. That is the documented behaviour rather than an oversight:
 * a contact with no way to reach them is a row that can never be matched again,
 * and a host's list filling up with anonymous entries from people who tapped
 * "join as guest" would make the CRM worse, not bigger.
 */
func (s *Store) ContactFromRegistration(ctx context.Context, slug string, reg types.Registration, optIn bool) (types.CRMContact, error) {
	var hostID string
	err := s.pool.QueryRow(ctx,
		`SELECT host_id::text FROM webinars WHERE slug = $1`, slug).Scan(&hostID)
	if noRows(err) {
		return types.CRMContact{}, ErrNotFound
	}
	if err != nil {
		return types.CRMContact{}, err
	}

	name := strings.TrimSpace(strings.TrimSpace(reg.FirstName) + " " + strings.TrimSpace(reg.LastName))
	return s.UpsertContact(ctx, hostID, ContactInput{
		Phone:          reg.Phone,
		Email:          reg.Email,
		Name:           name,
		Company:        reg.Company,
		Source:         "registration",
		RegistrationID: reg.ID,
		// Opt-in needs a number to apply to. Ticking the box on a form with no phone
		// field filled in is consent to nothing.
		WhatsAppOptIn: optIn && strings.TrimSpace(reg.Phone) != "",
	})
}
