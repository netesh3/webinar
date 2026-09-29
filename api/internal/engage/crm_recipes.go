package engage

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Recipes: ready-made automations over the drip and bot engines. See migrations/0062 and
 * docs/engage/V2.md, "Phase 4".
 *
 * A follow-up recipe is a drip after every webinar for one Follow up group — an engagement
 * tier or the no-shows — with one message a delay after the end. Keyword replies are one
 * small bot per word. Hot leads is a rule of its own: a word in a reply tags the person.
 * The reminders card is the reminder settings, shown here so every automation is in one
 * place; it is turned on and off where reminders are set. */

type followupPreset struct {
	id, title string
	group     types.EngagementTier
	delayMin  int
	step      string
}

var followupPresets = []followupPreset{
	{types.RecipeNoShow, "Replay for people who missed it", types.TierNoShow, 120, "Replay link"},
	{types.RecipeHigh, "Offer to the highly engaged", types.TierHigh, 60, "Thanks + offer"},
	{types.RecipeEngaged, "Thank-you to the engaged", types.TierEngaged, 120, "Thanks + replay"},
	{types.RecipePassive, "Recap for the passive", types.TierPassive, 24 * 60, "Replay + key moment"},
	{types.RecipeRisk, "Replay for those who left early", types.TierRisk, 24 * 60, "Replay from where they left"},
}

// recipeHints are the words a template for each recipe tends to use, the send dialog's.
var recipeHints = map[string][]string{
	types.RecipeNoShow:  {"missed", "sorry", "replay", "recording"},
	types.RecipeHigh:    {"offer", "program", "thank", "spot", "enrol"},
	types.RecipeEngaged: {"thank", "replay", "offer", "attend"},
	types.RecipePassive: {"replay", "recap", "highlight"},
	types.RecipeRisk:    {"replay", "missed", "left", "part"},
}

var defaultHotWords = []string{"price", "fee", "cost", "program", "1:1", "coaching", "enrol"}

const hotLeadTagName = "Hot lead"

func presetFor(id string) (followupPreset, bool) {
	for _, p := range followupPresets {
		if p.id == id {
			return p, true
		}
	}
	return followupPreset{}, false
}

func delayText(min int) string {
	switch {
	case min%1440 == 0:
		if min == 1440 {
			return "next day"
		}
		return strconv.Itoa(min/1440) + " days after"
	case min%60 == 0:
		return strconv.Itoa(min/60) + " h after end"
	default:
		return strconv.Itoa(min) + " min after end"
	}
}

func groupSegment(g types.EngagementTier) types.CRMSegment {
	if g == types.TierNoShow {
		return types.CRMSegment{Attendance: types.SegmentNoShow}
	}
	return types.CRMSegment{Attendance: types.SegmentJoined, Tiers: []types.EngagementTier{g}}
}

func groupLabel(g types.EngagementTier) string {
	if g == types.TierNoShow {
		return "Didn't join"
	}
	return crmstore.TierLabel(g)
}

