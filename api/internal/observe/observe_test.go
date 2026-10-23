package observe

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func clearEndpoints(t *testing.T) {
	for _, k := range []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	} {
		t.Setenv(k, "")
	}
}

// With no endpoint, Setup must start nothing and change nothing: this is every test run
// and every local server.
func TestSetupWithoutEndpointIsNoop(t *testing.T) {
	clearEndpoints(t)
	transport := http.DefaultTransport
	tp := otel.GetTracerProvider()

	tel, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if tel.Enabled() || Enabled() {
		t.Fatal("telemetry enabled without an endpoint")
	}
	if http.DefaultTransport != transport {
		t.Error("http.DefaultTransport was replaced")
	}
	if otel.GetTracerProvider() != tp {
		t.Error("global tracer provider was replaced")
	}
	if QueryTracer() != nil {
		t.Error("QueryTracer is not nil")
	}
	mux := http.NewServeMux()
	if h, ok := HTTPHandler(mux).(*http.ServeMux); !ok || h != mux {
		t.Error("HTTPHandler wrapped the handler")
	}
	base := slog.NewJSONHandler(&bytes.Buffer{}, nil)
	if LogHandler(tel, base, slog.LevelInfo) != slog.Handler(base) {
		t.Error("LogHandler wrapped the handler")
	}
	if err := tel.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown: %v", err)
	}
	// The zero value, which main falls back to when Setup fails, is safe too.
	var zero *Telemetry
	if zero.Enabled() || zero.Shutdown(context.Background()) != nil {
		t.Error("nil Telemetry is not a no-op")
	}
}

