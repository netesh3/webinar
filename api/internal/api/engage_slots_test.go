package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

func withSlots(c *config.Config) { c.EngageSlots = true }

func slotOf(t *testing.T, slots []types.MessageSlot, kind string) types.MessageSlot {
	t.Helper()
	sl, ok := types.FindSlot(slots, kind)
	if !ok {
		t.Fatalf("no slot %s", kind)
	}
	return sl
}

func getDefaults(t *testing.T, h *harness) []types.MessageSlot {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/message-defaults", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("defaults: status %d body %s", res.StatusCode, raw)
	}
	var out types.MessageDefaultsResponse
	h.decode(raw, &out)
	return out.Slots
}

func putDefaults(t *testing.T, h *harness, slots ...types.MessageSlot) []types.MessageSlot {
	t.Helper()
	res, raw := h.do(http.MethodPut, "/api/host/crm/message-defaults", types.MessageDefaultsRequest{Slots: slots})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put defaults: status %d body %s", res.StatusCode, raw)
	}
	var out types.MessageDefaultsResponse
	h.decode(raw, &out)
	return out.Slots
}

func webinarSlots(t *testing.T, h *harness, slug string) []types.MessageSlot {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/webinars/"+slug+"/messages", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("webinar messages: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMWebinarMessagesResponse
	h.decode(raw, &out)
	return out.Slots
}

func putWebinarSlots(t *testing.T, h *harness, slug string, slots ...types.MessageSlotPatch) []types.MessageSlot {
	t.Helper()
	res, raw := h.do(http.MethodPut, "/api/host/crm/webinars/"+slug+"/messages", types.WebinarMessagesRequest{Slots: slots})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("put webinar messages: status %d body %s", res.StatusCode, raw)
	}
	var out types.WebinarSlotsResponse
	h.decode(raw, &out)
	return out.Slots
}

