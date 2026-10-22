package store

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The recap rows against a real database: one per session however often it is scheduled,
 * claimed by one runner at a time, and emailed once. */

func recapStore(t *testing.T) (*Store, string, string, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	tag := time.Now().Format("150405.000000")
	var host, wid, slug string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO users (email, name) VALUES ('recap-' || $1 || '@test.dev', 'Recap Host') RETURNING id::text`, tag).Scan(&host); err != nil {
		t.Fatal(err)
	}
	start := time.Now().Add(-time.Hour)
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO webinars (slug, webinar_id, topic, starts_at, duration_min, host_id, status, started_at, ended_at)
		VALUES ('recap-' || $1, 'recap-' || $1, 'Recap', $2::timestamptz, 60, $3::uuid, 'ended', $2::timestamptz, $2::timestamptz + interval '1 hour')
		RETURNING id::text, slug`, tag, start, host).Scan(&wid, &slug); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM webinars WHERE id = $1::uuid`, wid)
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1::uuid`, host)
	})
	return s, host, wid, slug
}

func TestRecapRowLifecycle(t *testing.T) {
	s, host, wid, slug := recapStore(t)
	ctx := context.Background()

	if _, err := s.SessionRecap(ctx, slug); err != ErrNotFound {
		t.Fatalf("before scheduling: %v", err)
	}
	if ok, err := s.ScheduleRecap(ctx, slug, 0, 30*time.Minute); err != nil || !ok {
		t.Fatalf("schedule: %v %v", ok, err)
	}
	// Ending again changes nothing.
	if ok, err := s.ScheduleRecap(ctx, slug, time.Hour, 0); err != nil || ok {
		t.Fatalf("second schedule wrote a row: %v %v", ok, err)
	}
	row, err := s.SessionRecap(ctx, slug)
	if err != nil || row.Status != types.RecapPending || row.WaitUntil == nil {
		t.Fatalf("pending row = %+v %v", row, err)
	}

	// One claim at a time.
	job, ok, err := s.ClaimDueRecap(ctx, time.Minute)
	if err != nil || !ok || job.Slug != slug || job.WebinarID != wid {
		t.Fatalf("claim = %+v %v %v", job, ok, err)
	}
	if again, ok, _ := s.ClaimDueRecap(ctx, time.Minute); ok && again.WebinarID == wid {
		t.Fatal("a claimed recap was claimed twice")
	}
	// Deferred into the future: not due.
	if err := s.DeferRecap(ctx, wid, time.Now().Add(time.Hour), 1, types.RecapReasonWaitingTranscript); err != nil {
		t.Fatal(err)
	}
	if again, ok, _ := s.ClaimDueRecap(ctx, time.Minute); ok && again.WebinarID == wid {
		t.Fatal("a deferred recap was due")
	}
	// The transcript arrives: due now.
	if err := s.NudgeRecap(ctx, slug); err != nil {
		t.Fatal(err)
	}
	if job, ok, _ = s.ClaimDueRecap(ctx, time.Minute); !ok || job.WebinarID != wid || job.Attempts != 1 {
		t.Fatalf("after nudge = %+v %v", job, ok)
	}

	recap := types.SessionRecap{Summary: "It went well.", Chapters: []types.RecapChapter{{StartSec: 0, Title: "Start"}}}
	if err := s.SaveRecap(ctx, slug, recap, types.RecapSourceCaptions, "gpt-5-nano"); err != nil {
		t.Fatal(err)
	}
	// Settling after it is ready does not undo it.
	if err := s.SettleRecap(ctx, wid, types.RecapFailed, types.RecapReasonFailed); err != nil {
		t.Fatal(err)
	}
	row, _ = s.SessionRecap(ctx, slug)
	if row.Status != types.RecapReady || row.Recap == nil || row.Recap.Summary != "It went well." || row.Source != types.RecapSourceCaptions {
		t.Fatalf("ready row = %+v", row)
	}
	if ch, err := s.RecapChapters(ctx, slug); err != nil || len(ch) != 1 {
		t.Fatalf("chapters = %+v %v", ch, err)
	}

	// Emailed once.
	n := Notification{UserID: host, Kind: types.NotifySessionRecap, WebinarSlug: slug, Subject: "Your AI recap: Recap", Body: "x"}
	if ok, err := s.QueueRecapEmail(ctx, wid, n); err != nil || !ok {
		t.Fatalf("first email: %v %v", ok, err)
	}
	if ok, err := s.QueueRecapEmail(ctx, wid, n); err != nil || ok {
		t.Fatalf("second email: %v %v", ok, err)
	}
	var rows int
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE webinar_id = $1::uuid AND kind = 'session_recap'`, wid).Scan(&rows)
	if rows != 1 {
		t.Fatalf("recap notifications = %d, want 1", rows)
	}
	// A regenerate keeps emailed_at.
	if err := s.SaveRecap(ctx, slug, recap, types.RecapSourceServerTranscript, "gpt-5-nano"); err != nil {
		t.Fatal(err)
	}
	if row, _ = s.SessionRecap(ctx, slug); row.EmailedAt == nil || row.Source != types.RecapSourceServerTranscript {
		t.Fatalf("after regenerate = %+v", row)
	}
}

func TestRecapSources(t *testing.T) {
	s, host, wid, slug := recapStore(t)
	ctx := context.Background()
	var started time.Time
	_ = s.pool.QueryRow(ctx, `SELECT started_at FROM webinars WHERE id = $1::uuid`, wid).Scan(&started)

	// Captions: the host's line is named after the account.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO session_captions (webinar_id, identity, body, at) VALUES
		  ($1::uuid, 'user_' || $2, 'before the start', $3::timestamptz - interval '1 minute'),
		  ($1::uuid, 'user_' || $2, 'hello everyone', $3::timestamptz + interval '10 seconds'),
		  ($1::uuid, 'att_abc', 'a question out loud', $3::timestamptz + interval '20 seconds')`, wid, host, started); err != nil {
		t.Fatal(err)
	}
	lines, err := s.RecapCaptions(ctx, slug, started, 100)
	if err != nil || len(lines) != 2 || lines[0].Name != "Recap Host" || lines[1].Name != "" || lines[0].Text != "hello everyone" {
		t.Fatalf("captions = %+v %v", lines, err)
	}

	// A transcript from before this session is not this session's.
	if err := s.SaveSessionTranscript(ctx, slug, "old", []TranscriptSegment{{Text: "old"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE session_transcripts SET created_at = $2::timestamptz - interval '1 day' WHERE webinar_id = $1::uuid`, wid, started); err != nil {
		t.Fatal(err)
	}
	if _, _, found, err := s.TranscriptSince(ctx, slug, started); err != nil || found {
		t.Fatalf("old transcript found: %v %v", found, err)
	}
	if err := s.SaveSessionTranscript(ctx, slug, "large-v3", []TranscriptSegment{{Text: "new"}}); err != nil {
		t.Fatal(err)
	}
	if model, segs, found, err := s.TranscriptSince(ctx, slug, started); err != nil || !found || model != "large-v3" || segs[0].Text != "new" {
		t.Fatalf("transcript = %v %+v %v %v", model, segs, found, err)
	}

	// Peak: three overlapping, then a reconnect at the same instant is not a fourth.
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at) VALUES
		  ($1::uuid, 'att_a', $2::timestamptz,                         $2::timestamptz + interval '30 minutes'),
		  ($1::uuid, 'att_b', $2::timestamptz + interval '5 minutes',  $2::timestamptz + interval '20 minutes'),
		  ($1::uuid, 'att_c', $2::timestamptz + interval '10 minutes', $2::timestamptz + interval '15 minutes'),
		  ($1::uuid, 'att_c', $2::timestamptz + interval '15 minutes', $2::timestamptz + interval '25 minutes'),
		  ($1::uuid, 'user_x', $2::timestamptz,                        $2::timestamptz + interval '60 minutes')`, wid, started); err != nil {
		t.Fatal(err)
	}
	if peak, err := s.PeakViewers(ctx, slug); err != nil || peak != 3 {
		t.Fatalf("peak = %d %v, want 3", peak, err)
	}
}
