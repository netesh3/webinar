package config

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

/* The LIVEKIT_PROJECTS value in docs/SFU-BANGALORE.md is what an operator will paste into
 * a secret. It is parsed here, so a doc edit that Load would reject — a typo'd field, a
 * renamed "default" — fails CI instead of the API's next boot. */
func TestTheBangaloreRunbookTemplateLoads(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/SFU-BANGALORE.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	const begin, end = "<!-- LIVEKIT_PROJECTS template: begin -->", "<!-- LIVEKIT_PROJECTS template: end -->"
	i, j := strings.Index(doc, begin), strings.Index(doc, end)
	if i < 0 || j < i {
		t.Fatal("docs/SFU-BANGALORE.md has lost its LIVEKIT_PROJECTS template markers")
	}
	block := doc[i+len(begin) : j]
	block = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(block), "```json")), "```"))
	// The <…> placeholders stand for secrets; give each a value Load accepts.
	block = regexp.MustCompile(`"<[^"]*>"`).ReplaceAllString(block, `"placeholder-value-0123456789abcdef"`)

	c := load(t, projectsEnv(block, map[string]string{
		"BROADCAST_RTMP_BASE": "rtmp://127.0.0.1:1935/live",
		"BROADCAST_HLS_BASE":  "https://live.webinarliv.com/live",
	}))

	if len(c.LiveKitProjects) != 2 {
		t.Fatalf("got %d projects, want blr1 and default", len(c.LiveKitProjects))
	}
	blr1, def := c.LiveKitProjects[0], c.LiveKitProjects[1]
	if blr1.ID != "blr1" || !blr1.Enabled() {
		t.Errorf("first project = %q enabled=%v, want blr1 taking new rooms", blr1.ID, blr1.Enabled())
	}
	// "default" is what every pre-migration webinar is pinned to: renaming it orphans them.
	if def.ID != legacyProjectID || def.Enabled() {
		t.Errorf("second project = %q enabled=%v, want %q disabled", def.ID, def.Enabled(), legacyProjectID)
	}
	if got := c.EnabledLiveKitProjects(); len(got) != 1 || got[0].ID != "blr1" {
		t.Errorf("new rooms may go to %v, want only blr1", got)
	}

	if got, want := c.BroadcastHLSURLFor("blr1", "s"), "https://live-in.webinarliv.com/live/s/whep"; got != want {
		t.Errorf("blr1 broadcast = %q, want %q", got, want)
	}
	if got, want := c.BroadcastHLSURLFor("default", "s"), "https://live.webinarliv.com/live/s/whep"; got != want {
		t.Errorf("default broadcast = %q, want the global %q", got, want)
	}
}

func TestBroadcastHLSURLForFallsBackAndNeedsTheRTMPOrigin(t *testing.T) {
	c := Config{
		BroadcastHLSBase: "https://live.example.com/live",
		LiveKitProjects:  []LiveKitProject{{ID: "blr1", BroadcastHLSBase: "https://live-in.example.com/live"}},
	}
	// No RTMP origin: the broadcast is off everywhere, whatever a project says.
	if got := c.BroadcastHLSURLFor("blr1", "s"); got != "" {
		t.Errorf("without BROADCAST_RTMP_BASE got %q, want empty", got)
	}
	c.BroadcastRTMPBase = "rtmp://127.0.0.1:1935/live"
	if got := c.BroadcastHLSURLFor("", "s"); got != "https://live.example.com/live/s/whep" {
		t.Errorf("unpinned room got %q, want the global origin", got)
	}
	if got := c.BroadcastHLSURLFor("unknown", "s"); got != "https://live.example.com/live/s/whep" {
		t.Errorf("unknown project got %q, want the global origin", got)
	}
}

func TestBroadcastHLSBaseMustBeHTTPS(t *testing.T) {
	err := loadErr(t, projectsEnv(`[
  {"id":"blr1","url":"wss://sfu-in.example.com","key":"API1","secret":"s1","broadcastHlsBase":"http://live-in.example.com/live"}
]`, nil))
	if !strings.Contains(err.Error(), "broadcastHlsBase must begin with https://") {
		t.Errorf("error %q does not name broadcastHlsBase", err)
	}
}
