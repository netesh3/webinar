package store

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The two-URL wiring against a real database: queries in the transaction-pooler exec mode,
 * migrations and LISTEN on the session URL (told apart here by application_name). */
func TestSeparateListenURLCarriesMigrationsAndListen(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	o, err := DBOptionsFromEnv(dsn, envMap(map[string]string{
		"DATABASE_POOL_MODE":  "transaction",
		"DATABASE_LISTEN_URL": dsn + "&application_name=webcast_listen",
	}))
	if err != nil {
		t.Fatal(err)
	}
	s, err := OpenWith(ctx, o, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := s.pool.Config().ConnConfig.DefaultQueryExecMode; got != pgx.QueryExecModeCacheDescribe {
		t.Fatalf("query pool exec mode = %v", got)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	conn, err := s.ListenConn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var app string
	if err := conn.QueryRow(ctx, `SELECT current_setting('application_name')`).Scan(&app); err != nil {
		t.Fatal(err)
	}
	if app != "webcast_listen" {
		t.Fatalf("listen conn application_name = %q, want the session URL's", app)
	}
	if _, err := conn.Exec(ctx, `LISTEN webcast_dbconn_test`); err != nil {
		t.Fatal(err)
	}
	if err := s.PGNotify(ctx, "webcast_dbconn_test", "hello"); err != nil {
		t.Fatal(err)
	}
	n, err := conn.WaitForNotification(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n.Payload != "hello" {
		t.Fatalf("payload = %q", n.Payload)
	}
}
