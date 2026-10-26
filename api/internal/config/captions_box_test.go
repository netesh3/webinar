package config

import (
	"strings"
	"testing"
)

func TestSizeVCPUs(t *testing.T) {
	for size, want := range map[string]int{
		"s-2vcpu-4gb": 2, "s-4vcpu-8gb": 4, "c-2": 2, "c-4": 4, "c2-2vcpu-4gb": 2, "g-2vcpu-8gb": 2, "weird": 0, "": 0,
	} {
		if got := SizeVCPUs(size); got != want {
			t.Errorf("SizeVCPUs(%q) = %d, want %d", size, got, want)
		}
	}
}

func TestCaptionsBoxDefaultsAndValidation(t *testing.T) {
	for _, k := range []string{"CAPTIONS_BOX_ENABLED", "CAPTIONS_BOX_SIZE", "CAPTIONS_BOX_CPUS", "CAPTIONS_BOX_MAX_ROOMS",
		"CAPTIONS_BOX_IMAGE", "CAPTIONS_BOX_TAGS", "CAPTIONS_BOX_MODEL", "CAPTIONS_BOX_API_URL", "CAPTIONS_BOX_LIVEKIT_URL"} {
		t.Setenv(k, "")
	}
	b := loadCaptionsBox()
	if b.On || b.Size != "s-4vcpu-8gb" || b.CPUs != 4 || b.MaxRooms != 2 || b.Model != "base.en" ||
		b.SnapshotTag != "webinar-captions-image" || strings.Join(b.Tags, ",") != "webinar-captions" ||
		b.ManagedTag != "webinar-captions-ondemand" || b.APIURL != "https://webinarliv.com" {
		t.Fatalf("defaults = %+v", b)
	}
	// Capacity follows the size unless set.
	t.Setenv("CAPTIONS_BOX_SIZE", "s-2vcpu-4gb")
	if b := loadCaptionsBox(); b.CPUs != 2 || b.MaxRooms != 1 {
		t.Fatalf("s-2vcpu-4gb: cpus %d rooms %d, want 2 and 1", b.CPUs, b.MaxRooms)
	}
	t.Setenv("CAPTIONS_BOX_SIZE", "s-8vcpu-16gb")
	if b := loadCaptionsBox(); b.CPUs != 8 || b.MaxRooms != 4 {
		t.Fatalf("s-8vcpu-16gb: cpus %d rooms %d, want 8 and 4", b.CPUs, b.MaxRooms)
	}
	t.Setenv("CAPTIONS_BOX_SIZE", "c-4")
	t.Setenv("CAPTIONS_BOX_CPUS", "3")
	if b := loadCaptionsBox(); b.CPUs != 3 || b.MaxRooms != 1 {
		t.Fatalf("c-4 with CPUS=3: cpus %d rooms %d, want 3 and 1", b.CPUs, b.MaxRooms)
	}
	t.Setenv("CAPTIONS_BOX_CPUS", "")
	t.Setenv("CAPTIONS_BOX_MAX_ROOMS", "3")
	if b := loadCaptionsBox(); b.MaxRooms != 3 {
		t.Fatalf("override rooms = %d", b.MaxRooms)
	}

	good := func() Config {
		c := Config{CaptionsSecret: strings.Repeat("k", 40),
			LiveKitProjects: []LiveKitProject{{ID: "do-blr", URL: "wss://x", Key: "k", Secret: "s"}}}
		c.SFUBox = loadSFUBox()
		c.SFUBox.Project, c.SFUBox.Token = "do-blr", "tok"
		c.SFUBox.Captions = CaptionsBox{On: true, Name: "captions-blr-1", Size: "s-2vcpu-4gb",
			SnapshotTag: "webinar-captions-image", Tags: []string{"webinar-captions"}, Model: "base.en",
			APIURL: "https://webinarliv.com"}.WithDefaults()
		c.CaptionsProvider = CaptionsProvider{Name: CaptionsProviderLocal, Explicit: true}
		return c
	}
	if errs := good().validateSFUBox(); len(errs) != 0 {
		t.Fatalf("a good captions box reported %v", errs)
	}
	// Off: nothing is checked.
	off := good()
	off.SFUBox.Captions = CaptionsBox{}
	if errs := off.validateSFUBox(); len(errs) != 0 {
		t.Fatalf("an off captions box reported %v", errs)
	}
	for name, mutate := range map[string]func(*Config){
		"no video box":        func(c *Config) { c.SFUBox.Project = "" },
		"no captions secret":  func(c *Config) { c.CaptionsSecret = "" },
		"unknown size":        func(c *Config) { c.SFUBox.Captions.Size, c.SFUBox.Captions.CPUs = "weird", 0 },
		"bad model":           func(c *Config) { c.SFUBox.Captions.Model = "base.en; rm -rf /" },
		"http api url":        func(c *Config) { c.SFUBox.Captions.APIURL = "http://webinarliv.com" },
		"bad livekit url":     func(c *Config) { c.SFUBox.Captions.LiveKitURL = "https://lk" },
		"video box tag":       func(c *Config) { c.SFUBox.Captions.Tags = []string{"webinar-sfu"} },
		"video managed tag":   func(c *Config) { c.SFUBox.Captions.Tags = []string{"webinar-sfu-ondemand"} },
		"zero rooms":          func(c *Config) { c.SFUBox.Captions.MaxRooms = -1 },
		"short boot timeout":  func(c *Config) { c.SFUBox.Captions.BootTimeout = 1 },
		"tag with a space in": func(c *Config) { c.SFUBox.Captions.Tags = []string{"a b"} },
	} {
		c := good()
		mutate(&c)
		if errs := c.validateSFUBox(); len(errs) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCaptionsRoomsFor(t *testing.T) {
	for vcpus, want := range map[int]int{0: 0, -1: 0, 1: 1, 2: 1, 3: 1, 4: 2, 6: 3, 8: 4} {
		if got := CaptionsRoomsFor(vcpus); got != want {
			t.Fatalf("CaptionsRoomsFor(%d) = %d, want %d", vcpus, got, want)
		}
	}
}

/* The provider: deepgram when DEEPGRAM_API_KEY is set, else local; the captions box only with
 * CAPTIONS_PROVIDER=local set explicitly AND CAPTIONS_BOX_ENABLED=true. */
func TestCaptionsProviderDefaultsAndTheCaptionsBoxSwitch(t *testing.T) {
	for _, k := range []string{"CAPTIONS_PROVIDER", "DEEPGRAM_API_KEY", "CAPTIONS_DEEPGRAM_MODEL",
		"CAPTIONS_DEEPGRAM_LANGUAGE", "CAPTIONS_API_URL", "CAPTIONS_BOX_ENABLED"} {
		t.Setenv(k, "")
	}
	p := loadCaptionsProvider()
	if p.Name != "local" || p.Explicit || p.OnVideoBox() {
		t.Fatalf("no key: %+v", p)
	}
	t.Setenv("CAPTIONS_BOX_ENABLED", "true")
	c := Config{CaptionsProvider: p}
	c.SFUBox.Captions = loadCaptionsBox()
	if c.CaptionsBoxOn() {
		t.Fatal("CAPTIONS_BOX_ENABLED with local only by default made the captions box")
	}

	key := "dg_" + strings.Repeat("x", 37)
	t.Setenv("DEEPGRAM_API_KEY", key)
	p = loadCaptionsProvider()
	if p.Name != "deepgram" || !p.OnVideoBox() || p.DeepgramModel != "nova-3" || p.DeepgramLanguage != "multi" || p.APIURL != "https://webinarliv.com" {
		t.Fatalf("with a key: %+v", p)
	}
	c.CaptionsProvider = p
	if c.CaptionsBoxOn() {
		t.Fatal("deepgram made the captions box")
	}
	if errs := c.validateCaptionsProvider(); len(errs) != 0 {
		t.Fatalf("a good deepgram config reported %v", errs)
	}

	t.Setenv("CAPTIONS_PROVIDER", "local")
	c.CaptionsProvider = loadCaptionsProvider()
	if !c.CaptionsBoxOn() || c.CaptionsProvider.OnVideoBox() {
		t.Fatalf("explicit local with CAPTIONS_BOX_ENABLED: %+v", c.CaptionsProvider)
	}

	for name, p := range map[string]CaptionsProvider{
		"no key":      {Name: "deepgram", DeepgramModel: "nova-3", DeepgramLanguage: "multi", APIURL: "https://webinarliv.com"},
		"key with \n": {Name: "deepgram", DeepgramKey: key + "\nX=1", DeepgramModel: "nova-3", DeepgramLanguage: "multi", APIURL: "https://webinarliv.com"},
		"bad model":   {Name: "deepgram", DeepgramKey: key, DeepgramModel: "nova 3", DeepgramLanguage: "multi", APIURL: "https://webinarliv.com"},
		"http api":    {Name: "deepgram", DeepgramKey: key, DeepgramModel: "nova-3", DeepgramLanguage: "multi", APIURL: "http://webinarliv.com"},
		"unknown":     {Name: "whisper"},
	} {
		errs := (Config{CaptionsProvider: p}).validateCaptionsProvider()
		if len(errs) == 0 {
			t.Errorf("%s: accepted", name)
		}
		for _, err := range errs {
			if strings.Contains(err.Error(), key) {
				t.Errorf("%s: the key is in the error", name)
			}
		}
	}
}
