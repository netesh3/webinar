package store

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

/* How the API talks to Postgres, and why it is configured this carefully.
 *
 * Production sits behind Supabase's Supavisor, which offers two poolers on the same host:
 *
 *   :5432  SESSION mode. Every client connection pins one server connection for as long as
 *          it is open, and the project allows pool_size of them (15 on 24 Oct 2026, since raised
 *          to 30). Idle connections count.
 *   :6543  TRANSACTION mode. A server connection is lent per transaction, so many clients
 *          share few server connections. LISTEN does not work through it (the session that
 *          listened is handed to somebody else after the statement), and neither do named
 *          prepared statements kept across transactions, which is what pgx caches by default.
 *
 * On 24 Oct 2026 two deploys failed because everything ran through the session pooler: three
 * instances × (4 pooled + 1 LISTEN) is exactly 15, every pooled connection was being kept idle
 * after a load test, and the new revision's boot ping could not get a 16th. The container
 * exited, Cloud Run restarted it, and it failed again.
 *
 * So there are two connection strings:
 *
 *   DATABASE_URL         the query pool. Point it at :6543 (transaction mode) in production.
 *   DATABASE_LISTEN_URL  the session connection: the realtime LISTEN and the boot migrations.
 *                        Point it at :5432 (session mode). Defaults to DATABASE_URL.
 *
 * and DATABASE_POOL_MODE (session | transaction) says what DATABASE_URL is. Left empty it is
 * inferred: port 6543 means transaction, anything else session. Nothing set means exactly the
 * old behaviour: one session-mode URL for everything.
 *
 * Shortcut for Supabase: DATABASE_POOL_MODE=transaction with the existing :5432 pooler URL and
 * no DATABASE_LISTEN_URL routes queries to :6543 on the same host and keeps :5432 for LISTEN.
 * That is only done for a *.pooler.supabase.com host, where the two ports are known to be the
 * two modes of one pooler; anywhere else a guessed port would just be wrong. */

// Pool modes for DATABASE_POOL_MODE.
const (
	PoolModeSession     = "session"
	PoolModeTransaction = "transaction"
)

// supabaseSessionPort and supabaseTransactionPort are Supavisor's two modes on one host.
const (
	supabaseSessionPort     = "5432"
	supabaseTransactionPort = "6543"
)

// DBOptions is everything Open needs, resolved from the environment by DBOptionsFromEnv.
type DBOptions struct {
	// URL is the query pool's connection string.
	URL string
	// ListenURL is the session-mode connection string for LISTEN and migrations.
	// Equal to URL when nothing separate was configured.
	ListenURL string
	// PoolMode is what URL points at: PoolModeSession or PoolModeTransaction.
	PoolMode string
	// ExecMode is the pgx query exec mode for the query pool. In transaction mode it must
	// not keep named prepared statements across transactions.
	ExecMode pgx.QueryExecMode
	// ExecModeFromURL is true when URL itself carries default_query_exec_mode, which then
	// wins over ExecMode.
	ExecModeFromURL bool

	MaxConns              int32
	MinConns              int32
	MaxConnIdleTime       time.Duration
	MaxConnLifetime       time.Duration
	MaxConnLifetimeJitter time.Duration
	HealthCheckPeriod     time.Duration

	// ConnectTimeout is how long boot keeps retrying a refused connection (a full pooler,
	// a database restarting) before giving up. Cloud Run's default TCP startup probe allows
	// 240 s before the port must be open; this stays well inside it.
	ConnectTimeout time.Duration

	// BudgetInstances and SessionPoolSize feed the startup budget check (SessionBudget).
	BudgetInstances int
	SessionPoolSize int

	// Notes are things worth logging at startup: derivations made, budget warnings.
	Notes []string
}

