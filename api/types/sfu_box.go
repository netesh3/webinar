package types

// Video server states a waiting screen shows (VideoServerStatus.State).
const (
	VideoServerReady    = "ready"
	VideoServerStarting = "starting"
	VideoServerFailed   = "failed"
	// VideoServerNone is a session whose server is not started on demand: always ready.
	VideoServerNone = "none"
)

/* VideoServerStatus is GET /api/webinars/{slug}/server: whether the session's video server is
 * up, for the "Starting servers…" waiting screen. Read-only: asking does not start anything
 * (a join does). */
type VideoServerStatus struct {
	State   string `json:"state"`
	Message string `json:"message"`
	// SinceSec is how long it has been in this state; EtaSec a rough wait left while starting.
	SinceSec int `json:"sinceSec"`
	EtaSec   int `json:"etaSec"`
}

// AdminSFUBoxRun is one droplet's life.
type AdminSFUBoxRun struct {
	DropletID int64   `json:"dropletId"`
	CreatedAt string  `json:"createdAt"`
	ReadyAt   string  `json:"readyAt,omitempty"`
	DeletedAt string  `json:"deletedAt,omitempty"`
	Hours     float64 `json:"hours"`
}

/* AdminSFUBox is GET /api/admin/sfu-box: the on-demand video server's state, its recent
 * droplets and the hours it ran in the last 30 days (what the cost calculator can use
 * instead of 24/7). */
type AdminSFUBox struct {
	Enabled        bool             `json:"enabled"`
	Project        string           `json:"project"`
	Desired        string           `json:"desired"`
	Actual         string           `json:"actual"`
	DropletID      int64            `json:"dropletId"`
	Since          string           `json:"since"`
	LastError      string           `json:"lastError"`
	Failures       int              `json:"failures"`
	NextAttemptAt  string           `json:"nextAttemptAt,omitempty"`
	LastNeededAt   string           `json:"lastNeededAt,omitempty"`
	RequestedUntil string           `json:"requestedUntil,omitempty"`
	AlwaysOn       bool             `json:"alwaysOn"`
	WarmLeadMin    int              `json:"warmLeadMin"`
	IdleGraceMin   int              `json:"idleGraceMin"`
	HoursLast30d   float64          `json:"hoursLast30d"`
	Runs           []AdminSFUBoxRun `json:"runs"`
}
