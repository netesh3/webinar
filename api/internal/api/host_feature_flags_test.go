package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The per-host switches added for simulive, meetings, the AI sub-features and server
 * captions (migrations/0142): every one is refused by the SERVER without it, a sub-switch is
 * never in effect without its parent, and the admin can set several in one request. */

func forceFeature(t *testing.T, h *harness, userID, key string, on bool) {
	t.Helper()
	if _, err := h.store.SetFeature(context.Background(), userID, key, on); err != nil {
		t.Fatalf("set %s=%v: %v", key, on, err)
	}
}

func TestFeatureCatalogueIsGroupedAndItsRequirementsAreReal(t *testing.T) {
	groups := map[string]bool{}
	for _, g := range types.FeatureGroups {
		groups[g.Key] = true
	}
	for _, f := range types.Features {
		if !groups[f.Group] {
			t.Errorf("%s: group %q is not one of FeatureGroups", f.Key, f.Group)
		}
		for _, r := range f.Requires {
			if !types.KnownFeature(r) || r == f.Key {
				t.Errorf("%s requires %q, which is not another known switch", f.Key, r)
			}
		}
	}
	for _, key := range []string{types.FeatureSimulive, types.FeatureMeetings, types.FeatureAIKnowledge,
		types.FeatureSimuliveAuto, types.FeatureFollowupSend, types.FeatureCaptions} {
		if !types.KnownFeature(key) {
			t.Errorf("%s is not in the catalogue", key)
		}
	}
}

func TestEffectiveFeaturesDropsASubSwitchWithoutItsParent(t *testing.T) {
	for _, tc := range []struct{ in, want []string }{
		{[]string{"ai_knowledge", "followup_send", "simulive_auto", "whiteboard"}, []string{"whiteboard"}},
		{[]string{"ai", "ai_knowledge", "followup_send"}, []string{"ai", "ai_knowledge", "followup_send"}},
		// simulive_auto needs ai, replay_engage and simulive; replay_engage needs simulive.
		{[]string{"ai", "replay_engage", "simulive_auto"}, []string{"ai"}},
		{[]string{"ai", "replay_engage", "simulive", "simulive_auto"}, []string{"ai", "replay_engage", "simulive", "simulive_auto"}},
		{nil, []string{}},
	} {
		if got := types.EffectiveFeatures(tc.in); !slices.Equal(got, tc.want) {
			t.Errorf("EffectiveFeatures(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestSimuliveAndMeetingsNeedTheirSwitch(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Flag Host", "flag-host@test.dev", true)
	orig := h.newWebinar("Original", nil)
	rec := h.insertRecording(orig.ID, "ready", 1000)

	// A new account has meetings and not simulive.
	if a := meAccount(t, h); hasFeature(a.Features, types.FeatureSimulive) || !hasFeature(a.Features, types.FeatureMeetings) {
		t.Fatalf("new account features = %v, want meetings and no simulive", a.Features)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars", simuliveInput(rec))
	h.wantError(res, raw, http.StatusForbidden, "feature_off")

	// A live session cannot be turned into a simulive by an edit either.
	in := simuliveInput(rec)
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+orig.ID, in)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")

	grantFeature(t, h, host.ID, types.FeatureSimulive)
	res, raw = h.do(http.MethodPost, "/api/host/webinars", simuliveInput(rec))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("simulive with the switch: %d %s", res.StatusCode, raw)
	}
	var sim types.Webinar
	h.decode(raw, &sim)

	// Switched off again: saving the simulive is refused, as is a new one.
	forceFeature(t, h, host.ID, types.FeatureSimulive, false)
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+sim.ID, simuliveInput(rec))
	h.wantError(res, raw, http.StatusForbidden, "feature_off")

	// Meetings: on by default, refused (instant and scheduled) once an admin turns them off.
	meeting := types.WebinarInput{Topic: "Stand-up", Kind: types.KindMeeting, Instant: true, TimeZone: "UTC"}
	res, raw = h.do(http.MethodPost, "/api/host/webinars", meeting)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("meeting by default: %d %s", res.StatusCode, raw)
	}
	forceFeature(t, h, host.ID, types.FeatureMeetings, false)
	res, raw = h.do(http.MethodPost, "/api/host/webinars", meeting)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	scheduled := types.WebinarInput{Topic: "Review", Kind: types.KindMeeting, Duration: 30, TimeZone: "UTC",
		StartsAt: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)}
	res, raw = h.do(http.MethodPost, "/api/host/webinars", scheduled)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
}

