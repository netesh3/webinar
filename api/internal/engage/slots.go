package engage

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Message slots.
 *
 * One function, ResolveSlots, turns the account default and the per-webinar
 * override into the slots every screen and every sender reads. A webinar with
 * no settings row for confirmation or reminder still honours WebinarOptions,
 * so the schedule form keeps working until it writes slots itself.
 */

// SlotError is a refusal a host can be shown. Handlers map it to 422.
type SlotError struct{ Msg string }

func (e *SlotError) Error() string { return e.Msg }

func slotKinds() []string {
	kinds := []string{types.SlotConfirmation, types.SlotReminder, types.SlotReplay}
	for _, p := range followupPresets {
		kinds = append(kinds, followupKind(p.group))
	}
	return kinds
}

func knownSlotKind(kind string) bool {
	for _, k := range slotKinds() {
		if k == kind {
			return true
		}
	}
	return false
}

func followupKind(group types.EngagementTier) string {
	return "followup_" + string(group)
}

func recipeFollowupKind(recipe string) (string, bool) {
	for _, p := range followupPresets {
		if p.id == recipe {
			return followupKind(p.group), true
		}
	}
	return "", false
}

func slotNotifyKind(kind string) types.NotificationKind {
	switch kind {
	case types.SlotConfirmation:
		return types.NotifyWhatsAppConfirmed
	case types.SlotReminder:
		return types.NotifyWhatsAppReminder
	case types.SlotReplay:
		return types.NotifyWhatsAppReplay
	default:
		return ""
	}
}

func layers(from string) types.MessageSlotLayers {
	return types.MessageSlotLayers{
		Channels: from, Timing: from, Template: from,
		Language: from, Params: from, Enabled: from,
	}
}

func builtinSlot(kind string) types.MessageSlot {
	sl := types.MessageSlot{
		Kind: kind, Channels: []string{types.ChannelEmail}, Params: []string{},
		Enabled: true, Source: types.LayerBuiltin, Layers: layers(types.LayerBuiltin),
	}
	switch kind {
	case types.SlotConfirmation:
		sl.Timing = types.MessageTiming{Type: types.TimingImmediate}
	case types.SlotReminder:
		sl.Timing = types.MessageTiming{Type: types.TimingBefore, Minutes: append([]int(nil), types.DefaultReminders...)}
	case types.SlotReplay:
		sl.Timing = types.MessageTiming{Type: types.TimingOnPublish}
	default:
		mins := 120
		for _, p := range followupPresets {
			if followupKind(p.group) == kind {
				mins = p.delayMin
			}
		}
		sl.Channels = []string{types.ChannelWhatsApp}
		sl.Enabled = false
		sl.Timing = types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{mins}}
	}
	return sl
}

func applyDefault(sl types.MessageSlot, row crmstore.DefaultSlot) types.MessageSlot {
	sl.Channels = append([]string(nil), row.Channels...)
	sl.Timing = row.Timing
	sl.Template = row.Template
	sl.Language = row.Language
	sl.Params = append([]string(nil), row.Params...)
	sl.Enabled = row.Enabled
	sl.Layers = layers(types.LayerDefault)
	if sl.Channels == nil {
		sl.Channels = []string{}
	}
	if sl.Params == nil {
		sl.Params = []string{}
	}
	return sl
}

/* applyOptions is the legacy webinar form: EmailReminders, WhatsAppReminders and
 * Reminders. It only runs when the webinar has no settings row for the kind, so a
 * slot the host has saved is not overwritten by the old fields. */
func applyOptions(sl types.MessageSlot, wb types.Webinar) types.MessageSlot {
	switch sl.Kind {
	case types.SlotConfirmation:
		ch := []string{types.ChannelEmail}
		if wb.Options.WhatsAppReminders {
			ch = append(ch, types.ChannelWhatsApp)
		}
		sl.Channels = ch
		sl.Timing = types.MessageTiming{Type: types.TimingImmediate}
		sl.Enabled = true
		sl.Layers.Channels = types.LayerOptions
		sl.Layers.Timing = types.LayerOptions
		sl.Layers.Enabled = types.LayerOptions
	case types.SlotReminder:
		var ch []string
		if wb.Options.EmailReminders {
			ch = append(ch, types.ChannelEmail)
		}
		if wb.Options.WhatsAppReminders {
			ch = append(ch, types.ChannelWhatsApp)
		}
		if ch == nil {
			ch = []string{}
		}
		sl.Channels = ch
		sl.Timing = types.MessageTiming{Type: types.TimingBefore, Minutes: append([]int(nil), wb.Options.Reminders...)}
		sl.Enabled = len(ch) > 0 && len(sl.Timing.Minutes) > 0
		sl.Layers.Channels = types.LayerOptions
		sl.Layers.Timing = types.LayerOptions
		sl.Layers.Enabled = types.LayerOptions
	}
	return sl
}

