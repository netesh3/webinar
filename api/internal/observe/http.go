package observe

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
	"go.opentelemetry.io/otel/trace"
)

/*
HTTPHandler wraps the whole API in a server span and the standard HTTP server metrics
(http.server.request.duration and friends, by method, status and route). It returns h itself
when telemetry is off.

The span starts named by the method alone, because the route is not known until chi has
routed the request; RouteTag, inside the router, renames it once it is.
*/
func HTTPHandler(h http.Handler) http.Handler {
	if !Enabled() {
		return h
	}
	return otelhttp.NewHandler(h, "http.server",
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return r.Method }))
}

/*
RouteTag is chi middleware that, after the request has been handled, names the server span
"METHOD /route/{pattern}" and adds http.route to the span and to the request metrics.

The pattern rather than the path: /api/webinars/{slug} is one series, where the raw path is a
series per webinar — and a path can carry an invitation token. A request that matched no route
gets no http.route at all, rather than its path.

It has to be inside the router: chi sets the pattern on its own copy of the request, which
otelhttp, outside, never sees. The route context it reads is shared, so it is complete once
the handler returns. It must be the first middleware so that it sees every request.
*/
func RouteTag(next http.Handler) http.Handler {
	if !Enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		rc := chi.RouteContext(r.Context())
		if rc == nil {
			return
		}
		route := rc.RoutePattern()
		if route == "" {
			return
		}
		route = SanitizeSpanName(route)
		if l, ok := otelhttp.LabelerFromContext(r.Context()); ok {
			l.Add(semconv.HTTPRoute(route))
		}
		span := trace.SpanFromContext(r.Context())
		if span.IsRecording() {
			span.SetName(r.Method + " " + route)
			span.SetAttributes(semconv.HTTPRoute(route))
		}
	})
}
