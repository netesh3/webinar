package store

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// sleeper waits d or until ctx ends; swapped for a fake clock in tests.
type sleeper func(ctx context.Context, d time.Duration) error

func realSleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Backoff between connection attempts: 500 ms doubling to 5 s, each with ±20% jitter so the
// instances of a deploy do not knock on the pooler in step.
const (
	connectBackoffStart = 500 * time.Millisecond
	connectBackoffMax   = 5 * time.Second
)

/* retryConnect calls attempt until it succeeds, it fails in a way waiting cannot fix, or budget
 * runs out (counted on the sleeps, so a fake clock can drive it).
 *
 * Retried: everything that might clear — a full pooler, a refused or reset connection, a
 * database restarting. Not retried: a wrong password or a database that does not exist, where
 * ninety seconds of waiting only delays the error the operator needs to see. */
func retryConnect(ctx context.Context, log *slog.Logger, budget time.Duration, sleep sleeper, attempt func(context.Context) error) error {
	var waited time.Duration
	backoff := connectBackoffStart
	for n := 1; ; n++ {
		err := attempt(ctx)
		if err == nil {
			if n > 1 {
				log.Info("database connected", "attempts", n, "waited", waited.String())
			}
			return nil
		}
		if ctx.Err() != nil {
			return err
		}
		if permanentConnectError(err) {
			return err
		}
		if waited >= budget {
			log.Error("database still unreachable, giving up", "attempts", n, "waited", waited.String(), "error", err)
			return err
		}
		d := backoff + time.Duration((rand.Float64()*0.4-0.2)*float64(backoff)) // #nosec G404 -- jitter, not security
		if rest := budget - waited; d > rest {
			d = rest
		}
		if poolerFull(err) {
			log.Warn("database pooler full, retrying", "attempt", n, "retry_in", d.String(), "error", err)
		} else {
			log.Warn("database connection failed, retrying", "attempt", n, "retry_in", d.String(), "error", err)
		}
		if serr := sleep(ctx, d); serr != nil {
			return err
		}
		waited += d
		backoff = min(backoff*2, connectBackoffMax)
	}
}

// poolerFull reports a pooler or server that refused us for lack of slots: Supavisor's
// EMAXCONNSESSION / EMAXCONN, PgBouncer's "no more connections allowed", or Postgres's own
// too_many_connections (53300).
func poolerFull(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "53300" {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "emaxconn") ||
		strings.Contains(msg, "max clients reached") ||
		strings.Contains(msg, "no more connections allowed") ||
		strings.Contains(msg, "too many clients") ||
		strings.Contains(msg, "remaining connection slots are reserved")
}

// permanentConnectError reports errors no amount of waiting fixes: bad credentials
// (28P01, 28000) and a missing database (3D000).
func permanentConnectError(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.Code {
	case "28P01", "28000", "3D000":
		return true
	}
	return false
}
