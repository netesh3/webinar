package observe

import (
	"context"
	"log/slog"
	"strings"

	"go.opentelemetry.io/contrib/bridges/otelslog"
)

/*
LogHandler returns base unchanged when telemetry is off. When it is on, it returns a handler
that writes every record to base exactly as before — the JSON lines Cloud Logging indexes do
not change — and also sends it over OTLP, where a record logged with a request's context
(log.InfoContext(ctx, ...), as the request log does) carries that request's trace and span id.

The OTLP copy differs from stdout in two ways, both subtractive:
  - It is held to base's level, so debug records stay out of production on both.
  - It is redacted. The existing log lines were written for Cloud Logging, inside the same
    project as the data; Grafana is a third party. So attributes keyed as personal data or
    credentials (email, phone, ip, token, password, secret, ...) are replaced, paths have
    their id-like segments replaced (an unsubscribe link's token is a path segment), and
    every string loses any URL query string it quotes.
*/
func LogHandler(t *Telemetry, base slog.Handler, level slog.Leveler) slog.Handler {
	if !t.Enabled() {
		return base
	}
	otlp := otelslog.NewHandler("github.com/netkumar/webcast/api",
		otelslog.WithLoggerProvider(t.LoggerProvider()))
	return slog.NewMultiHandler(base, &otlpHandler{Handler: otlp, level: level})
}

// otlpHandler is the level filter and redaction in front of the OTLP bridge.
type otlpHandler struct {
	slog.Handler
	level slog.Leveler
}

func (h *otlpHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= h.level.Level() && h.Handler.Enabled(ctx, l)
}

func (h *otlpHandler) Handle(ctx context.Context, r slog.Record) error {
	nr := slog.NewRecord(r.Time, r.Level, scrubQueries(r.Message), r.PC)
	r.Attrs(func(a slog.Attr) bool {
		nr.AddAttrs(redactAttr(a))
		return true
	})
	return h.Handler.Handle(ctx, nr)
}

func (h *otlpHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	red := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		red[i] = redactAttr(a)
	}
	return &otlpHandler{Handler: h.Handler.WithAttrs(red), level: h.level}
}

func (h *otlpHandler) WithGroup(name string) slog.Handler {
	return &otlpHandler{Handler: h.Handler.WithGroup(name), level: h.level}
}

// sensitiveKeys are attribute keys whose value never leaves for Grafana. Matched on the
// lower-cased key, exactly or as a suffix after '_' or '.', so to_email and user.phone count.
var sensitiveKeys = []string{
	"email", "emails", "phone", "ip", "token", "password", "secret", "key", "authorization",
	"cookie", "otp", "code", "name",
}

const redacted = "[redacted]"

func sensitiveKey(k string) bool {
	k = strings.ToLower(k)
	for _, s := range sensitiveKeys {
		if k == s || strings.HasSuffix(k, "_"+s) || strings.HasSuffix(k, "."+s) {
			return true
		}
	}
	return false
}

func redactAttr(a slog.Attr) slog.Attr {
	v := a.Value.Resolve()
	if v.Kind() == slog.KindGroup {
		g := v.Group()
		out := make([]slog.Attr, len(g))
		for i, ga := range g {
			out[i] = redactAttr(ga)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(out...)}
	}
	if sensitiveKey(a.Key) {
		return slog.String(a.Key, redacted)
	}
	switch {
	case strings.EqualFold(a.Key, "path") && v.Kind() == slog.KindString:
		return slog.String(a.Key, redactPath(v.String()))
	case v.Kind() == slog.KindString:
		return slog.String(a.Key, scrubQueries(v.String()))
	case v.Kind() == slog.KindAny:
		// Errors and the like are rendered as text the same way the JSON handler would.
		if err, ok := v.Any().(error); ok {
			return slog.String(a.Key, scrubQueries(err.Error()))
		}
	}
	return slog.Attr{Key: a.Key, Value: v}
}
