package capture

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type memSink struct {
	mu      sync.Mutex
	batches [][]Event
	block   chan struct{}
	fail    error
}

func (m *memSink) InsertEngagementEvents(ctx context.Context, batch []Event) error {
	if m.block != nil {
		select {
		case <-m.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail != nil {
		return m.fail
	}
	m.batches = append(m.batches, append([]Event(nil), batch...))
	return nil
}

func (m *memSink) total() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, b := range m.batches {
		n += len(b)
	}
	return n
}

func ev(id string, k Kind) Event {
	return Event{Slug: "w1", Identity: id, Kind: k, Emoji: "👏"}
}

func TestFlushWritesEverythingAcceptedInBatches(t *testing.T) {
	sink := &memSink{}
	r := New(sink, Config{BatchSize: 10, FlushEvery: time.Hour, ReactionsPerMin: 1000}, nil)
	defer r.Close(context.Background())

	for i := 0; i < 25; i++ {
		if !r.Record(ev("att_a", Reaction)) {
			t.Fatalf("event %d refused", i)
		}
	}
	if err := r.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := sink.total(); got != 25 {
		t.Fatalf("wrote %d events, want 25", got)
	}
	for _, b := range sink.batches {
		if len(b) > 10 {
			t.Fatalf("batch of %d exceeds BatchSize", len(b))
		}
	}
}

func TestPerSenderLimitBoundsStoredReactions(t *testing.T) {
	sink := &memSink{}
	r := New(sink, Config{FlushEvery: time.Hour, ReactionsPerMin: 3, HandsPerMin: 1}, nil)
	defer r.Close(context.Background())

	for i := 0; i < 10; i++ {
		r.Record(ev("att_spam", Reaction))
	}
	r.Record(ev("att_other", Reaction))
	r.Record(ev("att_spam", HandRaise))
	r.Record(ev("att_spam", HandLower))
	r.Record(ev("att_spam", StageOn))
	_ = r.Flush(context.Background())

	if got := sink.total(); got != 3+1+1+1 {
		t.Fatalf("stored %d, want 6 (3 reactions, 1 other, 1 hand, 1 stage)", got)
	}
	if s := r.Stats(); s.Limited != 8 {
		t.Fatalf("limited = %d, want 8", s.Limited)
	}
}

func TestFullBufferDropsInsteadOfBlocking(t *testing.T) {
	sink := &memSink{block: make(chan struct{})}
	r := New(sink, Config{Buffer: 4, BatchSize: 1, FlushEvery: time.Hour, ReactionsPerMin: 1000}, nil)

	start := time.Now()
	for i := 0; i < 100; i++ {
		r.Record(ev("att_a", Reaction))
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("Record blocked on a stalled sink")
	}
	if s := r.Stats(); s.Dropped == 0 {
		t.Fatalf("expected drops, got %+v", s)
	}
	close(sink.block)
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	s := r.Stats()
	if s.Accepted+s.Dropped != 100 {
		t.Fatalf("accepted %d + dropped %d != 100", s.Accepted, s.Dropped)
	}
	if uint64(sink.total()) != s.Accepted {
		t.Fatalf("wrote %d, accepted %d", sink.total(), s.Accepted)
	}
}

func TestCloseDrainsAndRefusesLateEvents(t *testing.T) {
	sink := &memSink{}
	r := New(sink, Config{FlushEvery: time.Hour, ReactionsPerMin: 1000}, nil)
	for i := 0; i < 7; i++ {
		r.Record(ev("att_a", Reaction))
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sink.total() != 7 {
		t.Fatalf("close wrote %d, want 7", sink.total())
	}
	if r.Record(ev("att_a", Reaction)) {
		t.Fatal("accepted an event after Close")
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal("second Close:", err)
	}
	if err := r.Flush(context.Background()); err != nil {
		t.Fatal("Flush after Close:", err)
	}
}

func TestFailedBatchIsCountedAndDropped(t *testing.T) {
	sink := &memSink{fail: errors.New("db down")}
	r := New(sink, Config{FlushEvery: time.Hour, ReactionsPerMin: 1000}, nil)
	defer r.Close(context.Background())
	r.Record(ev("att_a", Reaction))
	if err := r.Flush(context.Background()); err == nil {
		t.Fatal("expected the write error from Flush")
	}
	if s := r.Stats(); s.Failed != 1 {
		t.Fatalf("failed = %d, want 1", s.Failed)
	}
}

func TestTickerFlushesWithoutAnExplicitFlush(t *testing.T) {
	sink := &memSink{}
	r := New(sink, Config{FlushEvery: 20 * time.Millisecond, ReactionsPerMin: 1000}, nil)
	defer r.Close(context.Background())
	r.Record(ev("att_a", Reaction))
	deadline := time.Now().Add(2 * time.Second)
	for sink.total() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("ticker never flushed")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestIncompleteEventsAreIgnored(t *testing.T) {
	r := New(&memSink{}, Config{}, nil)
	defer r.Close(context.Background())
	if r.Record(Event{Identity: "att_a", Kind: Reaction}) {
		t.Fatal("accepted an event with no webinar")
	}
	var nilRec *Recorder
	if nilRec.Record(ev("att_a", Reaction)) {
		t.Fatal("nil recorder accepted an event")
	}
}

func BenchmarkRecord(b *testing.B) {
	r := New(&memSink{}, Config{Buffer: 1 << 16, ReactionsPerMin: 1 << 30}, nil)
	defer r.Close(context.Background())
	e := ev("att_a", Reaction)
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			r.Record(e)
		}
	})
}
