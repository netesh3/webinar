package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// joinFrom joins as joinWithUA does, from where the site Worker says: X-Viewer-Country and
// the URI-encoded X-Viewer-Region, each left off when "".
func (h *harness) joinFrom(slug, joinKey, ua, country, region string) {
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

/* Each person is placed once, where their first join came from: coming back from another
 * country moves nobody. Cloudflare's XX (unknown) and T1 (Tor), a code that is not two
 * letters, and no header at all are all unknown, and a region without a country is dropped.
 * The states are India's. A headless browser is skipped as it is for devices. Both
 * deliveries record it. */
func TestJoinRecordsTheLocationOncePerAttendee(t *testing.T) {
	for _, delivery := range []string{types.DeliveryStandard, types.DeliveryEdge} {
		t.Run(delivery, func(t *testing.T) {
			h := newHarness(t, edgeConfig)
			h.signup("Location Host", "location-host-"+delivery+"@test.dev", true)
			wb := h.liveWebinar("Locations", func(in *types.WebinarInput) { in.Delivery = delivery })

			join := func(email, country, region string) string {
				reg := h.registerAsGuest(wb.ID, email)
				h.joinFrom(wb.ID, reg.JoinKey, uaAndroid, country, region)
				return reg.JoinKey
			}
			blr := join("blr@test.dev", "IN", "Karnataka")
			h.joinFrom(wb.ID, blr, uaMac, "US", "California") // travelled: still Karnataka
			join("blr2@test.dev", "in", "Karnataka")          // lower case is fine
			join("mum@test.dev", "IN", "Maharashtra")
			join("delhi@test.dev", "IN", "")              // India, state not given
			join("tn@test.dev", "IN", "Tamil%20Nadu")     // the Worker URI-encodes it
			join("sp@test.dev", "BR", "S%C3%A3o%20Paulo") // and keeps it UTF-8
			join("xx@test.dev", "XX", "Somewhere")        // Cloudflare does not know
			join("tor@test.dev", "T1", "")                // Tor
			join("bad@test.dev", "U1", "")                // not a country
			join("none@test.dev", "", "Karnataka")        // a region with no country
			mix := h.registerAsGuest(wb.ID, "mix@test.dev")
			h.joinFrom(wb.ID, mix.JoinKey, uaMix, "IN", "Kerala") // our own mix: never counted

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

			var region string
			if err := h.store.Pool().QueryRow(t.Context(),
				`SELECT region FROM attendance WHERE country = 'BR'`).Scan(&region); err != nil {
				t.Fatal(err)
			}
			if region != "São Paulo" {
				t.Fatalf("region = %q, want São Paulo", region)
			}
		})
	}
}

// A region longer than any real one is cut to 64 characters rather than refused.
func TestJoinLocationCapsTheRegion(t *testing.T) {
	h := newHarness(t)
	h.signup("Cap Host", "location-cap@test.dev", true)
	wb := h.liveWebinar("Caps", nil)
	reg := h.registerAsGuest(wb.ID, "long@test.dev")
	h.joinFrom(wb.ID, reg.JoinKey, uaIPhone, "IN", string(bytes.Repeat([]byte("ab"), 50)))
	_, l := h.locations("/api/host/webinars/" + wb.ID + "/locations")
	if len(l.IndiaRegions) != 1 || len(l.IndiaRegions[0].Key) != 64 {
		t.Fatalf("india regions = %+v, want one of 64 characters", l.IndiaRegions)
	}
}

// A host sees their own webinar's locations only; the all-webinar view is the admin's, and
// its window counts people by when they first joined.
func TestLocationCountsAreTheHostsAndTheAdmins(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "locations-owner@test.dev", true)
	wb := h.liveWebinar("Owner's session", nil)
	recent := h.registerAsGuest(wb.ID, "recent@test.dev")
	h.joinFrom(wb.ID, recent.JoinKey, uaAndroid, "IN", "Kerala")
	old := h.registerAsGuest(wb.ID, "old@test.dev")
	h.joinFrom(wb.ID, old.JoinKey, uaMac, "GB", "England")
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
		locationOf(l.IndiaRegions, "Kerala") != 1 {
		t.Fatalf("admin locations (30 days) = %+v", l)
	}
	if _, l = h.locations("/api/admin/locations?days=7"); l.Days != 7 || l.Recorded != 1 || locationOf(l.Countries, "GB") != 0 {
		t.Fatalf("admin locations (7 days) = %+v, want the GB viewer outside it", l)
	}
	if _, l = h.locations("/api/admin/locations?days=12"); l.Days != 7 {
		t.Fatalf("unknown window = %d days, want the default 7", l.Days)
	}
}
