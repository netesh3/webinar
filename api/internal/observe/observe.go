/*
Package observe sends the API's traces, request metrics and logs to an OTLP endpoint —
Grafana Cloud's OTLP gateway in production — and is nothing at all without one.

Everything is configured through the standard OpenTelemetry environment variables, so
pointing it somewhere else is a deploy change rather than a code change:

	OTEL_EXPORTER_OTLP_ENDPOINT   https://otlp-gateway-<region>.grafana.net/otlp. Unset = off.
	OTEL_EXPORTER_OTLP_HEADERS    Authorization=Basic <base64 instance:token>. A secret.
	OTEL_SERVICE_NAME             defaults to webcast-api.
	OTEL_RESOURCE_ATTRIBUTES      deployment.environment.name=prod,service.version=<git sha>
	OTEL_TRACES_SAMPLER(_ARG)     defaults to parentbased_traceidratio at 0.2.

Off is the default and the common case — local development, every test, any deployment that
has not set the endpoint. Off means the global providers stay the SDK's no-ops, nothing is
wrapped and no goroutine is started, so the cost of this package is one environment lookup.
*/
package observe

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otellog "go.opentelemetry.io/otel/log"
	lognoop "go.opentelemetry.io/otel/log/noop"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
)

// DefaultServiceName is what the API reports itself as when OTEL_SERVICE_NAME is unset.
const DefaultServiceName = "webcast-api"

/* Export cadences, short on purpose.
 *
 * Cloud Run only gives an instance CPU while it is serving a request. A batch that waits
 * the SDK's default five seconds after the last request of a burst may not get the CPU to
 * leave until the next request arrives — or ever, if the instance is scaled to zero first.
 * One second keeps traces and logs riding out on the tail of the request that produced
 * them. Metrics are cumulative, so a late export loses nothing but freshness; fifteen
 * seconds is Grafana's default scrape cadence and keeps the active-series bill flat.
 * Shutdown flushes everything regardless (see Telemetry.Shutdown). */
const (
	traceBatchTimeout = 1 * time.Second
	logExportInterval = 1 * time.Second
	metricInterval    = 15 * time.Second
	exportTimeout     = 5 * time.Second
	defaultSampleRate = 0.2
)

// enabled is read by the hooks other packages call (QueryTracer, RouteTag) so that they can
// stay pass-throughs without being handed the Telemetry value.
var enabled atomic.Bool

// Enabled reports whether Setup turned telemetry on in this process.
func Enabled() bool { return enabled.Load() }

// Telemetry is what Setup started. The zero value — what Setup returns when telemetry is
// off — is valid: every method is a no-op on it.
type Telemetry struct {
	tp *sdktrace.TracerProvider
	mp *sdkmetric.MeterProvider
	lp *sdklog.LoggerProvider
}

// Enabled reports whether this Telemetry exports anything.
func (t *Telemetry) Enabled() bool { return t != nil && t.tp != nil }

// LoggerProvider is the provider the slog bridge writes to: the SDK's when enabled, a no-op
// otherwise.
func (t *Telemetry) LoggerProvider() otellog.LoggerProvider {
	if t == nil || t.lp == nil {
		return lognoop.NewLoggerProvider()
	}
	return t.lp
}

// endpointConfigured is the single switch. Any of the signal-specific endpoints counts too,
// because the exporters honour those and someone setting only one would expect it to work.
func endpointConfigured() bool {
	for _, k := range []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	} {
		if strings.TrimSpace(os.Getenv(k)) != "" {
			return true
		}
	}
	return false
}

