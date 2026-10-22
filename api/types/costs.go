package types

/* The admin "Cost by host" report: what each host's recorded usage would have cost us.
 *
 * The API returns USAGE, not dollars: hours, GB and counts read from what the platform
 * records (sessions, attendance visits, recordings, ai_usage, the outboxes). The prices are
 * the admin Cost calculator's inputs (web/lib/cost-calculator.ts), applied in the browser by
 * web/lib/host-costs.ts, so a price is edited in one place and the report is re-priced
 * without a request. Every field is additive, so a host's usage is the sum of its sessions'
 * and a provider's the sum of its hosts'. The only money that is exact is AI (ai_usage
 * records the cost of each call). */

// Cost providers: where a session's video server ran. "none" is a session with no video
// server of ours (a simulive plays the recording; a Zoom venue runs on Zoom).
const (
	CostProviderGCP     = "gcp"
	CostProviderHetzner = "hetzner"
	CostProviderDO      = "do"
	CostProviderNone    = "none"
)

// AdminCostUsage is one session's, one host's or one provider's measured usage.
type AdminCostUsage struct {
	Sessions  int `json:"sessions"`
	Webinars  int `json:"webinars"`
	Meetings  int `json:"meetings"`
	Simulives int `json:"simulives"`
	// Attendees is distinct audience identities per session, summed over sessions.
	Attendees int `json:"attendees"`

	// SessionHours is every session's wall time (started to ended), on a video server or not:
	// what the platform share is split by.
	SessionHours float64 `json:"sessionHours"`
	// LiveHours is the wall time of sessions on our video server (webinars and meetings).
	LiveHours float64 `json:"liveHours"`
	/* BoxShareHours is LiveHours split by concurrency on the same video server: an hour two
	 * sessions share counts half an hour to each. Summed over a server, it is the hours the
	 * server was busy. */
	BoxShareHours float64 `json:"boxShareHours"`
	// EdgeLiveHours is the wall time of Edge-delivery webinars (each needs a mix rendered).
	EdgeLiveHours float64 `json:"edgeLiveHours"`
	/* EdgeExtraHours is the render time beyond the first Edge webinar live at once on the same
	 * server, shared among the Edge webinars live then: where the box renders one mix itself
	 * and every concurrent one needs a worker. */
	EdgeExtraHours float64 `json:"edgeExtraHours"`
	// StagePairHours is wall hours × n(n-1) for n distinct people on the stage: stage
	// traffic grows with the pairs (lib/admin-costs.ts stageMbps).
	StagePairHours float64 `json:"stagePairHours"`

	// Viewer time, from attendance visits.
	EdgeViewerHours         float64 `json:"edgeViewerHours"`
	WebRTCViewerHours       float64 `json:"webrtcViewerHours"`
	MeetingParticipantHours float64 `json:"meetingParticipantHours"`
	SimuliveViewerHours     float64 `json:"simuliveViewerHours"`
	// ZoomAttendeeHours is attendance on a Zoom venue: Zoom's bill, not ours.
	ZoomAttendeeHours float64 `json:"zoomAttendeeHours"`

	// Recordings of these sessions: compositor time (a LiveKit egress), recording the Edge mix
	// (no extra encode) and browser uploads; RecordedGB is what was uploaded to storage.
	CompositeRecHours float64 `json:"compositeRecHours"`
	MixRecHours       float64 `json:"mixRecHours"`
	BrowserRecHours   float64 `json:"browserRecHours"`
	RecordedGB        float64 `json:"recordedGb"`

	// Captions: live server captions, and the after-session transcript run.
	CaptionLiveHours  float64 `json:"captionLiveHours"`
	CaptionFinalHours float64 `json:"captionFinalHours"`
}

