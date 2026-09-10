// Command migrate applies embedded SQL migrations and exits.
//
// Same store.Migrate path as api/cmd/server boot. Useful for applying schema to
// Supabase (or any Postgres) before the first Cloud Run revision receives traffic.
//
//	DATABASE_URL='postgres://…?sslmode=require' go run ./cmd/migrate
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		slog.Error("DATABASE_URL is required")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	st, err := store.Open(ctx, dsn, log)
	if err != nil {
		slog.Error("open database", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	migCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if err := st.Migrate(migCtx); err != nil {
		slog.Error("migrate", "error", err)
		os.Exit(1)
	}
	log.Info("migrations up to date")
}
