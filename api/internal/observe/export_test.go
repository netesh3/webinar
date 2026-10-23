package observe

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
)

// With an endpoint, Setup exports, and Shutdown flushes what is buffered before returning —
// the SIGTERM path on Cloud Run.
func TestSetupExportsAndShutdownFlushes(t *testing.T) {
	clearEndpoints(t)
	var mu sync.Mutex
	paths := map[string]int{}
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths[r.URL.Path]++
		gotAuth = r.Header.Get("Authorization")
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", srv.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic dGVzdDp0ZXN0")
	t.Setenv("OTEL_TRACES_SAMPLER", "always_on")

	prevTransport := http.DefaultTransport
	prevTP, prevMP := otel.GetTracerProvider(), otel.GetMeterProvider()
	t.Cleanup(func() {
		http.DefaultTransport = prevTransport
		otel.SetTracerProvider(prevTP)
		otel.SetMeterProvider(prevMP)
		enabled.Store(false)
	})

	tel, err := Setup(context.Background())
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if !tel.Enabled() || !Enabled() || QueryTracer() == nil {
		t.Fatal("telemetry not enabled with an endpoint")
	}
	_, span := otel.Tracer("test").Start(context.Background(), "work")
	span.End()
	log := slog.New(LogHandler(tel, slog.NewJSONHandler(&bytes.Buffer{}, nil), slog.LevelInfo))
	log.Info("hello", "email", "a@b.com")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tel.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, p := range []string{"/v1/traces", "/v1/metrics", "/v1/logs"} {
		if paths[p] == 0 {
			t.Errorf("nothing was exported to %s (got %v)", p, paths)
		}
	}
	if gotAuth != "Basic dGVzdDp0ZXN0" {
		t.Errorf("OTEL_EXPORTER_OTLP_HEADERS not sent; Authorization = %q", gotAuth)
	}
}
