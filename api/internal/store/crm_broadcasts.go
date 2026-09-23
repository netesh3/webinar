package store

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Broadcasts: the audience, the broadcast row, and how it is going.
 *
 * The recipients are not in this file's tables at all — they are notifications, one
 * per person, written here in the same transaction as the broadcast they belong to.
 * That is the point of the design: the thing that sends a broadcast is the same
 * sweep that sends a reminder, so consent, backoff and "the host disconnected
 * WhatsApp yesterday" are handled once. See migrations/0045.
 *
 * What this file does own is the audience — which is SQL rather than product logic
 * only at first glance. Every clause in it is a person who must not be messaged.
 */

// BroadcastInput is a broadcast as the host configured it.
type BroadcastInput struct {
	Name             string
	TemplateName     string
	TemplateLanguage string
	// Params are the configured entries, one per {{n}}: a literal or a merge token.
	// Stored unresolved, so the broadcast reads back as it was written.
	Params []types.CRMParam
	// Audience is types.AudienceOptedIn, types.AudienceWebinar or types.AudienceTag.
	Audience string
	// WebinarSlug is required for the webinar audience and optional otherwise, where
	// it only supplies the topic/when merge fields.
	WebinarSlug string
	// TagID is required for the tag audience and empty for the others.
	TagID       string
	ScheduledAt time.Time
}

/* BroadcastRecipient is one person's copy: their contact id and the values their
 * {{n}} are filled with.
 *
 * Resolved by the caller, per contact, before anything is written — the same choice
 * the reminders made, and for the same reason: the row records what was promised to
 * this person, and a contact who changes their name next week does not retroactively
 * change a message that has already been composed.
 */
type BroadcastRecipient struct {
	ContactID string
	Params    []string
}

/* audienceFrom is the FROM and WHERE that define an audience, without the
 * reachability filters, plus the arguments it needs.
 *
 * Shared by the count and the list so the number a host is shown and the people who
 * are actually messaged cannot drift apart. The arguments come back with it rather
 * than being assembled by each caller, because a query that does not mention $2 and
 * is handed one is an error rather than a harmless extra.
 */
func audienceFrom(hostID, audience, webinarSlug, tagID string) (string, []any) {
	base := `FROM crm_contacts c WHERE c.host_id = $1::uuid`
	switch audience {
	case types.AudienceWebinar, types.AudienceTag:
	default:
		return base, []any{hostID}
	}
	if audience == types.AudienceTag {
		/* The tag is joined through crm_contact_tags rather than compared as a name,
		 * and the tag's own host is checked as well as the contact's: the two ids
		 * arrive from the same request, and a tag from another account matching
		 * nothing is a safer failure than one matching somebody. */
		return base + ` AND EXISTS (
			SELECT 1 FROM crm_contact_tags ct
			  JOIN crm_tags t ON t.id = ct.tag_id
			 WHERE ct.contact_id = c.id AND t.id = $2::uuid AND t.host_id = c.host_id
		)`, []any{hostID, tagID}
	}
	return base + ` AND ` + contactRegisteredFor(`$2`), []any{hostID, webinarSlug}
}

