package observe

/*
Request metrics, shaped to fit Grafana Cloud's free tier (10,000 active series).

Every attribute value on a histogram multiplies its series by the bucket count, and every
Cloud Run instance repeats the lot: service.instance.id is a fresh id per process, and it has
to stay, because cumulative counters from several writers need distinct series. otelhttp's
defaults — three server histograms of 15-16 buckets each by method, status code, scheme,
protocol and route, plus two client histograms by method, status and host — came to ~3,600
series per instance on 2026-10-24 and ~10,700 active across the day's instances.

What is exported instead (docs/observability.md has the numbers and the PromQL):

  - http.server.request.duration, recorded by RouteTag rather than by otelhttp, by http.route
    and http.response.status_code only. The status is a class (2xx, 3xx, 4xx) except for
    5xx, which keeps the exact code, so http_response_status_code=~"5.." and ="503" still
    select what they did. Rarely-used route families fold into one route each (metricRoute).
    Nine bucket boundaries.
  - http.client.request.duration (otelhttp's transport), by server.address only, same buckets.
  - No request or response body-size histograms, server or client.
  - Go runtime: goroutines and memory used and limit; the rest is dropped.

Trace spans are untouched: they keep the method, the exact status and the exact route.
*/

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/felixge/httpsnoop"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/sdk/instrumentation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

// meterScope is this package's instrumentation scope, shared with the audience gauges.
const meterScope = "github.com/netkumar/webcast/api/internal/observe"

const serverDurationName = "http.server.request.duration"

/*
durationBuckets are the bucket boundaries, in seconds, of both request-duration histograms:
ten buckets with +Inf instead of otelhttp's fifteen. Dense where the dashboard reads — p50
well under a second, the 3 s p95 alert between 2.5 and 5 — and 30 s is past the 20-second
request timeout. Event streams last minutes and land in +Inf; every latency panel excludes
them.
*/
var durationBuckets = []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}

// droppedRuntime are the Go runtime instruments nothing reads. go.goroutine.count and
// go.memory.used are on the dashboard (and go.memory.limit, reported only under a GOMEMLIMIT,
// is kept beside them).
var droppedRuntime = []string{
	"go.memory.allocated",
	"go.memory.allocations",
	"go.memory.gc.goal",
	"go.config.gogc",
	"go.processor.limit",
	"go.schedule.duration",
}

/*
meterViews reshapes the instruments this process registers. Each view selects instruments of
one scope by name, and no two overlap: an instrument matched by two views is exported twice.
*/
func meterViews() []sdkmetric.View {
	drop := sdkmetric.Stream{Aggregation: sdkmetric.AggregationDrop{}}
	buckets := sdkmetric.AggregationExplicitBucketHistogram{Boundaries: durationBuckets}
	httpScope := scopeNamed(otelhttp.ScopeName)

	views := []sdkmetric.View{
		// Ours, recorded by RouteTag. The filter is a backstop: RouteTag sets only these two.
		sdkmetric.NewView(
			sdkmetric.Instrument{Name: serverDurationName, Scope: scopeNamed(meterScope)},
			sdkmetric.Stream{
				Aggregation:     buckets,
				AttributeFilter: attribute.NewAllowKeysFilter(semconv.HTTPRouteKey, semconv.HTTPResponseStatusCodeKey),
			}),
		/* otelhttp's own server metrics. HTTPHandler hands otelhttp a no-op meter, so these
		 * should never exist; they are dropped here as well because a second
		 * http.server.request.duration would land on the same Prometheus series as ours. */
		sdkmetric.NewView(sdkmetric.Instrument{Name: "http.server.*", Scope: httpScope}, drop),
		// Outbound calls: one duration histogram per host.
		sdkmetric.NewView(
			sdkmetric.Instrument{Name: "http.client.request.duration", Scope: httpScope},
			sdkmetric.Stream{
				Aggregation:     buckets,
				AttributeFilter: attribute.NewAllowKeysFilter(semconv.ServerAddressKey),
			}),
		sdkmetric.NewView(sdkmetric.Instrument{Name: "http.client.*.body.size", Scope: httpScope}, drop),
	}
	for _, name := range droppedRuntime {
		views = append(views, sdkmetric.NewView(
			sdkmetric.Instrument{Name: name, Scope: scopeNamed(runtime.ScopeName)}, drop))
	}
	return views
}