/*
Setup starts telemetry when an OTLP endpoint is configured and returns a Telemetry whose
Shutdown must run before the process exits. With no endpoint it returns a disabled Telemetry
and a nil error, having touched nothing.

The exporters read the endpoint, headers, protocol and timeouts from the environment
themselves; nothing here parses OTEL_EXPORTER_OTLP_HEADERS, so the credential is never held
in a value this package could log.
*/
func Setup(ctx context.Context) (*Telemetry, error) {
	if !endpointConfigured() {
		return &Telemetry{}, nil
	}

	res, err := newResource(ctx)
	if err != nil {
		return nil, fmt.Errorf("otel resource: %w", err)
	}

	traceExp, err := otlptracehttp.New(ctx, otlptracehttp.WithTimeout(exportTimeout))
	if err != nil {
		return nil, fmt.Errorf("otlp trace exporter: %w", err)
	}
	metricExp, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithTimeout(exportTimeout))
	if err != nil {
		return nil, errors.Join(fmt.Errorf("otlp metric exporter: %w", err), traceExp.Shutdown(ctx))
	}
	logExp, err := otlploghttp.New(ctx, otlploghttp.WithTimeout(exportTimeout))
	if err != nil {
		return nil, errors.Join(fmt.Errorf("otlp log exporter: %w", err),
			traceExp.Shutdown(ctx), metricExp.Shutdown(ctx))
	}

	tpOpts := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(res),
		// sanitizingExporter strips query strings, raw paths and client addresses from every
		// span before it leaves; see sanitize.go for why each one goes.
		sdktrace.WithBatcher(sanitizingExporter{traceExp},
			sdktrace.WithBatchTimeout(traceBatchTimeout),
			sdktrace.WithExportTimeout(exportTimeout)),
	}
	/* The SDK already reads OTEL_TRACES_SAMPLER and its argument; an explicit sampler would
	 * override them, so one is only given when the variable is unset. The default keeps a
	 * fifth of request traces: enough to see every slow route over a webinar, without paying
	 * for the full join burst of a 500-person room. */
	if strings.TrimSpace(os.Getenv("OTEL_TRACES_SAMPLER")) == "" {
		tpOpts = append(tpOpts, sdktrace.WithSampler(
			sdktrace.ParentBased(sdktrace.TraceIDRatioBased(defaultSampleRate))))
	}
	tp := sdktrace.NewTracerProvider(tpOpts...)

	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp,
			sdkmetric.WithInterval(metricInterval),
			sdkmetric.WithTimeout(exportTimeout))),
	)

	lp := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp,
			sdklog.WithExportInterval(logExportInterval),
			sdklog.WithExportTimeout(exportTimeout))),
	)

	t := &Telemetry{tp: tp, mp: mp, lp: lp}

	/* No global propagator is set, deliberately, so the default (which carries nothing)
	 * stays in place. Inbound: Cloud Run's front end stamps its own traceparent on every
	 * request with its own sampling decision, and honouring it would make this service's
	 * sample rate Google's. Outbound: the clients talk to Zoom, OpenAI, Meta and the rest,
	 * none of which is part of this trace, so there is nothing to tell them. */
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)

	// Go runtime metrics (heap, GC, goroutines) on the same reader.
	if err := runtime.Start(runtime.WithMeterProvider(mp)); err != nil {
		return nil, errors.Join(fmt.Errorf("runtime metrics: %w", err), t.Shutdown(ctx))
	}

	/* Every outbound call made through a client without its own Transport — which is all of
	 * them: Zoom, OpenAI and the other AI providers, Meta, Google, DigitalOcean, Razorpay,
	 * Web Push, the CDN probes — goes through http.DefaultTransport, read at request time.
	 * Wrapping it once here instruments them all without touching any of those packages.
	 *
	 * The cost: http.DefaultTransport is no longer an *http.Transport while telemetry is on,
	 * so code that type-asserts it to Clone() would panic. Nothing in this module does
	 * (livekit/protocol's webhook URL notifier does, and it is not used). Asserting it
	 * anywhere new must handle the wrapped case. The OTLP exporters keep their own
	 * transports, so exporting does not trace itself. */
	http.DefaultTransport = otelhttp.NewTransport(http.DefaultTransport,
		otelhttp.WithTracerProvider(tp),
		otelhttp.WithMeterProvider(mp),
		otelhttp.WithSpanNameFormatter(clientSpanName))

	enabled.Store(true)
	return t, nil
}

/*
newResource describes this process. OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win over
the defaults here.

service.instance.id is a fresh id per process, not a constant: Cloud Run runs up to three
instances at once, and three processes reporting cumulative counters under one identity
would overwrite each other's series instead of adding up.
*/
func newResource(ctx context.Context) (*resource.Resource, error) {
	attrs := []resource.Option{
		resource.WithAttributes(
			semconv.ServiceName(DefaultServiceName),
			semconv.ServiceInstanceID(uuid.NewString()),
		),
	}
	// Cloud Run names the revision; it tells two deploys apart even without a git sha.
	if rev := os.Getenv("K_REVISION"); rev != "" {
		attrs = append(attrs, resource.WithAttributes(semconv.FaaSVersion(rev)))
	}
	attrs = append(attrs,
		resource.WithTelemetrySDK(),
		resource.WithFromEnv(), // last, so the environment overrides the defaults above
	)
	return resource.New(ctx, attrs...)
}

/*
Shutdown flushes and stops every provider, within ctx's deadline.

Called on SIGTERM. Cloud Run gives an instance ten seconds between SIGTERM and SIGKILL, and
because CPU is throttled outside requests, whatever the batchers were holding has most likely
not left yet — the last second of traces and logs, and up to fifteen seconds of metrics. An
explicit ForceFlush first, then Shutdown, so the export happens while the CPU is ours.
*/
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if !t.Enabled() {
		return nil
	}
	enabled.Store(false)
	var errs []error
	if err := t.tp.ForceFlush(ctx); err != nil {
		errs = append(errs, fmt.Errorf("flush traces: %w", err))
	}
	if err := t.mp.ForceFlush(ctx); err != nil {
		errs = append(errs, fmt.Errorf("flush metrics: %w", err))
	}
	if err := t.lp.ForceFlush(ctx); err != nil {
		errs = append(errs, fmt.Errorf("flush logs: %w", err))
	}
	if err := t.tp.Shutdown(ctx); err != nil {
		errs = append(errs, fmt.Errorf("shutdown traces: %w", err))
	}
	if err := t.mp.Shutdown(ctx); err != nil {
		errs = append(errs, fmt.Errorf("shutdown metrics: %w", err))
	}
	if err := t.lp.Shutdown(ctx); err != nil {
		errs = append(errs, fmt.Errorf("shutdown logs: %w", err))
	}
	return errors.Join(errs...)
}
