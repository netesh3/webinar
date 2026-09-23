package api_test

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Per-account feature switches, and what they refuse.
 *
 * The switches exist because every one of the things they govern either spends the
 * host's money or writes to other people's phones, so somebody has to have decided
 * that this account may. The two claims worth asserting are therefore:
 *
 *   - an admin can turn one on and off for one account, and nobody else can. Only
 *     ADMIN_EMAILS produces an admin, so this is the whole authorisation story.
 *   - a host without the switch is REFUSED by the server, not merely shown a screen
 *     with the button missing. A hidden button is not a permission.
 */

// meAccount is the signed-in account, which is how a test learns its own id.
func meAccount(t *testing.T, h *harness) types.Account {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	return acct
}

/* grantFeature switches features on for one account, through the store.
 *
 * The same write the admin endpoint performs, done directly for the same reason
 * h.signup revokes hosting directly: the tests below are about what a host with the
 * feature can DO, not about how it was granted. The endpoint itself is tested in
 * TestAdminSwitchesFeaturesPerAccount.
 */
func grantFeature(t *testing.T, h *harness, userID string, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if _, err := h.store.SetFeature(context.Background(), userID, key, true); err != nil {
			t.Fatalf("grant %s: %v", key, err)
		}
	}
}

func TestAdminSwitchesFeaturesPerAccount(t *testing.T) {
	h := newHarness(t)

	// The catalogue is the server's, so the admin screen renders what this build
	// actually has rather than a list the browser keeps its own copy of.
	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if len(cfg.FeatureCatalogue) != len(types.Features) {
		t.Fatalf("featureCatalogue has %d entries, want %d: %s",
			len(cfg.FeatureCatalogue), len(types.Features), raw)
	}
	for _, f := range cfg.FeatureCatalogue {
		if f.Label == "" || f.Description == "" {
			t.Errorf("feature %q has no label or description for the admin to read: %+v", f.Key, f)
		}
	}

	target := h.signup("Switchable Host", "switchable@test.dev", true)
	if len(target.Features) != 0 {
		t.Fatalf("a new account starts with features %v, want none: every switch is off until somebody decides", target.Features)
	}

	// A host cannot grant themselves anything.
	res, raw := h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCRMTags, Enabled: true})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("host granting itself a feature: status %d, want 403\n  body: %s", res.StatusCode, raw)
	}

	h.logout()
	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")

	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCRMTags, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("grant: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Account
	h.decode(raw, &updated)
	if !hasFeature(updated.Features, types.FeatureCRMTags) {
		t.Fatalf("features = %v after granting tags", updated.Features)
	}

	// A second switch on the same account does not replace the first: the column is
	// a set, and two admins deciding two things must not clobber each other.
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCRMNotes, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second grant: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &updated)
	if !hasFeature(updated.Features, types.FeatureCRMTags) || !hasFeature(updated.Features, types.FeatureCRMNotes) {
		t.Fatalf("features = %v, want both", updated.Features)
	}

	// Granting the same thing twice is not two grants.
	_, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCRMTags, Enabled: true})
	h.decode(raw, &updated)
	if len(updated.Features) != 2 {
		t.Errorf("features = %v after re-granting tags, want two", updated.Features)
	}

	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCRMTags, Enabled: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &updated)
	if hasFeature(updated.Features, types.FeatureCRMTags) || !hasFeature(updated.Features, types.FeatureCRMNotes) {
		t.Fatalf("features = %v after revoking tags, want notes only", updated.Features)
	}

	// The column has no CHECK, so this endpoint is the only thing standing between a
	// typo and a feature key nothing will ever read.
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: "crm_tagz", Enabled: true})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "unknown_feature" {
		t.Errorf("unknown feature: status %d code %q, want 422 unknown_feature", res.StatusCode, errorCode(t, raw))
	}

	res, raw = h.do(http.MethodPatch, "/api/admin/users/00000000-0000-0000-0000-000000000000/features",
		types.FeatureGrant{Feature: types.FeatureCRMTags, Enabled: true})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown account: status %d, want 404\n  body: %s", res.StatusCode, raw)
	}

	// And the admin list shows what was decided, which is what the dashboard renders.
	_, raw = h.do(http.MethodGet, "/api/admin/users?q=switchable@test.dev", nil)
	var users []types.AdminUser
	h.decode(raw, &users)
	if len(users) == 0 {
		t.Fatalf("admin list does not contain the target: %s", raw)
	}
	if !hasFeature(users[0].Features, types.FeatureCRMNotes) {
		t.Errorf("admin list features = %v, want notes", users[0].Features)
	}
}

/* Every gate, from the account they are switched off for.
 *
 * Table-driven on purpose: the interesting failure is a new endpoint added to one of
 * these feature areas and left ungated, and a list is the only shape of test that
 * makes that omission visible.
 */
func TestFeaturesAreRefusedWhenSwitchedOff(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "A webinar with no switches on")
	contact := registerOptedIn(t, h, wb.ID)

	for _, tc := range []struct{ name, method, path string }{
		{"list tags", http.MethodGet, "/api/host/crm/tags"},
		{"create tag", http.MethodPost, "/api/host/crm/tags"},
		{"tag a contact", http.MethodPost, "/api/host/crm/contacts/" + contact.ID + "/tags"},
		{"list notes", http.MethodGet, "/api/host/crm/contacts/" + contact.ID + "/notes"},
		{"write a note", http.MethodPost, "/api/host/crm/contacts/" + contact.ID + "/notes"},
		{"register a number", http.MethodPost, "/api/host/whatsapp/register"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.do(tc.method, tc.path, map[string]any{"name": "VIP", "body": "hello", "pin": "123456"})
			if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
				t.Errorf("status %d code %q, want 403 feature_off\n  body: %s",
					res.StatusCode, errorCode(t, raw), raw)
			}
			// The refusal names the thing, because "forbidden" tells a host nothing they
			// can act on — they have to know what to ask for.
			if !strings.Contains(string(raw), "isn't switched on") {
				t.Errorf("refusal does not say what is off: %s", raw)
			}
		})
	}

	// The screens that merely READ alongside a switched-off feature still work: the
	// inbox is the host's own conversations and does not belong to any of this.
	contacts := crmContacts(t, h)
	if len(contacts.Contacts) == 0 {
		t.Fatal("contacts list empty with features off")
	}
	if len(contacts.Tags) != 0 {
		t.Errorf("tags = %+v with the feature off", contacts.Tags)
	}
	for _, c := range contacts.Contacts {
		if c.Tags == nil {
			t.Error("contact.tags is null rather than an empty list: the UI has to special-case it")
		}
	}
	thread := crmThread(t, h, contact.ID)
	if thread.Notes == nil {
		t.Error("thread.notes is null rather than an empty list")
	}
}

func hasFeature(features []string, key string) bool {
	return slices.Contains(features, key)
}
