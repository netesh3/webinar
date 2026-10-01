package store

import (
	"context"

	"golang.org/x/sync/errgroup"
)

/* parallelLimit stays under DB_MAX_CONNS (4). One of these reads can use three
 * connections at once and still leave a connection for the session check or
 * another request on the same instance. A fourth query waits; none of them
 * holds a connection while it waits, so a full pool queues instead of
 * deadlocking. */
const parallelLimit = 3

/* RunParallel runs independent reads together.
 *
 * The context each function receives is cancelled when any of them fails, so
 * the others stop and give their connections back. The caller's context is
 * left alone. Every function is waited on before RunParallel returns, which
 * is what makes it safe to publish into the caller's variables from inside. */
func RunParallel(ctx context.Context, fns ...func(context.Context) error) error {
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(parallelLimit)
	for _, fn := range fns {
		g.Go(func() error { return fn(ctx) })
	}
	return g.Wait()
}
