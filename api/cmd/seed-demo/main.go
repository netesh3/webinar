// Command seed-demo creates a demo coach with a WhatsApp CRM full of believable data:
// webinars (two past, one upcoming), registrants with watch time, WhatsApp contacts,
// confirmations and reminders that went out, two post-webinar follow-ups, replies
// waiting in Messages, tags and a note.
//
//	DATABASE_URL='postgres://webcast:webcast@localhost:5432/webcast?sslmode=disable' \
//	  go run ./cmd/seed-demo
//
// Sign in as demo@webinarliv.com with the password printed at the end (DEMO_PASSWORD
// overrides it). Safe to run again: it deletes the demo account and everything under it
// first, and touches nothing else.
//
// The WhatsApp connection is pretend (a token starting with wa.DemoTokenPrefix): sends
// "succeed" without leaving the server, and the account never shows Reconnect. The
// People and Messages tabs only appear when the API has META_APP_ID and friends set.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/store"
)

const demoEmail = "demo@webinarliv.com"

func main() {
	if err := run(); err != nil {
		slog.Error("seed-demo", "error", err)
		os.Exit(1)
	}
}

func run() error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	password := os.Getenv("DEMO_PASSWORD")
	if password == "" {
		password = "demo-coach-2026"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	// Schema first, the same way the server boots, so a stale database is not a
	// confusing column error halfway through.
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	st, err := store.Open(ctx, dsn, log)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	if err := st.Migrate(ctx); err != nil {
		st.Close()
		return fmt.Errorf("migrate: %w", err)
	}
	st.Close()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()

	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := reset(ctx, tx); err != nil {
		return fmt.Errorf("reset: %w", err)
	}
	s := &seeder{ctx: ctx, tx: tx, now: time.Now().UTC()}
	if err := s.seed(hash); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	fmt.Printf("\nDemo coach ready.\n  email:    %s\n  password: %s\n\n", demoEmail, password)
	fmt.Printf("  %d contacts, %d webinars, %d WhatsApp messages, %d waiting for a reply.\n\n",
		s.contacts, len(s.webinars), s.messages, s.waiting)
	return nil
}

// reset removes the demo account and everything under it. Webinars first: deleting
// them cascades registrations, attendance and notifications, and users → webinars is
// RESTRICT. Deleting the user then cascades contacts, messages, templates, broadcasts.
func reset(ctx context.Context, tx pgx.Tx) error {
	// Broadcasts before webinars: a segment broadcast must name its webinar, and the
	// webinar delete would SET NULL it.
	if _, err := tx.Exec(ctx, `
		DELETE FROM crm_broadcasts WHERE host_id IN (SELECT id FROM users WHERE email = $1)`, demoEmail); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM webinars WHERE host_id IN (SELECT id FROM users WHERE email = $1)`, demoEmail); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM users WHERE email = $1`, demoEmail)
	return err
}
