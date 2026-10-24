package types

/* The Studio: one place for a host's recordings, the clips and reels made from them, and a
 * light plan of where and when to post each. Behind the clips switch (FeatureClips), like
 * everything it shows. See api/internal/api/studio.go.
 *
 * It lists the caller's OWN sessions only. The per-recording clip endpoints also let a
 * co-host in, but the switch that decides is the session host's, not the co-host's, so a
 * co-host works on those from the session's Recording tab. */

/* StudioNotStarted is a recording nobody has asked to find highlights (or reels) for yet: the
 * same word the recording's own highlights endpoint uses for it. */
const StudioNotStarted = "not_started"

// Plan statuses (ClipPlan.Status): an idea, a day set, done.
const (
	ClipPlanIdea      = "idea"
	ClipPlanScheduled = "scheduled"
	ClipPlanPosted    = "posted"
)

// ClipPlanNoteMaxRunes is the longest note on a plan.
const ClipPlanNoteMaxRunes = 500

// StudioPageSize and StudioMaxPage bound a page of the Studio's lists.
const (
	StudioPageSize = 24
	StudioMaxPage  = 100
)

// Studio clip filters (GET /api/host/studio/clips?status=).
const (
	StudioClipsReady   = "ready"
	StudioClipsPending = "pending" // waiting or being made
	StudioClipsFailed  = "failed"
)

/* StudioRecording is one recording session of the host's ended sessions, with where its
 * highlights, suggested reels and clips stand.
 *
 *   HighlightsStatus  as HighlightsResponse.Status, or StudioNotStarted
 *   ReelsStatus       likewise for the suggested reels
 *   ThumbPartID       the first take with a file, for the thumbnail (…/recordings/{id}/file) */
type StudioRecording struct {
	ID               string `json:"id"`
	Slug             string `json:"slug"`
	Topic            string `json:"topic"`
	Kind             string `json:"kind"`
	SessionAt        string `json:"sessionAt"`
	CreatedAt        string `json:"createdAt"`
	DurationMs       int64  `json:"durationMs"`
	Takes            int    `json:"takes"`
	ThumbPartID      string `json:"thumbPartId"`
	HighlightsStatus string `json:"highlightsStatus"`
	Highlights       int    `json:"highlights"`
	ReelsStatus      string `json:"reelsStatus"`
	Reels            int    `json:"reels"`
	ClipsReady       int    `json:"clipsReady"`
	ClipsPending     int    `json:"clipsPending"`
	ClipsFailed      int    `json:"clipsFailed"`
}

// StudioRecordingsResponse is GET /api/host/studio/recordings?q=&cursor=, newest first.
type StudioRecordingsResponse struct {
	Recordings []StudioRecording `json:"recordings"`
	// NextCursor resumes after the last item, and is empty on the last page.
	NextCursor string `json:"nextCursor,omitempty"`
}

/* ClipPlan is where and when the host means to post a clip, and how far they got. PlannedOn
 * is a day (YYYY-MM-DD) or empty for unplanned. */
type ClipPlan struct {
	Platforms []string `json:"platforms"`
	PlannedOn string   `json:"plannedOn,omitempty"`
	Status    string   `json:"status"`
	Note      string   `json:"note"`
	UpdatedAt string   `json:"updatedAt,omitempty"`
}

/* ClipPlanInput is PATCH /api/host/webinars/{slug}/recordings/{id}/clips/{clipId}/plan, the
 * whole plan as the host left it. A scheduled clip has a day. */
type ClipPlanInput struct {
	Platforms []string `json:"platforms"`
	PlannedOn string   `json:"plannedOn"`
	Status    string   `json:"status"`
	Note      string   `json:"note"`
}

/* StudioClip is one clip or reel with the session it came from (Slug and RecordingID are what
 * its own endpoints are under) and its plan, when it has one. */
type StudioClip struct {
	Clip        Clip      `json:"clip"`
	Slug        string    `json:"slug"`
	RecordingID string    `json:"recordingId"`
	Topic       string    `json:"topic"`
	SessionAt   string    `json:"sessionAt"`
	Plan        *ClipPlan `json:"plan"`
}

/* StudioClipsResponse is GET /api/host/studio/clips?status=&cursor=, newest first, with the
 * video server's state for the line over clips that are waiting. */
type StudioClipsResponse struct {
	Clips      []StudioClip `json:"clips"`
	Server     ClipServer   `json:"server"`
	NextCursor string       `json:"nextCursor,omitempty"`
}
