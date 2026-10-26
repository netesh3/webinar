package observe

import (
	"context"
	"errors"
	"testing"
	"time"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
)

func TestDBSizeGaugeReadsAndCaches(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })

	size, reads := int64(37<<20), 0
	clock := time.Unix(1_000_000, 0)
	read := func(context.Context) (int64, error) { reads++; return size, nil }
	if err := registerDBSizeGauge(mp, read, func() time.Time { return clock }); err != nil {
		t.Fatal(err)
	}

	got := collect(t, reader)
	if v := got[point{MetricDBSize, "scope=cluster"}]; v != 37<<20 || len(got) != 1 {
		t.Fatalf("got %v, want one scope=cluster point of %d", got, int64(37<<20))
	}

	// Inside the TTL a second collection does not ask the database again.
	size = 40 << 20
	clock = clock.Add(time.Minute)
	if v := collect(t, reader)[point{MetricDBSize, "scope=cluster"}]; v != 37<<20 || reads != 1 {
		t.Fatalf("within TTL: value %d after %d reads, want the cached value from 1 read", v, reads)
	}

	// After it, the new size.
	clock = clock.Add(dbSizeTTL)
	if v := collect(t, reader)[point{MetricDBSize, "scope=cluster"}]; v != 40<<20 || reads != 2 {
		t.Fatalf("after TTL: value %d after %d reads, want 40 MiB from 2 reads", v, reads)
	}
}

func TestDBSizeGaugeReportsNothingOnAFailedRead(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })

	read := func(context.Context) (int64, error) { return 0, errors.New("db down") }
	if err := registerDBSizeGauge(mp, read, time.Now); err != nil {
		t.Fatal(err)
	}
	if got := collect(t, reader); len(got) != 0 {
		t.Fatalf("a failed read must report no point (a zero would look like an empty database), got %v", got)
	}
}
