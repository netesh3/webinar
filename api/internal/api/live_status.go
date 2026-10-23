package api

import (
	"crypto/subtle"
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
)

/* handleInternalLiveStatus answers the deploy guard (.github/scripts/wait-no-live.sh): is any
 * session running that a deploy would interrupt, and on which video server.
 *
 * Same secret as the tick (X-Tick-Secret, TICK_SECRET), so the workflows need nothing new, and
 * like the tick it is not mounted without one. One query, no SFU calls: it has to stay fast and
 * keep answering while a deploy waits on it. Slugs only, no names or emails.
 *
 * byProject counts the sessions per video server (LiveKit project id, or "zoom"), so a box
 * deploy waits only for its own box. */
func (s *Server) handleInternalLiveStatus(w http.ResponseWriter, r *http.Request) {
	secret := r.Header.Get("X-Tick-Secret")
	if secret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(s.cfg.TickSecret)) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Bad tick secret.")
		return
	}
	live, err := s.store.LiveSessions(r.Context(), s.defaultCostProject())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal", "Could not read live sessions.")
		return
	}
	byProject := map[string]int{}
	for _, l := range live {
		byProject[l.Project]++
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, liveStatusResponse{Live: live, Count: len(live), ByProject: byProject})
}

// liveStatusResponse is GET /api/internal/live-status.
type liveStatusResponse struct {
	Live      []store.LiveSession `json:"live"`
	Count     int                 `json:"count"`
	ByProject map[string]int      `json:"byProject"`
}
