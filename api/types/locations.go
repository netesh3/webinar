package types

/* The audience by location: where each person joined from, as Cloudflare places their network
 * (the site Worker's X-Viewer-Country, X-Viewer-Region and X-Viewer-City), kept per attendee
 * (attendance, migrations 0171 and 0172). The country, the region inside it and the city
 * (from 29 Oct 2026); never the IP.
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

// CityCount is one city, with the region ("" when Cloudflare gave none) and the country it is
// in, so two cities of one name are two buckets.
type CityCount struct {
	Country string `json:"country"`
	Region  string `json:"region"`
	City    string `json:"city"`
	Count   int    `json:"count"`
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
	// Cities is the top ten cities, out of the people whose country is known. CitiesOther is
	// everyone in the cities past those; CitiesUnknown is those with a country but no city
	// (Cloudflare gave none, or they joined before cities were recorded, 29 Oct 2026).
	Cities        []CityCount `json:"cities"`
	CitiesOther   int         `json:"citiesOther"`
	CitiesUnknown int         `json:"citiesUnknown"`
	// Days is the admin's window; 0 for one webinar.
	Days int `json:"days,omitempty"`
}
