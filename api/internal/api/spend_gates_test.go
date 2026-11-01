package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/types"
)

/* Spend gates (1 Nov 2026): nothing paid is spent on a host whose plan does not include the
 * feature. Each test counts the calls a fake paid client receives. */

// Every AI feature is refused before the model for a host without its switches.
func TestAIIsNeverCalledForAHostWithoutTheSwitch(t *testing.T) {
	h, model := aiHarness(t, "hi", nil)
	ctx := context.Background()
	host, err := h.store.UserByEmail(ctx, "priya@acme.dev")
	if err != nil {
		t.Fatal(err)
	}
	for _, feature := range []string{
		types.AIFeatureWebinarSetup, types.AIFeatureRecap, types.AIFeatureQACluster, types.AIFeatureQAAnswer,
		types.AIFeatureQAAutoDraft, types.AIFeatureQAAuto, types.AIFeatureQAHarvest, types.AIFeatureLeads,
		types.AIFeatureFollowups, types.AIFeatureChatSpam, types.AIFeatureRepurpose,
		types.AIFeatureHighlights, types.AIFeatureReels, types.AIFeatureClipPosts,
	} {
		if _, err := api.AIComplete(h.server, ctx, feature, host.ID, aiHello); !api.IsAINotOnPlan(err) {
			t.Errorf("%s without ai: err = %v, want not on the plan", feature, err)
		}
	}
	// A host-less call is refused too, except the public site's sales assistant.
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureRecap, "", aiHello); !api.IsAINotOnPlan(err) {
		t.Errorf("recap with no host: err = %v", err)
	}
	if n := model.callCount(); n != 0 {
		t.Fatalf("the model was called %d times for a host without the switch", n)
	}

	// ai alone: the AI features run, the ones with their own switch still do not.
	forceFeature(t, h, host.ID, types.FeatureAI, true)
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureRecap, host.ID, aiHello); err != nil {
		t.Fatalf("recap with ai: %v", err)
	}
	for _, feature := range []string{types.AIFeatureRepurpose, types.AIFeatureQAAuto, types.AIFeatureQAHarvest, types.AIFeatureHighlights} {
		if _, err := api.AIComplete(h.server, ctx, feature, host.ID, aiHello); !api.IsAINotOnPlan(err) {
			t.Errorf("%s with ai only: err = %v, want not on the plan", feature, err)
		}
	}
	if n := model.callCount(); n != 1 {
		t.Fatalf("model calls = %d, want only the recap", n)
	}
	// An admin's override counts: repurpose granted to this host runs.
	forceFeature(t, h, host.ID, types.FeatureRepurpose, true)
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureRepurpose, host.ID, aiHello); err != nil {
		t.Fatalf("repurpose by an admin's override: %v", err)
	}
	// Business gives it all from the plan.
	if _, err := h.store.SetUserPlan(ctx, host.ID, types.PlanBusiness); err != nil {
		t.Fatal(err)
	}
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureQAHarvest, host.ID, aiHello); err != nil {
		t.Fatalf("knowledge on Business: %v", err)
	}
}

// Embeddings (the knowledge base) need ai and ai_knowledge before the embedder is called.
func TestEmbeddingsAreNeverMadeForAHostWithoutTheKnowledgeBase(t *testing.T) {
	h, _ := aiHarness(t, "hi", nil)
	emb := &fakeEmbedder{}
	api.SetEmbedder(h.server, emb)
	ctx := context.Background()
	host, _ := h.store.UserByEmail(ctx, "priya@acme.dev")
	forceFeature(t, h, host.ID, types.FeatureAI, true)
	if _, err := api.AIEmbed(h.server, ctx, host.ID, []string{"fees"}); !api.IsAINotOnPlan(err) {
		t.Fatalf("embed without ai_knowledge: err = %v", err)
	}
	if emb.callCount() != 0 {
		t.Fatalf("the embedder was called %d times", emb.callCount())
	}
	forceFeature(t, h, host.ID, types.FeatureAIKnowledge, true)
	if _, err := api.AIEmbed(h.server, ctx, host.ID, []string{"fees"}); err != nil {
		t.Fatalf("embed with the knowledge base: %v", err)
	}
	if emb.callCount() != 1 {
		t.Fatalf("embedder calls = %d, want 1", emb.callCount())
	}
}

