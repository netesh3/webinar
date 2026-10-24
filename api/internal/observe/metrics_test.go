package observe

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// newTestMeter is the production meter provider's shape (meterViews) on a manual reader.
func newTestMeter(t *testing.T) (*sdkmetric.MeterProvider, *sdkmetric.ManualReader) {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader), sdkmetric.WithView(meterViews()...))
	t.Cleanup(func() { _ = mp.Shutdown(context.Background()) })
	return mp, reader
}

func collectAll(t *testing.T, reader *sdkmetric.ManualReader) metricdata.ResourceMetrics {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("collect: %v", err)
	}
	return rm
}

// metricsNamed is every exported metric called name, from any scope.
func metricsNamed(rm metricdata.ResourceMetrics, name string) (out []metricdata.Metrics, scopes []string) {
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == name {
				out = append(out, m)
				scopes = append(scopes, sm.Scope.Name)
			}
		}
	}
	return out, scopes
}

func names(rm metricdata.ResourceMetrics) []string {
	var out []string
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			out = append(out, m.Name)
		}
	}
	return out
}

// attrSets renders each data point's attributes as "k=v,k=v", sorted.
func attrSets(t *testing.T, m metricdata.Metrics) ([]string, metricdata.Histogram[float64]) {
	t.Helper()
	h, ok := m.Data.(metricdata.Histogram[float64])
	if !ok {
		t.Fatalf("%s is %T, want a float64 histogram", m.Name, m.Data)
	}
	var out []string
	for _, dp := range h.DataPoints {
		var kv []string
		for _, a := range dp.Attributes.ToSlice() {
			kv = append(kv, string(a.Key)+"="+a.Value.Emit())
		}
		out = append(out, strings.Join(kv, ","))
		if !slices.Equal(dp.Bounds, durationBuckets) {
			t.Errorf("%s bounds = %v, want %v", m.Name, dp.Bounds, durationBuckets)
		}
	}
	sort.Strings(out)
	return out, h
}

/*
End to end through HTTPHandler (otelhttp) and RouteTag in a chi router: exactly one
http.server.request.duration, from this package, by route and status label only, on the nine
boundaries — and none of otelhttp's server histograms.
*/
func TestRequestHistogramShape(t *testing.T) {
	mp, reader := newTestMeter(t)
	prevMP, prevTP := otel.GetMeterProvider(), otel.GetTracerProvider()
	otel.SetMeterProvider(mp)
	otel.SetTracerProvider(tracenoop.NewTracerProvider())
	enabled.Store(true)
	t.Cleanup(func() {
		enabled.Store(false)
		otel.SetMeterProvider(prevMP)
		otel.SetTracerProvider(prevTP)
	})

	r := chi.NewRouter()
	r.Use(RouteTag)
	ok := func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }
	r.Get("/api/webinars/{slug}/join", ok)
	r.Post("/api/webinars/{slug}/join", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	r.Get("/api/admin/users/{id}", ok)
	r.Get("/api/admin/stats", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) })
	r.Get("/api/auth/me", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) })
	r.Get("/api/boom", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	r.Get("/api/empty", func(http.ResponseWriter, *http.Request) {})
	h := HTTPHandler(r)

	for _, req := range []struct{ method, path string }{
		{http.MethodGet, "/api/webinars/a/join"},
		{http.MethodGet, "/api/webinars/b/join?k=SECRET"},
		{http.MethodPost, "/api/webinars/a/join"},
		{http.MethodGet, "/api/admin/users/1"},
		{http.MethodGet, "/api/admin/stats"},
		{http.MethodGet, "/api/auth/me"},
		{http.MethodGet, "/api/boom"},
		{http.MethodGet, "/api/empty"},
		{http.MethodGet, "/no/such/route"},
	} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(req.method, req.path, nil))
	}

	rm := collectAll(t, reader)
	for _, n := range names(rm) {
		if strings.HasSuffix(n, ".body.size") {
			t.Errorf("%s exported", n)
		}
	}
	ms, scopes := metricsNamed(rm, serverDurationName)
	if len(ms) != 1 || scopes[0] != meterScope {
		t.Fatalf("%s exported from scopes %v, want once from %s", serverDurationName, scopes, meterScope)
	}
	got, hist := attrSets(t, ms[0])
	want := []string{
		"http.response.status_code=2xx,http.route=/api/admin/*",
		"http.response.status_code=2xx,http.route=/api/empty",
		"http.response.status_code=2xx,http.route=/api/webinars/{slug}/join",
		"http.response.status_code=4xx",
		"http.response.status_code=4xx,http.route=/api/admin/*",
		"http.response.status_code=4xx,http.route=/api/auth/me",
		"http.response.status_code=500,http.route=/api/boom",
		"http.response.status_code=503,http.route=/api/webinars/{slug}/join",
	}
	if !slices.Equal(got, want) {
		t.Errorf("series:\n got %q\nwant %q", got, want)
	}
	var total uint64
	for _, dp := range hist.DataPoints {
		total += dp.Count
	}
	if total != 9 {
		t.Errorf("recorded %d requests, want 9", total)
	}
}