func notifyRows(t *testing.T, h *harness, slug string) []struct {
	Kind, Channel string
	Offset        int
} {
	t.Helper()
	rows, err := h.store.Pool().Query(context.Background(), `
		SELECT n.kind, n.channel, COALESCE(n.offset_min, 0)
		  FROM notifications n
		  JOIN webinars w ON w.id = n.webinar_id
		 WHERE w.slug = $1`, slug)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []struct {
		Kind, Channel string
		Offset        int
	}
	for rows.Next() {
		var row struct {
			Kind, Channel string
			Offset        int
		}
		if err := rows.Scan(&row.Kind, &row.Channel, &row.Offset); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func hasNotify(rows []struct {
	Kind, Channel string
	Offset        int
}, kind, channel string, offset int) bool {
	for _, r := range rows {
		if r.Kind == kind && r.Channel == channel && r.Offset == offset {
			return true
		}
	}
	return false
}

/* Backfill copies reminder templates, recipe drips and the webinar's option
 * fields into the two slot tables. Re-running it does not overwrite a row. */
func TestMessageDefaultsBackfill(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReminder, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"starts_in"},
	})
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Backfill", "startsAt": time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 45, "status": "scheduled", "registrationRequired": true,
		"approval": "automatic", "attendeeLimit": 100,
		"options": map[string]any{
			"emailReminders": false, "whatsappReminders": true, "reminders": []int{60},
		},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	saveRecipe(t, h, types.RecipeHigh, types.CRMRecipeRequest{
		Active: true, Template: testTemplateMarketing, Language: "en_US", DelayMin: 90,
	})

	if err := h.crm.BackfillMessageSlots(context.Background()); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	defs := getDefaults(t, h)
	rem := slotOf(t, defs, types.SlotReminder)
	if rem.Template != testTemplateUtility || rem.Language != "en_US" || !rem.Enabled {
		t.Fatalf("default reminder = %+v", rem)
	}
	if len(rem.Channels) != 2 || rem.Timing.Type != types.TimingBefore {
		t.Fatalf("default reminder channels/timing = %+v %+v", rem.Channels, rem.Timing)
	}
	high := slotOf(t, defs, types.SlotFollowupHigh)
	if !high.Enabled || high.Timing.Type != types.TimingAfterEnd || len(high.Timing.Minutes) != 1 || high.Timing.Minutes[0] != 90 {
		t.Fatalf("default followup = %+v", high)
	}
	if high.Template != testTemplateMarketing || len(high.Channels) != 1 || high.Channels[0] != types.ChannelWhatsApp {
		t.Fatalf("default followup wording = %+v", high)
	}

	slots := webinarSlots(t, h, wb.ID)
	wrem := slotOf(t, slots, types.SlotReminder)
	if wrem.Layers.Channels != types.LayerWebinar || wrem.Sends(types.ChannelEmail) || !wrem.Sends(types.ChannelWhatsApp) {
		t.Fatalf("webinar reminder channels = %+v layers %+v", wrem.Channels, wrem.Layers)
	}
	if wrem.Layers.Timing != types.LayerWebinar || len(wrem.Timing.Minutes) != 1 || wrem.Timing.Minutes[0] != 60 {
		t.Fatalf("webinar reminder timing = %+v", wrem.Timing)
	}
	if wrem.Layers.Template != types.LayerDefault || wrem.Template != testTemplateUtility {
		t.Fatalf("wording should stay the account default, got %+v", wrem)
	}
	conf := slotOf(t, slots, types.SlotConfirmation)
	if !conf.Sends(types.ChannelEmail) || !conf.Sends(types.ChannelWhatsApp) || conf.Timing.Type != types.TimingImmediate {
		t.Fatalf("confirmation = %+v", conf)
	}

	// A second run must not clobber an edit made after the first copy.
	putDefaults(t, h, types.MessageSlot{
		Kind: types.SlotReminder, Channels: []string{types.ChannelEmail},
		Timing: types.MessageTiming{Type: types.TimingBefore, Minutes: []int{30}}, Enabled: true,
	})
	if err := h.crm.BackfillMessageSlots(context.Background()); err != nil {
		t.Fatal(err)
	}
	again := slotOf(t, getDefaults(t, h), types.SlotReminder)
	if len(again.Timing.Minutes) != 1 || again.Timing.Minutes[0] != 30 || again.Sends(types.ChannelWhatsApp) {
		t.Fatalf("backfill overwrote the edit: %+v", again)
	}
}

/* Webinar override beats the account default, which beats the built-in.
 * Legacy options fill confirmation and reminder only when no settings row exists,
 * and a saved row wins over those options. */
func TestEngageSlotResolutionPrecedence(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Precedence", "startsAt": time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 45, "status": "scheduled", "registrationRequired": true,
		"approval": "automatic", "attendeeLimit": 100,
		"options": map[string]any{"emailReminders": true, "whatsappReminders": false},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)

	replay := slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReplay)
	if replay.Source != types.LayerBuiltin || !replay.Sends(types.ChannelEmail) || replay.Timing.Type != types.TimingOnPublish {
		t.Fatalf("builtin replay = %+v", replay)
	}

	putDefaults(t, h, types.MessageSlot{
		Kind: types.SlotReplay, Channels: []string{types.ChannelWhatsApp},
		Timing: types.MessageTiming{Type: types.TimingOnPublish}, Enabled: true,
	})
	replay = slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReplay)
	if replay.Source != types.LayerDefault || replay.Sends(types.ChannelEmail) || !replay.Sends(types.ChannelWhatsApp) {
		t.Fatalf("default replay = %+v", replay)
	}

	putWebinarSlots(t, h, wb.ID, types.MessageSlotPatch{
		Kind:     types.SlotReplay,
		Channels: &[]string{types.ChannelEmail},
		Timing:   &types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{120}},
		Enabled:  boolPtr(true),
	})
	replay = slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReplay)
	if replay.Layers.Channels != types.LayerWebinar || replay.Layers.Timing != types.LayerWebinar {
		t.Fatalf("webinar replay layers = %+v", replay.Layers)
	}
	if replay.Timing.Type != types.TimingAfterEnd || replay.Timing.Minutes[0] != 120 || !replay.Sends(types.ChannelEmail) {
		t.Fatalf("webinar replay = %+v", replay)
	}

	// Options beat an account default while the webinar has no reminder row.
	putDefaults(t, h, types.MessageSlot{
		Kind: types.SlotReminder, Channels: []string{types.ChannelWhatsApp},
		Timing: types.MessageTiming{Type: types.TimingBefore, Minutes: []int{15}}, Enabled: true,
	})
	rem := slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReminder)
	if rem.Layers.Channels != types.LayerOptions || !rem.Sends(types.ChannelEmail) || rem.Sends(types.ChannelWhatsApp) {
		t.Fatalf("options should beat the default, got %+v", rem)
	}

	putWebinarSlots(t, h, wb.ID, types.MessageSlotPatch{
		Kind:     types.SlotReminder,
		Channels: &[]string{types.ChannelWhatsApp},
		Timing:   &types.MessageTiming{Type: types.TimingBefore, Minutes: []int{30}},
		Enabled:  boolPtr(true),
	})
	rem = slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReminder)
	if rem.Layers.Channels != types.LayerWebinar || rem.Sends(types.ChannelEmail) || !rem.Sends(types.ChannelWhatsApp) {
		t.Fatalf("saved row should beat options, got %+v", rem)
	}
	if len(rem.Timing.Minutes) != 1 || rem.Timing.Minutes[0] != 30 {
		t.Fatalf("saved timing = %+v", rem.Timing)
	}
}

