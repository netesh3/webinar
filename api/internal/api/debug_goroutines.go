package api

import (
	"fmt"
	"net/http"
	"runtime"
	"runtime/pprof"

	"github.com/netkumar/webcast/api/internal/httpx"
)

/* handleDebugGoroutines is GET /api/admin/debug/goroutines: the goroutine profile of the
 * instance that answered, as text. Admins only (the /admin group), and only when
 * DEBUG_GOROUTINES=true; otherwise 404, as if it did not exist.
 *
 * Only the goroutine profile, not net/http/pprof: no CPU or trace profiling that an admin
 * session could use to load an instance. ?debug=1 (the default) groups identical stacks with
 * a count each, which is what answers "what are these goroutines"; ?debug=2 is every stack.
 * Cloud Run spreads requests over instances, so call it a few times to see each one. */
func (s *Server) handleDebugGoroutines(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.DebugGoroutines {
		httpx.Error(w, http.StatusNotFound, "not_found", "Not found.")
		return
	}
	debug := 1
	if r.URL.Query().Get("debug") == "2" {
		debug = 2
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, "goroutines: %d\nedge streams: %d\n\n", runtime.NumGoroutine(), s.rt.Hub().Total())
	_ = pprof.Lookup("goroutine").WriteTo(w, debug)
}
