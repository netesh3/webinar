package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* A template's default field mapping.
 *
 * The template says what fills its blanks; a reminder or webinar message slot saved with
 * no values of its own follows it, and one saved with values keeps them however the
 * template's mapping changes later.
 */

func putMapping(t *testing.T, h *harness, name string, params ...types.CRMParam) (int, []byte) {
	t.Helper()
	res, raw := h.do(http.MethodPut, "/api/host/crm/templates/mapping", types.CRMTemplateMappingRequest{
		Name: name, Language: "en_US", Params: params,
	})
	return res.StatusCode, raw
}

// queuedParams is the values queued for each message of a kind on a webinar.
func queuedParams(t *testing.T, h *harness, slug string, kind types.NotificationKind) [][]string {
	t.Helper()
	rows, err := h.store.Pool().Query(context.Background(), `
		SELECT n.template_params
		  FROM notifications n
		  JOIN webinars w ON w.id = n.webinar_id
		 WHERE w.slug = $1 AND n.kind = $2 AND n.channel = 'whatsapp'`, slug, string(kind))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var vals []string
		if err := json.Unmarshal(raw, &vals); err != nil {
			t.Fatal(err)
		}
		out = append(out, vals)
	}
	return out
}

func TestTemplateMappingSavedPerHost(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	// Nothing saved: a suggestion read off "Hi {{1}}, …".
	utility := templateNamed(t, crmTemplates(t, h, "").Templates, testTemplateUtility)
	if utility.DefaultParamsSaved || len(utility.DefaultParams) != 1 || utility.DefaultParams[0].Field != "first_name" {
		t.Fatalf("unsaved mapping = %+v saved=%v, want the first-name suggestion", utility.DefaultParams, utility.DefaultParamsSaved)
	}

	for _, tc := range []struct {
		name   string
		params []types.CRMParam
		status int
	}{
		{"too many", []types.CRMParam{{Field: "topic"}, {Field: "when"}}, http.StatusUnprocessableEntity},
		{"none", nil, http.StatusUnprocessableEntity},
		{"unknown field", []types.CRMParam{{Field: "discount_code"}}, http.StatusUnprocessableEntity},
		{"blank words", []types.CRMParam{{Text: "   "}}, http.StatusUnprocessableEntity},
	} {
		if status, raw := putMapping(t, h, testTemplateUtility, tc.params...); status != tc.status {
			t.Errorf("%s: status %d, want %d: %s", tc.name, status, tc.status, raw)
		}
	}
	if status, _ := putMapping(t, h, "invented_template", types.CRMParam{Field: "topic"}); status != http.StatusNotFound {
		t.Errorf("unknown template: status %d, want 404", status)
	}

	status, raw := putMapping(t, h, testTemplateUtility, types.CRMParam{Field: "topic"})
	if status != http.StatusOK {
		t.Fatalf("save mapping: %d %s", status, raw)
	}
	var saved types.CRMTemplate
	h.decode(raw, &saved)
	if !saved.DefaultParamsSaved || saved.DefaultParams[0].Field != "topic" {
		t.Fatalf("saved = %+v", saved.DefaultParams)
	}
	again := templateNamed(t, crmTemplates(t, h, "").Templates, testTemplateUtility)
	if !again.DefaultParamsSaved || again.DefaultParams[0].Field != "topic" {
		t.Fatalf("re-read = %+v", again.DefaultParams)
	}
	// Saving a mapping is ours alone: nothing was submitted to Meta.
	if len(g.sent()) != 0 {
		t.Errorf("saving a mapping reached Meta: %v", g.sent())
	}

	// Another host cannot write to it, and does not see it.
	h.logout()
	h.login("lucia@cabify.com")
	if status, _ := putMapping(t, h, testTemplateUtility, types.CRMParam{Field: "host"}); status != http.StatusNotFound {
		t.Errorf("another host's save: status %d, want 404", status)
	}
	h.logout()
	h.login("neeraj@acme.dev")
	if got := templateNamed(t, crmTemplates(t, h, "").Templates, testTemplateUtility); got.DefaultParams[0].Field != "topic" {
		t.Errorf("after another host tried = %+v", got.DefaultParams)
	}
}

/* Inherit versus override, at the moment a message is queued: a reminder with no values
 * of its own uses the template's mapping, one with values keeps them. */
