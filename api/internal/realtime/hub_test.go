package realtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDispatchHonoursRecipients(t *testing.T) {
	h := NewHub(nil)
	a, cancelA := h.Subscribe("w1", "att_a")
	defer cancelA()
	b, cancelB := h.Subscribe("w1", "att_b")
	defer cancelB()
	other, cancelO := h.Subscribe("w2", "att_a")
	defer cancelO()

	if n := h.Dispatch(Event{Slug: "w1", Kind: KindPacket, Data: json.RawMessage(`{"kind":"chat"}`)}); n != 2 {
		t.Fatalf("broadcast delivered to %d, want 2", n)
	}
	if n := h.Dispatch(Event{Slug: "w1", Kind: KindPacket, To: []string{"att_b"}, Data: json.RawMessage(`{}`)}); n != 1 {
		t.Fatalf("targeted delivered to %d, want 1", n)
	}
	if len(a.C) != 1 || len(b.C) != 2 || len(other.C) != 0 {
		t.Fatalf("queues a=%d b=%d other=%d, want 1 2 0", len(a.C), len(b.C), len(other.C))
	}
	if h.Count("w1") != 2 || !h.Active() {
		t.Fatalf("count = %d", h.Count("w1"))
	}
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	h := NewHub(nil)
	slow, cancel := h.Subscribe("w", "att_slow")
	defer cancel()
	for i := 0; i < SubscriberBuffer+1; i++ {
		h.Dispatch(Event{Slug: "w", Kind: KindMeta, Data: json.RawMessage(`{}`)})
	}
	drained := 0
	for range slow.C {
		drained++
	}
	if drained != SubscriberBuffer {
		t.Fatalf("drained %d before close, want %d", drained, SubscriberBuffer)
	}
	if h.Count("w") != 0 {
		t.Fatal("dropped subscriber still registered")
	}
	cancel() // a second close is safe
}

func TestFirstSubscriberStartsListener(t *testing.T) {
	calls := 0
	h := NewHub(func() { calls++ })
	_, c1 := h.Subscribe("w", "a")
	_, c2 := h.Subscribe("w", "b")
	c1()
	c2()
	if calls != 1 {
		t.Fatalf("onFirst ran %d times, want 1", calls)
	}
}

func TestFitTurnsOversizeIntoRefetch(t *testing.T) {
	small := Event{Slug: "w", Kind: KindPacket, Data: json.RawMessage(`{"kind":"chat","text":"hi"}`)}
	got, raw, err := Fit(small)
	if err != nil || got.Kind != KindPacket || len(raw) > MaxPayload {
		t.Fatalf("small event changed: %+v %v", got, err)
	}
	big := Event{Slug: "w", Kind: KindPacket, To: []string{"att_x"},
		Data: json.RawMessage(`{"kind":"chat","text":"` + strings.Repeat("x", 9000) + `"}`)}
	got, raw, err = Fit(big)
	if err != nil || got.Kind != KindRefetch || len(raw) > MaxPayload {
		t.Fatalf("big event = %+v (%d bytes) %v", got.Kind, len(raw), err)
	}
	if string(got.Data) != `{"kind":"chat"}` || len(got.To) != 1 {
		t.Fatalf("refetch = %s to %v", got.Data, got.To)
	}
}

func TestLocalBusDispatches(t *testing.T) {
	h := NewHub(nil)
	bus := NewBus(h, nil, nil, nil)
	sub, cancel := h.Subscribe("w", "a")
	defer cancel()
	bus.Publish(context.Background(), Event{Slug: "w", Kind: KindMeta, Data: json.RawMessage(`{"status":"live"}`)})
	if e := <-sub.C; e.Kind != KindMeta {
		t.Fatalf("got %+v", e)
	}
	bus.Start() // no connect func: a no-op
	bus.Close()
}