// handleCRMRecipes is the Automations page.
func (s *Module) handleCRMRecipes(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	out, err := s.recipes(r.Context(), user)
	if err != nil {
		s.fail(w, r, "crm recipes", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Module) recipes(ctx context.Context, user store.User) (types.CRMRecipesResponse, error) {
	out := types.CRMRecipesResponse{
		WhatsAppConnected: user.WhatsAppToken != "" && user.WhatsAppPhoneNumberID != "",
		Recipes:           []types.CRMRecipe{},
	}
	drips, err := s.store.RecipeDrips(ctx, user.ID)
	if err != nil {
		return out, err
	}
	lastSlug, lastTopic, err := s.store.LatestEndedWebinar(ctx, user.ID)
	if err != nil {
		return out, err
	}

	// Reminders: the reminder settings, as a card.
	rem := types.CRMRecipe{ID: types.RecipeReminders, Title: "Reminders", Kind: "reminders",
		Flow: []string{"Registers", "Confirmation", "Before it starts", "Reminders"}}
	if tpls, err := s.store.ReminderTemplates(ctx, user.ID); err == nil {
		for _, t := range tpls {
			if t.Template != "" && t.Kind != types.NotifyWhatsAppReplay {
				rem.Active, rem.Configured = true, true
			}
		}
	}
	if sent, read, err := s.store.ReminderReads(ctx, user.ID, 30); err == nil {
		rem.Sent = sent
		if sent > 0 {
			rem.Hint = strconv.Itoa(sent) + " sent in the last 30 days · " +
				strconv.Itoa(read*100/sent) + "% read"
		}
	}
	out.Recipes = append(out.Recipes, rem)

	// The follow-up groups.
	for _, p := range followupPresets {
		c := types.CRMRecipe{ID: p.id, Title: p.title, Kind: "followup", Group: p.group,
			DelayMin: p.delayMin, Flow: []string{groupLabel(p.group), delayText(p.delayMin), p.step}}
		if d, ok := drips[p.id]; ok {
			c.Active, c.Configured, c.DripID = d.Active, true, d.ID
			c.Sent = d.Stats.Sent
			if len(d.Steps) > 0 {
				c.Template, c.Language, c.Params = d.Steps[0].Template, d.Steps[0].Language, d.Steps[0].Params
				c.DelayMin = d.Steps[0].DelayMinutes
				c.Flow[1] = delayText(c.DelayMin)
			}
		}
		if c.Active {
			c.Hint = "Sent " + strconv.Itoa(c.Sent) + " so far"
		} else if lastSlug != "" {
			seg := groupSegment(p.group)
			a, err := s.store.AudienceCounts(ctx, user.ID, crmstore.Audience{
				Kind: types.AudienceSegment, WebinarSlug: lastSlug, Segment: &seg})
			if err != nil {
				return out, err
			}
			n := a.Recipients
			c.Hint = "Would have reached " + strconv.Itoa(n) + people(n) + " from " + lastTopic
		}
		out.Recipes = append(out.Recipes, c)
	}

	// Keyword replies.
	kw := types.CRMRecipe{ID: types.RecipeKeywords, Title: "Keyword replies", Kind: "keywords",
		Keywords: []types.CRMRecipeKeyword{}}
	bots, err := s.store.RecipeBots(ctx, user.ID, types.RecipeKeywords+":")
	if err != nil {
		return out, err
	}
	for _, b := range bots {
		kw.Configured = true
		kw.Active = kw.Active || b.Active
		kw.Keywords = append(kw.Keywords, types.CRMRecipeKeyword{Word: strings.ToUpper(b.Word), Reply: b.Reply})
	}
	if len(kw.Keywords) == 0 {
		kw.Flow = []string{`"PRICE"`, "Program details", `"REPLAY"`, "Replay link"}
		kw.Hint = "Answers common questions at any hour"
	} else {
		for _, k := range kw.Keywords[:min(2, len(kw.Keywords))] {
			kw.Flow = append(kw.Flow, `"`+k.Word+`"`, "Your reply")
		}
		words := []string{}
		for _, k := range kw.Keywords {
			words = append(words, k.Word)
		}
		if n, err := s.store.KeywordAsks(ctx, user.ID, words, 30); err == nil && n > 0 {
			kw.Hint = strconv.Itoa(n) + people(n) + " sent one of these in the last 30 days"
		} else {
			kw.Hint = strconv.Itoa(len(kw.Keywords)) + " keyword(s) answered automatically"
		}
	}
	out.Recipes = append(out.Recipes, kw)

	// Hot leads.
	rule, err := s.store.HotLeadRule(ctx, user.ID)
	if err != nil {
		return out, err
	}
	hot := types.CRMRecipe{ID: types.RecipeHotLeads, Title: "Tag hot leads", Kind: "hot_leads",
		Active: rule.Active, Configured: len(rule.Words) > 0, Words: rule.Words, Sent: rule.Tagged,
		Flow: []string{"Reply mentions price, program, 1:1", `Tag "` + hotLeadTagName + `"`, "Shows in People"}}
	if len(hot.Words) == 0 {
		hot.Words = defaultHotWords
	}
	if rule.Active {
		hot.Hint = strconv.Itoa(rule.Tagged) + people(rule.Tagged) + " tagged"
	} else if names, n, err := s.store.HotLeadCandidates(ctx, user.ID, hot.Words, 30, 2); err == nil && n > 0 {
		hot.Hint = "Would have tagged " + strings.Join(names, " and ")
		if n > len(names) {
			hot.Hint += " and " + strconv.Itoa(n-len(names)) + " more"
		}
	}
	out.Recipes = append(out.Recipes, hot)
	return out, nil
}

func people(n int) string {
	if n == 1 {
		return " person"
	}
	return " people"
}

// handleSaveCRMRecipe turns a recipe on or off, creating what it runs on the first time.
func (s *Module) handleSaveCRMRecipe(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	id := chi.URLParam(r, "id")
	var body types.CRMRecipeRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if s.whatsapp == nil || !s.whatsapp.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "whatsapp_unset", "WhatsApp is not set up on this instance.")
		return
	}
	if user.WhatsAppToken == "" || user.WhatsAppPhoneNumberID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account before turning on an automation.")
		return
	}
	ctx := r.Context()
	var err error
	switch {
	case id == types.RecipeKeywords:
		if !s.saveKeywordRecipe(w, r, user, body) {
			return
		}
	case id == types.RecipeHotLeads:
		if !s.saveHotLeadRecipe(w, r, user, body) {
			return
		}
	default:
		p, ok := presetFor(id)
		if !ok {
			httpx.Error(w, http.StatusNotFound, "not_found", "No such automation.")
			return
		}
		if !s.saveFollowupRecipe(w, r, user, p, body) {
			return
		}
	}
	out, err := s.recipes(ctx, user)
	if err != nil {
		s.fail(w, r, "crm recipes", err)
		return
	}
	s.log.Info("crm recipe saved", "host", user.ID, "recipe", id, "active", body.Active)
	httpx.JSON(w, http.StatusOK, out)
}

