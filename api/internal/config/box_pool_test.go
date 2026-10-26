package config

import (
	"strings"
	"testing"
)

/* The box pool's config (SFU_BOX_SLOTS, SFU_BOX_AREA, SFU_BOX_CAPACITY, SFU_BOX_POINTS): a slot
 * inherits what it does not set, carries its own managed tags, and two slots may not share a
 * droplet name, volume, reserved IP or project. */

func poolEnv(t *testing.T, slots string) Config {
	t.Helper()
	t.Setenv("SFU_BOX_PROJECT", "do-blr")
	t.Setenv("DO_API_TOKEN", "tok")
	t.Setenv("SFU_BOX_SLOTS", slots)
	c := Config{SFUBox: loadSFUBox(), LiveKitProjects: []LiveKitProject{
		{ID: "do-blr", URL: "wss://a", Key: "k", Secret: "s"},
		{ID: "do-blr-2", URL: "wss://b", Key: "k", Secret: "s"},
		{ID: "do-us", URL: "wss://c", Key: "k", Secret: "s"},
	}}
	return c
}

func TestBoxPoolOfOneIsTheBoxAsBefore(t *testing.T) {
	c := poolEnv(t, "")
	if boxes := c.SFUBoxes(); len(boxes) != 1 || boxes[0].Project != "do-blr" || boxes[0].ManagedTag != "webinar-sfu-ondemand" {
		t.Fatalf("pool = %+v", boxes)
	}
	if b := c.SFUBox; b.Area != "in" || b.Capacity != 100 || b.Points != DefaultBoxPoints() {
		t.Fatalf("area %q capacity %d points %+v", b.Area, b.Capacity, b.Points)
	}
	if got := strings.Join(c.BoxAreas(), ","); got != "in" {
		t.Fatalf("areas = %s", got)
	}
	if errs := c.validateSFUBox(); len(errs) != 0 {
		t.Fatalf("a pool of one reported %v", errs)
	}
	off := Config{}
	if off.SFUBoxes() != nil || off.BoxAreas() != nil {
		t.Fatal("an off box has a pool")
	}
}

func TestBoxPoolSlotsInheritAndKeepTheirOwnTags(t *testing.T) {
	c := poolEnv(t, `[
		{"project":"do-blr-2","name":"sfu-blr-2","volume":"sfu-data-2","reservedIp":"10.0.0.2"},
		{"project":"do-us","name":"sfu-nyc-1","area":"US","region":"nyc3","volume":"sfu-data-us","reservedIp":"10.0.0.3","capacity":200}
	]`)
	if errs := c.validateSFUBox(); len(errs) != 0 {
		t.Fatalf("a good pool reported %v", errs)
	}
	boxes := c.SFUBoxes()
	if len(boxes) != 3 {
		t.Fatalf("pool of %d", len(boxes))
	}
	blr2, us := boxes[1], boxes[2]
	if blr2.Token != "tok" || blr2.Region != "blr1" || blr2.Size != "c-4" || blr2.Area != "in" || blr2.Capacity != 100 ||
		blr2.SnapshotTag != "webinar-sfu-image" || blr2.Repo != c.SFUBox.Repo || blr2.WarmLead != c.SFUBox.WarmLead {
		t.Fatalf("second slot did not inherit: %+v", blr2)
	}
	if blr2.ManagedTag != "webinar-sfu-ondemand-sfu-blr-2" || blr2.Captions.ManagedTag != c.SFUBox.Captions.ManagedTag+"-sfu-blr-2" ||
		blr2.Captions.Name != "captions-sfu-blr-2" || blr2.Captions.LiveKitURL != "" {
		t.Fatalf("second slot's own tags: %q %q %q", blr2.ManagedTag, blr2.Captions.ManagedTag, blr2.Captions.Name)
	}
	if us.Area != "us" || us.Region != "nyc3" || us.Capacity != 200 || us.VPCUUID != "" {
		t.Fatalf("US slot = %+v", us)
	}
	if got := strings.Join(c.BoxAreas(), ","); got != "in,us" {
		t.Fatalf("areas = %s, want in,us", got)
	}
}

func TestBoxPoolRefusesCollisionsAndBadSlots(t *testing.T) {
	for name, slots := range map[string]string{
		"shared reserved IP": `[{"project":"do-blr-2","name":"sfu-blr-2","volume":"sfu-data-2","reservedIp":"152.42.156.192"}]`,
		"shared volume":      `[{"project":"do-blr-2","name":"sfu-blr-2","volume":"sfu-data","reservedIp":"10.0.0.2"}]`,
		"shared name":        `[{"project":"do-blr-2","name":"sfu-blr-1","volume":"sfu-data-2","reservedIp":"10.0.0.2"}]`,
		"unknown project":    `[{"project":"nowhere","name":"sfu-blr-2","volume":"sfu-data-2","reservedIp":"10.0.0.2"}]`,
		"missing volume":     `[{"project":"do-blr-2","name":"sfu-blr-2","reservedIp":"10.0.0.2"}]`,
		"not JSON":           `{project}`,
	} {
		c := poolEnv(t, slots)
		if errs := c.validateSFUBox(); len(errs) == 0 {
			t.Errorf("%s was accepted", name)
		}
	}
	c := poolEnv(t, "")
	t.Setenv("SFU_BOX_POINTS", `{"mix":25,"viewersPerPoint":20}`)
	b := loadSFUBox()
	if b.Points.Mix != 25 || b.Points.ViewersPerPoint != 20 || b.Points.Extra != 10 || b.Points.MeetingBase != 4 {
		t.Fatalf("points override = %+v (the rest should keep their defaults)", b.Points)
	}
	t.Setenv("SFU_BOX_POINTS", `{mix}`)
	c.SFUBox = loadSFUBox()
	if errs := c.validateSFUBox(); len(errs) == 0 {
		t.Fatal("bad SFU_BOX_POINTS accepted")
	}
}
