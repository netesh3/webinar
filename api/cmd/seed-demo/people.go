package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

var ist = func() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+1800)
}()

// seedPeople registers everyone, records who watched for how long, and makes one CRM
// contact per person across all three webinars — the way a real registration does.
func (s *seeder) seedPeople() error {
	s.contact = map[int]string{}
	s.regs = map[[2]int]string{}
	s.regAt = map[[2]int]time.Time{}
	for wi, w := range s.webinars {
		for n, pi := range w.registered {
			p := people[pi]
			key := joinKey()
			// Registered over the fortnight before, in order.
			at := w.startsAt.Add(-time.Duration(14*24-n*20) * time.Hour)
			if at.After(s.now) {
				at = s.now.Add(-time.Duration(len(w.registered)-n) * time.Hour)
			}
			rid, err := s.id(`
				INSERT INTO registrations
					(webinar_id, email, first_name, last_name, company, country, phone, state, join_key, created_at)
				VALUES ($1::uuid,$2,$3,$4,$5,'IN',$6,'approved',$7,$8)
				RETURNING id::text`,
				w.id, emailFor(p), p.first, p.last, p.company, p.phone, key, at)
			if err != nil {
				return err
			}
			s.regs[[2]int{wi, pi}] = rid
			s.regAt[[2]int{wi, pi}] = at

			if _, ok := s.contact[pi]; !ok {
				if err := s.newContact(pi, rid, at); err != nil {
					return err
				}
			}

			if min, ok := w.watch[pi]; ok && w.past {
				if err := s.attend(w, rid, key, p, min); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (s *seeder) newContact(pi int, rid string, at time.Time) error {
	p := people[pi]
	var optIn *time.Time
	if p.optIn && p.phone != "" {
		optIn = &at
	}
	id, err := s.id(`
		INSERT INTO crm_contacts
			(host_id, phone, email, name, company, source, registration_id,
			 whatsapp_opt_in_at, last_seen_at, created_at)
		VALUES ($1::uuid,$2,$3,$4,$5,'registration',$6::uuid,$7,$8,$8)
		RETURNING id::text`,
		s.host, p.phone, emailFor(p), p.first+" "+p.last, p.company, rid, optIn, at)
	if err != nil {
		return err
	}
	s.contact[pi] = id
	s.contacts++
	return nil
}

// attend writes the attendance row and one visit: joined late enough to have watched
// exactly `min` minutes, left at the end.
func (s *seeder) attend(w seededWebinar, rid, key string, p person, min int) error {
	identity := "att_" + key
	joined := w.endsAt.Add(-time.Duration(min) * time.Minute)
	if err := s.exec(`
		INSERT INTO attendance (webinar_id, identity, registration_id, first_joined_at, last_seen_at, name)
		VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6)`,
		w.id, identity, rid, joined, w.endsAt, p.first+" "+p.last); err != nil {
		return err
	}
	return s.exec(`
		INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at)
		VALUES ($1::uuid,$2,$3,$4)`, w.id, identity, joined, w.endsAt)
}

// whatsappable: has a number and had opted in (and not out) at the given moment.
func (s *seeder) whatsappable(pi int, at time.Time) bool {
	p := people[pi]
	if !p.optIn || p.phone == "" {
		return false
	}
	return !(p.optedOut && at.After(s.optOutAt()))
}

// optOutAt is when Kavya replied STOP to the "missed you" follow-up.
func (s *seeder) optOutAt() time.Time { return s.followUpAt().Add(2 * time.Hour) }

// seedAutomatic writes the confirmation and every reminder each opted-in registrant
// got: sent and mostly read for the past webinars; for the upcoming one the
// confirmation is out and the reminders are queued for their times.
func (s *seeder) seedAutomatic() error {
	for wi, w := range s.webinars {
		for _, pi := range w.registered {
			rid := s.regs[[2]int{wi, pi}]
			// Sent the moment they registered, as the real one is.
			confirmAt := s.regAt[[2]int{wi, pi}].Add(time.Minute)
			if people[pi].optIn && people[pi].phone != "" && !s.whatsappable(pi, confirmAt) {
				// Opted out since: the send path would skip it, and says so.
				if err := s.automatic(w, pi, rid, types.NotifyWhatsAppConfirmed, nil, confirmAt, "skipped"); err != nil {
					return err
				}
				continue
			}
			if !s.whatsappable(pi, confirmAt) {
				continue
			}
			if err := s.automatic(w, pi, rid, types.NotifyWhatsAppConfirmed, nil, confirmAt, "sent"); err != nil {
				return err
			}
			for _, off := range w.reminders {
				off := off
				due := w.startsAt.Add(-time.Duration(off) * time.Minute)
				delivery := "sent"
				if due.After(s.now) {
					delivery = "pending"
				}
				if err := s.automatic(w, pi, rid, types.NotifyWhatsAppReminder, &off, due, delivery); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (s *seeder) automatic(w seededWebinar, pi int, rid string, kind types.NotificationKind, offset *int, at time.Time, delivery string) error {
	p := people[pi]
	tmplName, vals := "webinar_confirmation", []string{p.first, w.topic, whenText(w.startsAt)}
	if kind == types.NotifyWhatsAppReminder {
		tmplName, vals = "webinar_reminder", []string{p.first, w.topic, startsIn(*offset)}
	}
	body := render(tmplName, vals)
	var deliveredAt *time.Time
	if delivery == "sent" {
		deliveredAt = &at
	}
	params := paramsJSON(vals)
	nid, err := s.id(`
		INSERT INTO notifications
			(kind, channel, webinar_id, registration_id, contact_id, email, subject, body,
			 template_name, template_language, template_params, offset_min,
			 delivery, delivered_at, due_at, attempts, created_at)
		VALUES ($1,'whatsapp',$2::uuid,$3::uuid,$4::uuid,'',$5,$6,$7,'en',$8::jsonb,$9,
		        $10,$11,$12,$13,$14)
		RETURNING id::text`,
		string(kind), w.id, rid, s.contact[pi], tmplName, body, tmplName, params, offset,
		delivery, deliveredAt, at, map[bool]int{true: 1, false: 0}[delivery == "sent"],
		at.Add(-time.Minute))
	if err != nil || delivery != "sent" {
		return err
	}
	// Most people read their reminders; every fifth one only reached the phone.
	status := "read"
	if (pi+len(body))%5 == 0 {
		status = "delivered"
	}
	return s.message(pi, "out", body, tmplName, status, at, w.id, nid, "", false)
}

// message appends one line to a contact's thread and keeps last_seen_at current.
func (s *seeder) message(pi int, dir, body, tmpl, status string, at time.Time, webinarID, notificationID, broadcastID string, manual bool) error {
	if err := s.exec(`
		INSERT INTO crm_messages
			(host_id, contact_id, direction, body, template_name, wamid, status,
			 created_at, updated_at, webinar_id, notification_id, broadcast_id, manual)
		VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$8,NULLIF($9,'')::uuid,
		        NULLIF($10,'')::uuid,NULLIF($11,'')::uuid,$12)`,
		s.host, s.contact[pi], dir, body, tmpl, "wamid.demo."+randomHex(10), status, at,
		webinarID, notificationID, broadcastID, manual); err != nil {
		return err
	}
	s.messages++
	return s.exec(`
		UPDATE crm_contacts SET last_seen_at = GREATEST(last_seen_at, $2)
		 WHERE id = $1::uuid`, s.contact[pi], at)
}

func render(name string, vals []string) string {
	for _, t := range templates {
		if t.name == name {
			out := t.body
			for i, v := range vals {
				out = strings.ReplaceAll(out, fmt.Sprintf("{{%d}}", i+1), v)
			}
			return out
		}
	}
	return ""
}

func paramsJSON(vals []string) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = fmt.Sprintf("%q", v)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func whenText(t time.Time) string { return t.In(ist).Format("Mon 2 Jan, 3:04 PM") + " IST" }

func startsIn(min int) string {
	switch {
	case min%1440 == 0:
		if min == 1440 {
			return "in 24 hours"
		}
		return fmt.Sprintf("in %d days", min/1440)
	case min%60 == 0:
		if min == 60 {
			return "in 1 hour"
		}
		return fmt.Sprintf("in %d hours", min/60)
	default:
		return fmt.Sprintf("in %d minutes", min)
	}
}