/* Deepgram: a host with AI but no server captions never gets the caption agent, not even for
 * the AI's transcript; the speakers' devices make it. With server captions, it comes. */
func TestCaptionAgentNeverDispatchedWithoutServerCaptions(t *testing.T) {
	h := newHarness(t, captionsConfig)
	email := "spend-captions@test.dev"
	h.signup("Spend Captions", email, true)
	enableAI(t, h, email)
	forceFeature(t, h, h.me().ID, types.FeatureCaptions, false)
	wb := h.liveWebinar("AI without server captions", nil)
	on := true
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &on}); res.StatusCode != http.StatusOK {
		t.Fatalf("captions on: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched("webinar_" + wb.ID); ok {
		t.Fatal("the caption agent (Deepgram) was dispatched for a host without server captions")
	}
	// The after-session pass is refused too.
	res, raw := h.agentPost("/api/internal/transcripts/wanted", testCaptionsSecret, map[string]string{"room": "webinar_" + wb.ID})
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"reason":"plan"`) {
		t.Errorf("transcript wanted for a host without server captions: %s", raw)
	}

	// The same host with server captions: the agent comes for the AI's transcript.
	h.signup("Spend Captions Business", "spend-captions-biz@test.dev", true)
	enableAI(t, h, "spend-captions-biz@test.dev")
	serverCaptionsHost(t, h)
	biz := h.liveWebinar("AI with server captions", nil)
	if _, ok := h.rooms.dispatched("webinar_" + biz.ID); !ok {
		t.Fatal("the caption agent was not dispatched for a host with server captions and AI")
	}
}

/* Audience by device and location is Professional and up (migrations/0181): a Basic host's
 * webinar gets 403 for both breakdowns, a Professional host's gets them, and a Basic
 * subscriber who had them before keeps them (the migration on the old shape). */
func TestAudienceInsightsAreProfessionalAndUp(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	host := h.signup("Insights Host", "insights@test.dev", true)
	wb := h.newWebinar("Insights", nil)
	for _, c := range []struct {
		plan types.Plan
		want int
	}{{"", http.StatusForbidden}, {types.PlanBasic, http.StatusForbidden}, {types.PlanProfessional, http.StatusOK},
		{types.PlanBusiness, http.StatusOK}, {types.PlanEnterprise, http.StatusOK}, {types.PlanStarter, http.StatusOK}} {
		if _, err := h.store.SetUserPlan(ctx, host.ID, c.plan); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{"/devices", "/locations"} {
			res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+path, nil)
			if res.StatusCode != c.want {
				t.Errorf("plan %q %s: %d %s, want %d", c.plan, path, res.StatusCode, raw, c.want)
			}
			if c.want == http.StatusForbidden && !strings.Contains(string(raw), "Professional") {
				t.Errorf("plan %q %s refusal does not name the plan: %s", c.plan, path, raw)
			}
		}
	}

	// The migration keeps it for a Basic subscriber who had it.
	if _, err := h.store.SetUserPlan(ctx, host.ID, types.PlanBasic); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ConvertAudienceInsights(ctx); err != nil {
		t.Fatal(err)
	}
	if u, _ := h.store.UserByID(ctx, host.ID); !u.HasFeature(types.FeatureAudienceInsights) {
		t.Fatalf("the Basic subscriber lost audience insights: %v", u.Features)
	}
	if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/devices", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("kept by the override: %d %s", res.StatusCode, raw)
	}
}

// insightsHost gives the signed-in host audience insights, as Professional does (0181).
func insightsHost(t *testing.T, h *harness) {
	t.Helper()
	forceFeature(t, h, h.me().ID, types.FeatureAudienceInsights, true)
}
