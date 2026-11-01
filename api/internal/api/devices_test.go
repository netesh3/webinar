package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

const (
	uaIPhone  = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1"
	uaAndroid = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"
	uaMac     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
	uaMix     = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.0.0 Safari/537.36"
)

// joinWithUA joins with a join key and no session, as a browser with that User-Agent does.
func (h *harness) joinWithUA(slug, joinKey, ua string) {
	h.t.Helper()
	body, _ := json.Marshal(types.JoinRequest{JoinKey: joinKey})
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/webinars/"+slug+"/join", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ua)
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("join (%s): %d %s", ua[:20], res.StatusCode, raw)
	}
	if h.server != nil {
		h.server.WaitBackground()
	}
}

func (h *harness) devices(path string) (int, types.AudienceDevices) {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, path, nil)
	var out types.AudienceDevices
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res.StatusCode, out
}

func countOf(c []types.DeviceCount, key string) int {
	for _, x := range c {
		if x.Key == key {
			return x.Count
		}
	}
	return 0
}

/* Each person is counted once, on their first join's device: a reload on another device
 * moves nobody, a headless browser (our own mix, or anything like it) is never counted, and
 * the counts are the host's own webinar only. Both deliveries record it: WebRTC and edge. */
func TestJoinRecordsTheDeviceOncePerAttendee(t *testing.T) {
	for _, delivery := range []string{types.DeliveryStandard, types.DeliveryEdge} {
		t.Run(delivery, func(t *testing.T) {
			h := newHarness(t, edgeConfig)
			h.signup("Device Host", "device-host-"+delivery+"@test.dev", true)
			insightsHost(t, h)
			wb := h.liveWebinar("Devices", func(in *types.WebinarInput) { in.Delivery = delivery })

			phone := h.registerAsGuest(wb.ID, "phone@test.dev")
			droid := h.registerAsGuest(wb.ID, "droid@test.dev")
			mac := h.registerAsGuest(wb.ID, "mac@test.dev")
			bot := h.registerAsGuest(wb.ID, "mix@test.dev")
			h.joinWithUA(wb.ID, phone.JoinKey, uaIPhone)
			h.joinWithUA(wb.ID, phone.JoinKey, uaMac) // came back on a laptop: still the phone
			h.joinWithUA(wb.ID, droid.JoinKey, uaAndroid)
			h.joinWithUA(wb.ID, mac.JoinKey, uaMac)
			h.joinWithUA(wb.ID, bot.JoinKey, uaMix)

			code, d := h.devices("/api/host/webinars/" + wb.ID + "/devices")
			if code != http.StatusOK {
				t.Fatalf("host devices: %d", code)
			}
			if d.Attendees != 4 || d.Recorded != 3 {
				t.Fatalf("attendees %d recorded %d, want 4 and 3 (the headless join unrecorded): %+v", d.Attendees, d.Recorded, d)
			}
			if countOf(d.Classes, "phone") != 2 || countOf(d.Classes, "desktop") != 1 {
				t.Fatalf("classes = %+v, want phone 2 desktop 1", d.Classes)
			}
			if countOf(d.OS, "iOS") != 1 || countOf(d.OS, "Android") != 1 || countOf(d.OS, "macOS") != 1 {
				t.Fatalf("os = %+v", d.OS)
			}
			if countOf(d.Browsers, "Safari") != 1 || countOf(d.Browsers, "Chrome") != 2 {
				t.Fatalf("browsers = %+v", d.Browsers)
			}
			if d.Classes[0].Key != "phone" {
				t.Fatalf("largest bucket first: %+v", d.Classes)
			}
		})
	}
}

// A host sees their own webinar's devices only; the all-webinar view is the admin's.
func TestDeviceCountsAreTheHostsAndTheAdmins(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "devices-owner@test.dev", true)
	wb := h.liveWebinar("Owner's session", nil)
	reg := h.registerAsGuest(wb.ID, "viewer@test.dev")
	h.joinWithUA(wb.ID, reg.JoinKey, uaAndroid)

	h.signup("Other Host", "devices-other@test.dev", true)
	if code, _ := h.devices("/api/host/webinars/" + wb.ID + "/devices"); code == http.StatusOK {
		t.Fatalf("another host read this webinar's devices")
	}
	if code, _ := h.devices("/api/admin/devices"); code != http.StatusForbidden {
		t.Fatalf("a host read the admin devices: %d, want 403", code)
	}

	h.signup("Admin", "devices-admin@test.dev", false)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"devices-admin@test.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("devices-admin@test.dev")
	code, d := h.devices("/api/admin/devices?days=30")
	if code != http.StatusOK {
		t.Fatalf("admin devices: %d", code)
	}
	if d.Days != 30 || d.Recorded != 1 || countOf(d.Classes, "phone") != 1 || countOf(d.OS, "Android") != 1 {
		t.Fatalf("admin devices = %+v", d)
	}
	if _, d = h.devices("/api/admin/devices?days=12"); d.Days != 7 {
		t.Fatalf("unknown window = %d days, want the default 7", d.Days)
	}
}
