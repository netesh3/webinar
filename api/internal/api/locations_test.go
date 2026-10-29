package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// joinFrom joins as joinWithUA does, from where the site Worker says: X-Viewer-Country and
// the URI-encoded X-Viewer-Region and X-Viewer-City, each left off when "".
func (h *harness) joinFrom(slug, joinKey, ua, country, region, city string) {
	h.t.Helper()
	body, _ := json.Marshal(types.JoinRequest{JoinKey: joinKey})
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/webinars/"+slug+"/join", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ua)
	if country != "" {
		req.Header.Set("X-Viewer-Country", country)
	}
	if region != "" {
		req.Header.Set("X-Viewer-Region", region)
	}
	if city != "" {
		req.Header.Set("X-Viewer-City", city)
	}
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("join (%s): %d %s", country, res.StatusCode, raw)
	}
	if h.server != nil {
		h.server.WaitBackground()
	}
}

func (h *harness) locations(path string) (int, types.AudienceLocations) {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, path, nil)
	var out types.AudienceLocations
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res.StatusCode, out
}

func locationOf(c []types.LocationCount, key string) int {
	for _, x := range c {
		if x.Key == key {
			return x.Count
		}
	}
	return 0
}

// cityOf is the people in one city, told apart by its country and region.
func cityOf(c []types.CityCount, country, region, city string) int {
	for _, x := range c {
		if x.Country == country && x.Region == region && x.City == city {
			return x.Count
		}
	}
	return 0
}

/* Each person is placed once, where their first join came from: coming back from another
 * country moves nobody. Cloudflare's XX (unknown) and T1 (Tor), a code that is not two
 * letters, and no header at all are all unknown, and a region or a city without a country is
 * dropped. The states are India's. A headless browser is skipped as it is for devices. Both
 * deliveries record it. */
