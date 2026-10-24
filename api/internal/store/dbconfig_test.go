package store

import (
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The database options decide whether a deploy can boot (24 Oct 2026), so the defaults, the
 * derivations and the refusals are pinned here. No database needed. */

const (
	sessionURL = "postgres://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require"
	txURL      = "postgres://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func mustOpts(t *testing.T, dsn string, env map[string]string) DBOptions {
	t.Helper()
	o, err := DBOptionsFromEnv(dsn, envMap(env))
	if err != nil {
		t.Fatalf("DBOptionsFromEnv: %v", err)
	}
	return o
}

func TestDBOptionsUnchangedConfigKeepsOneSessionURL(t *testing.T) {
	o := mustOpts(t, sessionURL, nil)
	if o.PoolMode != PoolModeSession || o.URL != sessionURL || o.ListenURL != sessionURL || o.SeparateListen() {
		t.Fatalf("got mode=%s url=%s listen=%s", o.PoolMode, o.URL, o.ListenURL)
	}
	if o.ExecMode != pgx.QueryExecModeCacheStatement {
		t.Errorf("session mode exec = %v, want cache_statement (unchanged)", o.ExecMode)
	}
	if o.MaxConns != 4 || o.MinConns != 0 {
		t.Errorf("conns = %d/%d, want 4/0", o.MaxConns, o.MinConns)
	}
	if o.MaxConnIdleTime != time.Minute || o.MaxConnLifetime != 30*time.Minute || o.MaxConnLifetimeJitter <= 0 {
		t.Errorf("idle=%v life=%v jitter=%v", o.MaxConnIdleTime, o.MaxConnLifetime, o.MaxConnLifetimeJitter)
	}
	if o.HealthCheckPeriod != 15*time.Second || o.ConnectTimeout != 90*time.Second {
		t.Errorf("health=%v connect=%v", o.HealthCheckPeriod, o.ConnectTimeout)
	}
	// 2 × 3 × (4+1) = 30: exactly the default (raised) pool_size of 30, no headroom.
	b := o.SessionBudget()
	if b.PerInstance != 5 || b.Steady != 15 || b.Peak != 30 || b.Limit != 30 {
		t.Errorf("budget = %+v", b)
	}
	if !hasNote(o, "no headroom") {
		t.Errorf("no headroom warning in %q", o.Notes)
	}
	// Against the 15 of 24 Oct, the configuration that failed must say so at boot.
	o = mustOpts(t, sessionURL, map[string]string{"DB_POOLER_POOL_SIZE": "15"})
	if !hasNote(o, "can fill the session pooler") {
		t.Errorf("no budget warning in %q", o.Notes)
	}
}

func TestDBOptionsTransactionURLDerivesSessionListen(t *testing.T) {
	o := mustOpts(t, txURL, nil)
	if o.PoolMode != PoolModeTransaction {
		t.Fatalf("mode = %s, want inferred transaction from :6543", o.PoolMode)
	}
	if o.URL != txURL || o.ListenURL != sessionURL {
		t.Fatalf("url=%s listen=%s", o.URL, o.ListenURL)
	}
	if o.ExecMode != pgx.QueryExecModeCacheDescribe {
		t.Errorf("exec = %v, want cache_describe", o.ExecMode)
	}
	if o.MaxConns != 6 {
		t.Errorf("max = %d, want 6", o.MaxConns)
	}
	b := o.SessionBudget()
	if b.PerInstance != 1 || b.Peak != 6 {
		t.Errorf("budget = %+v, want 1 per instance and 6 at peak", b)
	}
	if hasNote(o, "WARNING") {
		t.Errorf("unexpected warning: %q", o.Notes)
	}
}

func TestDBOptionsModeSwitchOnSessionURLMovesQueriesTo6543(t *testing.T) {
	o := mustOpts(t, sessionURL, map[string]string{"DATABASE_POOL_MODE": "transaction"})
	if o.URL != txURL || o.ListenURL != sessionURL {
		t.Fatalf("url=%s listen=%s", o.URL, o.ListenURL)
	}
}

func TestDBOptionsExplicitListenURLWins(t *testing.T) {
	direct := "postgres://postgres:pw@db.abc.supabase.co:5432/postgres?sslmode=require"
	o := mustOpts(t, txURL, map[string]string{"DATABASE_LISTEN_URL": direct})
	if o.URL != txURL || o.ListenURL != direct {
		t.Fatalf("url=%s listen=%s", o.URL, o.ListenURL)
	}
}

func TestDBOptionsTransactionModeElsewhereDoesNotGuessPorts(t *testing.T) {
	local := "postgres://webcast:webcast@localhost:5432/webcast?sslmode=disable"
	o := mustOpts(t, local, map[string]string{"DATABASE_POOL_MODE": "transaction"})
	if o.URL != local || o.ListenURL != local {
		t.Fatalf("url=%s listen=%s, want both unchanged", o.URL, o.ListenURL)
	}
	if o.ExecMode != pgx.QueryExecModeCacheDescribe {
		t.Errorf("exec = %v", o.ExecMode)
	}
	if !hasNote(o, "LISTEN will not receive") {
		t.Errorf("want a LISTEN warning, got %q", o.Notes)
	}
}

func TestDBOptionsExecMode(t *testing.T) {
	o := mustOpts(t, txURL, map[string]string{"DB_QUERY_EXEC_MODE": "simple_protocol"})
	if o.ExecMode != pgx.QueryExecModeSimpleProtocol || o.ExecModeFromURL {
		t.Errorf("exec = %v fromURL=%v", o.ExecMode, o.ExecModeFromURL)
	}
	if !hasNote(o, "breaks json writes") {
		t.Errorf("simple_protocol should warn, got %q", o.Notes)
	}
	o = mustOpts(t, txURL+"&default_query_exec_mode=simple_protocol", nil)
	if !o.ExecModeFromURL {
		t.Error("exec mode in the URL should be left to the URL")
	}
	if _, err := DBOptionsFromEnv(txURL, envMap(map[string]string{"DB_QUERY_EXEC_MODE": "cache_statement"})); err == nil {
		t.Error("cache_statement behind a transaction pooler must be refused")
	}
	if _, err := DBOptionsFromEnv(txURL, envMap(map[string]string{"DB_QUERY_EXEC_MODE": "bogus"})); err == nil {
		t.Error("unknown exec mode must be refused")
	}
}

func TestDBOptionsRefusals(t *testing.T) {
	if _, err := DBOptionsFromEnv("", envMap(nil)); err == nil {
		t.Error("empty url accepted")
	}
	if _, err := DBOptionsFromEnv(sessionURL, envMap(map[string]string{"DATABASE_POOL_MODE": "statement"})); err == nil {
		t.Error("unknown pool mode accepted")
	}
}

func TestDBOptionsOverrides(t *testing.T) {
	o := mustOpts(t, sessionURL, map[string]string{
		"DB_MAX_CONNS":            "2",
		"DB_MIN_CONNS":            "5", // clamped to max
		"DB_MAX_CONN_IDLE_TIME":   "30s",
		"DB_MAX_CONN_LIFETIME":    "4m",
		"DB_HEALTH_CHECK_PERIOD":  "5s",
		"DB_CONNECT_TIMEOUT":      "1m",
		"DB_BUDGET_MAX_INSTANCES": "1",
		"DB_POOLER_POOL_SIZE":     "40",
	})
	if o.MaxConns != 2 || o.MinConns != 2 {
		t.Errorf("conns = %d/%d", o.MaxConns, o.MinConns)
	}
	if o.MaxConnIdleTime != 30*time.Second || o.MaxConnLifetime != 4*time.Minute || o.MaxConnLifetimeJitter != 2*time.Minute {
		t.Errorf("idle=%v life=%v jitter=%v", o.MaxConnIdleTime, o.MaxConnLifetime, o.MaxConnLifetimeJitter)
	}
	if o.HealthCheckPeriod != 5*time.Second || o.ConnectTimeout != time.Minute {
		t.Errorf("health=%v connect=%v", o.HealthCheckPeriod, o.ConnectTimeout)
	}
	if b := o.SessionBudget(); b.Peak != 6 || hasNote(o, "WARNING") {
		t.Errorf("budget = %+v notes=%q", b, o.Notes)
	}
	// Garbage falls back to defaults rather than to zero.
	o = mustOpts(t, sessionURL, map[string]string{"DB_MAX_CONNS": "0", "DB_MAX_CONN_IDLE_TIME": "soon"})
	if o.MaxConns != 4 || o.MaxConnIdleTime != time.Minute {
		t.Errorf("fallbacks: max=%d idle=%v", o.MaxConns, o.MaxConnIdleTime)
	}
}

func hasNote(o DBOptions, sub string) bool {
	for _, n := range o.Notes {
		if strings.Contains(n, sub) {
			return true
		}
	}
	return false
}