// Defaults. The session-mode pool size stays at 4 (see store.Open's history and parallel.go:
// RunParallel uses up to three at once); transaction mode can afford more because an idle
// client there holds no server connection.
const (
	defaultMaxConnsSession     = 4
	defaultMaxConnsTransaction = 6
	defaultMaxConnIdleTime     = 60 * time.Second
	defaultMaxConnLifetime     = 30 * time.Minute
	defaultMaxConnJitter       = 5 * time.Minute
	defaultHealthCheckPeriod   = 15 * time.Second
	defaultConnectTimeout      = 90 * time.Second
	defaultBudgetInstances     = 3
	defaultSessionPoolSize     = 30
)

// DBOptionsFromEnv resolves the database options for the query URL dsn, reading every other
// knob through getenv (os.Getenv in production, a map in tests).
//
//	DATABASE_LISTEN_URL       session-mode URL for LISTEN + migrations (default: derived or dsn)
//	DATABASE_POOL_MODE        session | transaction (default: 6543 → transaction, else session)
//	DB_QUERY_EXEC_MODE        pgx exec mode for the query pool (default: cache_statement in
//	                          session mode, cache_describe in transaction mode)
//	DB_MAX_CONNS              query pool size (default 4 session, 6 transaction)
//	DB_MIN_CONNS              connections kept open when idle (default 0)
//	DB_MAX_CONN_IDLE_TIME     close a connection idle this long (default 60s)
//	DB_MAX_CONN_LIFETIME      recycle a connection this old (default 30m, plus up to 5m jitter)
//	DB_HEALTH_CHECK_PERIOD    how often idle/old connections are reaped (default 15s)
//	DB_CONNECT_TIMEOUT        how long boot retries a refused connection (default 90s)
//	DB_BUDGET_MAX_INSTANCES   Cloud Run max-instances, for the budget check (default 3)
//	DB_POOLER_POOL_SIZE       the session pooler's pool_size, Supabase Dashboard → Database →
//	                          Connection pooling (default 30)
func DBOptionsFromEnv(dsn string, getenv func(string) string) (DBOptions, error) {
	o := DBOptions{URL: strings.TrimSpace(dsn)}
	if o.URL == "" {
		return o, errors.New("database url is empty")
	}
	listen := strings.TrimSpace(getenv("DATABASE_LISTEN_URL"))

	mode := strings.ToLower(strings.TrimSpace(getenv("DATABASE_POOL_MODE")))
	switch mode {
	case "":
		if urlPort(o.URL) == supabaseTransactionPort {
			mode = PoolModeTransaction
		} else {
			mode = PoolModeSession
		}
	case PoolModeSession, PoolModeTransaction:
	default:
		return o, fmt.Errorf("DATABASE_POOL_MODE must be %q or %q, got %q", PoolModeSession, PoolModeTransaction, mode)
	}
	o.PoolMode = mode

	if mode == PoolModeTransaction && listen == "" && isSupabasePooler(o.URL) {
		switch urlPort(o.URL) {
		case supabaseSessionPort, "":
			// The existing session URL: keep it for LISTEN, send queries to :6543.
			q, err := withPort(o.URL, supabaseTransactionPort)
			if err != nil {
				return o, err
			}
			listen = o.URL
			o.URL = q
			o.Notes = append(o.Notes, "DATABASE_POOL_MODE=transaction: queries use the Supabase transaction pooler (:6543), LISTEN and migrations keep the session pooler (:5432)")
		case supabaseTransactionPort:
			s, err := withPort(o.URL, supabaseSessionPort)
			if err != nil {
				return o, err
			}
			listen = s
			o.Notes = append(o.Notes, "DATABASE_URL is the Supabase transaction pooler: LISTEN and migrations use the session pooler (:5432) on the same host")
		}
	}
	if listen == "" {
		listen = o.URL
		if mode == PoolModeTransaction {
			o.Notes = append(o.Notes, "WARNING: DATABASE_URL is in transaction mode and DATABASE_LISTEN_URL is not set; realtime LISTEN will not receive notifications through a transaction pooler — set DATABASE_LISTEN_URL to a session-mode URL")
		}
	}
	o.ListenURL = listen

	o.ExecModeFromURL = strings.Contains(o.URL, "default_query_exec_mode")
	if o.ExecModeFromURL && (strings.Contains(o.URL, "=simple_protocol") || strings.Contains(o.URL, "default_query_exec_mode=exec")) {
		o.Notes = append(o.Notes, "WARNING: DATABASE_URL sets default_query_exec_mode to simple_protocol/exec, which sends []byte arguments as bytea and breaks json writes; drop it and let the API choose cache_describe")
	}
	o.ExecMode = pgx.QueryExecModeCacheStatement
	if mode == PoolModeTransaction {
		/* cache_describe: pgx learns a statement's parameter and result types once (an unnamed
		 * Parse/Describe), keeps that description on the client, and from then on runs every query
		 * as one unnamed Parse/Bind/Execute round trip. Nothing named lives on the server, so a
		 * pooler that hands the next transaction to another server connection never sees
		 * "prepared statement does not exist", and parameters keep their real types: exec and
		 * simple_protocol guess types from Go values and send a []byte meant for a json column as
		 * bytea, which the store does in hundreds of places (22P02 invalid input syntax for json). */
		o.ExecMode = pgx.QueryExecModeCacheDescribe
	}
	if v := strings.TrimSpace(getenv("DB_QUERY_EXEC_MODE")); v != "" {
		m, err := parseExecMode(v)
		if err != nil {
			return o, err
		}
		o.ExecMode = m
		o.ExecModeFromURL = false
		if m == pgx.QueryExecModeSimpleProtocol || m == pgx.QueryExecModeExec {
			// Measured: 705 of the API's database tests fail with 22P02 under simple_protocol.
			o.Notes = append(o.Notes, "WARNING: DB_QUERY_EXEC_MODE="+v+" sends []byte arguments as bytea and breaks json writes (22P02); use cache_describe")
		}
	}
	if mode == PoolModeTransaction && !o.ExecModeFromURL &&
		(o.ExecMode == pgx.QueryExecModeCacheStatement) {
		return o, errors.New("DB_QUERY_EXEC_MODE=cache_statement keeps named prepared statements, which break behind a transaction pooler; use cache_describe (or describe_exec)")
	}

	defMax := defaultMaxConnsSession
	if mode == PoolModeTransaction {
		defMax = defaultMaxConnsTransaction
	}
	o.MaxConns = int32(posInt(getenv("DB_MAX_CONNS"), defMax)) // #nosec G115 -- operator-set pool size, a small positive int
	o.MinConns = int32(nonNegInt(getenv("DB_MIN_CONNS"), 0))   // #nosec G115 -- operator-set pool size, a small int
	if o.MinConns > o.MaxConns {
		o.MinConns = o.MaxConns
	}
	o.MaxConnIdleTime = posDuration(getenv("DB_MAX_CONN_IDLE_TIME"), defaultMaxConnIdleTime)
	o.MaxConnLifetime = posDuration(getenv("DB_MAX_CONN_LIFETIME"), defaultMaxConnLifetime)
	o.MaxConnLifetimeJitter = defaultMaxConnJitter
	if o.MaxConnLifetimeJitter > o.MaxConnLifetime/2 {
		o.MaxConnLifetimeJitter = o.MaxConnLifetime / 2
	}
	o.HealthCheckPeriod = posDuration(getenv("DB_HEALTH_CHECK_PERIOD"), defaultHealthCheckPeriod)
	o.ConnectTimeout = posDuration(getenv("DB_CONNECT_TIMEOUT"), defaultConnectTimeout)
	o.BudgetInstances = posInt(getenv("DB_BUDGET_MAX_INSTANCES"), defaultBudgetInstances)
	o.SessionPoolSize = posInt(getenv("DB_POOLER_POOL_SIZE"), defaultSessionPoolSize)

	/* Warn at the limit, not only past it: a full pool has no room for `make migrate`, a psql
	 * session or a Supabase dashboard query, and the first of those during a busy deploy is
	 * the one that stops the new revision booting. */
	switch b := o.SessionBudget(); {
	case b.Peak > b.Limit:
		o.Notes = append(o.Notes, "WARNING: "+b.String()+": a deploy under load can fill the session pooler; move DATABASE_URL to the transaction pooler (deploy/SUPABASE.md)")
	case b.Peak == b.Limit:
		o.Notes = append(o.Notes, "WARNING: "+b.String()+": no headroom during a deploy; consider the transaction pooler (deploy/SUPABASE.md)")
	}
	return o, nil
}

