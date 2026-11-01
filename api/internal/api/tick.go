package api

import (
	"context"
	"crypto/subtle"
	"net/http"
	"time"

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
 *
 * The whole pass has tickRequestBudget, and the response its own write deadline past it.
 * On 1 Nov 2026 the realtime lane's 90 s ran past the server's 60 s WriteTimeout: the
 * answer was never written, Cloud Run saw a broken connection (503), took the instance
 * out of rotation and kept it until its open event streams ended, up to 25 minutes. Three
 * such instances were the whole of max-instances, and every request got 429 for twelve
 * minutes. The budget is under both the WriteTimeout and the worker's 55 s abort
 * (deploy/cloudflare/tick-worker), and the write deadline is extended anyway, so a job
 * that overruns its budget delays the answer rather than breaking the connection.
 */
func (s *Server) handleInternalTick(w http.ResponseWriter, r *http.Request) {
	got := r.Header.Get("X-Tick-Secret")
	if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.TickSecret)) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Bad tick secret.")
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(tickRequestBudget + tickWriteGrace))
	ctx, cancel := context.WithTimeout(r.Context(), tickRequestBudget)
	defer cancel()
	status := "busy"
	if s.RunTick(ctx) {
		status = "ran"
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: status})
}

/* tickRequestBudget bounds one POST /api/internal/tick: every lane of RunTick runs inside it.
 * Under the tick worker's 55 s abort and the server's 60 s WriteTimeout (cmd/server). A var
 * so a test can shorten it. tickWriteGrace is how long past it the answer may still be
 * written, for a job that overruns its deadline. */
var tickRequestBudget = 50 * time.Second

const tickWriteGrace = 30 * time.Second
