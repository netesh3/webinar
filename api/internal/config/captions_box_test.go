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

func TestCaptionsBoxDeepgramDefaultsAndValidation(t *testing.T) {
	for _, k := range []string{"CAPTIONS_BOX_SIZE", "CAPTIONS_BOX_CPUS", "CAPTIONS_BOX_MAX_ROOMS", "CAPTIONS_PROVIDER",
		"DEEPGRAM_API_KEY", "CAPTIONS_DEEPGRAM_MODEL", "CAPTIONS_DEEPGRAM_LANGUAGE", "CAPTIONS_FALLBACK_LOCAL"} {
		t.Setenv(k, "")
	}
	if b := loadCaptionsBox(); b.Provider != "local" || b.Size != "s-4vcpu-8gb" || b.MaxRooms != 2 {
		t.Fatalf("unset provider: %q on %q (%d rooms), want local on s-4vcpu-8gb, 2 rooms", b.Provider, b.Size, b.MaxRooms)
	}
	// Deepgram with the local fallback: the box keeps its local size (it may take a room over).
	t.Setenv("CAPTIONS_PROVIDER", "deepgram")
	if b := loadCaptionsBox(); b.Size != "s-4vcpu-8gb" || b.MaxRooms != 2 || !b.FallbackLocal || b.DeepgramModel != "nova-3" || b.DeepgramLanguage != "multi" {
		t.Fatalf("deepgram + fallback = %+v", b)
	}
	// Without it the box only moves audio: 1 vCPU, many rooms.
	t.Setenv("CAPTIONS_FALLBACK_LOCAL", "false")
	if b := loadCaptionsBox(); b.Size != "s-1vcpu-2gb" || b.CPUs != 1 || b.MaxRooms != 8 {
		t.Fatalf("deepgram only: size %q cpus %d rooms %d", b.Size, b.CPUs, b.MaxRooms)
	}
	// An explicit size still wins.
	t.Setenv("CAPTIONS_BOX_SIZE", "s-2vcpu-4gb")
	if b := loadCaptionsBox(); b.Size != "s-2vcpu-4gb" || b.MaxRooms != 16 {
		t.Fatalf("deepgram on 2 vCPU: size %q rooms %d", b.Size, b.MaxRooms)
	}

	base := func() Config {
		c := Config{CaptionsSecret: strings.Repeat("k", 40),
			LiveKitProjects: []LiveKitProject{{ID: "do-blr", URL: "wss://x", Key: "k", Secret: "s"}}}
		c.SFUBox = loadSFUBox()
		c.SFUBox.Project, c.SFUBox.Token = "do-blr", "tok"
		c.SFUBox.Captions = CaptionsBox{On: true, Name: "captions-blr-1", Size: "s-1vcpu-2gb",
			SnapshotTag: "webinar-captions-image", Tags: []string{"webinar-captions"}, Model: "base.en",
			APIURL: "https://webinarliv.com", Provider: CaptionsProviderDeepgram, DeepgramKey: strings.Repeat("d", 40),
			DeepgramModel: "nova-3", DeepgramLanguage: "multi"}.WithDefaults()
		return c
	}
	if errs := base().validateSFUBox(); len(errs) != 0 {
		t.Fatalf("a good deepgram captions box reported %v", errs)
	}
	for name, mutate := range map[string]func(*Config){
		"no key":           func(c *Config) { c.SFUBox.Captions.DeepgramKey = "" },
		"key with a space": func(c *Config) { c.SFUBox.Captions.DeepgramKey = "abc def ghi jkl mno pqr" },
		"unknown provider": func(c *Config) { c.SFUBox.Captions.Provider = "whisperx" },
		"model with quote": func(c *Config) { c.SFUBox.Captions.DeepgramModel = `nova"3` },
	} {
		c := base()
		mutate(&c)
		errs := c.validateSFUBox()
		if len(errs) == 0 {
			t.Errorf("%s: not refused", name)
		}
		for _, e := range errs {
			if strings.Contains(e.Error(), strings.Repeat("d", 40)) {
				t.Errorf("%s: an error echoes the key", name)
			}
		}
	}
}
