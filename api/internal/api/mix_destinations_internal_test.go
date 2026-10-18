package api

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func TestMixBackoffDoublesToACeiling(t *testing.T) {
	cases := map[int]time.Duration{0: 0, 1: 0, 2: 10 * time.Second, 3: 20 * time.Second, 4: 40 * time.Second, 9: 5 * time.Minute, 50: 5 * time.Minute}
	for n, want := range cases {
		if got := mixBackoff(n); got != want {
			t.Errorf("mixBackoff(%d) = %v, want %v", n, got, want)
		}
	}
}

func TestMixRestartBackoffResetsAfterAHealthyRun(t *testing.T) {
	slug := "backoff-test"
	defer forgetMixRestarts(slug)
	t0 := time.Now()
	noteMixStart(slug, t0)
	// A first restart is allowed at once.
	if !mixRestartAllowed(slug, t0.Add(time.Second)) {
		t.Fatal("first restart should be allowed immediately")
	}
	noteMixStart(slug, t0.Add(time.Second))
	// A second one that soon is held back.
	if mixRestartAllowed(slug, t0.Add(3*time.Second)) {
		t.Fatal("a mix that keeps dying should back off")
	}
	if !mixRestartAllowed(slug, t0.Add(time.Second+mixBackoff(2))) {
		t.Fatal("the backoff should expire")
	}
	// One that ran past the healthy window starts the count again.
	noteMixStart(slug, t0.Add(10*time.Minute))
	if !mixRestartAllowed(slug, t0.Add(10*time.Minute+time.Second)) {
		t.Fatal("a healthy run should reset the backoff")
	}
}

func TestSameHostIgnoresTheRedactedKey(t *testing.T) {
	if !sameHost("rtmps://live-api-s.facebook.com:443/rtmp/{redacted}", "rtmps://live-api-s.facebook.com:443/rtmp/FB-123-SECRET") {
		t.Fatal("same server, redacted key: should match")
	}
	if sameHost("rtmps://a.rtmps.youtube.com/live2/x", "rtmps://live-api-s.facebook.com:443/rtmp/y") {
		t.Fatal("different servers matched")
	}
}

func TestFirstOutputPrefersOurOrigin(t *testing.T) {
	dests := []mixDest{{Platform: "stream", URL: "rtmps://yt/k"}, {Platform: "linkedin", URL: "rtmps://li/k"}}
	start, sd, rest := firstOutput("rtmp://origin/live/x", dests)
	if start != "rtmp://origin/live/x" || sd != nil || len(rest) != 2 {
		t.Fatalf("with an origin: start=%q startDest=%v rest=%v", start, sd, rest)
	}
	start, sd, rest = firstOutput("", dests)
	if start != "rtmps://yt/k" || sd == nil || sd.Platform != "stream" || len(rest) != 1 {
		t.Fatalf("without an origin: start=%q startDest=%v rest=%v", start, sd, rest)
	}
}

func TestMixTemplateURLForEdgeWebinars(t *testing.T) {
	s := &Server{}
	s.cfg.RecordingsEgressTemplateURL = "https://webinarliv.com/recorder-template/"
	edge := types.Webinar{Delivery: types.DeliveryEdge}
	plain := types.Webinar{Delivery: types.DeliveryStandard}
	if got := s.mixTemplateURL(plain); got != "https://webinarliv.com/recorder-template/" {
		t.Fatalf("standard = %q, want the template unchanged", got)
	}
	if got := s.mixTemplateURL(edge); got != "https://webinarliv.com/recorder-template/edge" {
		t.Fatalf("edge = %q", got)
	}
	s.cfg.EdgeDebugClock = true
	if got := s.mixTemplateURL(edge); got != "https://webinarliv.com/recorder-template/edge/clock" {
		t.Fatalf("edge with clock = %q", got)
	}
	s.cfg.RecordingsEgressTemplateURL = ""
	if got := s.mixTemplateURL(edge); got != "" {
		t.Fatalf("no template = %q, want empty (LiveKit's own layout)", got)
	}
}
