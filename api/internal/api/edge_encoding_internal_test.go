package api

import (
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
)

// A Server whose config was not built by Load still encodes the edge mix at Load's defaults:
// 720p at 25 fps, 1500 kbps, baseline.
func TestEdgeEncodingDefaults(t *testing.T) {
	enc := (&Server{}).edgeEncoding()
	if enc.Width != 1280 || enc.Height != 720 || enc.FPS != 25 || enc.BitrateKbps != 1500 || enc.Profile != "baseline" {
		t.Errorf("zero config: %+v, want 1280x720@25 1500 kbps baseline", enc)
	}
	enc = (&Server{cfg: config.Config{EdgeEncodingWidth: 1920, EdgeEncodingHeight: 1080, EdgeEncodingFPS: 20,
		EdgeVideoBitrateKbps: 3500, EdgeH264Profile: "high"}}).edgeEncoding()
	if enc.FPS != 20 || enc.Width != 1920 || enc.BitrateKbps != 3500 || enc.Profile != "high" {
		t.Errorf("configured: %+v, want the config's 1080p20 3500 high", enc)
	}
}
