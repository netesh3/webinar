package config

import (
	"strings"
	"testing"
)

/* The player's cushion comes from here (EDGE_TARGET_LATENCY_SEC / _CDN_SEC). Unset must be
 * today's behaviour (3 s for both paths); a value outside 1.5–6 is a typo worth refusing at
 * boot, since 0.3 would stall every viewer and 30 would put them half a minute behind. */
func TestEdgeTargetLatency(t *testing.T) {
	t.Run("unset is 3 s on both paths", func(t *testing.T) {
		c := load(t, map[string]string{})
		d, cdn := c.EdgeTargetsLatency()
		if d != 3 || cdn != 3 {
			t.Fatalf("defaults: direct %v cdn %v, want 3 and 3", d, cdn)
		}
	})
	t.Run("the CDN follows the box unless set", func(t *testing.T) {
		c := load(t, map[string]string{"EDGE_TARGET_LATENCY_SEC": "2.5"})
		if d, cdn := c.EdgeTargetsLatency(); d != 2.5 || cdn != 2.5 {
			t.Fatalf("direct %v cdn %v, want 2.5 and 2.5", d, cdn)
		}
	})
	t.Run("a CDN value of its own", func(t *testing.T) {
		c := load(t, map[string]string{"EDGE_TARGET_LATENCY_SEC": "2.5", "EDGE_TARGET_LATENCY_CDN_SEC": "5"})
		if d, cdn := c.EdgeTargetsLatency(); d != 2.5 || cdn != 5 {
			t.Fatalf("direct %v cdn %v, want 2.5 and 5", d, cdn)
		}
	})
	for _, bad := range []map[string]string{
		{"EDGE_TARGET_LATENCY_SEC": "1"},
		{"EDGE_TARGET_LATENCY_SEC": "7"},
		{"EDGE_TARGET_LATENCY_SEC": "fast"},
		{"EDGE_TARGET_LATENCY_CDN_SEC": "0.5"},
		{"EDGE_TARGET_LATENCY_CDN_SEC": "9"},
	} {
		setEnv(t, bad)
		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "EDGE_TARGET_LATENCY") {
			t.Errorf("%v: want a boot error naming EDGE_TARGET_LATENCY, got %v", bad, err)
		}
	}
}
