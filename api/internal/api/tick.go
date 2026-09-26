package api

import (
	"crypto/subtle"
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* handleInternalTick runs one pass of the background job inside this request.
 *
 * Why it exists: Cloud Run scales this service to zero and, by default, gives an instance
 * CPU only while it is serving a request. The in-process ticker (StartMeetingLimitSweeper)
 * therefore does not run between requests, and a reminder due at 3 AM waits for the next
 * visitor. Cloud Scheduler calls this every minute instead; the request wakes an instance,
 * and the pass runs while the request holds the CPU.
 *
 * Authenticated by a shared secret in X-Tick-Secret, compared in constant time. Not
 * mounted at all when TICK_SECRET is unset. Nothing about the caller is Google-specific:
 * on a dedicated server a crontab line with curl does the same.
 *
 * The answer says whether this call did the pass or found another runner holding the
 * lease (the in-process ticker on a warm instance, or a previous tick still running).
 * Both are 200: the work is being done either way, and a scheduler that sees a 5xx retries.
 */
func (s *Server) handleInternalTick(w http.ResponseWriter, r *http.Request) {
	got := r.Header.Get("X-Tick-Secret")
	if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.TickSecret)) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Bad tick secret.")
		return
	}
	status := "busy"
	if s.RunTick(r.Context()) {
		status = "ran"
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: status})
}