func TestTemplateMappingInheritAndOverride(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	crmTemplates(t, h, "")
	if status, raw := putMapping(t, h, testTemplateUtility, types.CRMParam{Field: "topic"}); status != http.StatusOK {
		t.Fatalf("save mapping: %d %s", status, raw)
	}

	out := setReminders(t, h,
		// Customised: its own value, whatever the template says.
		types.CRMReminder{Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"name"}},
		// Template defaults: no values saved.
		types.CRMReminder{Kind: types.NotifyWhatsAppReminder, Template: testTemplateUtility,
			Language: "en_US"},
	)
	if got := reminderFor(t, out, types.NotifyWhatsAppReminder); len(got.Params) != 0 {
		t.Fatalf("inheriting reminder saved params %v, want none", got.Params)
	}

	wb := remindersWebinar(t, h, "Scaling Postgres", true)
	contact := registerOptedIn(t, h, wb.ID)

	_, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if len(thread.Messages) != 1 || thread.Messages[0].Body != "Hi Thandi Mokoena, your webinar starts in an hour." {
		t.Fatalf("confirmation = %+v, want its own value (the name), not the template's topic", thread.Messages)
	}
	reminders := queuedParams(t, h, wb.ID, types.NotifyWhatsAppReminder)
	if len(reminders) == 0 {
		t.Fatal("no reminders queued")
	}
	for _, p := range reminders {
		if len(p) != 1 || p[0] != "Scaling Postgres" {
			t.Errorf("inheriting reminder queued %v, want the template's mapping (topic)", p)
		}
	}

	// A later mapping change leaves the customised reminder's saved values alone.
	if status, raw := putMapping(t, h, testTemplateUtility, types.CRMParam{Text: "friend"}); status != http.StatusOK {
		t.Fatalf("change mapping: %d %s", status, raw)
	}
	_, raw = h.do(http.MethodGet, "/api/host/crm/reminders", nil)
	var reread types.CRMRemindersResponse
	h.decode(raw, &reread)
	if got := reminderFor(t, reread, types.NotifyWhatsAppConfirmed); len(got.Params) != 1 || got.Params[0] != "name" {
		t.Errorf("customised reminder after the mapping changed = %v", got.Params)
	}
	if got := reminderFor(t, reread, types.NotifyWhatsAppReminder); len(got.Params) != 0 {
		t.Errorf("inheriting reminder after the mapping changed = %v, want still none", got.Params)
	}

	// And the next message queued for the inheriting reminder follows the new mapping.
	wb2 := remindersWebinar(t, h, "Second session", true)
	registerOptedIn(t, h, wb2.ID)
	for _, p := range queuedParams(t, h, wb2.ID, types.NotifyWhatsAppReminder) {
		if len(p) != 1 || p[0] != "friend" {
			t.Errorf("after the change, inheriting reminder queued %v, want \"friend\"", p)
		}
	}
}

/* A webinar's message slot: saved with no values it follows the template; once the host
 * picks values it keeps them, and a later mapping change does not reach it. */
func TestTemplateMappingSlotInheritsThenKeepsOverride(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	crmTemplates(t, h, "")
	if status, raw := putMapping(t, h, testTemplateUtility, types.CRMParam{Field: "topic"}); status != http.StatusOK {
		t.Fatalf("save mapping: %d %s", status, raw)
	}
	slot := func(params []string) types.MessageSlotPatch {
		lang, name := "en_US", testTemplateUtility
		return types.MessageSlotPatch{
			Kind: types.SlotReminder, Channels: &[]string{types.ChannelWhatsApp},
			Timing:   &types.MessageTiming{Type: types.TimingBefore, Minutes: []int{60}},
			Template: &name, Language: &lang, Params: &params, Enabled: boolPtr(true),
		}
	}

	inherit := remindersWebinar(t, h, "Inherits", true)
	saved := slotOf(t, putWebinarSlots(t, h, inherit.ID, slot([]string{})), types.SlotReminder)
	if len(saved.Params) != 0 {
		t.Fatalf("inheriting slot saved %v", saved.Params)
	}
	custom := remindersWebinar(t, h, "Customised", true)
	putWebinarSlots(t, h, custom.ID, slot([]string{"first_name"}))

	registerOptedIn(t, h, inherit.ID)
	registerOptedIn(t, h, custom.ID)
	if got := queuedParams(t, h, inherit.ID, types.NotifyWhatsAppReminder); len(got) != 1 || got[0][0] != "Inherits" {
		t.Errorf("inheriting slot queued %v, want the topic", got)
	}
	if got := queuedParams(t, h, custom.ID, types.NotifyWhatsAppReminder); len(got) != 1 || got[0][0] != "Thandi" {
		t.Errorf("customised slot queued %v, want the first name", got)
	}

	if status, raw := putMapping(t, h, testTemplateUtility, types.CRMParam{Field: "host"}); status != http.StatusOK {
		t.Fatalf("change mapping: %d %s", status, raw)
	}
	if got := slotOf(t, webinarSlots(t, h, custom.ID), types.SlotReminder); len(got.Params) != 1 || got.Params[0] != "first_name" {
		t.Errorf("customised slot after the mapping changed = %v", got.Params)
	}
	if got := slotOf(t, webinarSlots(t, h, inherit.ID), types.SlotReminder); len(got.Params) != 0 {
		t.Errorf("inheriting slot after the mapping changed = %v, want still none", got.Params)
	}
}