// SeparateListen reports whether LISTEN and migrations use a connection string of their own.
func (o DBOptions) SeparateListen() bool { return o.ListenURL != o.URL }

// Budget is the session-pooler arithmetic for one configuration.
type Budget struct {
	PerInstance int // session connections one instance can hold
	Steady      int // with one revision at max-instances
	Peak        int // during a deploy: old and new revision both at max-instances
	Limit       int // the session pooler's client limit
}

func (b Budget) String() string {
	return fmt.Sprintf("session pooler budget: %d per instance, %d steady, %d during a deploy (2 revisions) against a limit of %d",
		b.PerInstance, b.Steady, b.Peak, b.Limit)
}

/* SessionBudget is how many session-pooler clients this configuration can hold.
 *
 * Each instance has one LISTEN connection on the session pooler. In session mode its query pool
 * is there too, up to MaxConns; in transaction mode the pool is on the other port and does not
 * count. During a deploy Cloud Run runs the old and the new revision side by side, so the peak
 * is twice max-instances:
 *
 *   session:      2 × 3 × (4 + 1) = 30  > 15   (the 24 Oct failure; = 30 now, no headroom)
 *   transaction:  2 × 3 × 1       = 6   ≤ 30
 *
 * Idle connections now close after a minute (DB_MAX_CONN_IDLE_TIME), so session mode reaches
 * its peak only when both revisions are busy, but it can. */