// Outbound calls: one duration histogram by server.address alone, no body sizes.
func TestClientHistogramShape(t *testing.T) {
	mp, reader := newTestMeter(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client := &http.Client{Transport: clientTransport(http.DefaultTransport, tracenoop.NewTracerProvider(), mp)}
	for _, p := range []string{"/a", "/missing"} {
		resp, err := client.Post(srv.URL+p, "text/plain", strings.NewReader("body"))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}

	rm := collectAll(t, reader)
	for _, n := range names(rm) {
		if n != "http.client.request.duration" {
			t.Errorf("unexpected metric %s", n)
		}
	}
	ms, scopes := metricsNamed(rm, "http.client.request.duration")
	if len(ms) != 1 || scopes[0] != otelhttp.ScopeName {
		t.Fatalf("http.client.request.duration from scopes %v", scopes)
	}
	got, _ := attrSets(t, ms[0])
	if want := []string{"server.address=127.0.0.1"}; !slices.Equal(got, want) {
		t.Errorf("series = %q, want %q", got, want)
	}
}

// Go runtime: what the dashboard reads stays, the rest goes.
func TestRuntimeMetricsTrimmed(t *testing.T) {
	mp, reader := newTestMeter(t)
	if err := runtime.Start(runtime.WithMeterProvider(mp)); err != nil {
		t.Fatal(err)
	}
	got := names(collectAll(t, reader))
	for _, n := range []string{"go.goroutine.count", "go.memory.used"} {
		if !slices.Contains(got, n) {
			t.Errorf("%s missing (got %v)", n, got)
		}
	}
	for _, n := range droppedRuntime {
		if slices.Contains(got, n) {
			t.Errorf("%s exported", n)
		}
	}
}

func TestStatusLabel(t *testing.T) {
	cases := map[int]string{0: "2xx", 101: "1xx", 200: "2xx", 204: "2xx", 302: "3xx", 404: "4xx",
		429: "4xx", 500: "500", 503: "503"}
	for code, want := range cases {
		if got := statusLabel(code); got != want {
			t.Errorf("statusLabel(%d) = %q, want %q", code, got, want)
		}
	}
}

func TestMetricRoute(t *testing.T) {
	cases := map[string]string{
		"/api/webinars/{slug}/events/beat":               "/api/webinars/{slug}/events/beat",
		"/api/internal/tick":                             "/api/internal/tick",
		"/api/internal/clip-jobs/{id}/progress":          "/api/internal/clip-jobs/*",
		"/api/admin/users/{id}/features":                 "/api/admin/*",
		"/api/admin/sales/{id}/join":                     "/api/admin/sales/{id}/join",
		"/api/auth/me":                                   "/api/auth/me",
		"/api/auth/google/callback":                      "/api/auth/*",
		"/api/host/crm/replies":                          "/api/host/crm/replies",
		"/api/host/crm/webinars/{slug}/metrics":          "/api/host/crm/*",
		"/api/host/webinars/{slug}/recordings":           "/api/host/webinars/{slug}/recordings/*",
		"/api/host/webinars/{slug}/recordings/{id}/file": "/api/host/webinars/{slug}/recordings/*",
		"/api/host/webinars/{slug}/join":                 "/api/host/webinars/{slug}/join",
		"/api/host/webinars/{slug}/edge":                 "/api/host/webinars/{slug}/edge",
	}
	for in, want := range cases {
		if got := metricRoute(in); got != want {
			t.Errorf("metricRoute(%q) = %q, want %q", in, got, want)
		}
	}
}

// The status wrapper must keep the writer's optional interfaces: the event streams flush.
func TestStatusWriterKeepsFlusher(t *testing.T) {
	rec := httptest.NewRecorder()
	w, status := statusWriter(rec)
	f, ok := w.(http.Flusher)
	if !ok {
		t.Fatal("wrapped writer is not an http.Flusher")
	}
	w.WriteHeader(http.StatusAccepted)
	f.Flush()
	if *status != http.StatusAccepted || rec.Code != http.StatusAccepted {
		t.Errorf("status = %d, recorder = %d", *status, rec.Code)
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		t.Errorf("ResponseController.Flush: %v", err)
	}
}