func TestEngageSlotConfirmationChannels(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := remindersWebinar(t, h, "Confirm", true)
	conf := slotOf(t, webinarSlots(t, h, wb.ID), types.SlotConfirmation)
	if conf.Timing.Type != types.TimingImmediate || !conf.Sends(types.ChannelEmail) || !conf.Sends(types.ChannelWhatsApp) {
		t.Fatalf("confirmation = %+v", conf)
	}
	if conf.Layers.Channels != types.LayerOptions {
		t.Fatalf("confirmation layer = %s", conf.Layers.Channels)
	}

	putWebinarSlots(t, h, wb.ID, types.MessageSlotPatch{
		Kind:     types.SlotConfirmation,
		Channels: &[]string{types.ChannelEmail},
		Timing:   &types.MessageTiming{Type: types.TimingImmediate},
		Enabled:  boolPtr(true),
	})
	conf = slotOf(t, webinarSlots(t, h, wb.ID), types.SlotConfirmation)
	if conf.Sends(types.ChannelWhatsApp) || conf.Layers.Channels != types.LayerWebinar {
		t.Fatalf("confirmation override = %+v", conf)
	}
}

func TestEngageSlotReminderTiming(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Reminder times", "startsAt": time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 45, "status": "scheduled", "registrationRequired": true,
		"approval": "automatic", "attendeeLimit": 100,
		"options": map[string]any{"emailReminders": true, "whatsappReminders": false, "reminders": []int{10, 1440}},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	rem := slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReminder)
	if rem.Timing.Type != types.TimingBefore || len(rem.Timing.Minutes) != 2 ||
		rem.Timing.Minutes[0] != 1440 || rem.Timing.Minutes[1] != 10 {
		t.Fatalf("options timing = %+v", rem.Timing)
	}
	res, raw = h.do(http.MethodPut, "/api/host/crm/webinars/"+wb.ID+"/messages", types.WebinarMessagesRequest{
		Slots: []types.MessageSlotPatch{{
			Kind:   types.SlotReminder,
			Timing: &types.MessageTiming{Type: types.TimingImmediate},
		}},
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("bad timing status %d body %s", res.StatusCode, raw)
	}
}