func TestJoinRecordsTheLocationOncePerAttendee(t *testing.T) {
	for _, delivery := range []string{types.DeliveryStandard, types.DeliveryEdge} {
		t.Run(delivery, func(t *testing.T) {
			h := newHarness(t, edgeConfig)
			h.signup("Location Host", "location-host-"+delivery+"@test.dev", true)
			wb := h.liveWebinar("Locations", func(in *types.WebinarInput) { in.Delivery = delivery })

			join := func(email, country, region, city string) string {
				reg := h.registerAsGuest(wb.ID, email)
				h.joinFrom(wb.ID, reg.JoinKey, uaAndroid, country, region, city)
				return reg.JoinKey
			}
			blr := join("blr@test.dev", "IN", "Karnataka", "Bengaluru")
			h.joinFrom(wb.ID, blr, uaMac, "US", "California", "San%20Jose") // travelled: still Bengaluru
			join("blr2@test.dev", "in", "Karnataka", "Bengaluru")           // lower case is fine
			join("mum@test.dev", "IN", "Maharashtra", "Mumbai")
			join("delhi@test.dev", "IN", "", "New%20Delhi")                   // India, state not given
			join("tn@test.dev", "IN", "Tamil%20Nadu", "")                     // the Worker URI-encodes it; no city
			join("sp@test.dev", "BR", "S%C3%A3o%20Paulo", "S%C3%A3o%20Paulo") // and keeps it UTF-8
			join("xx@test.dev", "XX", "Somewhere", "Nowhere")                 // Cloudflare does not know
			join("tor@test.dev", "T1", "", "")                                // Tor
			join("bad@test.dev", "U1", "", "")                                // not a country
			join("none@test.dev", "", "Karnataka", "Bengaluru")               // a region and city with no country
			mix := h.registerAsGuest(wb.ID, "mix@test.dev")
			h.joinFrom(wb.ID, mix.JoinKey, uaMix, "IN", "Kerala", "Kochi") // our own mix: never counted

			code, l := h.locations("/api/host/webinars/" + wb.ID + "/locations")
			if code != http.StatusOK {
				t.Fatalf("host locations: %d", code)
			}
			if l.Attendees != 11 || l.Recorded != 6 || l.Unknown != 5 {
				t.Fatalf("attendees %d recorded %d unknown %d, want 11, 6 and 5: %+v", l.Attendees, l.Recorded, l.Unknown, l)
			}
			if locationOf(l.Countries, "IN") != 5 || locationOf(l.Countries, "BR") != 1 || len(l.Countries) != 2 {
				t.Fatalf("countries = %+v, want IN 5 BR 1", l.Countries)
			}
			if l.Countries[0].Key != "IN" {
				t.Fatalf("largest bucket first: %+v", l.Countries)
			}
			if locationOf(l.IndiaRegions, "Karnataka") != 2 || locationOf(l.IndiaRegions, "Maharashtra") != 1 ||
				locationOf(l.IndiaRegions, "Tamil Nadu") != 1 || len(l.IndiaRegions) != 3 {
				t.Fatalf("india regions = %+v", l.IndiaRegions)
			}
			if l.IndiaUnknown != 1 {
				t.Fatalf("india unknown = %d, want 1", l.IndiaUnknown)
			}

			// Cities: the first join's, with its region and country; Tamil Nadu gave none.
			if cityOf(l.Cities, "IN", "Karnataka", "Bengaluru") != 2 || cityOf(l.Cities, "IN", "Maharashtra", "Mumbai") != 1 ||
				cityOf(l.Cities, "IN", "", "New Delhi") != 1 || cityOf(l.Cities, "BR", "São Paulo", "São Paulo") != 1 ||
				len(l.Cities) != 4 {
				t.Fatalf("cities = %+v", l.Cities)
			}
			if l.Cities[0].City != "Bengaluru" || l.CitiesOther != 0 || l.CitiesUnknown != 1 {
				t.Fatalf("cities = %+v, other %d unknown %d, want Bengaluru first, 0 and 1", l.Cities, l.CitiesOther, l.CitiesUnknown)
			}

			var region, city string
			if err := h.store.Pool().QueryRow(t.Context(),
				`SELECT region, city FROM attendance WHERE country = 'BR'`).Scan(&region, &city); err != nil {
				t.Fatal(err)
			}
			if region != "São Paulo" || city != "São Paulo" {
				t.Fatalf("region, city = %q, %q, want São Paulo twice", region, city)
			}
			// No city is stored without a country: not XX's, not the headerless one's.
			var stored int
			if err := h.store.Pool().QueryRow(t.Context(),
				`SELECT count(*) FROM attendance WHERE city IS NOT NULL`).Scan(&stored); err != nil {
				t.Fatal(err)
			}
			if stored != 5 {
				t.Fatalf("%d cities stored, want 5", stored)
			}
		})
	}
}

// A region or a city longer than any real one is cut to 64 characters rather than refused.
func TestJoinLocationCapsTheRegion(t *testing.T) {
	h := newHarness(t)
	h.signup("Cap Host", "location-cap@test.dev", true)
	wb := h.liveWebinar("Caps", nil)
	reg := h.registerAsGuest(wb.ID, "long@test.dev")
	long := string(bytes.Repeat([]byte("ab"), 50))
	h.joinFrom(wb.ID, reg.JoinKey, uaIPhone, "IN", long, long+"cd")
	_, l := h.locations("/api/host/webinars/" + wb.ID + "/locations")
	if len(l.IndiaRegions) != 1 || len(l.IndiaRegions[0].Key) != 64 {
		t.Fatalf("india regions = %+v, want one of 64 characters", l.IndiaRegions)
	}
	if len(l.Cities) != 1 || len(l.Cities[0].City) != 64 {
		t.Fatalf("cities = %+v, want one of 64 characters", l.Cities)
	}
}

/* A city is its country, region and city together: Paris in France and Paris in Texas are two.
 * The top ten are listed, the rest summed into CitiesOther. (29 Oct 2026) */
