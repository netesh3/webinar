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
		types.FeatureGrant{Feature: types.FeatureWhatsAppCRM, Enabled: true})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("host granting itself a feature: status %d, want 403\n  body: %s", res.StatusCode, raw)
	}

	h.logout()
	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")

	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureWhatsAppCRM, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("grant: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Account
	h.decode(raw, &updated)
	if !hasFeature(updated.Features, types.FeatureWhatsAppCRM) {
		t.Fatalf("features = %v after granting WhatsApp CRM", updated.Features)
	}

	// A second switch on the same account does not replace the first: the column is
	// a set, and two admins deciding two things must not clobber each other.
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCloudRecording, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second grant: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &updated)
	if !hasFeature(updated.Features, types.FeatureWhatsAppCRM) || !hasFeature(updated.Features, types.FeatureCloudRecording) {
		t.Fatalf("features = %v, want both", updated.Features)
	}

	// Granting the same thing twice is not two grants.
	_, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureWhatsAppCRM, Enabled: true})
	h.decode(raw, &updated)
	if len(updated.Features) != 2 {
		t.Errorf("features = %v after re-granting WhatsApp CRM, want two", updated.Features)
	}

	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureWhatsAppCRM, Enabled: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("revoke: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &updated)
	if hasFeature(updated.Features, types.FeatureWhatsAppCRM) || !hasFeature(updated.Features, types.FeatureCloudRecording) {
		t.Fatalf("features = %v after revoking WhatsApp CRM, want cloud recording only", updated.Features)
	}

	// The column has no CHECK, so this endpoint is the only thing standing between a
	// typo and a feature key nothing will ever read.
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+target.ID+"/features",
		types.FeatureGrant{Feature: "crm_tagz", Enabled: true})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "unknown_feature" {
		t.Errorf("unknown feature: status %d code %q, want 422 unknown_feature", res.StatusCode, errorCode(t, raw))
	}

	res, raw = h.do(http.MethodPatch, "/api/admin/users/00000000-0000-0000-0000-000000000000/features",
		types.FeatureGrant{Feature: types.FeatureWhatsAppCRM, Enabled: true})
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
	if !hasFeature(users[0].Features, types.FeatureCloudRecording) {
		t.Errorf("admin list features = %v, want cloud recording", users[0].Features)
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

/* WhatsApp CRM is one catalogue switch for the surface that used to be four.
 *
 * crm_tags, crm_notes, replay_links and whatsapp_register are gone. An account
 * without whatsapp_crm is refused a previously gated CRM action; an account with
 * it can do that action. A brand-new signup does not receive the switch.
 */
func TestWhatsAppCRMIsOneSwitch(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	keys := featureKeys(cfg.FeatureCatalogue)
	for _, gone := range []string{"crm_tags", "crm_notes", "replay_links", "whatsapp_register"} {
		if hasFeature(keys, gone) {
			t.Errorf("catalogue still offers %s", gone)
		}
	}
	var crmRows int
	for _, f := range cfg.FeatureCatalogue {
		if f.Key == types.FeatureWhatsAppCRM {
			crmRows++
			if f.Label != "WhatsApp CRM" || f.Description == "" {
				t.Errorf("whatsapp_crm row = %+v", f)
			}
		}
	}
	if crmRows != 1 {
		t.Fatalf("whatsapp_crm appears %d times in the catalogue, want 1: %+v", crmRows, cfg.FeatureCatalogue)
	}
	for _, stay := range []string{
		types.FeatureCloudRecording,
		types.FeatureJoinWithoutRegistration,
		types.FeatureInstantWebinar,
	} {
		if !hasFeature(keys, stay) {
			t.Errorf("catalogue is missing %s", stay)
		}
	}

	fresh := h.signup("CRM Default", "crm-default@test.dev", true)
	if hasFeature(fresh.Features, types.FeatureWhatsAppCRM) {
		t.Fatalf("new account features = %v, want WhatsApp CRM off", fresh.Features)
	}

	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	me := meAccount(t, h)
	res, raw := h.do(http.MethodPost, "/api/host/crm/tags", types.CRMTagRequest{Name: "VIP"})
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("without whatsapp_crm: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	grantFeature(t, h, me.ID, types.FeatureWhatsAppCRM)
	res, raw = h.do(http.MethodPost, "/api/host/crm/tags", types.CRMTagRequest{Name: "VIP"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("with whatsapp_crm: status %d, want 201\n  body: %s", res.StatusCode, raw)
	}
}

func hasFeature(features []string, key string) bool {
	return slices.Contains(features, key)
}

// grantCloudRecording turns the switch on for whoever is signed in.
// Recording tests that are about the file, not the switch, need this: the switch
// is off until an admin says otherwise, including for a fixture host.
func grantCloudRecording(t *testing.T, h *harness) {
	t.Helper()
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureCloudRecording)
}

/* Cloud recording is off for every account until an admin turns it on.
 *
 * The browser hides the tab and the Cloud destination. This is the part that
 * still has to be true when the browser is not involved: starting a cloud
 * recording, and saving a webinar with "Record automatically", both 403.
 * Recording on this computer does not call these endpoints, so it is unaffected.
 */
func TestCloudRecordingIsOffUntilAnAdminAllowsIt(t *testing.T) {
	h := newHarness(t)

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if !hasFeature(featureKeys(cfg.FeatureCatalogue), types.FeatureCloudRecording) {
		t.Fatal("feature catalogue does not offer cloud recording, so the admin screen cannot switch it")
	}

	host := h.signup("Cloud Host", "cloud-host@test.dev", true)
	if hasFeature(host.Features, types.FeatureCloudRecording) {
		t.Fatalf("new account features = %v, want cloud recording off", host.Features)
	}
	h.signup("Cloud Panelist", "cloud-panel@test.dev", false)
	h.login("cloud-host@test.dev")

	wb := h.newWebinar("No cloud yet", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "cloud-panel@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}

	refused := cloudInput(wb.Topic, wb.StartsAt, true)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", refused)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("create with auto-record: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, refused)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("update with auto-record: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start webinar: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("host start recording: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	// The recording routes are still there. Listing is not starting one.
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("list recordings with the switch off: status %d, want 200", res.StatusCode)
	}

	h.login("cloud-panel@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("panelist start recording: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCloudRecording, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin enable: status %d body %s", res.StatusCode, raw)
	}
	var enabled types.Account
	h.decode(raw, &enabled)
	if !hasFeature(enabled.Features, types.FeatureCloudRecording) {
		t.Fatalf("features after enable = %v", enabled.Features)
	}

	h.login("cloud-host@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording once enabled: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, refused)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("update auto-record once enabled: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Webinar
	h.decode(raw, &updated)
	if !updated.Options.AutoRecord {
		t.Fatal("auto-record did not stick after the switch was turned on")
	}

	// And turning it back off refuses the next cloud start. The one already
	// running is finished by the test database reset, not by this assertion.
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureCloudRecording, Enabled: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin disable: status %d body %s", res.StatusCode, raw)
	}
	h.login("cloud-host@test.dev")
	other := h.newWebinar("Still no cloud", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+other.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start second webinar: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+other.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("start after disable: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
}

func featureKeys(features []types.Feature) []string {
	keys := make([]string, len(features))
	for i, f := range features {
		keys[i] = f.Key
	}
	return keys
}

func cloudInput(topic, startsAt string, auto bool) types.WebinarInput {
	return types.WebinarInput{
		Topic: topic, StartsAt: startsAt, Duration: 60, TimeZone: "UTC",
		Kind: types.KindLive, Status: types.StatusScheduled,
		RegistrationRequired: true, Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
		Options: types.WebinarOptions{AutoRecord: auto},
		Controls: types.SessionControls{
			HideAttendees: true, MuteOnEntry: true, AllowUnmute: true,
			ChatEnabled: true, QAEnabled: true, RaiseHandEnabled: true,
			ReactionsEnabled: true, PollsEnabled: true,
		},
	}
}
