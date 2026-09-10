package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// SeedDev populates a development database. Idempotent: safe to run on every
// boot, does nothing if the users table is already populated.
//
// The host password is intentionally weak and only ever created when
// APP_ENV=development, which cmd/server enforces.
func (s *Store) SeedDev(ctx context.Context, hashedPassword string) error {
	var existing int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		s.log.Info("seed skipped, database already populated")
		return nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	type person struct {
		email, name, title, org, initials, hue string
	}
	people := []person{
		{"neeraj@acme.dev", "Neeraj Kumar", "Principal Engineer", "Acme Infra", "NK", "#0b5cff"},
		{"priya@acme.dev", "Priya Sharma", "SRE Lead", "Acme Infra", "PS", "#0b8a4b"},
		{"marco@streamline.io", "Marco Rossi", "CTO", "Streamline", "MR", "#c2410c"},
		{"amara@paystack.com", "Amara Tesfaye", "Staff Engineer", "Paystack", "AT", "#7c3aed"},
		{"lucia@cabify.com", "Lucía Moreno", "Head of Platform", "Cabify", "LM", "#be185d"},
		{"dieter@siemens.com", "Dieter Kraus", "Principal Architect", "Siemens", "DK", "#0e7490"},
	}
	ids := map[string]string{}
	for _, p := range people {
		var id string
		// Everyone gets the same dev password so any of them can sign in and
		// be a panelist.
		// can_host is set here rather than left to the migration: on a fresh
		// database the migration runs before the seed, so its backfill would
		// find no rows and every seeded account would be unable to host.
		if err := tx.QueryRow(ctx, `
			INSERT INTO users (email, password_hash, name, title, org, initials, hue, can_host)
			VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id::text`,
			p.email, hashedPassword, p.name, p.title, p.org, p.initials, p.hue,
		).Scan(&id); err != nil {
			return fmt.Errorf("seed user %s: %w", p.email, err)
		}
		ids[p.email] = id
	}

	opts := func(overrides map[string]bool) []byte {
		o := map[string]bool{
			"practiceSession": true, "autoRecord": true, "qAndA": true,
			"polls": true, "attendeeChat": true, "raiseHand": true,
			"captions": false, "multistream": false, "postWebinarSurvey": true,
		}
		for k, v := range overrides {
			o[k] = v
		}
		b, _ := json.Marshal(o)
		return b
	}

	type webinar struct {
		slug, wid, topic, summary, description, track string
		startsAt                                      time.Time
		duration                                      int
		kind, status                                  string
		hostEmail                                     string
		panelists                                     []string
		approval                                      string
		limit                                         int
		priceCents                                    *int
		passcode                                      string
		agenda                                        []map[string]string
		takeaways                                     []string
		options                                       []byte
		report                                        []byte
	}

	price49 := 4900
	base := time.Date(2026, 9, 17, 9, 0, 0, 0, time.FixedZone("IST", 5*3600+1800))

	webinars := []webinar{
		{
			slug: "scaling-webrtc-10k", wid: "984 2201 0055",
			topic:   "Scaling WebRTC to 10,000 viewers without going broke",
			summary: "The two-tier architecture that took a 10,000-person session from four figures to $34.",
			description: "We rebuilt our webinar stack on LiveKit and coturn, moved the audience to " +
				"LL-HLS behind a CDN, and cut the cost of a 10,000-person session by three orders of " +
				"magnitude. This is the whole architecture, the real numbers, and the three things that broke.",
			track: "Architecture", startsAt: base, duration: 60,
			kind: "live", status: "scheduled", hostEmail: "neeraj@acme.dev",
			panelists: []string{"priya@acme.dev", "marco@streamline.io"},
			approval:  "automatic", limit: 500, passcode: "228104",
			agenda: []map[string]string{
				{"at": "09:00", "title": "Why self-hosted webinars get expensive", "detail": "The per-viewer bandwidth math."},
				{"at": "09:08", "title": "Picking a media server", "detail": "LiveKit vs mediasoup vs Janus vs Jitsi."},
				{"at": "09:20", "title": "The two-tier architecture, live", "detail": "SFU for the stage, HLS for the audience."},
				{"at": "09:34", "title": "TURN, firewalls, and the black-screen problem"},
				{"at": "09:42", "title": "Cost model walkthrough", "detail": "Three scales, real invoices."},
				{"at": "09:50", "title": "Live Q&A"},
			},
			takeaways: []string{
				"The exact threshold where you move a viewer off WebRTC and onto HLS",
				"A cost model you can run on your own numbers",
				"Why ~15% of attendees see a black screen, and the coturn config that fixes it",
				"Egress sizing for concurrent recordings",
			},
			options: opts(nil),
		},
		{
			slug: "coturn-hostile-networks", wid: "712 8890 4417",
			topic:       "coturn in hostile networks",
			summary:     "Getting WebRTC through corporate firewalls, carrier NAT, and hotel wifi.",
			description: "Roughly one in six attendees sits behind a network that blocks UDP outright. A deep dive on TURN.",
			track:       "Networking", startsAt: base.AddDate(0, 0, 5).Add(time.Hour), duration: 45,
			kind: "live", status: "scheduled", hostEmail: "priya@acme.dev",
			panelists: []string{"dieter@siemens.com"},
			approval:  "automatic", limit: 500,
			agenda: []map[string]string{
				{"at": "10:00", "title": "How ICE actually fails"},
				{"at": "10:12", "title": "coturn on 443, beside your web tier"},
				{"at": "10:26", "title": "What relay costs, measured"},
			},
			takeaways: []string{"A working coturn config for TCP 443", "The metrics that prove relay is the problem"},
			options:   opts(map[string]bool{"captions": true}),
		},
		{
			slug: "postgres-event-platforms", wid: "301 5567 9920",
			topic:       "Postgres schema design for event platforms",
			summary:     "Registrations, attendance intervals, and Q&A at scale — without a second database.",
			description: "The schema we landed on after three rewrites, including attendance as intervals.",
			track:       "Data", startsAt: base.AddDate(0, 0, 7), duration: 60,
			kind: "live", status: "scheduled", hostEmail: "marco@streamline.io",
			panelists: []string{"neeraj@acme.dev"},
			// Manual approval so the pending-registration path is exercised.
			approval: "manual", limit: 300, priceCents: &price49,
			agenda: []map[string]string{
				{"at": "09:00", "title": "The three tables everyone gets wrong"},
				{"at": "09:15", "title": "Attendance as intervals, not events"},
				{"at": "09:32", "title": "Reporting queries that stay fast"},
			},
			takeaways: []string{"A schema you can copy, with migrations", "The two indexes that matter most"},
			options:   opts(map[string]bool{"polls": false}),
		},
		{
			slug: "simulive-playbook", wid: "556 7712 3388",
			topic:       "The simulive playbook: run one webinar four times",
			summary:     "Pre-recorded video, live host, live chat. Same conversion, a quarter of the effort.",
			description: "Simulive plays a recording on a schedule while a real host answers chat live.",
			track:       "Growth", startsAt: base.AddDate(0, 0, 13).Add(9 * time.Hour), duration: 45,
			kind: "simulive", status: "scheduled", hostEmail: "lucia@cabify.com",
			panelists: []string{"amara@paystack.com"},
			approval:  "automatic", limit: 500,
			agenda: []map[string]string{
				{"at": "18:00", "title": "What simulive is and isn't"},
				{"at": "18:10", "title": "Disclosure that keeps trust intact"},
			},
			takeaways: []string{"A disclosure script that doesn't cost credibility", "The chat-staffing ratio that works"},
			options:   opts(map[string]bool{"practiceSession": false, "multistream": true}),
		},
		{
			slug: "egress-tuning", wid: "445 1120 8834",
			topic:       "Egress tuning: recording 6 webinars on one box",
			summary:     "Headless Chrome, ffmpeg presets, and the CPU ceiling nobody documents.",
			description: "How many concurrent room-composite jobs a 4-core box really sustains.",
			track:       "Operations", startsAt: base.AddDate(0, 0, -28), duration: 55,
			kind: "live", status: "ended", hostEmail: "priya@acme.dev",
			panelists: []string{"neeraj@acme.dev"},
			approval:  "automatic", limit: 500,
			agenda:    []map[string]string{{"at": "09:00", "title": "Where Egress actually spends CPU"}},
			takeaways: []string{"A sizing table for concurrent egress jobs"},
			options:   opts(nil),
			report:    []byte(`{"attended":712,"avgWatchMin":31,"questions":44}`),
		},
		{
			slug: "webrtc-mobile-safari", wid: "620 3391 7745",
			topic:       "WebRTC on mobile Safari: the survival guide",
			summary:     "Autoplay policies, backgrounding, and the bugs you can't work around.",
			description: "Draft outline. Around 40% of attendees are on a phone and most of the pain is iOS.",
			track:       "Frontend", startsAt: base.AddDate(0, 0, 28), duration: 45,
			kind: "live", status: "draft", hostEmail: "neeraj@acme.dev",
			approval: "automatic", limit: 500,
			options: opts(map[string]bool{"autoRecord": false}),
		},
	}

	questions := map[string][]map[string]any{
		"scaling-webrtc-10k": {
			{"key": "stack", "label": "What are you running today?", "type": "select", "required": true,
				"options": []string{"Zoom / Teams / Webex", "A managed WebRTC API (Agora, Daily, 100ms)", "Something self-hosted already", "Nothing yet — evaluating"}},
			{"key": "scale", "label": "Largest audience you need to serve", "type": "select", "required": false,
				"options": []string{"Under 100", "100 – 500", "500 – 2,000", "2,000+"}},
			{"key": "ask", "label": "Anything specific you want covered?", "type": "short", "required": false},
		},
		"coturn-hostile-networks": {
			{"key": "stack", "label": "What are you running today?", "type": "select", "required": true,
				"options": []string{"Zoom / Teams / Webex", "A managed WebRTC API", "Self-hosted already", "Nothing yet"}},
		},
		"postgres-event-platforms": {
			{"key": "stack", "label": "What are you running today?", "type": "select", "required": true,
				"options": []string{"Postgres", "MySQL", "Something else"}},
		},
	}

	for _, wb := range webinars {
		agenda, _ := json.Marshal(orEmptySlice(wb.agenda))
		takeaways, _ := json.Marshal(orEmptyStrings(wb.takeaways))

		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO webinars
				(slug, webinar_id, topic, summary, description, track, starts_at,
				 duration_min, time_zone, kind, status, host_id, approval,
				 attendee_limit, price_cents, passcode, agenda, takeaways, options, report)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Asia/Kolkata',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
			RETURNING id::text`,
			wb.slug, wb.wid, wb.topic, wb.summary, wb.description, wb.track, wb.startsAt,
			wb.duration, wb.kind, wb.status, ids[wb.hostEmail], wb.approval,
			wb.limit, wb.priceCents, wb.passcode, agenda, takeaways, wb.options, nullableJSON(wb.report),
		).Scan(&id)
		if err != nil {
			return fmt.Errorf("seed webinar %s: %w", wb.slug, err)
		}

		for i, email := range wb.panelists {
			if _, err := tx.Exec(ctx, `
				INSERT INTO webinar_panelists (webinar_id, user_id, position)
				VALUES ($1,$2,$3)`, id, ids[email], i); err != nil {
				return fmt.Errorf("seed panelist %s: %w", email, err)
			}
		}

		for i, q := range questions[wb.slug] {
			optJSON, _ := json.Marshal(q["options"])
			if q["options"] == nil {
				optJSON = []byte(`[]`)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO custom_questions (webinar_id, key, label, type, required, options, position)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				id, q["key"], q["label"], q["type"], q["required"], optJSON, i); err != nil {
				return fmt.Errorf("seed question: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.log.Info("seeded development data", "users", len(people), "webinars", len(webinars))
	return nil
}

func nullableJSON(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

func orEmptySlice(s []map[string]string) []map[string]string {
	if s == nil {
		return []map[string]string{}
	}
	return s
}

func orEmptyStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