func TestLocationCitiesAreGroupedByCountryAndRegion(t *testing.T) {
	h := newHarness(t)
	h.signup("City Host", "location-cities@test.dev", true)
	wb := h.liveWebinar("Cities", nil)
	n := 0
	join := func(country, region, city string) {
		n++
		reg := h.registerAsGuest(wb.ID, fmt.Sprintf("city%d@test.dev", n))
		h.joinFrom(wb.ID, reg.JoinKey, uaAndroid, country, region, city)
	}
	for range 3 {
		join("FR", "%C3%8Ele-de-France", "Paris")
	}
	for range 2 {
		join("US", "Texas", "Paris")
	}
	join("IN", "Karnataka", "Bengaluru")
	join("IN", "Kerala", "Bengaluru") // not a real place, but it is not Karnataka's
	for i := range 9 {
		join("IN", "Kerala", fmt.Sprintf("Town%d", i))
	}

	_, l := h.locations("/api/host/webinars/" + wb.ID + "/locations")
	if len(l.Cities) != 10 {
		t.Fatalf("%d cities, want the top 10: %+v", len(l.Cities), l.Cities)
	}
	if l.Cities[0] != (types.CityCount{Country: "FR", Region: "Île-de-France", City: "Paris", Count: 3}) ||
		l.Cities[1] != (types.CityCount{Country: "US", Region: "Texas", City: "Paris", Count: 2}) {
		t.Fatalf("cities = %+v, want France's Paris then Texas's", l.Cities)
	}
	if cityOf(l.Cities, "IN", "Karnataka", "Bengaluru") != 1 || cityOf(l.Cities, "IN", "Kerala", "Bengaluru") != 1 {
		t.Fatalf("cities = %+v, want the two Bengalurus apart", l.Cities)
	}
	// 13 places, 16 people: the top ten hold 3+2+8, the other three towns are Other.
	if l.CitiesOther != 3 || l.CitiesUnknown != 0 || l.Recorded != 16 {
		t.Fatalf("other %d unknown %d recorded %d, want 3, 0 and 16", l.CitiesOther, l.CitiesUnknown, l.Recorded)
	}
}

// A host sees their own webinar's locations only; the all-webinar view is the admin's, and
// its window counts people by when they first joined.
func TestLocationCountsAreTheHostsAndTheAdmins(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "locations-owner@test.dev", true)
	wb := h.liveWebinar("Owner's session", nil)
	recent := h.registerAsGuest(wb.ID, "recent@test.dev")
	h.joinFrom(wb.ID, recent.JoinKey, uaAndroid, "IN", "Kerala", "Kochi")
	old := h.registerAsGuest(wb.ID, "old@test.dev")
	h.joinFrom(wb.ID, old.JoinKey, uaMac, "GB", "England", "London")
	// The GB viewer first joined 20 days ago: in the 30-day window, not the 7-day one.
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE attendance SET first_joined_at = now() - interval '20 days' WHERE country = 'GB'`); err != nil {
		t.Fatal(err)
	}

	h.signup("Other Host", "locations-other@test.dev", true)
	if code, _ := h.locations("/api/host/webinars/" + wb.ID + "/locations"); code == http.StatusOK {
		t.Fatalf("another host read this webinar's locations")
	}
	if code, _ := h.locations("/api/admin/locations"); code != http.StatusForbidden {
		t.Fatalf("a host read the admin locations: %d, want 403", code)
	}

	h.signup("Admin", "locations-admin@test.dev", false)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"locations-admin@test.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("locations-admin@test.dev")
	code, l := h.locations("/api/admin/locations?days=30")
	if code != http.StatusOK {
		t.Fatalf("admin locations: %d", code)
	}
	if l.Days != 30 || l.Recorded != 2 || locationOf(l.Countries, "IN") != 1 || locationOf(l.Countries, "GB") != 1 ||
		locationOf(l.IndiaRegions, "Kerala") != 1 ||
		cityOf(l.Cities, "IN", "Kerala", "Kochi") != 1 || cityOf(l.Cities, "GB", "England", "London") != 1 {
		t.Fatalf("admin locations (30 days) = %+v", l)
	}
	if _, l = h.locations("/api/admin/locations?days=7"); l.Days != 7 || l.Recorded != 1 || locationOf(l.Countries, "GB") != 0 ||
		len(l.Cities) != 1 || cityOf(l.Cities, "GB", "England", "London") != 0 {
		t.Fatalf("admin locations (7 days) = %+v, want the GB viewer outside it", l)
	}
	if _, l = h.locations("/api/admin/locations?days=12"); l.Days != 7 {
		t.Fatalf("unknown window = %d days, want the default 7", l.Days)
	}
}
