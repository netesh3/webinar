package types

/* Highlight clips: the best moments of a recorded session, found from how the audience
 * reacted (reaction bursts, chat and question rates, polls) and what was said, for the host
 * to cut into short videos. See api/internal/api/highlights.go and internal/highlights.
 *
 * The suggestions are counted and then chosen: the engagement around every stretch of the
 * recording is counted in Go, and gpt-5-nano, given the transcript with those counts beside
 * it, picks and titles the moments worth a clip. Each is snapped to sentence boundaries and
 * kept to 20–90 seconds inside one take of the recording, so it can be cut from one file. */

/* FeatureClips is the switch: suggested highlights on a session's recording, and the clips
 * made from them. Needs FeatureAI (the picks count against the monthly AI caps) and
 * FeatureCloudRecording (there is no recording without it). Off for every account until an
 * admin turns it on for a host (Admin -> Accounts), because absent means off. */
const FeatureClips = "clips"

// AIFeatureHighlights is the ai_usage feature name for picking a recording's highlights.
const AIFeatureHighlights = "highlights"

// Bounds on a highlight's length, in seconds.
const (
	HighlightMinSec = 20
	HighlightMaxSec = 90
)

/* HighlightSignals is what the audience did during a highlight (and the few seconds after,
 * when reactions land), counted, never written by a model. */
type HighlightSignals struct {
	Reactions int `json:"reactions"`
	Chat      int `json:"chat"`
	Questions int `json:"questions"`
	Polls     int `json:"polls"`
}

/* Highlight is one suggested moment. StartSec and EndSec are on the recording's player
 * timeline (its takes end to end, as the player plays them), PartID the take it lies in,
 * and PartStartSec its start inside that take's own file. Score is 0–100: how the moment
 * ranks, from the AI's pick and the engagement around it. */
type Highlight struct {
	ID           string           `json:"id"`
	Title        string           `json:"title"`
	Why          string           `json:"why"`
	StartSec     float64          `json:"startSec"`
	EndSec       float64          `json:"endSec"`
	PartID       string           `json:"partId"`
	PartStartSec float64          `json:"partStartSec"`
	Score        int              `json:"score"`
	Signals      HighlightSignals `json:"signals"`
	// Quote is the first sentence said in it, from the transcript, for the list.
	Quote string `json:"quote,omitempty"`
}

/* HighlightsResponse is GET /api/host/webinars/{slug}/recordings/{id}/highlights. Status is
 * ready, processing (being picked: look again shortly), or why there are none: not_ended,
 * ai_off, ai_session_off, ai_limit, ai_unavailable, failed, no_transcript, not_ready (the
 * recording is not ready to play yet). */
type HighlightsResponse struct {
	Status      string      `json:"status"`
	Highlights  []Highlight `json:"highlights"`
	GeneratedAt string      `json:"generatedAt,omitempty"`
}

// Reasons only highlights have (HighlightsResponse.Status); the rest are the recap's.
const (
	HighlightsNoTranscript = "no_transcript"
	HighlightsNotReady     = "not_ready"
)
