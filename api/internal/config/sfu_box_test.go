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