func applyWebinar(sl types.MessageSlot, row crmstore.WebinarSlot) types.MessageSlot {
	if row.ChannelsSet {
		sl.Channels = append([]string(nil), row.Channels...)
		if sl.Channels == nil {
			sl.Channels = []string{}
		}
		sl.Layers.Channels = types.LayerWebinar
	}
	if row.TimingSet {
		sl.Timing = row.Timing
		sl.Layers.Timing = types.LayerWebinar
	}
	if row.TemplateSet {
		sl.Template = row.Template
		sl.Layers.Template = types.LayerWebinar
	}
	if row.LanguageSet {
		sl.Language = row.Language
		sl.Layers.Language = types.LayerWebinar
	}
	if row.ParamsSet {
		sl.Params = append([]string(nil), row.Params...)
		if sl.Params == nil {
			sl.Params = []string{}
		}
		sl.Layers.Params = types.LayerWebinar
	}
	if row.EnabledSet {
		sl.Enabled = row.Enabled
		sl.Layers.Enabled = types.LayerWebinar
	}
	return sl
}

func summarize(sl types.MessageSlot) string {
	rank := map[string]int{
		types.LayerBuiltin: 0, types.LayerDefault: 1,
		types.LayerOptions: 2, types.LayerWebinar: 3,
	}
	best := types.LayerBuiltin
	for _, layer := range []string{
		sl.Layers.Channels, sl.Layers.Timing, sl.Layers.Template,
		sl.Layers.Language, sl.Layers.Params, sl.Layers.Enabled,
	} {
		if rank[layer] > rank[best] {
			best = layer
		}
	}
	return best
}

/* ResolveDefaults is the account layer only: builtin, then the host's defaults.
 * The WhatsApp page edits this and nothing else. */
func (s *Module) ResolveDefaults(ctx context.Context, hostID string) ([]types.MessageSlot, error) {
	rows, err := s.store.MessageDefaults(ctx, hostID)
	if err != nil {
		return nil, err
	}
	out := make([]types.MessageSlot, 0, len(slotKinds()))
	for _, kind := range slotKinds() {
		sl := builtinSlot(kind)
		if row, ok := rows[kind]; ok {
			sl = applyDefault(sl, row)
		}
		sl.Source = summarize(sl)
		out = append(out, sl)
	}
	return out, nil
}

/* ResolveSlots combines the account default with this webinar's overrides.
 *
 * Order, lowest first: the built-in product default, the host's default row,
 * the legacy option fields (only when this kind has no settings row), then
 * each non-NULL column on the settings row.
 */
func (s *Module) ResolveSlots(ctx context.Context, webinarSlug string) ([]types.MessageSlot, error) {
	hostID, err := s.store.HostIDFor(ctx, webinarSlug)
	if err != nil {
		return nil, err
	}
	wb, err := s.store.WebinarBySlug(ctx, webinarSlug)
	if err != nil {
		return nil, err
	}
	defaults, err := s.store.MessageDefaults(ctx, hostID)
	if err != nil {
		return nil, err
	}
	overrides, err := s.store.WebinarMessageSettings(ctx, webinarSlug)
	if err != nil {
		return nil, err
	}
	out := make([]types.MessageSlot, 0, len(slotKinds()))
	for _, kind := range slotKinds() {
		sl := builtinSlot(kind)
		if row, ok := defaults[kind]; ok {
			sl = applyDefault(sl, row)
		}
		if _, ok := overrides[kind]; !ok && (kind == types.SlotConfirmation || kind == types.SlotReminder) {
			sl = applyOptions(sl, wb)
		}
		if row, ok := overrides[kind]; ok {
			sl = applyWebinar(sl, row)
		}
		sl.Source = summarize(sl)
		out = append(out, sl)
	}
	return out, nil
}

