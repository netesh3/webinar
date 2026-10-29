package types

/* The audience by location: where each person joined from, as Cloudflare places their network
 * (the site Worker's X-Viewer-Country and X-Viewer-Region), kept per attendee (attendance,
 * migration 0171). The country, and the region inside it; never the city or the IP.
 *
 *   GET /api/host/webinars/{slug}/locations   one webinar, for its host
 *   GET /api/admin/locations?days=7           every webinar, people who first joined in the window
 *
 * People, not page loads: one attendee is counted once, where they first joined from. Recorded
 * from 29 Oct 2026; everyone before is unknown. */

// LocationCount is one bucket: an ISO 3166-1 alpha-2 country ("IN", "US") or, inside India,
// a state or territory as Cloudflare names it ("Karnataka").
type LocationCount struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// AudienceLocations is the audience's locations, largest bucket first.
type AudienceLocations struct {
	// Attendees is everyone in the audience; Recorded is those whose country is known. The
	// difference (Unknown) joined before locations were recorded, came from a network
	// Cloudflare could not place (or Tor), or was only seen by the video server.
	Attendees int             `json:"attendees"`
	Recorded  int             `json:"recorded"`
	Unknown   int             `json:"unknown"`
	Countries []LocationCount `json:"countries"`
	// IndiaRegions is the people from India by state; IndiaUnknown is those from India whose
	// state Cloudflare did not give.
	IndiaRegions []LocationCount `json:"indiaRegions"`
	IndiaUnknown int             `json:"indiaUnknown"`
	// Days is the admin's window; 0 for one webinar.
	Days int `json:"days,omitempty"`
}
