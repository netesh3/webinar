package config

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

/* The LIVEKIT_PROJECTS template in docs/ADDING-AN-SFU.md is what an operator will paste into a
 * secret. Parsed here so a doc edit Load would reject fails CI instead of the API's next boot. */
func TestTheAddingAnSFUTemplateLoads(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/ADDING-AN-SFU.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	const begin, end = "<!-- LIVEKIT_PROJECTS template: begin -->", "<!-- LIVEKIT_PROJECTS template: end -->"
	i, j := strings.Index(doc, begin), strings.Index(doc, end)
	if i < 0 || j < i {
		t.Fatal("docs/ADDING-AN-SFU.md has lost its LIVEKIT_PROJECTS template markers")
	}
	block := strings.TrimSpace(doc[i+len(begin) : j])
	block = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(block, "```json"), "```"))
	// Placeholders stand for the keys and secrets.
	block = regexp.MustCompile(`"<[^"]*>"`).ReplaceAllString(block, `"placeholder-value-0123456789abcdef"`)

	// The default entry takes its url/key/secret from the legacy three, which stay set.
	c := load(t, projectsEnv(block, map[string]string{
		"BROADCAST_RTMP_BASE": "rtmp://127.0.0.1:1935/live",
		"BROADCAST_HLS_BASE":  "https://live.webinarliv.com/live",
		"LIVEKIT_URL":         "wss://88.198.141.104.sslip.io",
		"LIVEKIT_API_KEY":     "APIlegacykey0123",
		"LIVEKIT_API_SECRET":  "legacy-secret-0123456789abcdef0123456789abcdef",
	}))
	if len(c.LiveKitProjects) != 2 {
		t.Fatalf("got %d projects, want default and edge2", len(c.LiveKitProjects))
	}
	def, edge := c.LiveKitProjects[0], c.LiveKitProjects[1]
	// "default" is what every existing webinar is pinned to; renaming it orphans them.
	if def.ID != legacyProjectID || def.DisplayLabel() != "Hetzner (default)" {
		t.Errorf("first project = %+v, want the legacy default box", def)
	}
	if got := c.BroadcastHLSURLFor("default", "s"); got != "https://live.webinarliv.com/live/s/whep" {
		t.Errorf("default broadcast = %q", got)
	}
	if got := c.BroadcastHLSURLFor(edge.ID, "s"); got != "https://live2.webinarliv.com/live/s/whep" {
		t.Errorf("edge2 broadcast = %q", got)
	}
}

func TestAProjectBroadcastOriginMustBeHTTPS(t *testing.T) {
	err := loadErr(t, projectsEnv(`[{"id":"x","url":"wss://x.example.com","key":"K","secret":"s","broadcastHlsBase":"http://live.example.com/live"}]`, nil))
	if !strings.Contains(err.Error(), "broadcastHlsBase must begin with https://") {
		t.Errorf("error %q does not require https", err)
	}
}

func TestAProjectWithNoLabelIsLabelledByItsID(t *testing.T) {
	c := load(t, projectsEnv(`[{"id":"x","url":"wss://x.example.com","key":"K","secret":"s","label":"  "}]`, nil))
	if got := c.LiveKitProjects[0].DisplayLabel(); got != "x" {
		t.Errorf("label = %q, want the id", got)
	}
}

func TestAProjectWithoutItsOwnOriginUsesTheGlobalOne(t *testing.T) {
	c := load(t, projectsEnv(`[{"id":"x","url":"wss://x.example.com","key":"K","secret":"s"}]`, map[string]string{
		"BROADCAST_RTMP_BASE": "rtmp://127.0.0.1:1935/live",
		"BROADCAST_HLS_BASE":  "https://live.example.com/live",
	}))
	for _, id := range []string{"x", "unknown"} {
		if got := c.BroadcastHLSURLFor(id, "s"); got != "https://live.example.com/live/s/whep" {
			t.Errorf("%s broadcast = %q", id, got)
		}
	}
}