func scopeNamed(name string) instrumentation.Scope { return instrumentation.Scope{Name: name} }

/*
statusLabel is the value of http.response.status_code on the request histogram: the class
for anything below 500, the exact code for a server error. Server errors are rare, so their
codes cost almost nothing, and the alert can tell a full room's 503 from a 500. A handler
that never wrote anything answered 200.
*/
func statusLabel(code int) string {
	switch {
	case code >= 500:
		return strconv.Itoa(code)
	case code >= 100:
		return strconv.Itoa(code/100) + "xx"
	default:
		return "2xx"
	}
}

/*
routeFamilies fold rarely-called route families into one http.route each. Every route an
instance has served stays in its cumulative export for as long as the instance lives, so a
long tail of admin, CRM and auth pages called a few times a day costs as many series as the
hot paths. These are the families of 2026-10-24's tail (110 of 146 routes under 30 calls a
day). A folded route keeps its family's prefix, and no event-stream or join route and not
/api/internal/tick is folded, so every route filter the dashboard and alerts use selects the
same requests before and after.

The first matching prefix wins; keep lists routes of a family that stay on their own.
*/
var routeFamilies = []struct {
	prefix string
	keep   []string
}{
	{prefix: "/api/admin/", keep: []string{"/api/admin/sales/{id}/join"}},
	{prefix: "/api/auth/", keep: []string{"/api/auth/me"}},
	{prefix: "/api/billing/"},
	{prefix: "/api/me/", keep: []string{"/api/me/registrations"}},
	{prefix: "/api/host/crm/", keep: []string{"/api/host/crm/replies"}},
	{prefix: "/api/host/webinars/{slug}/recordings"},
	{prefix: "/api/host/webinars/{slug}/polls"},
	{prefix: "/api/host/webinars/{slug}/engagement"},
	{prefix: "/api/host/webinars/{slug}/survey"},
	{prefix: "/api/internal/clip-jobs/"},
	{prefix: "/api/internal/mix-recordings/"},
}

// metricRoute is the http.route the request histogram records for a chi route pattern.
func metricRoute(route string) string {
	for _, f := range routeFamilies {
		if !strings.HasPrefix(route, f.prefix) {
			continue
		}
		for _, k := range f.keep {
			if route == k {
				return route
			}
		}
		return strings.TrimSuffix(f.prefix, "/") + "/*"
	}
	return route
}

// serverDuration is the request histogram on mp; a no-op if it cannot be created.
func serverDuration(mp metric.MeterProvider) metric.Float64Histogram {
	h, err := mp.Meter(meterScope).Float64Histogram(serverDurationName,
		metric.WithUnit("s"),
		metric.WithDescription("Duration of HTTP server requests."),
		metric.WithExplicitBucketBoundaries(durationBuckets...))
	if err != nil {
		otel.Handle(err)
	}
	return h
}

/*
statusWriter wraps w to remember the response's status, which reads 0 until something is
written. httpsnoop, as otelhttp uses, so that every optional interface of the underlying
writer (Flusher for the event streams, Hijacker, ReaderFrom) survives the wrapping.
*/
func statusWriter(w http.ResponseWriter) (http.ResponseWriter, *int) {
	status := new(int)
	wrote := func() {
		if *status == 0 {
			*status = http.StatusOK
		}
	}
	return httpsnoop.Wrap(w, httpsnoop.Hooks{
		WriteHeader: func(f httpsnoop.WriteHeaderFunc) httpsnoop.WriteHeaderFunc {
			return func(code int) {
				// 1xx are informational; the response's status is the final one.
				if *status == 0 && code >= 200 {
					*status = code
				}
				f(code)
			}
		},
		Write: func(f httpsnoop.WriteFunc) httpsnoop.WriteFunc {
			return func(b []byte) (int, error) { wrote(); return f(b) }
		},
		ReadFrom: func(f httpsnoop.ReadFromFunc) httpsnoop.ReadFromFunc {
			return func(src io.Reader) (int64, error) { wrote(); return f(src) }
		},
		// A flush before any write sends the headers, and with them 200.
		Flush: func(f httpsnoop.FlushFunc) httpsnoop.FlushFunc {
			return func() { wrote(); f() }
		},
	}), status
}
