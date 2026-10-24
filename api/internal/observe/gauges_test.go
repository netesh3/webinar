package observe

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

type fakeAudience struct {
	streams int
	a       Audience
	err     error
	reads   int
}

func (f *fakeAudience) EdgeStreams() int { return f.streams }
func (f *fakeAudience) Audience(context.Context) (Audience, error) {
	f.reads++
	return f.a, f.err
}

// point is one observed value, keyed by metric name and the attributes rendered as a string.
type point struct {
	name, attrs string
}

func collect(t *testing.T, r *sdkmetric.ManualReader) map[point]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[point]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			g, ok := m.Data.(metricdata.Gauge[int64])
			if !ok {
				t.Fatalf("%s is %T, want an int64 gauge", m.Name, m.Data)
			}
			for _, dp := range g.DataPoints {
				out[point{m.Name, dp.Attributes.Encoded(attribute.DefaultEncoder())}] = dp.Value
			}
		}
	}
	return out
}

func TestAudienceGaugesObserveTheSource(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })

	src := &fakeAudience{streams: 7, a: Audience{
		LiveSessions:       map[string]int{KindWebinar: 3, KindMeeting: 2},
		EdgeViewers:        41,
		WebRTCParticipants: 12,
	}}
	clock := time.Unix(1_000_000, 0)
	if err := registerAudienceGauges(mp, src, func() time.Time { return clock }); err != nil {
		t.Fatal(err)
	}

	want := map[point]int64{
		{MetricEdgeViewers, ""}:                             7,
		{MetricEdgeViewersCluster, "scope=cluster"}:         41,
		{MetricWebRTCParticipants, "scope=cluster"}:         12,
		{MetricLiveSessions, "kind=webinar,scope=cluster"}:  3,
		{MetricLiveSessions, "kind=meeting,scope=cluster"}:  2,
		{MetricLiveSessions, "kind=simulive,scope=cluster"}: 0, // a series at zero, not a gap
	}
	got := collect(t, reader)
	if len(got) != len(want) {
		t.Fatalf("got %d points %v, want %d", len(got), got, len(want))
	}
	for p, v := range want {
		if g, ok := got[p]; !ok || g != v {
			t.Errorf("%s{%s} = %d (present %v), want %d", p.name, p.attrs, g, ok, v)
		}
	}

	// Within the TTL the database is not read again; the per-instance count always is live.
	src.streams = 9
	src.a.EdgeViewers = 50
	got = collect(t, reader)
	if src.reads != 1 {
		t.Fatalf("database read %d times within the TTL, want 1", src.reads)
	}
	if got[point{MetricEdgeViewers, ""}] != 9 || got[point{MetricEdgeViewersCluster, "scope=cluster"}] != 41 {
		t.Fatalf("within the TTL: %v", got)
	}

	// Past it, a fresh read.
	clock = clock.Add(snapshotTTL)
	got = collect(t, reader)
	if src.reads != 2 || got[point{MetricEdgeViewersCluster, "scope=cluster"}] != 50 {
		t.Fatalf("after the TTL: reads %d, %v", src.reads, got)
	}

	// A failed read drops the cluster series rather than reporting zero.
	clock = clock.Add(snapshotTTL)
	src.err = errors.New("db down")
	got = collect(t, reader)
	if len(got) != 1 || got[point{MetricEdgeViewers, ""}] != 9 {
		t.Fatalf("after a failed read: %v, want only the per-instance gauge", got)
	}
}

func TestMeterProviderIsNoopWhenOff(t *testing.T) {
	src := &fakeAudience{}
	if err := RegisterAudienceGauges((&Telemetry{}).MeterProvider(), src); err != nil {
		t.Fatal(err)
	}
	if src.reads != 0 {
		t.Fatal("a disabled telemetry read the database")
	}
}
