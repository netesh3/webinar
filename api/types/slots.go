package types

import (
	"encoding/json"
	"time"
)

/* Message slots: one shape for every attendee message.
 *
 * Confirmation, reminder, replay and each follow-up are the same thing. The account
 * default (crm_message_defaults) applies to every webinar; a webinar stores only what
 * differs (webinar_message_settings). NULL there means "use the default". ResolveSlots
 * is the one place those two layers are combined.
 */

const (
	SlotConfirmation    = "confirmation"
	SlotReminder        = "reminder"
	SlotReplay          = "replay"
	SlotFollowupHigh    = "followup_high"
	SlotFollowupEngaged = "followup_engaged"
	SlotFollowupPassive = "followup_passive"
	SlotFollowupRisk    = "followup_risk"
	SlotFollowupNoShow  = "followup_no_show"

	ChannelEmail    = "email"
	ChannelWhatsApp = "whatsapp"

	TimingImmediate   = "immediate"
	TimingBefore      = "before"
	TimingOnPublish   = "on_publish"
	TimingAfterEnd    = "after_end"
	TimingNextMorning = "next_morning"

	/* Where a resolved field came from. options is the legacy WebinarOptions read,
	 * used for confirmation and reminder when the webinar has no settings row yet. */
	LayerBuiltin = "builtin"
	LayerDefault = "default"
	LayerOptions = "options"
	LayerWebinar = "webinar"
)

/* MessageTiming is when a slot sends.
 *
 * before carries minutes as a list (largest first). after_end carries minutes as
 * one number on the wire. next_morning carries the hour in the webinar's time zone.
 */
type MessageTiming struct {
	Type string `json:"type"`
	/** Minutes before the start (a list) or after the end (one number on the wire). */
	Minutes []int `json:"minutes,omitempty"`
	/** Hour of the morning after the webinar, 0–23, for next_morning. */
	Hour *int `json:"hour,omitempty"`
}

func (t MessageTiming) MarshalJSON() ([]byte, error) {
	switch t.Type {
	case TimingBefore:
		mins := t.Minutes
		if mins == nil {
			mins = []int{}
		}
		return json.Marshal(struct {
			Type    string `json:"type"`
			Minutes []int  `json:"minutes"`
		}{t.Type, mins})
	case TimingAfterEnd:
		m := 0
		if len(t.Minutes) > 0 {
			m = t.Minutes[0]
		}
		return json.Marshal(struct {
			Type    string `json:"type"`
			Minutes int    `json:"minutes"`
		}{t.Type, m})
	case TimingNextMorning:
		h := 0
		if t.Hour != nil {
			h = *t.Hour
		}
		return json.Marshal(struct {
			Type string `json:"type"`
			Hour int    `json:"hour"`
		}{t.Type, h})
	default:
		return json.Marshal(struct {
			Type string `json:"type"`
		}{t.Type})
	}
}

