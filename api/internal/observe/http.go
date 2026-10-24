package observe

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
	"go.opentelemetry.io/otel/trace"
)

/*
HTTPHandler wraps the whole API in a server span. It returns h itself when telemetry is off.

otelhttp records no metrics here — it is given a no-op meter. Its server histograms carry
attributes this service cannot afford (see metrics.go); RouteTag records the request
histogram instead.

The span starts named by the method alone, because the route is not known until chi has
routed the request; RouteTag, inside the router, renames it once it is.
*/
func HTTPHandler(h http.Handler) http.Handler {
	if !Enabled() {
		return h
	}
	return otelhttp.NewHandler(h, "http.server",
		otelhttp.WithMeterProvider(noop.NewMeterProvider()),
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method }))
}

/*
RouteTag is chi middleware that, after the request has been handled, names the server span
"METHOD /route/{pattern}", adds http.route to it, and records http.server.request.duration
by route and status (see metrics.go for the shape).

The pattern rather than the path: /api/webinars/{slug} is one series, where the raw path is a
series per webinar — and a path can carry an invitation token. A request that matched no route
gets no http.route at all, rather than its path.

It has to be inside the router: chi sets the pattern on its own copy of the request, which
otelhttp, outside, never sees. The route context it reads is shared, so it is complete once
the handler returns. It must be the first middleware so that it sees every request, and the
status the recoverer and timeout middleware write.
*/
func RouteTag(next http.Handler) http.Handler {
	if !Enabled() {
		return next
	}
	return routeTag(next, serverDuration(otel.GetMeterProvider()))
}

func routeTag(next http.Handler, duration metric.Float64Histogram) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww, status := statusWriter(w)
		next.ServeHTTP(ww, r)
		elapsed := time.Since(start).Seconds()

		attrs := make([]attribute.KeyValue, 0, 2)
		attrs = append(attrs, semconv.HTTPResponseStatusCodeKey.String(statusLabel(*status)))
		var route string
		if rc := chi.RouteContext(r.Context()); rc != nil {
			route = rc.RoutePattern()
		}
		if route != "" {
			route = SanitizeSpanName(route)
			attrs = append(attrs, semconv.HTTPRoute(metricRoute(route)))
		}
		duration.Record(r.Context(), elapsed, metric.WithAttributes(attrs...))

		if route == "" {
			return
		}
		span := trace.SpanFromContext(r.Context())
		if span.IsRecording() {
			span.SetName(r.Method + " " + route)
			span.SetAttributes(semconv.HTTPRoute(route))
		}
	})
}
