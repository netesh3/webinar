package types

/* The audience by device: what each person joined on, read from their join request's
 * User-Agent (api/internal/useragent) and kept per attendee (attendance, migration 0166).
 *
 *   GET /api/host/webinars/{slug}/devices   one webinar, for its host
 *   GET /api/admin/devices?days=7           every webinar, people who first joined in the window
 *
 * People, not page loads: one attendee is counted once, on the device of their first join. */

// DeviceCount is one bucket of a breakdown: a device class ("phone", "tablet",
// "desktop"), an OS ("Android", "iOS", "iPadOS", "macOS", "Windows", "Linux",
// "ChromeOS", "other") or a browser ("Chrome", "Safari", "Firefox", "Edge",
// "Samsung Internet", "other").
type DeviceCount struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// AudienceDevices is the audience's devices, largest bucket first.
type AudienceDevices struct {
	// Attendees is everyone in the audience; Recorded is those whose device is known. The
	// difference joined before devices were recorded, or was only seen by the video server.
	Attendees int           `json:"attendees"`
	Recorded  int           `json:"recorded"`
	Classes   []DeviceCount `json:"classes"`
	OS        []DeviceCount `json:"os"`
	Browsers  []DeviceCount `json:"browsers"`
	// Days is the admin's window; 0 for one webinar.
	Days int `json:"days,omitempty"`
}