// AdminCostAI is one AI feature's calls, exactly as ai_usage recorded them.
type AdminCostAI struct {
	Feature          string  `json:"feature"`
	Calls            int     `json:"calls"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	CostUSD          float64 `json:"costUsd"`
}

// AdminCostCount is a number of sends of one kind.
type AdminCostCount struct {
	Kind  string `json:"kind"`
	Count int    `json:"count"`
}

// AdminCostHostExtras is what a host costs outside any one session.
type AdminCostHostExtras struct {
	// GB-days held in the range (GB × days stored), for storage priced by the GB-month.
	RecordingGBDays float64 `json:"recordingGbDays"`
	MediaGBDays     float64 `json:"mediaGbDays"`
	KnowledgeGBDays float64 `json:"knowledgeGbDays"`
	// What is held now.
	RecordingGB float64 `json:"recordingGb"`
	MediaGB     float64 `json:"mediaGb"`
	KnowledgeGB float64 `json:"knowledgeGb"`

	AI       []AdminCostAI    `json:"ai"`
	Emails   []AdminCostCount `json:"emails"`
	WhatsApp []AdminCostCount `json:"whatsapp"`
}

// AdminCostHost is one host's usage: by provider, so each part is priced at its own rates.
type AdminCostHost struct {
	HostID     string                    `json:"hostId"`
	Name       string                    `json:"name"`
	Email      string                    `json:"email"`
	ByProvider map[string]AdminCostUsage `json:"byProvider"`
	Extras     AdminCostHostExtras       `json:"extras"`
}

// AdminCostPlatform is everybody's usage in the range, for the shared costs: the transfer
// pool's effective rate, the video server's idle time and the platform share.
type AdminCostPlatform struct {
	ByProvider map[string]AdminCostUsage `json:"byProvider"`
	// FirstSessionAt is each provider's first session ever (RFC 3339): a box is counted from then.
	FirstSessionAt map[string]string `json:"firstSessionAt"`
	SessionHours   float64           `json:"sessionHours"`
	// UnattributedAIUSD is AI spent with no host (the sales chat, platform jobs).
	UnattributedAIUSD float64 `json:"unattributedAiUsd"`
	// UnattributedRecordingGBDays is storage of deleted recordings whose host is unknown.
	UnattributedRecordingGBDays float64 `json:"unattributedRecordingGbDays"`
}

// AdminCostsResponse is GET /api/admin/costs.
type AdminCostsResponse struct {
	// From and To are the dates asked for (To inclusive, India time); empty is all time.
	From     string `json:"from"`
	To       string `json:"to"`
	Provider string `json:"provider"`
	// RangeStart and RangeEnd are the effective window (RFC 3339): all time starts at the
	// first session, and nothing ends after now.
	RangeStart  string            `json:"rangeStart"`
	RangeEnd    string            `json:"rangeEnd"`
	Hosts       []AdminCostHost   `json:"hosts"`
	Platform    AdminCostPlatform `json:"platform"`
	GeneratedAt string            `json:"generatedAt"`
}

// AdminCostSession is one session in a host's drill-down.
type AdminCostSession struct {
	ID        string         `json:"id"`
	Topic     string         `json:"topic"`
	Kind      string         `json:"kind"`
	Delivery  string         `json:"delivery"`
	Provider  string         `json:"provider"`
	Project   string         `json:"project"`
	StartedAt string         `json:"startedAt"`
	EndedAt   string         `json:"endedAt"`
	Usage     AdminCostUsage `json:"usage"`
}

// AdminCostHostDetail is GET /api/admin/costs/hosts/{id}.
type AdminCostHostDetail struct {
	From        string             `json:"from"`
	To          string             `json:"to"`
	RangeStart  string             `json:"rangeStart"`
	RangeEnd    string             `json:"rangeEnd"`
	Host        AdminCostHost      `json:"host"`
	Sessions    []AdminCostSession `json:"sessions"`
	Platform    AdminCostPlatform  `json:"platform"`
	GeneratedAt string             `json:"generatedAt"`
}
