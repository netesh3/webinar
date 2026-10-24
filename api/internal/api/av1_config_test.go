package api

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The AV1 kill switch reaches the browser through /api/config: "off" unless the operator
 * says otherwise (an unset or garbled value included), and exactly the mode when they do. */
func TestConfigCarriesAV1KillSwitch(t *testing.T) {
	cases := map[string]string{
		"":                        config.AV1PublishOff,
		"garbage":                 config.AV1PublishOff,
		config.AV1PublishOn:       config.AV1PublishOn,
		config.AV1PublishMeetings: config.AV1PublishMeetings,
	}
	for mode, want := range cases {
		h := newHarness(t, func(c *config.Config) { c.AV1Publish = mode })
		var cfg types.AppConfig
		_, raw := h.do(http.MethodGet, "/api/config", nil)
		h.decode(raw, &cfg)
		if cfg.AV1Publish != want {
			t.Errorf("AV1Publish %q: /api/config av1Publish = %q, want %q", mode, cfg.AV1Publish, want)
		}
	}
}