func TestSanitizeURL(t *testing.T) {
	cases := map[string]string{
		"https://api.zoom.us/v2/users/me/meetings?page_size=30":     "https://api.zoom.us/v2/users/me/meetings",
		"https://www.googleapis.com/youtube/v3/videos?key=SECRET&x": "https://www.googleapis.com/youtube/v3/videos",
		"https://user:pass@example.com/a#frag":                      "https://example.com/a",
		"https://api.zoom.us/v2/meetings/85512345678/registrants":   "https://api.zoom.us/v2/meetings/{id}/registrants",
		"https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHun": "https://fcm.googleapis.com/fcm/send/{id}",
		"https://graph.facebook.com/v21.0/media":                    "https://graph.facebook.com/v21.0/media",
		"https://api.openai.com/v1/chat/completions":                "https://api.openai.com/v1/chat/completions",
	}
	for in, want := range cases {
		if got := SanitizeURL(in); got != want {
			t.Errorf("SanitizeURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestScrubQueriesAndSpanName(t *testing.T) {
	msg := `Get "https://host/p?key=SECRET&t=abc": context deadline exceeded`
	if got := scrubQueries(msg); strings.Contains(got, "SECRET") || !strings.Contains(got, "https://host/p") {
		t.Errorf("scrubQueries = %q", got)
	}
	if got := SanitizeSpanName("GET /join?k=abc"); got != "GET /join" {
		t.Errorf("SanitizeSpanName = %q", got)
	}
	if got := SanitizeSpanName("GET /api/webinars/{slug}"); got != "GET /api/webinars/{slug}" {
		t.Errorf("SanitizeSpanName changed a clean name: %q", got)
	}
}

func TestSanitizeSpan(t *testing.T) {
	stub := tracetest.SpanStub{
		Name:     "GET /api/join/{slug}?k=SECRET",
		SpanKind: trace.SpanKindServer,
		Attributes: []attribute.KeyValue{
			attribute.String("url.path", "/api/join/my-webinar"),
			attribute.String("url.query", "k=SECRET"),
			attribute.String("client.address", "203.0.113.9"),
			attribute.String("network.peer.address", "10.0.0.1"),
			attribute.String("http.request.header.authorization", "Bearer SECRET"),
			attribute.String("http.route", "/api/join/{slug}"),
			attribute.Int("http.response.status_code", 200),
		},
		Status: sdktrace.Status{Code: codes.Error, Description: `Get "https://x/y?t=SECRET": EOF`},
		Events: []sdktrace.Event{{Name: "exception", Attributes: []attribute.KeyValue{
			attribute.String("exception.message", `Post "https://x/y?key=SECRET": timeout`),
		}}},
	}
	s := sanitizeSpan(stub.Snapshot())

	if s.Name() != "GET /api/join/{slug}" {
		t.Errorf("name = %q", s.Name())
	}
	got := map[attribute.Key]attribute.Value{}
	for _, kv := range s.Attributes() {
		got[kv.Key] = kv.Value
	}
	for _, k := range []attribute.Key{"url.query", "client.address", "network.peer.address",
		"http.request.header.authorization"} {
		if _, ok := got[k]; ok {
			t.Errorf("%s was not dropped", k)
		}
	}
	if got["url.path"].AsString() != "/api/join/{slug}" {
		t.Errorf("url.path = %q, want the route", got["url.path"].AsString())
	}
	if got["http.response.status_code"].AsInt64() != 200 {
		t.Error("an ordinary attribute was lost")
	}
	if strings.Contains(s.Status().Description, "SECRET") {
		t.Errorf("status description kept the query: %q", s.Status().Description)
	}
	for _, e := range s.Events() {
		for _, kv := range e.Attributes {
			if strings.Contains(kv.Value.Emit(), "SECRET") {
				t.Errorf("event attribute %s kept the query: %q", kv.Key, kv.Value.Emit())
			}
		}
	}

	// A server span that matched no route keeps no path at all.
	unrouted := tracetest.SpanStub{Name: "GET", SpanKind: trace.SpanKindServer,
		Attributes: []attribute.KeyValue{attribute.String("url.path", "/email/unsubscribe/tok")}}
	for _, kv := range sanitizeSpan(unrouted.Snapshot()).Attributes() {
		if kv.Key == "url.path" {
			t.Errorf("unrouted url.path kept: %q", kv.Value.AsString())
		}
	}
}

// End to end through otelhttp and chi: the span is named by route and nothing from the
// raw path or the query string survives export.
func TestRouteTagNamesSpanByRoute(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(sanitizingExporter{exp}))
	prevTP := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	enabled.Store(true)
	t.Cleanup(func() {
		enabled.Store(false)
		otel.SetTracerProvider(prevTP)
	})

	r := chi.NewRouter()
	r.Use(RouteTag)
	r.Route("/api", func(r chi.Router) {
		r.Get("/join/{slug}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	})
	h := HTTPHandler(r)

	req := httptest.NewRequest(http.MethodGet, "/api/join/secret-webinar?k=SECRETKEY&t=TOKEN", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)

	spans := exp.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	sp := spans[0]
	if sp.Name != "GET /api/join/{slug}" {
		t.Errorf("span name = %q", sp.Name)
	}
	var route string
	for _, kv := range sp.Attributes {
		v := kv.Value.Emit()
		if strings.Contains(v, "SECRETKEY") || strings.Contains(v, "TOKEN") || strings.Contains(v, "secret-webinar") {
			t.Errorf("attribute %s leaked %q", kv.Key, v)
		}
		if kv.Key == "http.route" {
			route = v
		}
	}
	if route != "/api/join/{slug}" {
		t.Errorf("http.route = %q", route)
	}
}

func TestLogRedaction(t *testing.T) {
	cases := []struct {
		in   slog.Attr
		want string
	}{
		{slog.String("email", "a@b.com"), redacted},
		{slog.String("to_email", "a@b.com"), redacted},
		{slog.String("ip", "203.0.113.9"), redacted},
		{slog.String("path", "/api/email/unsubscribe/abcdefghijklmnopqrstuvwxyz"), "/api/email/unsubscribe/{id}"},
		{slog.String("error", `Get "https://h/p?key=SECRET": EOF`), `Get "https://h/p": EOF`},
		{slog.Int("status", 200), "200"},
	}
	for _, c := range cases {
		if got := redactAttr(c.in).Value.String(); got != c.want {
			t.Errorf("redactAttr(%s) = %q, want %q", c.in.Key, got, c.want)
		}
	}
	g := redactAttr(slog.Group("user", slog.String("phone", "+911234567890")))
	if g.Value.Group()[0].Value.String() != redacted {
		t.Error("a sensitive attribute inside a group was kept")
	}
}

func TestSQLOperation(t *testing.T) {
	cases := map[string]string{
		"SELECT 1":                     "SELECT",
		"\n  with x as (select 1) ...": "WITH",
		"-- why\nUPDATE t SET a=$1":    "UPDATE",
		"":                             "QUERY",
	}
	for in, want := range cases {
		if got := sqlOperation(in); got != want {
			t.Errorf("sqlOperation(%q) = %q, want %q", in, got, want)
		}
	}
}
