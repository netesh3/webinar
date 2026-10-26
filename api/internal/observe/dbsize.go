package observe

/*
Database size gauge: how close Postgres is to its plan's cap, for a Grafana alert.

Supabase's Free plan (since 2026-10-26) caps the database at 500 MB, and past that the
project goes read-only: sign-ups, registrations, joins and chat would all stop writing. The
alert fires at 300 MB (docs/observability.md), long before that.

Cluster-wide like the live-session counts (gauges.go): every instance reads the same number,
so it carries scope="cluster" and the dashboard takes max(). pg_database_size walks the data
directory, which is cheap at our size but not free, so one read serves dbSizeTTL and a
failed read reports nothing rather than a zero that would look like an empty database.
*/

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/otel/metric"
)

// MetricDBSize is the database's size in bytes. Prometheus names it webinarliv_db_size_bytes.
const MetricDBSize = "webinarliv.db_size"

// dbSizeTTL is how long one size read serves the gauge: the size moves by kilobytes a minute.
const dbSizeTTL = 5 * time.Minute

// DBSizeFunc reads the database's size in bytes (store.DatabaseSize).
type DBSizeFunc func(ctx context.Context) (int64, error)

type dbSizeCache struct {
	read DBSizeFunc
	ttl  time.Duration
	now  func() time.Time

	mu   sync.Mutex
	at   time.Time
	last int64
	ok   bool
}

func (c *dbSizeCache) get(ctx context.Context) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if !c.at.IsZero() && now.Sub(c.at) < c.ttl {
		return c.last, c.ok
	}
	ctx, cancel := context.WithTimeout(ctx, snapshotTimeout)
	defer cancel()
	n, err := c.read(ctx)
	c.at, c.last, c.ok = now, n, err == nil
	return c.last, c.ok
}

// RegisterDBSizeGauge registers webinarliv.db_size on mp, read through read. With telemetry
// off mp is the no-op provider and the database is never asked.
func RegisterDBSizeGauge(mp metric.MeterProvider, read DBSizeFunc) error {
	return registerDBSizeGauge(mp, read, time.Now)
}

func registerDBSizeGauge(mp metric.MeterProvider, read DBSizeFunc, now func() time.Time) error {
	m := mp.Meter(meterScope)
	g, err := m.Int64ObservableGauge(MetricDBSize,
		metric.WithDescription("Postgres database size (scope=cluster). Max across instances, do not sum."),
		metric.WithUnit("By"))
	if err != nil {
		return err
	}
	cache := &dbSizeCache{read: read, ttl: dbSizeTTL, now: now}
	_, err = m.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		if n, ok := cache.get(ctx); ok {
			o.ObserveInt64(g, n, scopeCluOpt)
		}
		return nil
	}, g)
	return err
}