/* contactRegisteredFor is "this contact `c` registered for the webinar named by that
 * placeholder", for a caller that has a contacts query and a slug to bind.
 *
 * Takes the placeholder rather than assuming $2, because the two callers number their
 * arguments differently and a predicate that silently reads the wrong one would filter
 * a contacts list by a search term.
 *
 * Shared so that "this webinar's contacts" is ONE set of people. The CRM list scoped to
 * a webinar and the broadcast audience for the same webinar are the same question asked
 * on two screens, and a host who reads 12 on one and 14 on the other has no reason to
 * trust either number. Two copies of this would drift the first time one was fixed.
 *
 * Registrants are matched three ways, because there is no single key. registration_id is
 * only set from the FIRST registration that created the contact, so it answers for one
 * webinar and not for the others. Email is the reliable one but a registrant may have
 * given a different address than the contact has. Phone needs the digits compared rather
 * than the strings: a registration keeps what was typed ("+27 84 555 6666") and a contact
 * is normalised, and matching them literally would quietly message nobody.
 *
 * Declined seats are excluded. Pending ones are not: the host decides whether to approve,
 * and somebody waiting for that decision still asked to hear about it.
 *
 * The webinar's host must be the contact's, which is what stops a slug from another
 * account selecting anybody. It is not the whole of the authorization — a handler still
 * owes the host the difference between "not yours" and "nobody came" — but it means the
 * worst case of a missing check is an empty list rather than a leak.
 *
 * ── Why this is three EXISTS and not one ──────────────────────────────────────────
 *
 * The obvious spelling is a single EXISTS with contactMatchesRegistration inside it.
 * That is what this was, and on a host with 20,000 contacts and a webinar with 500
 * registrants it took 7.7 seconds — measured, not guessed. Postgres cannot correlate an
 * OR of three arms per contact, so it gave up and built a nested loop over the whole
 * cross product instead: 9.9 million evaluations of the join filter, two regexes in
 * each. Adding indexes did not help, because the plan never probed anything.
 *
 * Split into three single-arm subqueries, each one becomes a hashed subplan Postgres can
 * evaluate per contact. The same measurement: 11ms at 500 registrants, 14ms at 5,000.
 * Identical results — an OR of the same three conditions about the same contact — and
 * no new index was needed for it.
 *
 * The `c.email <> ''` / `c.phone <> ''` guards are hoisted OUTSIDE their subqueries
 * rather than left in with the comparison. That is where they belong anyway (they are
 * facts about the contact, not about any registration) and it means a contact with no
 * phone costs nothing to rule out of the phone arm.
 *
 * Note that AttachRegistrantWhatsApp reassembles the same arms the OTHER way, as one OR
 * inside a lateral driven from registrations, and that shape IS fast — 3.5ms, using the
 * BitmapOr over the three indexes migration 0050 adds. Two directions, two spellings,
 * one set of arms. That is the reason they are named consts.
 */
func contactRegisteredFor(slugParam string) string {
	// registeredWhere is "this webinar has a registration matching <arm>".
	registeredWhere := func(arm string) string {
		return `EXISTS (
			SELECT 1 FROM registrations r
			  JOIN webinars w ON w.id = r.webinar_id
			 WHERE w.slug = ` + slugParam + ` AND w.host_id = c.host_id AND r.state <> 'declined'
			   AND ` + arm + `
		)`
	}
	return `(` + registeredWhere(matchByRegistrationID) + `
		OR (c.email <> '' AND ` + registeredWhere(matchEmails) + `)
		OR (c.phone <> '' AND ` + registeredWhere(matchPhoneDigits) + `))`
}

/* contactMatchesRegistration matches a contact `c` to a registration `r`, for callers
 * that have both in scope.
 *
 * Shared rather than repeated because it is the one piece of this file that is easy to
 * get subtly wrong — see the paragraph above — and the drip triggers ask the same
 * question about the same two tables.
 */
/* Written as three named arms and reassembled, rather than as one string, for two
 * reasons that both came out of making it fast. The index each arm needs is only
 * legible when the arm has a name (see migrations/0050), and if the planner ever
 * refuses to build a BitmapOr across them inside a nested loop, the escape hatch is a
 * UNION ALL of the three — which must be derived from these same parts and not from a
 * second copy that can drift.
 *
 * The email arm lowers BOTH sides. UpsertContact stores emails lowercased, so comparing
 * the bare column was correct — but it made crm_contacts_host_email_key, which is built
 * on lower(email), unusable, and it meant any future import that skipped the
 * normalisation would produce a contact matching nobody with no error anywhere.
 */
const (
	matchByRegistrationID = `c.registration_id = r.id`
	// The comparison alone, without the "this contact has one at all" guard. Split
	// because contactRegisteredFor hoists the guard out of a subquery and this half is
	// what goes inside — see there.
	matchEmails      = `lower(c.email) = lower(r.email)`
	matchPhoneDigits = `r.phone <> ''
		AND regexp_replace(r.phone, '[^0-9]', '', 'g')
		  = regexp_replace(c.phone, '[^0-9]', '', 'g')`

	matchByEmail = `c.email <> '' AND ` + matchEmails
	matchByPhone = `c.phone <> '' AND ` + matchPhoneDigits

	contactMatchesRegistration = `(
		(` + matchByRegistrationID + `)
		OR (` + matchByEmail + `)
		OR (` + matchByPhone + `)
	)`
)