// countSending is how many resolved slots are on and include the channel.
func countSending(slots []types.MessageSlot, channel string) int {
	n := 0
	for _, sl := range slots {
		if sl.Sends(channel) {
			n++
		}
	}
	return n
}

/* MessageSlots is the Engage contract the email senders call.
 * ok is false only when the slots cannot be read; the caller then keeps the
 * confirmation rather than dropping it. ResolveSlots still applies
 * WebinarOptions when an old webinar has no settings row for that kind. */
func (s *Module) MessageSlots(ctx context.Context, webinarID string) ([]types.MessageSlot, bool, error) {
	slots, err := s.ResolveSlots(ctx, webinarID)
	if err != nil {
		return nil, false, err
	}
	return slots, true, nil
}

// ---------------------------------------------------------------- validation

func normalizeChannels(in []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, raw := range in {
		ch := strings.ToLower(strings.TrimSpace(raw))
		if ch == "" {
			continue
		}
		if ch != types.ChannelEmail && ch != types.ChannelWhatsApp {
			return nil, &SlotError{Msg: "A message can be sent by email or WhatsApp."}
		}
		if !seen[ch] {
			seen[ch] = true
			out = append(out, ch)
		}
	}
	if out == nil {
		out = []string{}
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i] == types.ChannelEmail && out[j] != types.ChannelEmail
	})
	return out, nil
}

func normalizeTiming(kind string, t types.MessageTiming) (types.MessageTiming, error) {
	switch kind {
	case types.SlotConfirmation:
		if t.Type != types.TimingImmediate {
			return t, &SlotError{Msg: "A confirmation is sent when they register."}
		}
		return types.MessageTiming{Type: types.TimingImmediate}, nil
	case types.SlotReminder:
		if t.Type != types.TimingBefore {
			return t, &SlotError{Msg: "A reminder is sent before the webinar starts."}
		}
		seen := map[int]bool{}
		var mins []int
		for _, m := range t.Minutes {
			if m < types.MinReminderOffset || m > types.MaxReminderOffset {
				return t, &SlotError{Msg: "A reminder has to be between 1 minute and 30 days before the start."}
			}
			if !seen[m] {
				seen[m] = true
				mins = append(mins, m)
			}
		}
		if len(mins) == 0 {
			return t, &SlotError{Msg: "Choose at least one reminder time."}
		}
		if len(mins) > types.MaxReminders {
			return t, &SlotError{Msg: "At most " + strconv.Itoa(types.MaxReminders) + " reminders."}
		}
		sort.Sort(sort.Reverse(sort.IntSlice(mins)))
		return types.MessageTiming{Type: types.TimingBefore, Minutes: mins}, nil
	case types.SlotReplay:
		switch t.Type {
		case types.TimingOnPublish:
			return types.MessageTiming{Type: types.TimingOnPublish}, nil
		case types.TimingAfterEnd:
			m, err := oneDelay(t)
			if err != nil {
				return t, err
			}
			return types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{m}}, nil
		default:
			return t, &SlotError{Msg: "A replay is sent when you publish the recording, or a while after the webinar ends."}
		}
	default:
		switch t.Type {
		case types.TimingAfterEnd:
			m, err := oneDelay(t)
			if err != nil {
				return t, err
			}
			return types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{m}}, nil
		case types.TimingNextMorning:
			if t.Hour == nil || *t.Hour < 0 || *t.Hour > 23 {
				return t, &SlotError{Msg: "Choose an hour between 0 and 23 for the next morning."}
			}
			h := *t.Hour
			return types.MessageTiming{Type: types.TimingNextMorning, Hour: &h}, nil
		default:
			return t, &SlotError{Msg: "A follow-up is sent after the webinar ends, or the next morning."}
		}
	}
}

func oneDelay(t types.MessageTiming) (int, error) {
	if len(t.Minutes) != 1 {
		return 0, &SlotError{Msg: "Say how many minutes after the webinar ends."}
	}
	m := t.Minutes[0]
	if m < 0 || m > 129600 {
		return 0, &SlotError{Msg: "That wait has to be between 0 minutes and 90 days."}
	}
	return m, nil
}

