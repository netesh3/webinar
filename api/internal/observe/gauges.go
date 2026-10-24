package observe

/*
Audience gauges: how many people are watching right now, for the Grafana dashboard.

Two kinds of number, and they add up across Cloud Run's instances differently:

  - Per instance. webinarliv.edge_viewers is the edge (LL-HLS) event streams THIS process
    holds open. Each viewer's stream lives on exactly one instance, so the dashboard sums
    the series: sum(webinarliv_edge_viewers).

  - Cluster-wide, read from Postgres. Every instance reads the same rows and reports the
    same value, so summing them would count the room once per instance. These carry
    scope="cluster" and the dashboard takes max() across instances instead:
    max by (kind) (webinarliv_live_sessions). There is no leader election to pick one
    exporter, and max() survives any instance being scaled away, so every instance exports.

No attribute names a webinar or a person: one series per kind per instance, whatever is live.

The database read is cached for snapshotTTL, so one snapshot serves every gauge of one
collection and a second reader (or a ForceFlush on shutdown) does not query again.

With telemetry off the meter provider is the no-op one, the callback is never called, and
nothing here touches the database.
*/

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
)

// MeterProvider is the provider this package's own instruments register on: the SDK's when
// telemetry is on, a no-op otherwise.
func (t *Telemetry) MeterProvider() metric.MeterProvider {
	if t == nil || t.mp == nil {
		return noop.NewMeterProvider()
	}
	return t.mp
}

// Session kinds, the values of the kind attribute on webinarliv.live_sessions.
const (
	KindWebinar  = "webinar"
	KindMeeting  = "meeting"
	KindSimulive = "simulive"
)

// sessionKinds is every kind, so each has a series (at zero when nothing of it is live)
// rather than a gap the dashboard draws as "no data".
var sessionKinds = []string{KindWebinar, KindMeeting, KindSimulive}

// Audience is the cluster-wide snapshot, read from the database.
type Audience struct {
	// LiveSessions by kind (KindWebinar, KindMeeting, KindSimulive).
	LiveSessions map[string]int
	// EdgeViewers is attendees on edge delivery whose browser beat recently: the number the
	// host's room badge shows, summed over every live webinar.
	EdgeViewers int
	// WebRTCParticipants is people in LiveKit rooms of live sessions, from the visits the
	// participant_joined/left webhooks keep.
	WebRTCParticipants int
}

// AudienceSource is what the gauges read. The API server implements it.
type AudienceSource interface {
	// EdgeStreams is how many edge event streams this process holds open.
	EdgeStreams() int
	// Audience reads the cluster-wide snapshot.
	Audience(ctx context.Context) (Audience, error)
}

// snapshotTTL is how long one database read serves the gauges. The export interval is
// fifteen seconds, so this is about one query per instance per export.
const snapshotTTL = 15 * time.Second

// snapshotTimeout bounds the read, so a slow database cannot hold up an export.
const snapshotTimeout = 3 * time.Second

// Metric names. Prometheus (Grafana Cloud's OTLP ingest) turns the dots into underscores.
const (
	MetricEdgeViewers        = "webinarliv.edge_viewers"
	MetricEdgeViewersCluster = "webinarliv.edge_viewers_cluster"
	MetricLiveSessions       = "webinarliv.live_sessions"
	MetricWebRTCParticipants = "webinarliv.webrtc_participants"
)

var (
	scopeCluster = attribute.String("scope", "cluster")
	scopeCluOpt  = metric.WithAttributes(scopeCluster)
)

type audienceCache struct {
	src AudienceSource
	ttl time.Duration
	now func() time.Time

	mu   sync.Mutex
	at   time.Time
	last Audience
	ok   bool
}

/* get returns the cached snapshot, reading a fresh one when it is older than ttl. A failed
 * read keeps reporting nothing for the cluster gauges (ok false) rather than a stale or zero
 * value that would look like everybody left. */
func (c *audienceCache) get(ctx context.Context) (Audience, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if !c.at.IsZero() && now.Sub(c.at) < c.ttl {
		return c.last, c.ok
	}
	ctx, cancel := context.WithTimeout(ctx, snapshotTimeout)
	defer cancel()
	a, err := c.src.Audience(ctx)
	c.at, c.last, c.ok = now, a, err == nil
	return c.last, c.ok
}

/*
RegisterAudienceGauges registers the audience gauges on mp, reading src at collection time.
Pass Telemetry.MeterProvider(); with telemetry off it is a no-op provider and this costs
nothing.
*/
func RegisterAudienceGauges(mp metric.MeterProvider, src AudienceSource) error {
	return registerAudienceGauges(mp, src, time.Now)
}

func registerAudienceGauges(mp metric.MeterProvider, src AudienceSource, now func() time.Time) error {
	m := mp.Meter(meterScope)

	edge, err := m.Int64ObservableGauge(MetricEdgeViewers,
		metric.WithDescription("Edge (LL-HLS) viewers with an event stream open on this instance. Sum across instances."),
		metric.WithUnit("{viewer}"))
	if err != nil {
		return err
	}
	edgeCluster, err := m.Int64ObservableGauge(MetricEdgeViewersCluster,
		metric.WithDescription("Edge (LL-HLS) viewers watching now, across every instance (scope=cluster). Max across instances, do not sum."),
		metric.WithUnit("{viewer}"))
	if err != nil {
		return err
	}
	sessions, err := m.Int64ObservableGauge(MetricLiveSessions,
		metric.WithDescription("Sessions live now by kind, across every instance (scope=cluster). Max by kind across instances, do not sum."),
		metric.WithUnit("{session}"))
	if err != nil {
		return err
	}
	webrtc, err := m.Int64ObservableGauge(MetricWebRTCParticipants,
		metric.WithDescription("People in the video server's rooms of live sessions, across every instance (scope=cluster). Max across instances, do not sum."),
		metric.WithUnit("{participant}"))
	if err != nil {
		return err
	}

	kindOpts := make(map[string]metric.ObserveOption, len(sessionKinds))
	for _, k := range sessionKinds {
		kindOpts[k] = metric.WithAttributes(scopeCluster, attribute.String("kind", k))
	}

	cache := &audienceCache{src: src, ttl: snapshotTTL, now: now}
	_, err = m.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		o.ObserveInt64(edge, int64(src.EdgeStreams()))
		a, ok := cache.get(ctx)
		if !ok {
			return nil
		}
		o.ObserveInt64(edgeCluster, int64(a.EdgeViewers), scopeCluOpt)
		o.ObserveInt64(webrtc, int64(a.WebRTCParticipants), scopeCluOpt)
		for _, k := range sessionKinds {
			o.ObserveInt64(sessions, int64(a.LiveSessions[k]), kindOpts[k])
		}
		return nil
	}, edge, edgeCluster, sessions, webrtc)
	return err
}
