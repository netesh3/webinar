package config

import (
	"strings"
	"testing"
	"time"
)

func TestSFUBoxDefaultsAndValidation(t *testing.T) {
	t.Setenv("SFU_BOX_PROJECT", "")
	t.Setenv("DO_API_TOKEN", "")
	b := loadSFUBox()
	if b.Enabled() || b.Region != "blr1" || b.Size != "c-4" || b.Volume != "sfu-data" || b.SnapshotTag != "webinar-sfu-image" ||
		b.ReservedIP != "152.42.156.192" || b.WarmLead != 15*time.Minute || b.IdleGrace != 40*time.Minute || b.AlwaysOn {
		t.Fatalf("defaults = %+v", b)
	}
	c := Config{SFUBox: b}
	if errs := c.validateSFUBox(); len(errs) != 0 {
		t.Fatalf("off box reported %v", errs)
	}

	// A token alone leaves the box unmanaged (the rollback); a project without one is an error.
	c.SFUBox.Token = "tok"
	if errs := c.validateSFUBox(); len(errs) != 0 || c.SFUBox.Enabled() {
		t.Fatalf("a token without a project: %v, enabled %v", errs, c.SFUBox.Enabled())
	}
	c.SFUBox.Token, c.SFUBox.Project = "", "do-blr"
	if errs := c.validateSFUBox(); len(errs) == 0 {
		t.Fatal("a project without a token was accepted")
	}
	// A project that is not in LIVEKIT_PROJECTS.
	c.SFUBox.Token = "tok"
	errs := c.validateSFUBox()
	if len(errs) == 0 || !strings.Contains(errs[0].Error(), "LIVEKIT_PROJECTS") {
		t.Fatalf("unknown project: %v", errs)
	}
	c.LiveKitProjects = []LiveKitProject{{ID: "do-blr", URL: "wss://x", Key: "k", Secret: "s"}}
	if errs := c.validateSFUBox(); len(errs) != 0 {
		t.Fatalf("a good box reported %v", errs)
	}

	t.Setenv("SFU_BOX_ALWAYS_ON", "true")
	t.Setenv("SFU_BOX_IDLE_GRACE", "1h")
	if b := loadSFUBox(); !b.AlwaysOn || b.IdleGrace != time.Hour {
		t.Fatalf("overrides = %+v", b)
	}
}

func TestSFUBoxGrafana(t *testing.T) {
	for _, k := range []string{"GRAFANA_CLOUD_PROM_URL", "GRAFANA_CLOUD_PROM_USER", "GRAFANA_CLOUD_LOKI_URL", "GRAFANA_CLOUD_LOKI_USER", "GRAFANA_CLOUD_TOKEN"} {
		t.Setenv(k, "")
	}
	c := Config{SFUBox: loadSFUBox(), LiveKitProjects: []LiveKitProject{{ID: "do-blr", URL: "wss://x", Key: "k", Secret: "s"}}}
	c.SFUBox.Project, c.SFUBox.Token = "do-blr", "tok"
	if c.SFUBox.Grafana.Set() || len(c.validateSFUBox()) != 0 {
		t.Fatalf("none set: %+v %v", c.SFUBox.Grafana, c.validateSFUBox())
	}

	t.Setenv("GRAFANA_CLOUD_PROM_URL", "https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom/push")
	t.Setenv("GRAFANA_CLOUD_PROM_USER", "1234567")
	t.Setenv("GRAFANA_CLOUD_LOKI_URL", "https://logs-prod-028.grafana.net/loki/api/v1/push")
	t.Setenv("GRAFANA_CLOUD_LOKI_USER", "765432")
	c.SFUBox.Grafana = loadSFUBox().Grafana
	errs := c.validateSFUBox()
	if c.SFUBox.Grafana.Set() || len(errs) != 1 || !strings.Contains(errs[0].Error(), "GRAFANA_CLOUD_TOKEN") {
		t.Fatalf("four of five: %v", errs)
	}

	t.Setenv("GRAFANA_CLOUD_TOKEN", "glc_eyJvIjoiMTIzIiwibiI6IndlYmluYXIifQ==")
	c.SFUBox.Grafana = loadSFUBox().Grafana
	if !c.SFUBox.Grafana.Set() || len(c.validateSFUBox()) != 0 {
		t.Fatalf("all five: %v", c.validateSFUBox())
	}

	// A value the box's .env cannot carry is refused, and the error does not repeat it.
	c.SFUBox.Grafana.Token = "glc_abc'$(reboot)"
	errs = c.validateSFUBox()
	if len(errs) != 1 || strings.Contains(errs[0].Error(), "glc_") || !strings.Contains(errs[0].Error(), "GRAFANA_CLOUD_TOKEN") {
		t.Fatalf("unsafe token: %v", errs)
	}
}