func (t *MessageTiming) UnmarshalJSON(b []byte) error {
	var raw struct {
		Type    string          `json:"type"`
		Minutes json.RawMessage `json:"minutes"`
		Hour    *int            `json:"hour"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	t.Type = raw.Type
	t.Hour = raw.Hour
	t.Minutes = nil
	if len(raw.Minutes) == 0 || string(raw.Minutes) == "null" {
		return nil
	}
	if raw.Minutes[0] == '[' {
		var nums []float64
		if err := json.Unmarshal(raw.Minutes, &nums); err != nil {
			return err
		}
		t.Minutes = make([]int, len(nums))
		for i, n := range nums {
			t.Minutes[i] = int(n)
		}
		return nil
	}
	var one float64
	if err := json.Unmarshal(raw.Minutes, &one); err != nil {
		return err
	}
	t.Minutes = []int{int(one)}
	return nil
}

/* MessageSlot is one resolved attendee message.
 *
 * Source is the highest layer that contributed a field. Layers says which layer
 * each field came from, so a webinar that only overrides timing still shows the
 * wording as the account default.
 */
type MessageSlot struct {
	Kind     string            `json:"kind"`
	Channels []string          `json:"channels"`
	Timing   MessageTiming     `json:"timing"`
	Template string            `json:"template"`
	Language string            `json:"language"`
	Params   []string          `json:"params"`
	Enabled  bool              `json:"enabled"`
	Source   string            `json:"source"`
	Layers   MessageSlotLayers `json:"layers"`
}

/* MessageSlotLayers names the layer of each field: builtin, default, options or webinar. */
type MessageSlotLayers struct {
	Channels string `json:"channels"`
	Timing   string `json:"timing"`
	Template string `json:"template"`
	Language string `json:"language"`
	Params   string `json:"params"`
	Enabled  string `json:"enabled"`
}

/* MessageSlotPatch is one webinar override. A null or omitted field is stored as
 * NULL and resolved from the account default. */
type MessageSlotPatch struct {
	Kind     string         `json:"kind"`
	Channels *[]string      `json:"channels"`
	Timing   *MessageTiming `json:"timing"`
	Template *string        `json:"template"`
	Language *string        `json:"language"`
	Params   *[]string      `json:"params"`
	Enabled  *bool          `json:"enabled"`
}

/* MessageDefaultsResponse is the coach's defaults, one slot per kind. */
type MessageDefaultsResponse struct {
	Slots []MessageSlot `json:"slots"`
}

/* MessageDefaultsRequest replaces the kinds it names. Kinds left out are unchanged. */
type MessageDefaultsRequest struct {
	Slots []MessageSlot `json:"slots"`
}

/* WebinarMessagesRequest replaces the override row for each named kind. */
type WebinarMessagesRequest struct {
	Slots []MessageSlotPatch `json:"slots"`
}

/* WebinarSlotsResponse is the resolved slots for one webinar. */
type WebinarSlotsResponse struct {
	WebinarID string        `json:"webinarId"`
	Slots     []MessageSlot `json:"slots"`
}

// Sends reports whether this slot is on and includes the channel.
func (s MessageSlot) Sends(channel string) bool {
	if !s.Enabled {
		return false
	}
	for _, c := range s.Channels {
		if c == channel {
			return true
		}
	}
	return false
}

// BeforeMinutes is the reminder offsets when timing is "before".
func (s MessageSlot) BeforeMinutes() []int {
	if s.Timing.Type != TimingBefore {
		return nil
	}
	return append([]int(nil), s.Timing.Minutes...)
}

// FindSlot returns the slot with this kind.
func FindSlot(slots []MessageSlot, kind string) (MessageSlot, bool) {
	for _, s := range slots {
		if s.Kind == kind {
			return s, true
		}
	}
	return MessageSlot{}, false
}

/* EndOf is when the webinar finished, or when it is scheduled to finish.
 *
 * EndedAt wins once the session has one. Otherwise the start plus the duration.
 */
func EndOf(wb Webinar) time.Time {
	if wb.EndedAt != "" {
		if t, err := time.Parse(time.RFC3339, wb.EndedAt); err == nil {
			return t
		}
	}
	start, err := time.Parse(time.RFC3339, wb.StartsAt)
	if err != nil {
		return time.Time{}
	}
	if wb.Duration > 0 {
		return start.Add(time.Duration(wb.Duration) * time.Minute)
	}
	return start
}

/* From is the moment a post-webinar timing is due, counted from end.
 *
 * immediate and on_publish return the zero time: send now. next_morning is the
 * next such hour in loc strictly after end.
 */
func (t MessageTiming) From(end time.Time, loc *time.Location) time.Time {
	switch t.Type {
	case TimingNextMorning:
		hour := 9
		if t.Hour != nil {
			hour = *t.Hour
		}
		if loc == nil {
			loc = time.UTC
		}
		local := end.In(loc)
		cand := time.Date(local.Year(), local.Month(), local.Day(), hour, 0, 0, 0, loc)
		if !cand.After(local) {
			cand = cand.Add(24 * time.Hour)
		}
		return cand
	case TimingAfterEnd:
		m := 0
		if len(t.Minutes) > 0 {
			m = t.Minutes[0]
		}
		return end.Add(time.Duration(m) * time.Minute)
	default:
		return time.Time{}
	}
}
