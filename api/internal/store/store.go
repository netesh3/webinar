// Package store owns all database access. Handlers never see SQL.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
	ErrFull     = errors.New("at capacity")
	/* ErrGuestNotAllowed: this webinar requires the host to approve each registrant, so there
	 * is no name-only door. A distinct error rather than ErrConflict because the handler turns
	 * it into a specific message — "this webinar needs the host to approve you, please register"
	 * — and "conflict" would have to be guessed at from context. */
	ErrGuestNotAllowed = errors.New("guest entry not allowed")
	// ErrInvalid marks input the database layer rejected on its own terms —
	// an unparseable timestamp, a status transition that makes no sense. It
	// maps to a 422 rather than the 500 an unexpected error would produce.
	ErrInvalid = errors.New("invalid input")
	// ErrHasWebinars means an account cannot be deleted because it still
	// hosts at least one webinar — webinars.host_id is ON DELETE RESTRICT,
	// deliberately: an admin deleting an account should not be how a whole
	// webinar's registrations, chat history and recordings quietly vanish.
	// The webinars have to go first, on purpose, as their own visible action.
	ErrHasWebinars = errors.New("account owns webinars")
)

type Store struct {
	pool *pgxpool.Pool
	log  *slog.Logger
}

func Open(ctx context.Context, dsn string, log *slog.Logger) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	// Sized for a single API node in front of a 500-attendee webinar. The join
	// burst at the top of the hour is the peak: ~500 requests over a minute or
	// two, each a single indexed lookup.
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool, log: log}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Migrate applies any unapplied migration files inside a transaction each.
//
// Deliberately hand-rolled rather than pulling in golang-migrate: the whole
// mechanism is 40 lines, needs no extra binary in the image, and the files are
// embedded so a deployed binary can never disagree with its schema.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)

	for _, path := range entries {
		var exists bool
		if err := s.pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, path,
		).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}

		body, err := migrationFS.ReadFile(path)
		if err != nil {
			return err
		}

		// One transaction per file: a failed migration leaves no partial schema.
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", path, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, path); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		s.log.Info("migration applied", "version", path)
	}
	return nil
}

// isUniqueViolation reports whether err is a Postgres 23505.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
