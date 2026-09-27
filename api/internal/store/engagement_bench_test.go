package store

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/engagement"
	"github.com/netkumar/webcast/api/types"
)

/* BenchmarkEngagementPipeline is the whole path a recompute takes against a real database:
 * load every source for one webinar, compute, and replace the snapshot and scores. Seeded
 * at the target scale — 5,000 attendees, 6,000 visits, 15,000 chat lines, 16,500 poll votes
 * and 100,000 captured events — with set-based INSERTs so seeding is seconds, not minutes.
 *
 *	TEST_DATABASE_URL=… go test ./internal/store -bench Engagement -run '^$' -benchtime 5x
 */
func BenchmarkEngagementPipeline(b *testing.B) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		b.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn, slog.New(slog.DiscardHandler))
	if err != nil {
		b.Fatal(err)
	}
	defer s.Close()
	if err := s.Migrate(ctx); err != nil {
		b.Fatal(err)
	}
	wid := seedEngagement(b, s, 5000, 90, 100_000)
	defer s.pool.Exec(ctx, `DELETE FROM webinars WHERE id = $1`, wid)
	f := engagement.Current()

	var in engagement.Input
	b.Run("load", func(b *testing.B) {
		for b.Loop() {
			if in, err = s.EngagementInput(ctx, wid, time.Now()); err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(float64(len(in.Events)), "eventGroups")
	})
	res := engagement.Compute(in, f)
	if len(res.Rows) != 5000 {
		b.Fatalf("%d rows", len(res.Rows))
	}
	b.Run("compute", func(b *testing.B) {
		for b.Loop() {
			res = engagement.Compute(in, f)
		}
	})
	b.Run("save", func(b *testing.B) {
		for b.Loop() {
			if _, err := s.SaveEngagement(ctx, wid, f.Version, time.Now(), []byte(`{}`), res.Rows); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("page", func(b *testing.B) {
		for b.Loop() {
			if _, _, err := s.EngagementAttendees(ctx, wid, AttendeeQuery{
				Sort: types.SortScore, Desc: true, Offset: 2500, Limit: 50,
				Tiers: []types.EngagementTier{types.TierEngaged, types.TierPassive},
			}); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("activity", func(b *testing.B) {
		for b.Loop() {
			if _, _, err := s.EngagementActivity(ctx, wid, "att_000042"); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func seedEngagement(b *testing.B, s *Store, people, minutes, events int) string {
	b.Helper()
	ctx := context.Background()
	var host, wid string
	tag := time.Now().Format("150405.000000")
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO users (email, name) VALUES ('bench-' || $1 || '@test.dev', 'Bench') RETURNING id::text`, tag).Scan(&host); err != nil {
		b.Fatal(err)
	}
	start := time.Now().Add(-3 * time.Hour).Truncate(time.Minute)
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO webinars (slug, webinar_id, topic, starts_at, duration_min, host_id, status, started_at, ended_at)
		VALUES ('bench-' || $1, 'bench-' || $1, 'Bench', $2::timestamptz, $3::int, $4::uuid, 'ended',
		        $2::timestamptz, $2::timestamptz + make_interval(mins => $3::int))
		RETURNING id::text`, tag, start, minutes, host).Scan(&wid); err != nil {
		b.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO registrations (webinar_id, email, first_name, last_name, join_key)
		 SELECT $1::uuid, 'p' || i || '@bench.dev', 'Person', i::text, 'k' || $1::uuid || '-' || i FROM generate_series(0, $2::int - 1) i`,
		`INSERT INTO attendance (webinar_id, identity, registration_id, name)
		 SELECT $1::uuid, 'att_' || lpad(i::text, 6, '0'), r.id, 'Person ' || i
		   FROM generate_series(0, $2::int - 1) i JOIN registrations r ON r.join_key = 'k' || $1::uuid || '-' || i`,
		`INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at)
		 SELECT $1::uuid, 'att_' || lpad(i::text, 6, '0'),
		        $3::timestamptz + make_interval(secs => (i % 20 - 8) * 60),
		        $3::timestamptz + make_interval(secs => LEAST($4::int * 60, (i % 20 - 8) * 60 + ($4::int * 60 * (20 + i % 80) / 100)))
		   FROM generate_series(0, $2::int - 1) i`,
		`INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at)
		 SELECT $1::uuid, 'att_' || lpad(i::text, 6, '0'), $3::timestamptz + make_interval(mins => $4::int - 10),
		        $3::timestamptz + make_interval(mins => $4::int)
		   FROM generate_series(0, $2::int - 1, 5) i`,
		`INSERT INTO chat_messages (id, webinar_id, sender_identity, sender_name, sender_role, content, created_at)
		 SELECT 'bench-' || $1::uuid || '-' || i, $1::uuid, 'att_' || lpad((i % $2::int)::text, 6, '0'), 'Person', 'attendee',
		        repeat('x', 5 + i % 60), $3::timestamptz + make_interval(secs => (i * 7919) % ($4::int * 60))
		   FROM generate_series(0, $2::int * 3 - 1) i`,
		`INSERT INTO polls (webinar_id, question, kind, options, correct_option, state, opened_at, closed_at)
		 SELECT $1::uuid, 'Q' || p, CASE WHEN p % 2 = 1 THEN 'quiz' ELSE 'poll' END, '["a","b","c","d"]',
		        CASE WHEN p % 2 = 1 THEN 1 END, 'closed',
		        $3::timestamptz + make_interval(mins => $4::int * (p + 1) / 7),
		        $3::timestamptz + make_interval(mins => $4::int * (p + 1) / 7 + 2)
		   FROM generate_series(0, 5) p WHERE $2::int > 0`,
		`INSERT INTO poll_votes (poll_id, identity, choice, voted_at)
		 SELECT p.id, 'att_' || lpad(i::text, 6, '0'), i % 4, p.opened_at + interval '30 seconds'
		   FROM polls p CROSS JOIN generate_series(0, $2::int - 1) i
		  WHERE p.webinar_id = $1::uuid AND (i * 31 + length(p.question)) % 100 < 55`,
	} {
		args := []any{wid, people, start, minutes}
		n := 0
		for i := range args {
			if strings.Contains(q, fmt.Sprintf("$%d", i+1)) {
				n = i + 1
			}
		}
		if _, err := s.pool.Exec(ctx, q, args[:n]...); err != nil {
			b.Fatalf("seed: %v\n%s", err, q)
		}
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO engagement_events (webinar_id, identity, kind, payload, occurred_at)
		SELECT $1::uuid, 'att_' || lpad(((i::bigint * 2654435761) % $2::int)::text, 6, '0'),
		       CASE WHEN i % 20 = 0 THEN 'hand_raise' ELSE 'reaction' END,
		       CASE WHEN i % 20 = 0 THEN '{}'::jsonb
		            ELSE jsonb_build_object('emoji', (ARRAY['👏','👍','❤️','😂','🎉','😮'])[1 + i % 6]) END,
		       $3::timestamptz + make_interval(secs => (i::bigint * 104729) % ($4::int * 60))
		  FROM generate_series(0, $5::int - 1) i`, wid, people, start, minutes, events); err != nil {
		b.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `ANALYZE`); err != nil {
		b.Fatal(err)
	}
	return wid
}
