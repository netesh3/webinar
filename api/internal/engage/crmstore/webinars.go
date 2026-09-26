package crmstore

/* The CRM's side of webinar events: the WhatsApp rows in the shared outbox that a webinar
 * decision affects, and the per-webinar reminder switch it reports on.
 *
 * The email rows for the same events are the webinar store's, in store/notifications.go.
 * The two halves are split by kind: 'reminder' and 'registration_*' are email and
 * webinar-owned; every 'wa_*' kind is the CRM's. A new kind goes on one side only.
 */

import (
	"context"
	"time"
)

// waReminderKinds are the WhatsApp kinds that promise something about a future session.
const waReminderKinds = `'wa_reminder','wa_registration_confirmed'`

/* SkipWhatsAppForRegistrations drops unsent WhatsApp reminders when seats are declined.
 *
 * The WhatsApp confirmation is in the list, unlike its email twin, because it is queued at
 * registration and held by the sweep until the host decides. A decline is that decision,
 * and the row would otherwise wait for an approval that is never coming. */
func (s *Store) SkipWhatsAppForRegistrations(ctx context.Context, registrationIDs []string) error {
	if len(registrationIDs) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications
		   SET delivery = 'skipped', delivery_error = 'registration declined', delivered_at = now()
		 WHERE registration_id = ANY($1::uuid[])
		   AND delivery = 'pending'
		   AND kind IN (`+waReminderKinds+`)`, registrationIDs)
	return err
}

/* ReplanWhatsAppReminders is ReplanReminders (store/notifications.go) for the WhatsApp
 * reminders: times no longer on the list, or that moving put in the past, are deleted
 * unsent; the rest move with the start. Rows already due are left to the outbox. */
func (s *Store) ReplanWhatsAppReminders(ctx context.Context, slug string, startsAt time.Time, offsets []int) error {
	if offsets == nil {
		offsets = []int{}
	}
	_, err := s.pool.Exec(ctx, `
		WITH w AS (SELECT id FROM webinars WHERE slug = $1)
		DELETE FROM notifications n
		 USING w
		 WHERE n.webinar_id = w.id AND n.kind = 'wa_reminder' AND n.delivery = 'pending'
		   AND n.due_at > now()
		   AND (n.offset_min <> ALL($3::int[])
		        OR $2::timestamptz - make_interval(mins => n.offset_min) <= now())`,
		slug, startsAt, offsets)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE notifications n
		   SET due_at = $2::timestamptz - make_interval(mins => n.offset_min)
		  FROM webinars w
		 WHERE n.webinar_id = w.id AND w.slug = $1
		   AND n.kind = 'wa_reminder' AND n.delivery = 'pending' AND n.due_at > now()`,
		slug, startsAt)
	return err
}

// WhatsAppReminderGap is one opted-in contact on an approved registration with no WhatsApp
// reminder row for one time.
type WhatsAppReminderGap struct {
	RegistrationID string
	ContactID      string
	OffsetMin      int
}

/* WhatsAppReminderGaps is the WhatsApp half of store.ReminderGaps: for each time on the
 * list, the approved registrants whose contact has a phone and is opted in, and who have
 * no wa_reminder row for it. The contact is matched as WhatsAppReplayRecipients matches
 * it: the registration it came from, else the address. */
func (s *Store) WhatsAppReminderGaps(ctx context.Context, slug string, offsets []int) ([]WhatsAppReminderGap, error) {
	if len(offsets) == 0 {
		return []WhatsAppReminderGap{}, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (r.id, o.offset_min) r.id::text, c.id::text, o.offset_min
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		  JOIN crm_contacts c
		    ON c.host_id = w.host_id
		   AND (c.registration_id = r.id OR (r.email <> '' AND lower(c.email) = lower(r.email)))
		  CROSS JOIN unnest($2::int[]) AS o(offset_min)
		 WHERE w.slug = $1 AND r.state = 'approved'
		   AND c.phone <> '' AND c.whatsapp_opt_in_at IS NOT NULL
		   AND (c.whatsapp_opt_out_at IS NULL OR c.whatsapp_opt_in_at > c.whatsapp_opt_out_at)
		   AND NOT EXISTS (
		         SELECT 1 FROM notifications n
		          WHERE n.registration_id = r.id AND n.kind = 'wa_reminder'
		            AND n.offset_min = o.offset_min)
		 ORDER BY r.id, o.offset_min, (c.registration_id = r.id) DESC NULLS LAST, c.created_at`,
		slug, offsets)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WhatsAppReminderGap{}
	for rows.Next() {
		var g WhatsAppReminderGap
		if err := rows.Scan(&g.RegistrationID, &g.ContactID, &g.OffsetMin); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// SkipWhatsAppForEndedWebinar stops WhatsApp reminders about a session that will not happen.
func (s *Store) SkipWhatsAppForEndedWebinar(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications n
		   SET delivery = 'skipped', delivery_error = 'webinar ended', delivered_at = now()
		  FROM webinars w
		 WHERE n.webinar_id = w.id AND w.slug = $1
		   AND n.delivery = 'pending'
		   AND n.kind IN (`+waReminderKinds+`)
		   AND n.due_at > now()`, slug)
	return err
}

/* WebinarReminderCounts is how many of a host's live webinars have WhatsApp reminders
 * turned on, out of how many there are.
 *
 * The one setup step nothing else in the product surfaces. Every other part of the
 * WhatsApp setup is host-level and visible on one screen; this switch is per webinar and
 * defaults to off, deliberately — every message is charged to the host's own Meta
 * account, so spending their money has to be something they asked for (see
 * types.WebinarOptions.WhatsAppReminders). The consequence is a host who configures
 * everything correctly and watches nothing send. Reported so a checklist can say so.
 *
 * Drafts and ended webinars are left out. On an ended one the switch no longer means
 * anything, and a draft has nobody registered to message — counting either would make
 * the ratio read worse than the host's actual position. This is the same set the send
 * sweep itself honours: see PendingWhatsApp, which skips `ended` and `draft`.
 */
func (s *Store) WebinarReminderCounts(ctx context.Context, hostID string) (withReminders, total int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (
		         WHERE COALESCE((w.options->>'whatsappReminders')::boolean, false)),
		       count(*)
		  FROM webinars w
		 WHERE w.host_id = $1 AND w.status NOT IN ('ended','draft')`,
		hostID).Scan(&withReminders, &total)
	return withReminders, total, err
}
