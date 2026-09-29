package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func recipes(t *testing.T, h *harness) types.CRMRecipesResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/recipes", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("recipes: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMRecipesResponse
	h.decode(raw, &out)
	return out
}

func saveRecipe(t *testing.T, h *harness, id string, body types.CRMRecipeRequest) types.CRMRecipesResponse {
	t.Helper()
	res, raw := h.do(http.MethodPut, "/api/host/crm/recipes/"+id, body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("save recipe %s: status %d body %s", id, res.StatusCode, raw)
	}
	var out types.CRMRecipesResponse
	h.decode(raw, &out)
	return out
}

func recipeByID(t *testing.T, r types.CRMRecipesResponse, id string) types.CRMRecipe {
	t.Helper()
	for _, x := range r.Recipes {
		if x.ID == id {
			return x
		}
	}
	t.Fatalf("no recipe %s in %+v", id, r.Recipes)
	return types.CRMRecipe{}
}

/* A follow-up recipe is a drip after every webinar for one engagement group. The
 * highly engaged one is enrolled once the scores exist — not at the end, when the tiers
 * are not computed yet — and only the people in that tier. */
func TestRecipeFollowupByTierEnrollsOnScored(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Recipes", true)

	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)

	r := recipes(t, h)
	high := recipeByID(t, r, types.RecipeHigh)
	if high.Active || high.Configured || high.Group != types.TierHigh {
		t.Fatalf("high before = %+v", high)
	}

	r = saveRecipe(t, h, types.RecipeHigh, types.CRMRecipeRequest{
		Active: true, Template: testTemplateMarketing, Language: "en_US",
		Params: []types.CRMParam{}, DelayMin: 60,
	})
	high = recipeByID(t, r, types.RecipeHigh)
	if !high.Active || high.DripID == "" || high.DelayMin != 60 {
		t.Fatalf("high after = %+v", high)
	}
	d := readDrip(t, h, high.DripID).Drip
	if d.Trigger != types.DripAttended || len(d.Tiers) != 1 || d.Tiers[0] != types.TierHigh || d.Recipe != types.RecipeHigh {
		t.Fatalf("recipe drip = %+v", d)
	}

	// Both attended; only Thandi scores high.
	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Minute)
	pinSessionWindow(t, wb.ID, start, start.Add(60*time.Minute))
	seedWatch(t, h, wb.ID, "thandi@example.com", 55, start)
	seedWatch(t, h, wb.ID, "ayanda@example.com", 5, start)

	// At the end of the webinar the tiered sequence is left alone…
	h.engage.OnEnded(context.Background(), types.Webinar{ID: wb.ID, Options: wb.Options})
	if n := len(readDrip(t, h, high.DripID).Enrollments); n != 0 {
		t.Fatalf("enrolled at end = %d, want 0 before scoring", n)
	}
	// …and filled in once the scores are written.
	seedTier(t, h, wb.ID, "thandi@example.com", types.TierHigh)
	seedTier(t, h, wb.ID, "ayanda@example.com", types.TierRisk)
	h.engage.OnScored(context.Background(), wb.ID)
	got := onlyEnrollment(t, readDrip(t, h, high.DripID))
	if got.ContactID != thandi.ID {
		t.Errorf("enrolled %s, want Thandi", got.ContactName)
	}
	// Scoring again enrolls nobody twice.
	h.engage.OnScored(context.Background(), wb.ID)
	onlyEnrollment(t, readDrip(t, h, high.DripID))

	// Off pauses the drip and keeps it; on again brings back the same one.
	r = saveRecipe(t, h, types.RecipeHigh, types.CRMRecipeRequest{Active: false})
	if x := recipeByID(t, r, types.RecipeHigh); x.Active || !x.Configured || x.DripID != high.DripID {
		t.Errorf("after off = %+v", x)
	}
	r = saveRecipe(t, h, types.RecipeHigh, types.CRMRecipeRequest{
		Active: true, Template: testTemplateMarketing, Language: "en_US", Params: []types.CRMParam{}, DelayMin: 60,
	})
	if x := recipeByID(t, r, types.RecipeHigh); !x.Active || x.DripID != high.DripID {
		t.Errorf("after on again = %+v, want the same drip", x)
	}

	// An unknown recipe is not found.
	if res, _ := h.do(http.MethodPut, "/api/host/crm/recipes/nope", types.CRMRecipeRequest{Active: true}); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown recipe status %d", res.StatusCode)
	}
}

/* Keyword replies answer a whole-message keyword; hot leads tag a reply that mentions
 * one of the words, and the page says who it would have tagged before it is on. */
func TestRecipeKeywordRepliesAndHotLeads(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhatsAppCRM)
	wb := autoWebinar(t, h, "Keywords")
	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)

	postWebhook(t, h, inboundNow("wamid.R1", crmPhoneDigits, "Thandi", "What is the price of the program?"))
	hot := recipeByID(t, recipes(t, h), types.RecipeHotLeads)
	if hot.Active || hot.Hint == "" {
		t.Errorf("hot leads before = %+v, want a 'would have tagged' hint", hot)
	}

	saveRecipe(t, h, types.RecipeHotLeads, types.CRMRecipeRequest{Active: true, Words: []string{"price"}})
	r := saveRecipe(t, h, types.RecipeKeywords, types.CRMRecipeRequest{Active: true,
		Keywords: []types.CRMRecipeKeyword{{Word: "Replay", Reply: "Here's the replay: example.com/r"}}})
	kw := recipeByID(t, r, types.RecipeKeywords)
	if !kw.Active || len(kw.Keywords) != 1 || kw.Keywords[0].Word != "REPLAY" {
		t.Fatalf("keywords = %+v", kw)
	}

	before := len(g.sent())
	postWebhook(t, h, inboundNow("wamid.R2", crmPhoneDigits, "Thandi", "replay"))
	if n := len(g.sent()) - before; n != 1 {
		t.Errorf("keyword reply sends = %d, want 1", n)
	}

	postWebhook(t, h, inboundNow("wamid.R3", crmPhoneDigits, "Thandi", "and the PRICE?"))
	th := threadFor(t, h, thandi.ID)
	tagged := false
	for _, tg := range th.Contact.Tags {
		tagged = tagged || tg.Name == "Hot lead"
	}
	if !tagged {
		t.Errorf("tags = %+v, want Hot lead", th.Contact.Tags)
	}
	if x := recipeByID(t, recipes(t, h), types.RecipeHotLeads); !x.Active || x.Sent != 1 {
		t.Errorf("hot leads after = %+v, want 1 tagged", x)
	}

	// STOP can't be a keyword.
	res, _ := h.do(http.MethodPut, "/api/host/crm/recipes/"+types.RecipeKeywords, types.CRMRecipeRequest{
		Active: true, Keywords: []types.CRMRecipeKeyword{{Word: "stop", Reply: "bye"}}})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("stop keyword status %d, want 422", res.StatusCode)
	}
}
