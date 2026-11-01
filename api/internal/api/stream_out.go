package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* Streaming out is Professional and up (types.FeatureStreamOut, migrations/0183, 2 Nov 2026):
 * every egress push and every YouTube API call it causes is ours to pay for. It is checked on
 * the server wherever one starts: setting a webinar's stream (handleSetStream), connecting
 * YouTube (handleYouTubeConnect), saving a LinkedIn, Facebook or Instagram key, turning
 * "Stream to YouTube" on for a webinar, the go-live YouTube broadcast (applyYouTubeLive), and
 * the compositor's destinations (mixPlan). The webinar's host decides; admin overrides count. */

// errStreamOutOff is a stream started for a host whose plan has no stream_out.
var errStreamOutOff = errors.New("stream out is not on this host's plan")

// streamOutMessage is the refusal a host reads.
const streamOutMessage = "Streaming to YouTube, LinkedIn, Facebook, Instagram or RTMP is on the Professional plan and up."

// requireStreamOut answers 403 feature_off unless hostID has stream_out.
func (s *Server) requireStreamOut(w http.ResponseWriter, r *http.Request, hostID string) bool {
	if s.hostHas(r.Context(), hostID, types.FeatureStreamOut) {
		return true
	}
	httpx.Error(w, http.StatusForbidden, "feature_off", streamOutMessage)
	return false
}

// hostStreamsOut is the background form: no response to write.
func (s *Server) hostStreamsOut(ctx context.Context, hostID string) bool {
	return s.hostHas(ctx, hostID, types.FeatureStreamOut)
}

// googleDriveMessage is the refusal for Google Drive below Business.
const googleDriveMessage = "Google Drive is on the Business plan and up."
