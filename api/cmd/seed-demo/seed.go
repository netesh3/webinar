package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

type seeder struct {
	ctx context.Context
	tx  pgx.Tx
	now time.Time

	host     string
	webinars []seededWebinar
	contact  map[int]string // person index → crm_contacts.id
	regs     map[[2]int]string
	regAt    map[[2]int]time.Time
	tags     map[string]string

	contacts, messages, waiting int
}

type seededWebinar struct {
	webinar
	id       string
	startsAt time.Time
	endsAt   time.Time
	past     bool
}

func (s *seeder) exec(sql string, args ...any) error {
	_, err := s.tx.Exec(s.ctx, sql, args...)
	return err
}

func (s *seeder) id(sql string, args ...any) (string, error) {
	var id string
	err := s.tx.QueryRow(s.ctx, sql, args...).Scan(&id)
	return id, err
}

func (s *seeder) seed(passwordHash string) error {
	steps := []struct {
		name string
		fn   func() error
	}{
		{"coach", func() error { return s.seedCoach(passwordHash) }},
		{"templates", s.seedTemplates},
		{"webinars", s.seedWebinars},
		{"people", s.seedPeople},
		{"automatic messages", s.seedAutomatic},
		{"follow-ups", s.seedFollowUps},
		{"conversations", s.seedThreads},
		{"tags and notes", s.seedTagsNotes},
	}
	for _, st := range steps {
		if err := st.fn(); err != nil {
			return fmt.Errorf("%s: %w", st.name, err)
		}
	}
	return nil
}

// seedCoach creates the account with a pretend, healthy, never-expiring WhatsApp
// connection on the Business app (coexistence), so replies from her phone would show.
func (s *seeder) seedCoach(passwordHash string) error {
	var err error
	s.host, err = s.id(`
		INSERT INTO users
			(email, password_hash, name, title, org, initials, hue, can_host, phone, features,
			 whatsapp_access_token, whatsapp_waba_id, whatsapp_phone_number_id,
			 whatsapp_display_phone, whatsapp_verified_name, whatsapp_connected_at,
			 whatsapp_registered_at, whatsapp_coexistence, whatsapp_token_checked_at,
			 whatsapp_reply_digest_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,'demo-waba','demo-phone-number',
		        $11,$12,$13,$13,true,$14,$14)
		RETURNING id::text`,
		demoEmail, passwordHash, coach.name, coach.title, coach.org, coach.initials, coach.hue,
		coach.phone, []string{types.FeatureCRMTags, types.FeatureCRMNotes, types.FeatureReplayLinks},
		wa.DemoTokenPrefix+randomHex(16), coach.waDisplay, coach.waName,
		s.now.Add(-30*24*time.Hour), s.now)
	return err
}

func (s *seeder) seedTemplates() error {
	for _, t := range templates {
		if err := s.exec(`
			INSERT INTO crm_templates (host_id, name, language, status, category, body, variables, synced_at)
			VALUES ($1::uuid,$2,'en','APPROVED',$3,$4,$5,$6)`,
			s.host, t.name, t.category, t.body, t.vars, s.now); err != nil {
			return err
		}
	}
	for _, r := range reminderTemplates {
		if err := s.exec(`
			INSERT INTO crm_reminder_templates (host_id, kind, name, language, params)
			VALUES ($1::uuid,$2,$3,'en',$4::jsonb)`, s.host, r.kind, r.name, r.params); err != nil {
			return err
		}
	}
	return nil
}

func (s *seeder) seedWebinars() error {
	for i, w := range webinars {
		sw := seededWebinar{webinar: w, past: w.ago > 0}
		if sw.past {
			sw.endsAt = s.now.Add(-w.ago).Truncate(time.Minute)
			sw.startsAt = sw.endsAt.Add(-time.Duration(w.duration) * time.Minute)
		} else {
			sw.startsAt = s.now.Add(-w.ago).Truncate(time.Hour)
		}
		opts, _ := json.Marshal(map[string]any{
			"reminders": w.reminders, "emailReminders": true, "whatsappReminders": true, "autoRecord": true,
		})
		status := "scheduled"
		var started, ended *time.Time
		if sw.past {
			status, started, ended = "ended", &sw.startsAt, &sw.endsAt
		}
		id, err := s.id(`
			INSERT INTO webinars
				(slug, webinar_id, topic, summary, description, track, starts_at, duration_min,
				 time_zone, kind, status, host_id, approval, attendee_limit, options,
				 started_at, ended_at)
			VALUES ($1,$2,$3,$4,$4,'Coaching',$5,$6,'Asia/Kolkata','live',$7,$8::uuid,
			        'automatic',500,$9::jsonb,$10,$11)
			RETURNING id::text`,
			w.slug, fmt.Sprintf("900 %03d %04d", 100+i, 4400+i*37), w.topic, w.summary,
			sw.startsAt, w.duration, status, s.host, opts, started, ended)
		if err != nil {
			return err
		}
		sw.id = id
		s.webinars = append(s.webinars, sw)
	}
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// joinKey matches the store's alphabet (no I, O, 0, 1).
func joinKey() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	for i, v := range b {
		b[i] = alphabet[int(v)%len(alphabet)]
	}
	return string(b)
}

func emailFor(p person) string {
	return strings.ToLower(p.first+"."+p.last) + "@example.com"
}
