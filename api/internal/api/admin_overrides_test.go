package api_test

import (
	"net/http"
	"slices"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The Accounts panel's three states (2 Nov 2026): an admin can turn a feature the plan includes
 * OFF for one host, turn one the plan lacks ON, and put either back to the plan, through the
 * same PATCH the panel uses, for every switch in the catalogue (PerHost ones included). */
func TestAdminOverridesWorkBothWaysForEverySwitch(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Override Host", "override-host@test.dev", true)
	if _, err := h.store.SetUserPlan(t.Context(), host.ID, types.PlanBusiness); err != nil {
		t.Fatal(err)
	}
	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	set := func(key string, state *bool) types.Account {
		t.Helper()
		body := map[string]any{"feature": key, "enabled": state != nil && *state, "inherit": state == nil}
		res, raw := h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features", body)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", key, res.StatusCode, raw)
		}
		var a types.Account
		h.decode(raw, &a)
		return a
	}
	on, off := true, false
	// A tier feature off for this Business host, then back to the plan.
	if a := set(types.FeatureCaptions, &off); slices.Contains(a.Features, types.FeatureCaptions) {
		t.Fatalf("captions forced off on Business are still on: %v", a.Features)
	}
	if a := set(types.FeatureCaptions, nil); !slices.Contains(a.Features, types.FeatureCaptions) {
		t.Fatalf("captions back to the plan on Business are off: %v", a.Features)
	}
	// Every switch can be forced on and off, and reset.
	for _, f := range types.Features {
		set(f.Key, &on)
		a := set(f.Key, &off)
		if slices.Contains(a.Features, f.Key) {
			t.Errorf("%s forced off is still on", f.Key)
		}
		set(f.Key, nil)
	}
}
