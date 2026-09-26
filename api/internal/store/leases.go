package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"
)

/* TryLease takes the named lease for ttl, or reports that somebody else holds it.
 *
 * ok=false with a nil error is the normal "another runner has it" answer, and the caller
 * skips its work: the holder is doing it. release drops the lease early; a caller that
 * never calls it gets the lease back after ttl, which is how a job is rate-limited to once
 * per ttl (see RunTick's recording retention). See migrations/0051.
 *
 * ttl must be longer than the work it covers. If the work overruns, a second runner can
 * start — the lease is a guard against the ordinary race, not a correctness proof, which
 * is why every send also keeps its own row-level guard.
 */
func (s *Store) TryLease(ctx context.Context, name string, ttl time.Duration) (release func(), ok bool, err error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, false, err
	}
	holder := hex.EncodeToString(b[:])

	tag, err := s.pool.Exec(ctx, `
		INSERT INTO sweep_leases (name, holder, expires_at)
		VALUES ($1, $2, now() + make_interval(secs => $3))
		ON CONFLICT (name) DO UPDATE
		   SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
		 WHERE sweep_leases.expires_at <= now()`,
		name, holder, ttl.Seconds())
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 0 {
		return nil, false, nil
	}

	return func() {
		// Its own context: release runs in a defer, often after the work's context is done.
		rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.pool.Exec(rctx,
			`DELETE FROM sweep_leases WHERE name = $1 AND holder = $2`, name, holder)
	}, true, nil
}
