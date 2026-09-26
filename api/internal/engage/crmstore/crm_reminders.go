package crmstore

import (
	"context"
	"strings"

	"github.com/netkumar/webcast/api/types"
)

/* The automatic WhatsApp messages: which template each one uses, and which of them
 * are owed right now.
 *
 * Two halves of one feature. The settings are a host's choice of an approved
 * template per kind — there is no default, because Meta only delivers templates it
 * has approved and inventing a name would produce a rejection instead of a
 * message. The sweep is the outbox query, and nearly all of it is the conditions
 * under which a queued message must NOT be sent.
 */

// ReminderInput is one kind's chosen template, as the settings endpoint supplies it.
type ReminderInput struct {
	Kind     string
	Name     string
	Language string
	// Params are merge-field tokens, one per {{n}}, in order — resolved per
	// recipient when a message is queued, not here.
	Params []string
}

/* ReminderTemplates returns every kind, configured or not.
 *
 * All of them, always, with an empty Name for the ones that are off: the caller is
 * rendering a settings screen or deciding whether to queue a message, and both
 * want "this kind is not set up" as an answer rather than an absence to interpret.
 */
func (s *Store) ReminderTemplates(ctx context.Context, hostID string) ([]types.CRMReminder, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kind, name, language, params
		  FROM crm_reminder_templates
		 WHERE host_id = $1`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	found := map[types.NotificationKind]types.CRMReminder{}
	for rows.Next() {
		var r types.CRMReminder
		if err := rows.Scan(&r.Kind, &r.Template, &r.Language, &r.Params); err != nil {
			return nil, err
		}
		if r.Params == nil {
			r.Params = []string{}
		}
		found[r.Kind] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// In the order the messages reach somebody, which is the order the settings
	// screen reads in — not the order Postgres happened to return.
	out := make([]types.CRMReminder, 0, len(types.WhatsAppReminderKinds))
	for _, kind := range types.WhatsAppReminderKinds {
		if r, ok := found[kind]; ok {
			out = append(out, r)
			continue
		}
		out = append(out, types.CRMReminder{Kind: kind, Params: []string{}})
	}
	return out, nil
}

/* ReminderTemplate returns one kind's template, or false when it is not set up.
 *
 * Used by the enqueue path, which has to know whether there is anything to queue
 * before it queues it: a row naming no template would sit in the outbox for ever.
 */
func (s *Store) ReminderTemplate(ctx context.Context, hostID string, kind types.NotificationKind) (types.CRMReminder, bool, error) {
	var r types.CRMReminder
	err := s.pool.QueryRow(ctx, `
		SELECT kind, name, language, params
		  FROM crm_reminder_templates
		 WHERE host_id = $1 AND kind = $2`, hostID, string(kind)).Scan(
		&r.Kind, &r.Template, &r.Language, &r.Params)
	if noRows(err) {
		return types.CRMReminder{}, false, nil
	}
	if err != nil {
		return types.CRMReminder{}, false, err
	}
	if r.Params == nil {
		r.Params = []string{}
	}
	return r, r.Template != "", nil
}

/* SetReminderTemplates replaces the host's whole set.
 *
 * A replace rather than a patch because the settings screen edits them together,
 * and because "off" has to be expressible: a kind the caller omits, or names with
 * an empty template, is a kind that stops being sent. Deleting the row rather than
 * storing a blank keeps "not configured" as one state instead of two.
 */
func (s *Store) SetReminderTemplates(ctx context.Context, hostID string, in []ReminderInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`DELETE FROM crm_reminder_templates WHERE host_id = $1`, hostID); err != nil {
		return err
	}
	for _, r := range in {
		name := strings.TrimSpace(r.Name)
		if name == "" {
			continue // off
		}
		params := r.Params
		if params == nil {
			params = []string{}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm_reminder_templates (host_id, kind, name, language, params, updated_at)
			VALUES ($1, $2, $3, $4, $5, now())`,
			hostID, r.Kind, name, strings.TrimSpace(r.Language), params); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// WhatsAppOutbound is one queued WhatsApp message that may be sent right now,
// with the host's own credentials to send it under.
type WhatsAppOutbound struct {
	ID     string
	Kind   string
	HostID string
	// Token and PhoneNumberID are the HOST's, which is the whole commercial point:
	// the message is billed to their WhatsApp Business account, not ours.
	Token         string
	PhoneNumberID string

	ContactID string
	Phone     string

	TemplateName     string
	TemplateLanguage string
	Params           []string

	// BroadcastID is set only on a broadcast's rows, and is carried through to the
	// conversation row so delivered and read — which arrive by webhook, hours later —
	// can be counted against the broadcast that caused them.
	BroadcastID string

	Attempts int
}

