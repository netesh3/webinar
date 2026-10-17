package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* "Audience sees only the shared video" is a session control: stored, mirrored into
 * room metadata, muting the stage for the audience by default, the host's (or a
 * co-host's) to change, and gone once the webinar ends. */
func TestAudienceShareOnlyControl(t *testing.T) {
	h := newHarness(t)
	h.signup("Share Host", "share-only-host@test.dev", true)
	wb := h.newWebinar("Replay as live", nil)
	h.goLive(wb.ID)
	room := lk.RoomName(wb.ID)
	on, off := true, false

	patch := func(p types.ControlsPatch) types.Webinar {
		t.Helper()
		res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", p)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("controls: status %d body %s", res.StatusCode, raw)
		}
		var out types.Webinar
		h.decode(raw, &out)
		return out
	}

	got := patch(types.ControlsPatch{AudienceShareOnly: &on})
	if !got.Controls.AudienceShareOnly || !got.Controls.AudienceMuteStage {
		t.Fatalf("on: controls = %+v, want share-only with the stage muted by default", got.Controls)
	}
	if meta := h.rooms.roomMeta(t, room); !meta.Controls.AudienceShareOnly || !meta.Controls.AudienceMuteStage {
		t.Fatalf("room metadata = %+v, want the control pushed", meta.Controls)
	}

	// The host can keep the stage audible while showing only the share.
	got = patch(types.ControlsPatch{AudienceMuteStage: &off})
	if !got.Controls.AudienceShareOnly || got.Controls.AudienceMuteStage {
		t.Fatalf("unmute stage: controls = %+v", got.Controls)
	}
	// Both stated explicitly are both honoured.
	got = patch(types.ControlsPatch{AudienceShareOnly: &on, AudienceMuteStage: &off})
	if !got.Controls.AudienceShareOnly || got.Controls.AudienceMuteStage {
		t.Fatalf("explicit pair: controls = %+v", got.Controls)
	}
	// Turning the view off without a word about the stage un-mutes it as well.
	patch(types.ControlsPatch{AudienceShareOnly: &on})
	got = patch(types.ControlsPatch{AudienceShareOnly: &off})
	if got.Controls.AudienceShareOnly || got.Controls.AudienceMuteStage {
		t.Fatalf("off: controls = %+v, want both off", got.Controls)
	}

	// Another account cannot change it.
	patch(types.ControlsPatch{AudienceShareOnly: &on})
	h.logout()
	h.signup("Other Host", "share-only-other@test.dev", true)
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{AudienceShareOnly: &off}); res.StatusCode == http.StatusOK {
		t.Fatalf("another host changed the control: %s", raw)
	}

	// Live-only: ending the webinar clears it, so it never carries into the next session.
	h.login("share-only-host@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get: status %d body %s", res.StatusCode, raw)
	}
	var ended types.Webinar
	h.decode(raw, &ended)
	if ended.Controls.AudienceShareOnly || ended.Controls.AudienceMuteStage {
		t.Fatalf("after end: controls = %+v, want cleared", ended.Controls)
	}
}