/* Where a contact stands on WhatsApp: four predicates that partition every contact of
 * a host, whatever else is true about them.
 *
 * Named and shared because three things ask the question and must not answer it
 * differently: the send path (reachable), the audience preview a host reads before
 * spending their own money, and the filter chips over the contacts list. A host who
 * filters to "opted out" and finds fewer people than the preview said has no reason to
 * trust either screen.
 *
 * Exhaustive by construction — take the four combinations of the two timestamps:
 * neither set is neverOptedIn; opt-out only is optedOutNow; opt-in only is optedInNow;
 * both set falls to whichever is later, with a tie going to the refusal.
 */
const (
	hasNumber = `c.phone <> ''`
	noNumber  = `c.phone = ''`

	// May be sent a broadcast: asked for it, and has not since asked to stop.
	optedInNow = hasNumber + ` AND c.whatsapp_opt_in_at IS NOT NULL
		AND (c.whatsapp_opt_out_at IS NULL
		     OR c.whatsapp_opt_in_at > c.whatsapp_opt_out_at)`

	/* Asked to stop, and has not since asked to start again.
	 *
	 * Note the `opt_in IS NULL` arm. Somebody who replies STOP to a message they never
	 * opted in to has an opt-out and no opt-in, and the earlier shape of this counted
	 * them under "no opt-in" — true as far as it goes, and the wrong word for a person
	 * who explicitly refused. The totals were right either way, which is why it went
	 * unnoticed; a host filtering to "opted out" and not finding the one person who
	 * said so out loud is what makes it visible.
	 */
	optedOutNow = hasNumber + ` AND c.whatsapp_opt_out_at IS NOT NULL
		AND (c.whatsapp_opt_in_at IS NULL
		     OR c.whatsapp_opt_out_at >= c.whatsapp_opt_in_at)`

	// Never said either thing. The default for somebody who filled in a registration
	// form, and the one bucket the host can do something about — by asking.
	neverOptedIn = hasNumber + ` AND c.whatsapp_opt_in_at IS NULL
		AND c.whatsapp_opt_out_at IS NULL`
)

// reachable is the contacts of an audience who may actually be sent a broadcast.
// Marketing consent, in one place: a broadcast is the host's own message rather
// than a receipt for anything, so opt-in is required whatever Meta's category says.
const reachable = ` AND ` + optedInNow

/* contactReplied is "this person has written to the host" — the only fact in the CRM
 * the host did not put there themselves, and the one they ask about.
 *
 * Inbound only, for the same reason LastInboundAt is: a business writing to somebody
 * does not make it a conversation. EXISTS rather than a count, because the question is
 * whether there is a reply at all. Backed by crm_messages_inbound_idx.
 */
const contactReplied = `EXISTS (
	SELECT 1 FROM crm_messages inb
	 WHERE inb.contact_id = c.id AND inb.direction = 'in'
)`

/* lastInboundAt is the same question when the answer wanted is the timestamp rather
 * than whether there is one. Also for a caller holding the contact as `c`.
 *
 * The alias is `inb` rather than `m` because the contacts list already has a lateral
 * called `m` for the last message in either direction, and an inner alias that shadows
 * it would still compile while meaning something almost right.
 */
const lastInboundAt = `(SELECT max(inb.created_at) FROM crm_messages inb
	 WHERE inb.contact_id = c.id AND inb.direction = 'in')`

/* contactStatusPredicate turns one filter chip into a WHERE fragment, leading AND
 * included. The empty status is no filter at all; anything else off the list is a
 * client bug worth naming rather than a filter worth guessing at, so it is refused
 * here as well as by the handler — this is what stops a query being built from an
 * unvalidated string however it arrived.
 */
func contactStatusPredicate(status string) (string, error) {
	switch status {
	case "":
		return "", nil
	case types.CRMStatusReplied:
		return ` AND ` + contactReplied, nil
	case types.CRMStatusNoReply:
		return ` AND NOT ` + contactReplied, nil
	case types.CRMStatusOptedIn:
		return ` AND ` + optedInNow, nil
	case types.CRMStatusNoOptIn:
		return ` AND ` + neverOptedIn, nil
	case types.CRMStatusOptedOut:
		return ` AND ` + optedOutNow, nil
	case types.CRMStatusNoNumber:
		return ` AND ` + noNumber, nil
	}
	return "", ErrInvalid
}

/* AudienceCounts is how many people an audience reaches, and how many it does not.
 *
 * Four disjoint buckets rather than one number. A host about to spend their own
 * money on 900 messages and reaching 40 people is entitled to know which of the
 * three possible reasons applies to the other 860 — and "no opt-in" is the one they
 * can do something about, by asking.
 */
