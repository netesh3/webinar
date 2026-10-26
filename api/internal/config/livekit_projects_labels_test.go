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

	// Every entry states its own url/key/secret; no legacy trio (Hetzner, deleted 2026-10-26).
	c := load(t, projectsEnv(block, map[string]string{
		"BROADCAST_RTMP_BASE": "rtmp://127.0.0.1:1935/live",
		"BROADCAST_HLS_BASE":  "https://box.example.test/live",
	}))
	if len(c.LiveKitProjects) != 2 {
		t.Fatalf("got %d projects, want do-blr and edge2", len(c.LiveKitProjects))
	}
	box, edge := c.LiveKitProjects[0], c.LiveKitProjects[1]
	if box.ID != "do-blr" || box.CostProvider() != "do" || box.DisplayLabel() != "Bangalore (DigitalOcean)" {
		t.Errorf("first project = %+v, want the DigitalOcean box", box)
	}
	if edge.CostProvider() != "do" {
		t.Errorf("edge2 provider = %q, want do (the template states it)", edge.CostProvider())
	}
	if got := c.EdgePlaybackURLFor(edge.ID, "s"); got != "https://live2.webinarliv.com/live/s/index.m3u8" {
		t.Errorf("edge2 broadcast = %q", got)
	}
}