func (o DBOptions) SessionBudget() Budget {
	per := 1
	if o.PoolMode == PoolModeSession {
		per += int(o.MaxConns)
	}
	return Budget{
		PerInstance: per,
		Steady:      o.BudgetInstances * per,
		Peak:        2 * o.BudgetInstances * per,
		Limit:       o.SessionPoolSize,
	}
}

func parseExecMode(s string) (pgx.QueryExecMode, error) {
	switch strings.ToLower(s) {
	case "cache_statement":
		return pgx.QueryExecModeCacheStatement, nil
	case "cache_describe":
		return pgx.QueryExecModeCacheDescribe, nil
	case "describe_exec":
		return pgx.QueryExecModeDescribeExec, nil
	case "exec":
		return pgx.QueryExecModeExec, nil
	case "simple_protocol":
		return pgx.QueryExecModeSimpleProtocol, nil
	}
	return 0, fmt.Errorf("DB_QUERY_EXEC_MODE: unknown mode %q (cache_statement, cache_describe, describe_exec, exec, simple_protocol)", s)
}

// urlPort is the port of a postgres:// URL, "" when it has none or is not a URL (a
// key=value DSN, which is left alone).
func urlPort(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Port()
}

func isSupabasePooler(dsn string) bool {
	u, err := url.Parse(dsn)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(u.Hostname()), ".pooler.supabase.com")
}

func withPort(dsn, port string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil || u.Host == "" {
		return "", errors.New("database url: cannot derive a pooler port from a non-URL connection string")
	}
	u.Host = net.JoinHostPort(u.Hostname(), port)
	return u.String(), nil
}

func posInt(v string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
		return n
	}
	return def
}

func nonNegInt(v string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
		return n
	}
	return def
}

func posDuration(v string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(strings.TrimSpace(v)); err == nil && d > 0 {
		return d
	}
	return def
}