func TestEngageSlotReplayChannels(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := remindersWebinar(t, h, "Replay", false)
	hour := 8
	// next_morning is a follow-up time, not a replay time.
	res, raw := h.do(http.MethodPut, "/api/host/crm/message-defaults", types.MessageDefaultsRequest{
		Slots: []types.MessageSlot{{
			Kind: types.SlotReplay, Channels: []string{types.ChannelEmail, types.ChannelWhatsApp},
			Timing: types.MessageTiming{Type: types.TimingNextMorning, Hour: &hour}, Enabled: true,
		}},
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("replay next_morning status %d body %s", res.StatusCode, raw)
	}
	putDefaults(t, h, types.MessageSlot{
		Kind: types.SlotReplay, Channels: []string{types.ChannelEmail},
		Timing: types.MessageTiming{Type: types.TimingOnPublish}, Enabled: false,
	})
	replay := slotOf(t, webinarSlots(t, h, wb.ID), types.SlotReplay)
	if replay.Enabled || replay.Timing.Type != types.TimingOnPublish || replay.Source != types.LayerDefault {
		t.Fatalf("replay = %+v", replay)
	}
}

func TestEngageSlotFollowupTiming(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), withSlots)
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Follow up", true)
	saveRecipe(t, h, types.RecipeHigh, types.CRMRecipeRequest{
		Active: true, Template: testTemplateMarketing, Language: "en_US", DelayMin: 60,
	})
	putDefaults(t, h, types.MessageSlot{
		Kind: types.SlotFollowupHigh, Channels: []string{types.ChannelWhatsApp},
		Timing: types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{180}}, Enabled: true,
	})
	slot := slotOf(t, webinarSlots(t, h, wb.ID), types.SlotFollowupHigh)
	if slot.Layers.Timing != types.LayerDefault || slot.Timing.Minutes[0] != 180 || !slot.Enabled {
		t.Fatalf("followup slot = %+v", slot)
	}

	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Minute)
	ended := start.Add(60 * time.Minute)
	pinSessionWindow(t, wb.ID, start, ended)
	seedTier(t, h, wb.ID, "thandi@example.com", types.TierHigh)
	h.engage.OnScored(context.Background(), wb.ID)

	r := recipes(t, h)
	high := recipeByID(t, r, types.RecipeHigh)
	got := onlyEnrollment(t, readDrip(t, h, high.DripID))
	if got.ContactID != thandi.ID {
		t.Fatalf("enrolled %s, want Thandi", got.ContactName)
	}
	due, err := time.Parse(time.RFC3339, got.NextDueAt)
	if err != nil {
		t.Fatalf("due %q: %v", got.NextDueAt, err)
	}
	want := ended.Add(180 * time.Minute)
	if due.Sub(want) > time.Minute || want.Sub(due) > time.Minute {
		t.Fatalf("due %s, want about %s (slot), not the recipe's 60 minutes from now", due, want)
	}
}

/* With the flag on, a saved reminder slot decides the channel and the time.
 * Options still say email at a day and an hour; the slot says WhatsApp at 30 minutes. */
func TestEngageSlotsReminderSender(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), withSlots)
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReminder, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"starts_in"},
	})
	wb := remindersWebinar(t, h, "Sender", false)
	putWebinarSlots(t, h, wb.ID, types.MessageSlotPatch{
		Kind:     types.SlotReminder,
		Channels: &[]string{types.ChannelWhatsApp},
		Timing:   &types.MessageTiming{Type: types.TimingBefore, Minutes: []int{30}},
		Enabled:  boolPtr(true),
	})
	registerOptedIn(t, h, wb.ID)

	rows := notifyRows(t, h, wb.ID)
	if !hasNotify(rows, string(types.NotifyWhatsAppReminder), "whatsapp", 30) {
		t.Fatalf("want a WhatsApp reminder at 30 minutes, got %+v", rows)
	}
	if hasNotify(rows, string(types.NotifyReminder), "email", 1440) ||
		hasNotify(rows, string(types.NotifyReminder), "email", 60) ||
		hasNotify(rows, string(types.NotifyWhatsAppReminder), "whatsapp", 1440) {
		t.Fatalf("options leaked into the outbox: %+v", rows)
	}
	if !hasNotify(rows, string(types.NotifyRegistrationConfirmed), "email", 0) {
		t.Fatalf("confirmation email missing: %+v", rows)
	}
}

func boolPtr(v bool) *bool { return &v }
