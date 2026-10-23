package observe

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.40.0"
	"go.opentelemetry.io/otel/trace"
)

/*
sanitizingExporter rewrites every span on its way out so that nothing which identifies a
person, or works as a credential, reaches Grafana.

Here rather than at each place spans are made because the instrumentation is not ours:
otelhttp records the raw request path, the outbound URL with its query string, and the
client's address, and has no option to stop. The query strings are the sharp part — join
links carry their key in ?k= and ?t=, the YouTube client sends its API key in ?key=, and
an outbound error message quotes the URL it failed on. Raw paths carry webinar slugs and
invitation tokens. Client addresses are personal data and say nothing about performance.

So, per span:
  - url.query, client.address, network.peer.* are dropped;
  - url.path on a server span becomes the route pattern, or goes when there is none;
  - url.full keeps scheme, host and path, with id-like path segments replaced by {id};
  - the span name, status message and every string attribute of every event (the
    exception message, mostly) lose any query string a URL in them carried.
*/
type sanitizingExporter struct {
	next sdktrace.SpanExporter
}

func (e sanitizingExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	out := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, s := range spans {
		out[i] = sanitizeSpan(s)
	}
	return e.next.ExportSpans(ctx, out)
}

func (e sanitizingExporter) Shutdown(ctx context.Context) error { return e.next.Shutdown(ctx) }

// sanitizedSpan is a ReadOnlySpan with its name, attributes, events and status replaced.
// Embedding the original satisfies the interface's unexported method and passes everything
// else through.
type sanitizedSpan struct {
	sdktrace.ReadOnlySpan
	name   string
	attrs  []attribute.KeyValue
	events []sdktrace.Event
	status sdktrace.Status
}

func (s sanitizedSpan) Name() string                     { return s.name }
func (s sanitizedSpan) Attributes() []attribute.KeyValue { return s.attrs }
func (s sanitizedSpan) Events() []sdktrace.Event         { return s.events }
func (s sanitizedSpan) Status() sdktrace.Status          { return s.status }

func sanitizeSpan(s sdktrace.ReadOnlySpan) sdktrace.ReadOnlySpan {
	server := s.SpanKind() == trace.SpanKindServer
	in := s.Attributes()
	var route string
	for _, kv := range in {
		if kv.Key == semconv.HTTPRouteKey {
			route = kv.Value.AsString()
		}
	}
	attrs := make([]attribute.KeyValue, 0, len(in))
	for _, kv := range in {
		switch kv.Key {
		case semconv.URLQueryKey, semconv.ClientAddressKey,
			semconv.NetworkPeerAddressKey, semconv.NetworkPeerPortKey:
			continue
		case semconv.URLPathKey:
			if !server {
				attrs = append(attrs, attribute.String(string(kv.Key), redactPath(kv.Value.AsString())))
			} else if route != "" {
				attrs = append(attrs, attribute.String(string(kv.Key), route))
			}
			continue
		case semconv.URLFullKey:
			attrs = append(attrs, attribute.String(string(kv.Key), SanitizeURL(kv.Value.AsString())))
			continue
		}
		if strings.HasPrefix(string(kv.Key), "http.request.header.") ||
			strings.HasPrefix(string(kv.Key), "http.response.header.") {
			continue
		}
		attrs = append(attrs, kv)
	}

	var events []sdktrace.Event
	if ev := s.Events(); len(ev) > 0 {
		events = make([]sdktrace.Event, len(ev))
		for i, e := range ev {
			e.Name = scrubQueries(e.Name)
			if len(e.Attributes) > 0 {
				ea := make([]attribute.KeyValue, len(e.Attributes))
				for j, kv := range e.Attributes {
					if kv.Value.Type() == attribute.STRING {
						kv = attribute.String(string(kv.Key), scrubQueries(kv.Value.AsString()))
					}
					ea[j] = kv
				}
				e.Attributes = ea
			}
			events[i] = e
		}
	}

	st := s.Status()
	st.Description = scrubQueries(st.Description)

	return sanitizedSpan{
		ReadOnlySpan: s,
		name:         SanitizeSpanName(s.Name()),
		attrs:        attrs,
		events:       events,
		status:       st,
	}
}

// urlQuery matches a URL's query string and fragment wherever a URL appears in free text —
// an error message, typically: `Get "https://host/path?key=secret": context deadline`.
var urlQuery = regexp.MustCompile(`(https?://[^\s"'?#]*)[?#][^\s"']*`)

// scrubQueries removes the query string and fragment from every URL in s.
func scrubQueries(s string) string {
	if !strings.ContainsAny(s, "?#") {
		return s
	}
	return urlQuery.ReplaceAllString(s, "$1")
}

// SanitizeSpanName drops anything from the first '?' or '#' — a span name is a route
// pattern or a method and host, never a URL with its parameters.
func SanitizeSpanName(name string) string {
	if i := strings.IndexAny(name, "?#"); i >= 0 {
		return strings.TrimSpace(name[:i])
	}
	return name
}

/*
SanitizeURL reduces a URL to scheme, host and a redacted path: no user info, no query, no
fragment. A string that does not parse is dropped to its prefix before any '?', since it
was going to be shown to someone either way.
*/
func SanitizeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		if i := strings.IndexAny(raw, "?#"); i >= 0 {
			return raw[:i]
		}
		return raw
	}
	// Assembled by hand: url.URL.String would escape the braces of {id}.
	if u.Host == "" {
		return redactPath(u.EscapedPath())
	}
	return u.Scheme + "://" + u.Host + redactPath(u.EscapedPath())
}

/*
redactPath replaces each path segment that looks like an identifier with {id}.

Outbound paths have no route pattern to fall back on, and the ones that matter here carry
identifiers that are someone's: a Zoom meeting number, a Web Push subscription (whose URL is
the credential to reach that browser), a WhatsApp media id. "Looks like" is: all digits, or
long, or a mix of letters and digits long enough not to be a version like v2 or v21.0.
*/
func redactPath(p string) string {
	if p == "" || p == "/" {
		return p
	}
	segs := strings.Split(p, "/")
	for i, seg := range segs {
		if idLike(seg) {
			segs[i] = "{id}"
		}
	}
	return strings.Join(segs, "/")
}

func idLike(seg string) bool {
	if seg == "" {
		return false
	}
	if len(seg) >= 16 {
		return true
	}
	var digits, letters int
	for _, r := range seg {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z'):
			letters++
		}
	}
	if digits == len(seg) && digits >= 3 {
		return true
	}
	return digits > 0 && letters > 0 && len(seg) >= 8
}

// clientSpanName names an outbound call by method and host: "POST api.openai.com".
// Low-cardinality, and enough to tell which dependency was slow.
func clientSpanName(_ string, r *http.Request) string {
	host := ""
	if r.URL != nil {
		host = r.URL.Host
	}
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return r.Method
	}
	return r.Method + " " + host
}
