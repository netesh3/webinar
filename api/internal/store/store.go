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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/observe"
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
	 * on (crm_drips.trigger_tag_id is ON DELETE RESTRICT — see migrations/0049): NULL
	 * there means "any tag", so letting the delete through would silently widen the rule
	 * from one label to every label. Distinct from ErrConflict because the handler names
	 * the sequence in its refusal, which is the only thing that makes it actionable.
	 */
	ErrInUse = errors.New("still referenced")
	// ErrAlreadyHost means this account can already host, so a request to
	// become a host is refused. The request never grants that itself.
	ErrAlreadyHost = errors.New("already a host")
	// ErrHostRequested means an open hosting request is already recorded.
	// A second one must not send another email.
	ErrHostRequested = errors.New("hosting already requested")
	// ErrPhoneRequired means the account has no phone and the request did
	// not include one that could be stored.
	ErrPhoneRequired = errors.New("phone required")
)

type Store struct {
	pool *pgxpool.Pool
	log  *slog.Logger
	// listenCfg is the session-mode connection for LISTEN and migrations (DBOptions.ListenURL).
	listenCfg *pgx.ConnConfig
	opts      DBOptions
}

/* Open connects using dsn for queries and the environment for everything else (see
 * DBOptionsFromEnv). Kept with this signature because every caller, tests included, has a
 * single URL in hand. */
func Open(ctx context.Context, dsn string, log *slog.Logger) (*Store, error) {
	opts, err := DBOptionsFromEnv(dsn, os.Getenv)
	if err != nil {
		return nil, err
	}
	return OpenWith(ctx, opts, log)
}

/* OpenWith connects with resolved options.
 *
 * Sized to the database's ceiling, not to one node's appetite. Production runs on Supabase's
 * Supavisor, whose session pooler caps the project at pool_size clients (15 on 24 Oct 2026,
 * now 30), idle ones included. The
 * pool therefore keeps nothing it is not using: MinConns 0 and a one-minute idle timeout mean
 * an instance that served a load test gives its connections back a minute later, instead of
 * holding the whole allowance until the next deploy needs it (24 Oct 2026). Lifetimes are
 * jittered so a fleet started together does not reconnect together.
 *
 * The query pool should point at the transaction pooler (see dbconfig.go), where idle clients
 * cost no server connection; LISTEN and migrations keep a session connection of their own.
 *
 * The first connection is retried for DB_CONNECT_TIMEOUT: a pooler that is full for the minute
 * it takes the old revision to drain is a reason to wait, not to exit and be restarted into the
 * same wall. */
func OpenWith(ctx context.Context, opts DBOptions, log *slog.Logger) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(opts.URL)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	cfg.MaxConns = opts.MaxConns
	cfg.MinConns = opts.MinConns
	cfg.MaxConnLifetime = opts.MaxConnLifetime
	cfg.MaxConnLifetimeJitter = opts.MaxConnLifetimeJitter
	cfg.MaxConnIdleTime = opts.MaxConnIdleTime
	cfg.HealthCheckPeriod = opts.HealthCheckPeriod
	if !opts.ExecModeFromURL {
		cfg.ConnConfig.DefaultQueryExecMode = opts.ExecMode
	}

	listenCfg := cfg.ConnConfig.Copy()
	if opts.SeparateListen() {
		listenCfg, err = pgx.ParseConfig(opts.ListenURL)
		if err != nil {
			return nil, fmt.Errorf("parse listen dsn: %w", err)
		}
	}
	// Queries as child spans of the request that made them; nil (no tracer) when
	// telemetry is off. See observe.QueryTracer for what is and is not recorded.
	if t := observe.QueryTracer(); t != nil {
		cfg.ConnConfig.Tracer = t
		listenCfg.Tracer = t
	}

	for _, n := range opts.Notes {
		if strings.HasPrefix(n, "WARNING") {
			log.Warn(n)
		} else {
			log.Info(n)
		}
	}
	b := opts.SessionBudget()
	log.Info("database pool",
		"mode", opts.PoolMode, "separate_listen", opts.SeparateListen(),
		"max_conns", opts.MaxConns, "min_conns", opts.MinConns,
		"idle_timeout", opts.MaxConnIdleTime.String(), "exec_mode", cfg.ConnConfig.DefaultQueryExecMode.String(),
		"session_per_instance", b.PerInstance, "session_deploy_peak", b.Peak, "session_limit", b.Limit)

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	err = retryConnect(ctx, log, opts.ConnectTimeout, realSleep, func(ctx context.Context) error {
		pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return pool.Ping(pingCtx)
	})
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool, log: log, listenCfg: listenCfg, opts: opts}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// DatabaseSize is the current database's size on disk in bytes (observe.RegisterDBSizeGauge).
func (s *Store) DatabaseSize(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&n)
	return n, err
}

// migrator is what Migrate needs; both *pgxpool.Pool and *pgx.Conn have it.
type migrator interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Migrate applies any unapplied migration files inside a transaction each.
//
// Deliberately hand-rolled rather than pulling in golang-migrate: the whole
// mechanism is 40 lines, needs no extra binary in the image, and the files are
// embedded so a deployed binary can never disagree with its schema.
//
// When a separate session URL is configured (DATABASE_LISTEN_URL, or derived), migrations
// run on one connection of their own there rather than through the query pool: DDL is the
// one place a session pooler is the safe choice, and the connection is closed straight after.
func (s *Store) Migrate(ctx context.Context) error {
	if !s.opts.SeparateListen() {
		return s.migrate(ctx, s.pool)
	}
	var conn *pgx.Conn
	err := retryConnect(ctx, s.log, s.opts.ConnectTimeout, realSleep, func(ctx context.Context) error {
		c, err := pgx.ConnectConfig(ctx, s.listenCfg.Copy())
		if err != nil {
			return err
		}
		conn = c
		return nil
	})
	if err != nil {
		return fmt.Errorf("migrations connection: %w", err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	return s.migrate(ctx, conn)
}

func (s *Store) migrate(ctx context.Context, db migrator) error {
	if _, err := db.Exec(ctx, `
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
		if err := db.QueryRow(ctx,
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
		tx, err := db.Begin(ctx)
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
	return errors.As(err, &pgErr) &&
		// 23001 is what Postgres 18 raises for ON DELETE RESTRICT; earlier versions use 23503.
		(pgErr.Code == "23503" || pgErr.Code == "23001")
}

func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