/* saveFollowupRecipe writes the recipe's drip. Turning it off keeps the drip, paused, so
 * turning it back on keeps what was chosen and who has already had it. */
func (s *Module) saveFollowupRecipe(w http.ResponseWriter, r *http.Request, user store.User,
	p followupPreset, body types.CRMRecipeRequest) bool {
	ctx := r.Context()
	drips, err := s.store.RecipeDrips(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "crm recipe: drips", err)
		return false
	}
	existing, has := drips[p.id]
	if !body.Active && strings.TrimSpace(body.Template) == "" {
		if has {
			if err := s.store.SetDripActive(ctx, user.ID, existing.ID, false); err != nil {
				s.fail(w, r, "crm recipe: pause", err)
				return false
			}
		}
		return true
	}
	delay := body.DelayMin
	if delay <= 0 {
		delay = p.delayMin
	}
	trigger := types.DripAttended
	var tiers []types.EngagementTier
	if p.group == types.TierNoShow {
		trigger = types.DripNoShow
	} else {
		tiers = []types.EngagementTier{p.group}
	}
	steps, ok := s.stepsAllowed(w, r, user, []types.CRMDripStep{{
		DelayMinutes: delay, Template: strings.TrimSpace(body.Template),
		Language: body.Language, Params: body.Params,
	}}, trigger, "")
	if !ok {
		return false
	}
	in := crmstore.DripInput{Name: p.title, Trigger: trigger, Tiers: tiers, Active: body.Active,
		Steps: steps, Recipe: p.id}
	id := ""
	if has {
		id = existing.ID
	}
	if _, err := s.store.SaveDrip(ctx, user.ID, id, in); err != nil {
		if errors.Is(err, store.ErrConflict) {
			httpx.Error(w, http.StatusConflict, "crm_recipe_exists", "That automation was just set up — reload and try again.")
			return false
		}
		s.fail(w, r, "crm recipe: save drip", err)
		return false
	}
	return true
}

/* saveKeywordRecipe replaces the keyword bots: one per word, each a single message. The
 * previous ones are deleted, which ends their sessions — a keyword reply has nothing to
 * wait for. */
