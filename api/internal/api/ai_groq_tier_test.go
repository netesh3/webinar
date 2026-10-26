package api

import (
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

// What a host reads and keeps gets Groq's quality tier; live-session calls get the fast one.
func TestAIGroqModelForTiers(t *testing.T) {
	s := &Server{cfg: config.Config{AIGroqModelQuality: "Q", AIGroqModelFast: "F"}}
	quality := []string{types.AIFeatureRecap, types.AIFeatureFollowups, types.AIFeatureRepurpose,
		types.AIFeatureHighlights, types.AIFeatureReels, types.AIFeatureClipPosts,
		types.AIFeatureLeads, types.AIFeatureWebinarSetup, types.AIFeatureQACluster}
	fast := []string{types.AIFeatureSalesChat, types.AIFeatureChatSpam, types.AIFeatureQAAuto,
		types.AIFeatureQAAutoDraft, types.AIFeatureQAAnswer, types.AIFeatureQAHarvest, "something_new"}
	for _, f := range quality {
		if got := s.aiGroqModelFor(f); got != "Q" {
			t.Errorf("%s = %q, want the quality tier", f, got)
		}
	}
	for _, f := range fast {
		if got := s.aiGroqModelFor(f); got != "F" {
			t.Errorf("%s = %q, want the fast tier", f, got)
		}
	}
}