func (s *Store) AudienceCounts(ctx context.Context, hostID, audience, webinarSlug, tagID string) (types.CRMAudienceResponse, error) {
	from, args := audienceFrom(hostID, audience, webinarSlug, tagID)
	out := types.CRMAudienceResponse{Audience: audience}
	err := s.pool.QueryRow(ctx, `
		SELECT
		  count(*) FILTER (WHERE `+optedInNow+`),
		  count(*) FILTER (WHERE `+neverOptedIn+`),
		  count(*) FILTER (WHERE `+optedOutNow+`),
		  count(*) FILTER (WHERE `+noNumber+`)
		`+from, args...).
		Scan(&out.Recipients, &out.NoOptIn, &out.OptedOut, &out.NoNumber)
	if err != nil {
		return types.CRMAudienceResponse{}, err
	}
	return out, nil
}

/* AudienceContacts returns the people a broadcast would be sent to.
 *
 * In creation order, and capped: a host with a list of half a million has a problem
 * this application should not solve by holding all of it in memory. The caller
 * refuses to create the broadcast when the cap is hit rather than silently sending
 * to a prefix of somebody's list.
 */
func (s *Store) AudienceContacts(ctx context.Context, hostID, audience, webinarSlug, tagID string, limit int) ([]types.CRMContact, error) {
	if limit <= 0 || limit > 20000 {
		limit = 20000
	}
	from, args := audienceFrom(hostID, audience, webinarSlug, tagID)
	// One more than asked for, so the caller can tell "exactly the cap" from "more
	// than we are willing to send".
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx,
		`SELECT `+crmContactColumns+`
		`+from+reachable+`
		 ORDER BY c.created_at, c.id
		 LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMContact{}
	for rows.Next() {
		c, err := scanContact(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > limit {
		return out, ErrConflict
	}
	return out, nil
}

/* CreateBroadcast writes the broadcast and every recipient's queued message, at once.
 *
 * One transaction, and it matters more here than in most places: a broadcast row
 * with no queued messages is a thing a host believes they sent, and queued messages
 * with no broadcast row are messages nobody can cancel. Either both or neither.
 */
func (s *Store) CreateBroadcast(ctx context.Context, hostID string, in BroadcastInput, to []BroadcastRecipient) (string, error) {
	params := in.Params
	if params == nil {
		params = []types.CRMParam{}
	}
	due := in.ScheduledAt
	if due.IsZero() {
		due = time.Now()
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO crm_broadcasts
			(host_id, name, template_name, template_language, params, audience,
			 webinar_id, scheduled_at, tag_id)
		VALUES ($1::uuid, $2, $3, $4, $5, $6,
		        (SELECT id FROM webinars WHERE slug = $7 AND host_id = $1::uuid), $8,
		        (SELECT id FROM crm_tags WHERE id = NULLIF($9,'')::uuid AND host_id = $1::uuid))
		RETURNING id::text`,
		hostID, strings.TrimSpace(in.Name), in.TemplateName, in.TemplateLanguage,
		params, in.Audience, in.WebinarSlug, due, in.TagID).Scan(&id)
	if err != nil {
		return "", err
	}

	for _, rec := range to {
		if err := s.Notify(ctx, tx, Notification{
			Kind:             types.NotifyWhatsAppBroadcast,
			Channel:          "whatsapp",
			ContactID:        rec.ContactID,
			BroadcastID:      id,
			TemplateName:     in.TemplateName,
			TemplateLanguage: in.TemplateLanguage,
			TemplateParams:   rec.Params,
			DueAt:            due,
		}); err != nil {
			return "", err
		}
	}
	return id, tx.Commit(ctx)
}

/* The broadcast read, with its stats.
 *
 * Status is derived here rather than stored, so it cannot disagree with the queue it
 * describes; the counts come from the outbox and from the conversations, because
 * that is where the two halves of "what happened" live. Delivered and read only ever
 * arrive by webhook, against a message row, after the outbox has finished with it.
 */
