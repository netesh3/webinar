package config

import (
	"reflect"
	"testing"
)

/* Delivery by where the viewer is (EdgePlaybackChoiceFor): the box for viewers near it or of
 * unknown country, the CDN for everyone else, each with the other as a fallback; and the old
 * rule, the CDN for everybody, whenever EDGE_NEAR_COUNTRIES or one of the two bases is missing. */
func TestEdgePlaybackChoiceFor(t *testing.T) {
	const box = "https://box.example/live"
	const cdn = "https://zone.b-cdn.net/live"
	const slug = "my-webinar"
	boxURL := box + "/" + slug + "/index.m3u8"
	cdnURL := cdn + "/" + slug + "/index.m3u8"

	withProject := func(near []string) Config {
		return Config{
			BroadcastRTMPBase: "rtmp://127.0.0.1:1935/live",
			EdgeNearCountries: near,
			LiveKitProjects: []LiveKitProject{{
				ID:               "do-blr",
				BroadcastHLSBase: box,
				EdgePlaybackBase: cdn,
			}},
		}
	}

	cases := []struct {
		name    string
		cfg     Config
		project string
		country string
		want    EdgePlaybackChoice
	}{
		{"near viewer plays the box", withProject([]string{"IN"}), "do-blr", "IN",
			EdgePlaybackChoice{URL: boxURL, Path: EdgePathDirect, Fallback: cdnURL}},
		{"lower-case country still matches", withProject([]string{"IN"}), "do-blr", "in",
			EdgePlaybackChoice{URL: boxURL, Path: EdgePathDirect, Fallback: cdnURL}},
		{"far viewer plays the CDN", withProject([]string{"IN"}), "do-blr", "US",
			EdgePlaybackChoice{URL: cdnURL, Path: EdgePathCDN, Fallback: boxURL}},
		{"unknown country plays the box", withProject([]string{"IN"}), "do-blr", "",
			EdgePlaybackChoice{URL: boxURL, Path: EdgePathDirect, Fallback: cdnURL}},
		{"Cloudflare's no-country marker plays the box", withProject([]string{"IN"}), "do-blr", "XX",
			EdgePlaybackChoice{URL: boxURL, Path: EdgePathDirect, Fallback: cdnURL}},
		{"several near countries", withProject([]string{"IN", "LK"}), "do-blr", "LK",
			EdgePlaybackChoice{URL: boxURL, Path: EdgePathDirect, Fallback: cdnURL}},
		{"unset keeps the old rule: the CDN for everybody", withProject(nil), "do-blr", "IN",
			EdgePlaybackChoice{URL: cdnURL}},
		{"no CDN in front: one path, no fallback", Config{
			BroadcastRTMPBase: "rtmp://127.0.0.1:1935/live",
			EdgeNearCountries: []string{"IN"},
			LiveKitProjects:   []LiveKitProject{{ID: "do-blr", BroadcastHLSBase: box}},
		}, "do-blr", "US", EdgePlaybackChoice{URL: boxURL, Path: EdgePathDirect}},
		{"global bases when the project sets none", Config{
			BroadcastRTMPBase: "rtmp://127.0.0.1:1935/live",
			BroadcastHLSBase:  box,
			EdgePlaybackBase:  cdn,
			EdgeNearCountries: []string{"IN"},
		}, "", "DE", EdgePlaybackChoice{URL: cdnURL, Path: EdgePathCDN, Fallback: boxURL}},
		{"no live origin: nothing to play", Config{EdgeNearCountries: []string{"IN"}}, "", "IN",
			EdgePlaybackChoice{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.cfg.EdgePlaybackChoiceFor(tc.project, slug, tc.country)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCountryList(t *testing.T) {
	if got := countryList(" in, lk  US,,"); !reflect.DeepEqual(got, []string{"IN", "LK", "US"}) {
		t.Fatalf("countryList: got %v", got)
	}
	if got := countryList(""); got != nil {
		t.Fatalf("countryList(\"\"): got %v, want nil", got)
	}
}