func normalizeParams(kind string, params []string) ([]string, error) {
	if params == nil {
		params = []string{}
	}
	out := make([]string, 0, len(params))
	notifyKind := slotNotifyKind(kind)
	for _, raw := range params {
		token := strings.TrimSpace(raw)
		if token == "" {
			return nil, &SlotError{Msg: "A template value cannot be blank."}
		}
		if notifyKind != "" {
			if !knownMergeField(token) {
				return nil, &SlotError{Msg: "There is nothing called " + token + " to fill a template with."}
			}
			if only := mergeFieldOnlyKind(token); only != "" && only != notifyKind {
				return nil, &SlotError{Msg: "The " + token + " field has no value on this message, so it cannot fill it in."}
			}
		}
		out = append(out, token)
	}
	return out, nil
}

// ValidateMessageSlot checks one slot and returns it with channels and timing normalised.
func ValidateMessageSlot(kind string, channels []string, timing types.MessageTiming, params []string) (types.MessageSlot, error) {
	kind = strings.TrimSpace(kind)
	if !knownSlotKind(kind) {
		return types.MessageSlot{}, &SlotError{Msg: "There is no message called " + kind + "."}
	}
	ch, err := normalizeChannels(channels)
	if err != nil {
		return types.MessageSlot{}, err
	}
	tm, err := normalizeTiming(kind, timing)
	if err != nil {
		return types.MessageSlot{}, err
	}
	ps, err := normalizeParams(kind, params)
	if err != nil {
		return types.MessageSlot{}, err
	}
	return types.MessageSlot{Kind: kind, Channels: ch, Timing: tm, Params: ps}, nil
}

func (s *Module) checkSlotWording(w http.ResponseWriter, r *http.Request, user store.User, template, language string, params []string) bool {
	name := strings.TrimSpace(template)
	if name == "" {
		return true
	}
	if user.WhatsAppToken == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "whatsapp_not_connected",
			"Connect your WhatsApp Business account before choosing templates.")
		return false
	}
	tmpl, err := s.templateForSend(r.Context(), user, name, language)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_template",
			"That template is not in your WhatsApp account. Refresh your templates and try again.")
		return false
	}
	if err != nil {
		s.fail(w, r, "message slots: template", err)
		return false
	}
	if !tmpl.Sendable {
		msg := tmpl.Unsupported
		if msg == "" {
			msg = "Meta has not approved that template yet — it is " + strings.ToLower(tmpl.Status) + "."
		}
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_unusable", msg)
		return false
	}
	if len(params) != tmpl.Variables {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_template_params",
			"That template needs exactly "+strconv.Itoa(tmpl.Variables)+" value(s) filling in.")
		return false
	}
	return true
}

func writeSlotError(w http.ResponseWriter, err error) bool {
	var se *SlotError
	if errors.As(err, &se) {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_slot", se.Msg)
		return true
	}
	return false
}

// ---------------------------------------------------------------- routes

func (s *Module) handleMessageDefaults(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	slots, err := s.ResolveDefaults(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "message defaults", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.MessageDefaultsResponse{Slots: slots})
}

func (s *Module) handleSetMessageDefaults(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body types.MessageDefaultsRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	seen := map[string]bool{}
	for _, in := range body.Slots {
		if seen[in.Kind] {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_slot", "Each message can only be saved once.")
			return
		}
		seen[in.Kind] = true
		norm, err := ValidateMessageSlot(in.Kind, in.Channels, in.Timing, in.Params)
		if writeSlotError(w, err) {
			return
		}
		if err != nil {
			s.fail(w, r, "message defaults: validate", err)
			return
		}
		norm.Template = strings.TrimSpace(in.Template)
		norm.Language = strings.TrimSpace(in.Language)
		norm.Enabled = in.Enabled
		if !s.checkSlotWording(w, r, user, norm.Template, norm.Language, norm.Params) {
			return
		}
		if err := s.store.UpsertMessageDefault(r.Context(), user.ID, norm); err != nil {
			s.fail(w, r, "message defaults: save", err)
			return
		}
	}
	slots, err := s.ResolveDefaults(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "message defaults: reload", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.MessageDefaultsResponse{Slots: slots})
}