func TestAISubSwitchesAreEnforced(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	wb, _ := leadsWebinar(t, h, true)
	host, err := h.store.UserByEmail(context.Background(), "engagement-host@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	// With ai on, the sub-switches (on in every tier) are in effect.
	a := meAccount(t, h)
	for _, k := range []string{types.FeatureAIKnowledge, types.FeatureFollowupSend} {
		if !hasFeature(a.Features, k) {
			t.Fatalf("features with ai = %v, want %s", a.Features, k)
		}
	}

	// AI knowledge off: the library refuses, AI writing elsewhere does not.
	forceFeature(t, h, host.ID, types.FeatureAIKnowledge, false)
	res, raw := h.do(http.MethodGet, "/api/host/knowledge", nil)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")

	// Send follow-ups off: the plan (and so the send) is refused.
	forceFeature(t, h, host.ID, types.FeatureFollowupSend, false)
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/followups/plan", types.FollowupPlanRequest{Keys: []string{"x"}})
	h.wantError(res, raw, http.StatusForbidden, "feature_off")

	// And forced on, a sub-switch is still not in effect without ai.
	forceFeature(t, h, host.ID, types.FeatureAIKnowledge, true)
	forceFeature(t, h, host.ID, types.FeatureAI, false)
	if a := meAccount(t, h); hasFeature(a.Features, types.FeatureAIKnowledge) {
		t.Fatalf("features without ai = %v, want no ai_knowledge", a.Features)
	}
	res, raw = h.do(http.MethodGet, "/api/host/knowledge", nil)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	if model.callCount() != 0 {
		t.Fatalf("model called %d times", model.callCount())
	}
}

/* The bug: an account WITH AI whose session had the room's AI switch off was told "AI is
 * switched off for this account" by Hot leads and the follow-up writer. The reason is now
 * the session's, and the account's only when the account lacks AI. */
func TestLeadsAndFollowupsSayTheSessionNotTheAccount(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	wb, _ := leadsWebinar(t, h, true)
	h.exec(`UPDATE webinars SET ai_off_this_session = true WHERE slug = $1`, wb.ID)

	if got := h.getLeads(wb.ID); got.AIStatus != types.RecapReasonAISessionOff || len(got.Leads) != 4 {
		t.Fatalf("leads with the session's AI off = %q (%d leads), want ai_session_off", got.AIStatus, len(got.Leads))
	}
	if f := h.getFollowups(wb.ID, ""); f.Status != types.RecapReasonAISessionOff {
		t.Fatalf("followups with the session's AI off = %q, want ai_session_off", f.Status)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/followups/plan", types.FollowupPlanRequest{Keys: []string{"x"}})
	h.wantError(res, raw, http.StatusForbidden, types.RecapReasonAISessionOff)

	// The room switch itself (controls.aiEnabled) off says the same.
	h.exec(`UPDATE webinars SET ai_off_this_session = false, ai_enabled = false WHERE slug = $1`, wb.ID)
	if got := h.getLeads(wb.ID); got.AIStatus != types.RecapReasonAISessionOff {
		t.Fatalf("leads with the room switch off = %q, want ai_session_off", got.AIStatus)
	}

	// The account without AI: that is the reason, whatever the session's switch says.
	host, err := h.store.UserByEmail(context.Background(), "engagement-host@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	forceFeature(t, h, host.ID, types.FeatureAI, false)
	if got := h.getLeads(wb.ID); got.AIStatus != types.RecapReasonAIOff {
		t.Fatalf("leads on an account without AI = %q, want ai_off", got.AIStatus)
	}
	if f := h.getFollowups(wb.ID, ""); f.Status != types.RecapReasonAIOff {
		t.Fatalf("followups on an account without AI = %q, want ai_off", f.Status)
	}
	if model.callCount() != 0 {
		t.Fatalf("model called %d times with AI off", model.callCount())
	}
}

func TestServerCaptionsNeedTheirSwitch(t *testing.T) {
	h := newHarness(t, captionsConfig)
	host := h.signup("Caption Flag Host", "srvcap-flag@test.dev", true)
	wb := h.liveWebinar("Captions switch", nil)
	forceFeature(t, h, host.ID, types.FeatureCaptions, false)
	res, _, raw := h.setServerCaptions(wb.ID, true)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	if _, ok := h.rooms.dispatched("webinar_" + wb.ID); ok {
		t.Fatal("the caption agent was dispatched with the switch off")
	}
}

func TestAdminSetsSeveralFeaturesAtOnce(t *testing.T) {
	h := newHarness(t)
	target := h.signup("Bulk Host", "bulk-host@test.dev", true)
	h.logout()
	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")

	path := "/api/admin/users/" + target.ID + "/features"
	res, raw := h.do(http.MethodPut, path, types.FeatureGrants{Grants: []types.FeatureGrant{
		{Feature: types.FeatureAI, Enabled: true},
		{Feature: types.FeatureSimulive, Enabled: true},
		{Feature: types.FeatureMeetings, Enabled: false},
	}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("bulk: %d %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	for _, k := range []string{types.FeatureAI, types.FeatureSimulive, types.FeatureAIKnowledge} {
		if !hasFeature(acct.Features, k) {
			t.Errorf("after bulk: %v, want %s", acct.Features, k)
		}
	}
	if hasFeature(acct.Features, types.FeatureMeetings) {
		t.Errorf("after bulk: %v, want meetings off", acct.Features)
	}

	// Back to the plan's defaults, together.
	res, raw = h.do(http.MethodPut, path, types.FeatureGrants{Grants: []types.FeatureGrant{
		{Feature: types.FeatureAI, Inherit: true},
		{Feature: types.FeatureSimulive, Inherit: true},
		{Feature: types.FeatureMeetings, Inherit: true},
	}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("bulk inherit: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &acct)
	if want := []string{types.FeatureCaptions, types.FeatureMeetings, types.FeatureWhiteboard}; !slices.Equal(acct.Features, want) {
		t.Errorf("after inherit: %v, want %v", acct.Features, want)
	}

	// One unknown key writes nothing.
	res, raw = h.do(http.MethodPut, path, types.FeatureGrants{Grants: []types.FeatureGrant{
		{Feature: types.FeatureZoom, Enabled: true},
		{Feature: "zoomz", Enabled: true},
	}})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "unknown_feature")
	if u, _ := h.store.UserByID(context.Background(), target.ID); u.HasFeature(types.FeatureZoom) {
		t.Fatal("a refused bulk request wrote a switch")
	}

	// A host cannot do it to themselves.
	h.logout()
	h.login("bulk-host@test.dev")
	res, _ = h.do(http.MethodPut, path, types.FeatureGrants{Grants: []types.FeatureGrant{{Feature: types.FeatureZoom, Enabled: true}}})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("host bulk-granting itself: %d, want 403", res.StatusCode)
	}
}
