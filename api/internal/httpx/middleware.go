package httpx

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// Logger logs one structured line per request. Uses chi's RequestID so a log
// line can be tied back to the response header a client saw.
func Logger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)

			level := slog.LevelInfo
			if ww.Status() >= 500 {
				level = slog.LevelError
			} else if ww.Status() >= 400 {
				level = slog.LevelWarn
			}
			log.Log(r.Context(), level, "http",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"duration_ms", time.Since(start).Milliseconds(),
				"request_id", middleware.GetReqID(r.Context()),
				"ip", ClientIP(r),
			)
		})
	}
}

// Recoverer converts a panic into a 500 instead of killing the connection, and
// logs the request id so the stack can be correlated.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					// http.ErrAbortHandler is a deliberate abort, not a bug.
					if rec == http.ErrAbortHandler {
						panic(rec)
					}
					log.Error("panic",
						"error", rec,
						"path", r.URL.Path,
						"request_id", middleware.GetReqID(r.Context()),
					)
					Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeaders sets the headers that are free to set and cheap to forget.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// Timeout applies a request deadline, except on paths that stream.
//
// A single global timeout is right for everything that returns JSON and wrong for
// the one endpoint that returns a video: a forty-minute recording on a hotel
// connection takes longer than any sane API deadline, and the request context
// being cancelled mid-stream shows up as a truncated download rather than as an
// error. Exempting by path is blunt, and it is visible here rather than being an
// unexplained gap in the middleware stack.
func Timeout(d time.Duration, exemptSubstrings ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for _, e := range exemptSubstrings {
				if strings.Contains(r.URL.Path, e) {
					next.ServeHTTP(w, r)
					return
				}
			}
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClientIP prefers the left-most X-Forwarded-For entry, which is correct behind
// a single trusted reverse proxy (Caddy/nginx). Do not trust this if the app is
// reachable directly — a client can forge the header.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// RateLimiter is a fixed-window per-key counter.
//
// In-memory on purpose: this deployment is a single API node, so a shared store
// would add a Redis round trip to every request for no benefit. Moving to more
// than one node means moving this to Redis, or the effective limit multiplies by
// the node count.
type RateLimiter struct {
	mu     sync.Mutex
	hits   map[string]*window
	limit  int
	window time.Duration
	lastGC time.Time
}

type window struct {
	count int
	reset time.Time
}

func NewRateLimiter(limit int, per time.Duration) *RateLimiter {
	return &RateLimiter{
		hits:   make(map[string]*window),
		limit:  limit,
		window: per,
		lastGC: time.Now(),
	}
}

// Allow reports whether key may proceed, and how long until the window resets.
func (rl *RateLimiter) Allow(key string) (bool, time.Duration) {
	// A non-positive limit means no limiting.
	//
	// Read literally, a limit of zero would reject every request after the first —
	// a whole endpoint dead behind a 429 that looks like an attack rather than a
	// typo. config.validate() refuses a non-positive limit at boot, so this is the
	// safe reading of a value that should never arrive: failing open here is
	// recoverable, failing closed on the join path takes the webinar down.
	if rl.limit < 1 {
		return true, 0
	}

	now := time.Now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Opportunistic sweep so the map can't grow without bound.
	if now.Sub(rl.lastGC) > rl.window {
		for k, w := range rl.hits {
			if now.After(w.reset) {
				delete(rl.hits, k)
			}
		}
		rl.lastGC = now
	}

	w, ok := rl.hits[key]
	if !ok || now.After(w.reset) {
		rl.hits[key] = &window{count: 1, reset: now.Add(rl.window)}
		return true, 0
	}
	if w.count >= rl.limit {
		return false, time.Until(w.reset)
	}
	w.count++
	return true, 0
}

// Middleware rejects over-limit requests with 429 and a Retry-After header.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ok, retryIn := rl.Allow(ClientIP(r))
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(retryIn.Seconds())+1))
			Error(w, http.StatusTooManyRequests, "rate_limited",
				"Too many attempts. Please wait a moment and try again.")
			return
		}
		next.ServeHTTP(w, r)
	})
}