func (s *Module) handleSetWebinarMessages(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	slug := chi.URLParam(r, "slug")
	if !s.crmWebinarAllowed(w, r, user.ID, slug) {
		return
	}
	var body types.WebinarMessagesRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	seen := map[string]bool{}
	for _, in := range body.Slots {
		kind := strings.TrimSpace(in.Kind)
		if !knownSlotKind(kind) {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_slot", "There is no message called "+kind+".")
			return
		}
		if seen[kind] {
			httpx.Error(w, http.StatusUnprocessableEntity, "crm_bad_slot", "Each message can only be saved once.")
			return
		}
		seen[kind] = true
		patch := types.MessageSlotPatch{Kind: kind, Enabled: in.Enabled, Template: in.Template, Language: in.Language}
		if in.Channels != nil {
			ch, err := normalizeChannels(*in.Channels)
			if writeSlotError(w, err) {
				return
			}
			patch.Channels = &ch
		}
		if in.Timing != nil {
			tm, err := normalizeTiming(kind, *in.Timing)
			if writeSlotError(w, err) {
				return
			}
			patch.Timing = &tm
		}
		if in.Params != nil {
			ps, err := normalizeParams(kind, *in.Params)
			if writeSlotError(w, err) {
				return
			}
			patch.Params = &ps
		}
		if in.Template != nil {
			lang := ""
			if in.Language != nil {
				lang = *in.Language
			}
			ps := []string{}
			if patch.Params != nil {
				ps = *patch.Params
			}
			if !s.checkSlotWording(w, r, user, *in.Template, lang, ps) {
				return
			}
			name := strings.TrimSpace(*in.Template)
			patch.Template = &name
		}
		if in.Language != nil {
			lang := strings.TrimSpace(*in.Language)
			patch.Language = &lang
		}
		if err := s.store.UpsertWebinarMessage(r.Context(), slug, patch); err != nil {
			s.fail(w, r, "webinar messages: save", err)
			return
		}
	}
	slots, err := s.ResolveSlots(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "webinar messages: reload", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.WebinarSlotsResponse{WebinarID: slug, Slots: slots})
}

// ---------------------------------------------------------------- follow-up timing

func webinarLocation(wb types.Webinar) *time.Location {
	if wb.TimeZone == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(wb.TimeZone)
	if err != nil {
		return time.UTC
	}
	return loc
}

/* applyFollowupTiming points a recipe enrollment at the slot's clock instead of
 * the preset delay. Only a stored default or webinar override counts: the built-in
 * delay would otherwise move a sequence the host timed themselves. */
func (s *Module) applyFollowupTiming(ctx context.Context, slug string, since time.Time) {
	if slug == "" {
		return
	}
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.log.Warn("message slots: webinar", "webinar", slug, "error", err)
		return
	}
	slots, err := s.ResolveSlots(ctx, slug)
	if err != nil {
		s.log.Warn("message slots: follow-up timing", "webinar", slug, "error", err)
		return
	}
	end := types.EndOf(wb)
	loc := webinarLocation(wb)
	for _, p := range followupPresets {
		sl, ok := types.FindSlot(slots, followupKind(p.group))
		if !ok {
			continue
		}
		if sl.Layers.Timing != types.LayerDefault && sl.Layers.Timing != types.LayerWebinar {
			continue
		}
		due := sl.Timing.From(end, loc)
		if due.IsZero() {
			continue
		}
		if err := s.store.RetargetRecipeDue(ctx, slug, p.id, due, since); err != nil {
			s.log.Warn("message slots: retarget", "webinar", slug, "recipe", p.id, "error", err)
		}
	}
}

/* followupBlocked is a recipe step whose slot is explicitly off or not on WhatsApp.
 * The built-in "off" does not count: a recipe the host turned on still sends until
 * they save a slot that says otherwise. */
func followupBlocked(slots []types.MessageSlot, recipe string) bool {
	kind, ok := recipeFollowupKind(recipe)
	if !ok {
		return false
	}
	sl, ok := types.FindSlot(slots, kind)
	if !ok || sl.Layers.Enabled == types.LayerBuiltin {
		return false
	}
	return !sl.Sends(types.ChannelWhatsApp)
}