const broadcastSelect = `
	SELECT b.id::text, b.name, b.template_name, b.template_language, b.params,
	       b.audience, COALESCE(w.slug,''), COALESCE(w.topic,''),
	       COALESCE(t.id::text,''), COALESCE(t.name,''),
	       b.scheduled_at, b.created_at, b.canceled_at,
	       (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id),
	       (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.delivery = 'pending'),
	       (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.delivery = 'sent'),
	       (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.delivery = 'failed')
	       + (SELECT count(*) FROM crm_messages m WHERE m.broadcast_id = b.id AND m.status = 'failed'),
	       (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.delivery = 'skipped'),
	       (SELECT count(*) FROM crm_messages m WHERE m.broadcast_id = b.id AND m.status IN ('delivered','read')),
	       (SELECT count(*) FROM crm_messages m WHERE m.broadcast_id = b.id AND m.status = 'read')
	  FROM crm_broadcasts b
	  LEFT JOIN webinars w ON w.id = b.webinar_id
	  LEFT JOIN crm_tags t ON t.id = b.tag_id`

func scanBroadcast(row scanner) (types.CRMBroadcast, error) {
	var (
		b           types.CRMBroadcast
		scheduledAt time.Time
		createdAt   time.Time
		canceledAt  *time.Time
		st          types.CRMBroadcastStats
	)
	if err := row.Scan(&b.ID, &b.Name, &b.Template, &b.Language, &b.Params,
		&b.Audience, &b.WebinarID, &b.WebinarTopic, &b.TagID, &b.TagName,
		&scheduledAt, &createdAt, &canceledAt,
		&st.Recipients, &st.Queued, &st.Sent, &st.Failed, &st.Skipped,
		&st.Delivered, &st.Read); err != nil {
		return types.CRMBroadcast{}, err
	}
	if b.Params == nil {
		b.Params = []types.CRMParam{}
	}
	b.ScheduledAt = scheduledAt.Format(time.RFC3339)
	b.CreatedAt = createdAt.Format(time.RFC3339)
	b.Stats = st
	switch {
	case canceledAt != nil:
		// Cancelled says what the host did, even when most of it had already gone
		// out — which is exactly the case a host needs to see rather than have
		// smoothed into "sent".
		b.Status = "cancelled"
	case st.Queued > 0 && st.Sent+st.Failed+st.Skipped == 0:
		b.Status = "scheduled"
	case st.Queued > 0:
		b.Status = "sending"
	default:
		b.Status = "sent"
	}
	return b, nil
}

// Broadcasts lists a host's broadcasts, newest first.
func (s *Store) Broadcasts(ctx context.Context, hostID string, limit int) ([]types.CRMBroadcast, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, broadcastSelect+`
		 WHERE b.host_id = $1::uuid
		 ORDER BY b.created_at DESC
		 LIMIT $2`, hostID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMBroadcast{}
	for rows.Next() {
		b, err := scanBroadcast(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Broadcast reads one. Another host's id is ErrNotFound, like every other CRM read.
func (s *Store) Broadcast(ctx context.Context, hostID, id string) (types.CRMBroadcast, error) {
	row := s.pool.QueryRow(ctx, broadcastSelect+`
		 WHERE b.host_id = $1::uuid AND b.id = $2::uuid`, hostID, id)
	b, err := scanBroadcast(row)
	if noRows(err) {
		return types.CRMBroadcast{}, ErrNotFound
	}
	if err != nil {
		return types.CRMBroadcast{}, err
	}
	return b, nil
}

/* CancelBroadcast stops the messages that have not gone out yet.
 *
 * ErrConflict when there is nothing pending, rather than a silent success: a host
 * cancelling a broadcast is trying to stop something, and "cancelled" on a
 * broadcast that had already finished would tell them they managed it.
 *
 * The already-sent ones stay sent. There is no unsend on WhatsApp, and pretending
 * otherwise in our own stats would be the one lie a host cannot check.
 */
func (s *Store) CancelBroadcast(ctx context.Context, hostID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var canceled *time.Time
	err = tx.QueryRow(ctx, `
		SELECT canceled_at FROM crm_broadcasts
		 WHERE host_id = $1::uuid AND id = $2::uuid
		 FOR UPDATE`, hostID, id).Scan(&canceled)
	if noRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if canceled != nil {
		return ErrConflict
	}

	tag, err := tx.Exec(ctx, `
		UPDATE notifications
		   SET delivery = 'skipped', delivery_error = 'broadcast cancelled', delivered_at = now()
		 WHERE broadcast_id = $1::uuid AND delivery = 'pending'`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	if _, err := tx.Exec(ctx, `
		UPDATE crm_broadcasts SET canceled_at = now(), updated_at = now()
		 WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
