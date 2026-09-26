package crmstore

/* The CRM's side of webinar events: the WhatsApp rows in the shared outbox that a webinar
 * decision affects, and the per-webinar reminder switch it reports on.
 *
 * The email rows for the same events are the webinar store's, in store/notifications.go.
 * The two halves are split by kind: 'reminder_*' and 'registration_*' are email and
 * webinar-owned; every 'wa_*' kind is the CRM's. A new kind goes on one side only.
 */

import (
	"context"
	"time"
)

// waReminderKinds are the WhatsApp kinds that promise something about a future session.
const waReminderKinds = `'wa_reminder_24h','wa_reminder_1h','wa_registration_confirmed'`

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

/* RescheduleWhatsAppReminders moves unsent WhatsApp 24h/1h due times with the webinar.
 * $2 is cast explicitly: without it Postgres types the parameter from `$2 - interval`,
 * decides it is an interval, and rejects the statement. */
func (s *Store) RescheduleWhatsAppReminders(ctx context.Context, slug string, startsAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications n
		   SET due_at = CASE n.kind
		                  WHEN 'wa_reminder_24h' THEN $2::timestamptz - interval '24 hours'
		                  WHEN 'wa_reminder_1h'  THEN $2::timestamptz - interval '1 hour'
		                END
		  FROM webinars w
		 WHERE n.webinar_id = w.id AND w.slug = $1
		   AND n.delivery = 'pending'
		   AND n.kind IN ('wa_reminder_24h','wa_reminder_1h')`, slug, startsAt)
	return err
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
