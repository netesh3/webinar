package engage

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func TestSlotTimingValidation(t *testing.T) {
	if _, err := ValidateMessageSlot(types.SlotConfirmation, []string{"email"},
		types.MessageTiming{Type: types.TimingImmediate}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateMessageSlot(types.SlotConfirmation, []string{"sms"},
		types.MessageTiming{Type: types.TimingImmediate}, nil); err == nil {
		t.Fatal("sms channel accepted")
	}
	got, err := ValidateMessageSlot(types.SlotReminder, []string{"whatsapp", "email", "email"},
		types.MessageTiming{Type: types.TimingBefore, Minutes: []int{60, 1440, 60}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Channels) != 2 || got.Channels[0] != types.ChannelEmail || got.Channels[1] != types.ChannelWhatsApp {
		t.Fatalf("channels = %v", got.Channels)
	}
	if len(got.Timing.Minutes) != 2 || got.Timing.Minutes[0] != 1440 || got.Timing.Minutes[1] != 60 {
		t.Fatalf("minutes = %v", got.Timing.Minutes)
	}
	if _, err := ValidateMessageSlot(types.SlotReminder, nil,
		types.MessageTiming{Type: types.TimingBefore, Minutes: []int{0}}, nil); err == nil {
		t.Fatal("zero offset accepted")
	}
	hour := 9
	if _, err := ValidateMessageSlot(types.SlotFollowupHigh, []string{"whatsapp"},
		types.MessageTiming{Type: types.TimingNextMorning, Hour: &hour}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateMessageSlot(types.SlotReplay, []string{"email"},
		types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{120}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateMessageSlot("followup_nope", nil,
		types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{1}}, nil); err == nil {
		t.Fatal("unknown kind accepted")
	}
}

func TestSlotTimingJSON(t *testing.T) {
	raw, err := json.Marshal(types.MessageTiming{Type: types.TimingAfterEnd, Minutes: []int{120}})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"type":"after_end","minutes":120}` {
		t.Fatalf("after_end = %s", raw)
	}
	raw, err = json.Marshal(types.MessageTiming{Type: types.TimingBefore, Minutes: []int{1440, 60}})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"type":"before","minutes":[1440,60]}` {
		t.Fatalf("before = %s", raw)
	}
	var back types.MessageTiming
	if err := json.Unmarshal([]byte(`{"type":"after_end","minutes":120}`), &back); err != nil {
		t.Fatal(err)
	}
	if back.Type != types.TimingAfterEnd || len(back.Minutes) != 1 || back.Minutes[0] != 120 {
		t.Fatalf("decoded = %+v", back)
	}
	hour := 9
	end := time.Date(2026, 9, 28, 20, 0, 0, 0, time.UTC)
	due := (types.MessageTiming{Type: types.TimingNextMorning, Hour: &hour}).From(end, time.UTC)
	want := time.Date(2026, 9, 29, 9, 0, 0, 0, time.UTC)
	if !due.Equal(want) {
		t.Fatalf("next morning = %s, want %s", due, want)
	}
}