/* PendingWhatsApp returns the WhatsApp messages that are due and still allowed.
 *
 * Almost all of this query is the second half of that sentence, and every clause is
 * a different way a queued message can become one that must not be sent between
 * being written and being due — which for a 24-hour reminder is a whole day:
 *
 *   - the contact opted out, or never opted in. Required here even for templates
 *     Meta considers transactional: this message is sent automatically, to somebody
 *     who gave a phone number on a registration form, and the tick box next to it
 *     is the only thing that makes that a conversation they agreed to.
 *   - the host disconnected WhatsApp, so there is no token to bill and no number to
 *     send from.
 *   - the host turned WhatsApp reminders off for this webinar, or it never happened.
 *   - the registration was declined after the message was queued.
 *   - the broadcast it belongs to was cancelled. Cancelling already marks the rows
 *     skipped, so this clause only catches the one in flight at that moment — which
 *     is the only row a cancel can lose, and the reason it is worth a clause.
 *   - the drip it is a step of was paused, or the person was taken off it. A paused
 *     sequence holds its queued step rather than losing it, which is what makes
 *     pausing reversible.
 *
 * Rows that fail these are left pending rather than marked, exactly as the email
 * sweep leaves them: the conditions can come back — a host reconnects, a contact
 * opts in again — and a row marked 'skipped' on a Tuesday cannot.
 */
func (s *Store) PendingWhatsApp(ctx context.Context, limit int) ([]WhatsAppOutbound, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT n.id::text, n.kind, c.host_id::text,
		       u.whatsapp_access_token, u.whatsapp_phone_number_id,
		       c.id::text, c.phone,
		       n.template_name, n.template_language, n.template_params,
		       COALESCE(n.broadcast_id::text,''), n.attempts
		  FROM notifications n
		  JOIN crm_contacts c ON c.id = n.contact_id
		  JOIN users u        ON u.id = c.host_id
		 WHERE n.delivery = 'pending' AND n.channel = 'whatsapp' AND n.due_at <= now()
		   AND c.phone <> ''
		   AND c.whatsapp_opt_in_at IS NOT NULL
		   AND (c.whatsapp_opt_out_at IS NULL OR c.whatsapp_opt_in_at > c.whatsapp_opt_out_at)
		   AND u.whatsapp_access_token <> '' AND u.whatsapp_phone_number_id <> ''
		   AND (n.webinar_id IS NULL OR EXISTS (
		         SELECT 1 FROM webinars w
		          WHERE w.id = n.webinar_id
		            /* The replay message is exempt from both, and deliberately so: it is
		             * about a session that has ended, and it is not a reminder — the host
		             * asked for it by publishing the recording, one press at a time, long
		             * after the webinar's own reminder toggle stopped meaning anything. */
		            AND (n.kind = 'wa_replay' OR (
		              w.status NOT IN ('ended','draft')
		              AND COALESCE((w.options->>'whatsappReminders')::boolean, false)
		            ))
		       ))
		   AND (n.registration_id IS NULL OR EXISTS (
		         SELECT 1 FROM registrations r
		          WHERE r.id = n.registration_id AND r.state = 'approved'
		       ))
		   AND (n.broadcast_id IS NULL OR EXISTS (
		         SELECT 1 FROM crm_broadcasts b
		          WHERE b.id = n.broadcast_id AND b.canceled_at IS NULL
		       ))
		   AND (n.drip_enrollment_id IS NULL OR EXISTS (
		         SELECT 1 FROM crm_drip_enrollments e
		           JOIN crm_drips d ON d.id = e.drip_id
		          WHERE e.id = n.drip_enrollment_id AND d.active AND e.state <> 'exited'
		       ))
		 ORDER BY n.due_at, n.created_at
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []WhatsAppOutbound{}
	for rows.Next() {
		var m WhatsAppOutbound
		if err := rows.Scan(&m.ID, &m.Kind, &m.HostID, &m.Token, &m.PhoneNumberID,
			&m.ContactID, &m.Phone, &m.TemplateName, &m.TemplateLanguage,
			&m.Params, &m.BroadcastID, &m.Attempts); err != nil {
			return nil, err
		}
		if m.Params == nil {
			m.Params = []string{}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
