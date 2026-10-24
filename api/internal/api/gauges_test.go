package api_test

/* The audience gauges against a real database: an edge viewer with an open event stream is
 * counted on this instance and in the cluster count, a webhook-owned visit is a WebRTC
 * participant, and the live webinar shows under kind=webinar.
 *
 * Set TEST_DATABASE_URL to run; skipped otherwise, like every test in this package. */

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func gaugeValues(t *testing.T, r *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := r.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			g, ok := m.Data.(metricdata.Gauge[int64])
			if !ok {
				continue
			}
			for _, dp := range g.DataPoints {
				out[m.Name+"{"+dp.Attributes.Encoded(attribute.DefaultEncoder())+"}"] = dp.Value
			}
		}
	}
	return out
}

func TestAudienceGauges(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "gauges-host@test.dev")
	wb := edgeWebinar(h, "Gauges")
	alice := h.registerAsGuest(wb.ID, "gauges-alice@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	events, _, cancel := h.openEvents(wb.ID, aj.EventsToken)
	defer cancel()
	waitFor(t, events, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })

	// The host on the video server, as participant_joined records them (seen_at NULL), and
	// the recorder, which is not a person and must not count.
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO attendance_visits (webinar_id, identity, joined_at)
		SELECT id, i, now() FROM webinars, unnest(ARRAY['user_gauges-host', 'MIXREC_x']) i
		 WHERE slug = $1`, wb.ID); err != nil {
		t.Fatal(err)
	}

	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	defer func() { _ = mp.Shutdown(context.Background()) }()
	if err := h.server.RegisterGauges(mp); err != nil {
		t.Fatal(err)
	}

	got := gaugeValues(t, reader)
	want := map[string]int64{
		"webinarliv.edge_viewers{}":                             1,
		"webinarliv.edge_viewers_cluster{scope=cluster}":        1,
		"webinarliv.webrtc_participants{scope=cluster}":         1,
		"webinarliv.live_sessions{kind=webinar,scope=cluster}":  1,
		"webinarliv.live_sessions{kind=meeting,scope=cluster}":  0,
		"webinarliv.live_sessions{kind=simulive,scope=cluster}": 0,
	}
	for k, v := range want {
		if g, ok := got[k]; !ok || g != v {
			t.Errorf("%s = %d (present %v), want %d; all: %v", k, g, ok, v, got)
		}
	}
}
