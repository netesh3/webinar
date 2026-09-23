// Package store owns all database access. Handlers never see SQL.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"sort"
	"strconv"
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
	/* ErrInUse means a row cannot be deleted because something still points at it and
	 * the pointer is not ours to break. The one case today is a tag a sequence triggers
	 * on (crm_drips.trigger_tag_id is ON DELETE RESTRICT — see migrations/0048): NULL
	 * there means "any tag", so letting the delete through would silently widen the rule
	 * from one label to every label. Distinct from ErrConflict because the handler names
	 * the sequence in its refusal, which is the only thing that makes it actionable.
	 */
	ErrInUse = errors.New("still referenced")
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
	/* Sized to the database's ceiling, not to one node's appetite.
	 *
	 * This used to ask for 20, reasoning about a single API node in front of a
	 * 500-attendee join burst. But the connections are not this node's to spend:
	 * production runs on Supabase's session-mode pooler, which caps the whole
	 * project at 15 clients, and every pooled connection is one of those 15. One
	 * node at 20 could hold the entire allowance, so when Cloud Run started a
	 * second instance — a deploy rolling over, or a scale-up under load — the new
	 * one's very first ping came back "max clients reached" and the container
	 * exited on boot. That is what made deploys fail and, with a warm instance
	 * always holding connections, what min-instances exposed.
	 *
	 * The default now fits max-instances (3) inside the 15: 4 each leaves room
	 * for a fourth instance's boot ping during a rollover. Each query is a single
	 * indexed lookup measured in milliseconds, so four in flight per node clears
	 * the burst without trouble. DB_MAX_CONNS / DB_MIN_CONNS override it for a
	 * database with a different ceiling — a dedicated Postgres, or Supabase's
	 * transaction pooler, where the old 20 would be fine again. */
	cfg.MaxConns = int32(envInt("DB_MAX_CONNS", 4))
	cfg.MinConns = int32(envInt("DB_MIN_CONNS", 1))
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

// envInt reads a positive integer from the environment, falling back to def
// when the variable is unset, empty, unparseable, or not positive. Pool sizes
// are the only knobs here and a zero or negative one is never what was meant.
func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return def
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

// isForeignKeyViolation reports whether err is a Postgres 23503 — a row that is
// still referenced by an ON DELETE RESTRICT pointer, or one pointing at something
// that does not exist.
func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
