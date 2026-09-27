package main

import (
	"encoding/json"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// followUpAt is when the coach sent her post-webinar messages: the morning after the
// first webinar ended.
func (s *seeder) followUpAt() time.Time { return s.webinars[0].endsAt.Add(14 * time.Hour) }

// seedFollowUps sends the two messages from the first webinar's Messages tab: a thank
// you to everyone who stayed 30+ minutes, and a "missed you" to the no-shows.
func (s *seeder) seedFollowUps() error {
	w := s.webinars[0]
	at := s.followUpAt()
	sends := []struct {
		name, tmpl string
		seg        types.CRMSegment
		picked     func(pi int) (bool, []string)
	}{
		{
			"Thanks for staying — workbook offer", "thanks_for_attending",
			types.CRMSegment{Attendance: types.SegmentJoined, MinWatchMin: 30},
			func(pi int) (bool, []string) {
				min, ok := w.watch[pi]
				return ok && min >= 30, []string{people[pi].first, minutes(min), w.topic}
			},
		},
		{
			"Missed you — replay", "missed_you",
			types.CRMSegment{Attendance: types.SegmentNoShow},
			func(pi int) (bool, []string) {
				_, ok := w.watch[pi]
				return !ok, []string{people[pi].first, w.topic}
			},
		},
	}
	for i, b := range sends {
		params := []types.CRMParam{{Field: "first_name"}, {Field: "watched"}, {Field: "topic"}}
		if b.tmpl == "missed_you" {
			params = []types.CRMParam{{Field: "first_name"}, {Field: "topic"}}
		}
		pj, _ := json.Marshal(params)
		sj, _ := json.Marshal(b.seg)
		sentAt := at.Add(time.Duration(i) * 10 * time.Minute)
		bid, err := s.id(`
			INSERT INTO crm_broadcasts
				(host_id, name, template_name, template_language, params, audience,
				 webinar_id, scheduled_at, segment, created_at)
			VALUES ($1::uuid,$2,$3,'en',$4::jsonb,'segment',$5::uuid,$6,$7::jsonb,$6)
			RETURNING id::text`,
			s.host, b.name, b.tmpl, pj, w.id, sentAt, sj)
		if err != nil {
			return err
		}
		for _, pi := range w.registered {
			ok, vals := b.picked(pi)
			if !ok || !s.whatsappable(pi, sentAt) {
				continue
			}
			body := render(b.tmpl, vals)
			nid, err := s.id(`
				INSERT INTO notifications
					(kind, channel, contact_id, broadcast_id, email, subject, body,
					 template_name, template_language, template_params,
					 delivery, delivered_at, due_at, attempts, created_at)
				VALUES ('wa_broadcast','whatsapp',$1::uuid,$2::uuid,'',$3,$4,$3,'en',$5::jsonb,
				        'sent',$6,$6,1,$6)
				RETURNING id::text`,
				s.contact[pi], bid, b.tmpl, body, paramsJSON(vals), sentAt)
			if err != nil {
				return err
			}
			if err := s.message(pi, "out", body, b.tmpl, "read", sentAt, w.id, nid, bid, false); err != nil {
				return err
			}
		}
	}
	return nil
}

// seedThreads writes the replies (and the coach's answers) that followed.
func (s *seeder) seedThreads() error {
	w := s.webinars[0]
	base := s.followUpAt()
	for _, t := range threads {
		lastIn := false
		var last time.Time
		for _, l := range t.lines {
			at := base.Add(l.after)
			if at.After(s.now) {
				at = s.now.Add(-5 * time.Minute)
			}
			dir, status := "out", "read"
			if l.in {
				dir, status = "in", "delivered"
			}
			if err := s.message(t.who, dir, l.body, "", status, at, w.id, "", "", !l.in); err != nil {
				return err
			}
			lastIn, last = l.in, at
		}
		if t.done {
			if err := s.exec(`UPDATE crm_contacts SET inbox_done_at = $2 WHERE id = $1::uuid`,
				s.contact[t.who], last.Add(time.Minute)); err != nil {
				return err
			}
		} else if lastIn {
			s.waiting++
		}
	}

	// Kavya said STOP to the "missed you" message: recorded, and she is off the list.
	kavya := 6
	at := s.optOutAt()
	if err := s.message(kavya, "in", "STOP", "", "delivered", at, w.id, "", "", false); err != nil {
		return err
	}
	if err := s.exec(`UPDATE crm_contacts SET whatsapp_opt_out_at = $2, inbox_done_at = $2 WHERE id = $1::uuid`,
		s.contact[kavya], at); err != nil {
		return err
	}

	// One reply that arrived an hour ago, still inside the 24-hour window, so the
	// reply box is open in the demo.
	fresh := s.now.Add(-time.Hour)
	if err := s.message(9, "in", "Hi Aarti! Just registered for the budgeting one. Will the slides be shared?", "",
		"delivered", fresh, s.webinars[2].id, "", "", false); err != nil {
		return err
	}
	s.waiting++
	return nil
}

func (s *seeder) seedTagsNotes() error {
	s.tags = map[string]string{}
	for _, name := range []string{"Hot lead", "Workbook sent", "Paid program interest"} {
		id, err := s.id(`INSERT INTO crm_tags (host_id, name) VALUES ($1::uuid,$2) RETURNING id::text`, s.host, name)
		if err != nil {
			return err
		}
		s.tags[name] = id
	}
	tagged := map[int][]string{
		0: {"Workbook sent"},
		1: {"Hot lead", "Paid program interest"},
		3: {"Workbook sent"},
		9: {"Hot lead"},
	}
	for pi, names := range tagged {
		for _, n := range names {
			if err := s.exec(`INSERT INTO crm_contact_tags (contact_id, tag_id) VALUES ($1::uuid,$2::uuid)`,
				s.contact[pi], s.tags[n]); err != nil {
				return err
			}
		}
	}
	return s.exec(`
		INSERT INTO crm_notes (host_id, contact_id, body, author_id, created_at)
		VALUES ($1::uuid,$2::uuid,$3,$1::uuid,$4)`,
		s.host, s.contact[1],
		"Works at Infosys, wants 1:1 accountability. Send the paid program details after the budgeting webinar.",
		s.followUpAt().Add(time.Hour))
}

func minutes(n int) string {
	if n == 1 {
		return "1 minute"
	}
	return itoa(n) + " minutes"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
