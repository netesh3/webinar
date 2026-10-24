package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* "Write with AI" (POST /api/host/ai/webinar-setup) against a fake gpt-5-nano. */

const setupReply = `{
  "title": "  Money basics for young earners  ",
  "description": "A calm hour on budgeting.\n\n\n\nFor anyone in their first job.",
  "registrationHeadline": "Learn to budget your first salary",
  "registrationBullets": ["- Split your salary in three", "Start an emergency fund", "Pick one simple SIP", "  "],
  "socialPosts": {"linkedin": "Join me.", "instagram": "Join me 🙂 #money", "whatsapp": "Join me. Register here:"}
}`

func setupPost(h *harness, body any) (*http.Response, []byte) {
	return h.do(http.MethodPost, "/api/host/ai/webinar-setup", body)
}

// enableAI switches AI on for a host, as an admin does: it is opt-in (migrations/0127).
func enableAI(t *testing.T, h *harness, email string) {
	t.Helper()
	u, err := h.store.UserByEmail(t.Context(), email)
	if err != nil {
		t.Fatal(err)
	}
	enableAIForUser(t, h, u.ID)
}

func TestAIWebinarSetupWritesADraft(t *testing.T) {
	h, model := aiHarness(t, setupReply, nil)

	// Anonymous: no session, no AI.
	if res, _ := setupPost(h, types.AIWebinarSetupRequest{Idea: "budgeting"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", res.StatusCode)
	}

	h.login("priya@acme.dev")
	enableAI(t, h, "priya@acme.dev")
	res, raw := setupPost(h, types.AIWebinarSetupRequest{Idea: "budgeting for people in their first job", Language: "hinglish"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s", res.StatusCode, raw)
	}
	var out types.AIWebinarSetup
	h.decode(raw, &out)
	if out.Title != "Money basics for young earners" {
		t.Errorf("title = %q", out.Title)
	}
	if out.Description != "A calm hour on budgeting.\n\nFor anyone in their first job." {
		t.Errorf("description = %q", out.Description)
	}
	if len(out.RegistrationBullets) != 3 || out.RegistrationBullets[0] != "Split your salary in three" {
		t.Errorf("bullets = %q", out.RegistrationBullets)
	}
	if out.SocialPosts.WhatsApp == "" || out.SocialPosts.LinkedIn == "" || out.SocialPosts.Instagram == "" {
		t.Errorf("social = %+v", out.SocialPosts)
	}

	body := model.lastBody()
	rf, _ := body["response_format"].(map[string]any)
	if rf["type"] != "json_schema" {
		t.Errorf("response_format = %v", body["response_format"])
	}
	msgs, _ := json.Marshal(body["messages"])
	if !strings.Contains(string(msgs), "Hinglish") || !strings.Contains(string(msgs), "budgeting for people in their first job") {
		t.Errorf("messages = %s", msgs)
	}

	// Counted against the month.
	if m := h.adminAI().Month; len(m.Features) != 1 || m.Features[0].Feature != types.AIFeatureWebinarSetup || m.Features[0].Calls != 1 {
		t.Errorf("usage = %+v", m)
	}
}

func TestAIWebinarSetupValidates(t *testing.T) {
	h, model := aiHarness(t, setupReply, nil)
	h.login("priya@acme.dev")
	enableAI(t, h, "priya@acme.dev")
	for name, in := range map[string]types.AIWebinarSetupRequest{
		"empty":    {Idea: "   "},
		"too long": {Idea: strings.Repeat("a", 301)},
		"language": {Idea: "budgeting", Language: "fr"},
	} {
		if res, raw := setupPost(h, in); res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d body %s, want 422", name, res.StatusCode, raw)
		}
	}
	if model.callCount() != 0 {
		t.Fatal("an invalid request reached the model")
	}
}

func TestAIWebinarSetupRefusals(t *testing.T) {
	h, model := aiHarness(t, setupReply, func(c *config.Config) { c.AIHostMonthlyUSD = 0.01 })
	ctx := context.Background()
	h.login("priya@acme.dev")
	enableAI(t, h, "priya@acme.dev")

	// The first draft ($0.045) crosses this host's tiny cap; the next is refused.
	if res, raw := setupPost(h, types.AIWebinarSetupRequest{Idea: "yoga for desk workers"}); res.StatusCode != http.StatusOK {
		t.Fatalf("first: %d %s", res.StatusCode, raw)
	}
	res, raw := setupPost(h, types.AIWebinarSetupRequest{Idea: "yoga for desk workers"})
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if res.StatusCode != http.StatusTooManyRequests || apiErr.Error != "ai_limit" || apiErr.Message != "AI limit reached for this month." {
		t.Fatalf("over the cap: %d %s", res.StatusCode, raw)
	}

	// The switch off for this account: 403 feature_off, and the model is not asked.
	priya, _ := h.store.UserByEmail(ctx, "priya@acme.dev")
	off := false
	if _, err := h.store.SetFeatureOverride(ctx, priya.ID, types.FeatureAI, &off); err != nil {
		t.Fatal(err)
	}
	before := model.callCount()
	res, raw = setupPost(h, types.AIWebinarSetupRequest{Idea: "yoga"})
	h.decode(raw, &apiErr)
	if res.StatusCode != http.StatusForbidden || apiErr.Error != "feature_off" {
		t.Fatalf("feature off: %d %s", res.StatusCode, raw)
	}
	if model.callCount() != before {
		t.Fatal("the model was called for an account with AI off")
	}
}

func TestAIWebinarSetupWithNoProvider(t *testing.T) {
	h := newHarness(t)
	h.login("priya@acme.dev")
	enableAI(t, h, "priya@acme.dev")
	res, raw := setupPost(h, types.AIWebinarSetupRequest{Idea: "yoga"})
	if res.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(raw), "ai_unavailable") {
		t.Fatalf("no provider: %d %s", res.StatusCode, raw)
	}
}

func TestAIWebinarSetupRejectsAReplyThatDoesNotMatch(t *testing.T) {
	h, _ := aiHarness(t, `{"title":"Only a title"}`, nil)
	h.login("priya@acme.dev")
	enableAI(t, h, "priya@acme.dev")
	if res, raw := setupPost(h, types.AIWebinarSetupRequest{Idea: "yoga"}); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("invalid reply: %d %s, want 503", res.StatusCode, raw)
	}
}