func (s *Module) saveKeywordRecipe(w http.ResponseWriter, r *http.Request, user store.User, body types.CRMRecipeRequest) bool {
	ctx := r.Context()
	existing, err := s.store.RecipeBots(ctx, user.ID, types.RecipeKeywords+":")
	if err != nil {
		s.fail(w, r, "crm recipe: bots", err)
		return false
	}
	if !body.Active && len(body.Keywords) == 0 {
		for _, b := range existing {
			if err := s.store.SetBotActive(ctx, user.ID, b.ID, false); err != nil {
				s.fail(w, r, "crm recipe: pause bot", err)
				return false
			}
		}
		return true
	}
	type pair struct{ word, reply string }
	var pairs []pair
	seen := map[string]bool{}
	for _, k := range body.Keywords {
		word := strings.ToLower(strings.Join(strings.Fields(k.Word), " "))
		reply := strings.TrimSpace(k.Reply)
		if word == "" && reply == "" {
			continue
		}
		if word == "" || reply == "" {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_recipe_keyword",
				"Each keyword needs a word and the reply to send.")
			return false
		}
		if len([]rune(word)) > maxBotKeywordLen || len([]rune(reply)) > types.BotMaxText {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_recipe_keyword",
				`"`+word+`" or its reply is too long.`)
			return false
		}
		if isWhatsAppStop(word) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_recipe_keyword",
				`"`+word+`" is how people opt out, so it can't start a reply.`)
			return false
		}
		if seen[word] {
			continue
		}
		seen[word] = true
		pairs = append(pairs, pair{word, reply})
	}
	if len(pairs) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_recipe_keyword", "Add at least one keyword and its reply.")
		return false
	}
	if len(pairs) > maxBotKeywords {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_recipe_keyword",
			"At most "+strconv.Itoa(maxBotKeywords)+" keywords.")
		return false
	}
	for _, b := range existing {
		if err := s.store.DeleteBot(ctx, user.ID, b.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, r, "crm recipe: replace bot", err)
			return false
		}
	}
	for _, p := range pairs {
		id, err := s.store.SaveBot(ctx, user.ID, "", crmstore.BotInput{
			Name: "Keyword · " + strings.ToUpper(p.word), Trigger: types.BotKeyword,
			Keywords: []string{p.word}, Entry: "reply", Active: body.Active,
			Nodes: []types.CRMBotNode{{Key: "reply", Kind: types.BotNodeMessage, Text: p.reply}},
		})
		if err != nil {
			s.fail(w, r, "crm recipe: save bot", err)
			return false
		}
		if err := s.store.MarkBotRecipe(ctx, user.ID, id, types.RecipeKeywords+":"+p.word); err != nil {
			s.fail(w, r, "crm recipe: mark bot", err)
			return false
		}
	}
	return true
}

// saveHotLeadRecipe writes the rule, creating the "Hot lead" tag the first time.
func (s *Module) saveHotLeadRecipe(w http.ResponseWriter, r *http.Request, user store.User, body types.CRMRecipeRequest) bool {
	ctx := r.Context()
	if !s.featureAllowed(w, user, types.FeatureCRMTags) {
		return false
	}
	words := []string{}
	for _, raw := range body.Words {
		if wd := strings.ToLower(strings.TrimSpace(raw)); wd != "" && !contains(words, wd) {
			words = append(words, wd)
		}
	}
	if len(words) == 0 {
		words = defaultHotWords
	}
	tagID := ""
	if body.Active {
		tag, err := s.store.CreateTag(ctx, user.ID, hotLeadTagName)
		if err != nil {
			s.fail(w, r, "crm recipe: hot lead tag", err)
			return false
		}
		tagID = tag.ID
	}
	if err := s.store.SaveHotLeadRule(ctx, user.ID, body.Active, words, tagID); err != nil {
		s.fail(w, r, "crm recipe: hot leads", err)
		return false
	}
	return true
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

/* tagHotLead runs on an inbound message: a reply mentioning one of the words tags the
 * person, once. Failures are logged; the message is already in the thread. */
func (s *Module) tagHotLead(ctx context.Context, host store.User, contactID, text string) {
	rule, err := s.store.HotLeadRule(ctx, host.ID)
	if err != nil {
		s.log.Warn("crm: hot lead rule", "host", host.ID, "error", err)
		return
	}
	if !rule.Active || rule.TagID == "" || !crmstore.MatchesHotLead(text, rule.Words) {
		return
	}
	if err := s.applyTag(ctx, host, contactID, rule.TagID); err != nil {
		s.log.Warn("crm: hot lead tag", "host", host.ID, "contact", contactID, "error", err)
	}
}
