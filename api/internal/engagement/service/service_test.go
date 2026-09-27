package service

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/engagement"
	"github.com/netkumar/webcast/api/internal/store"
)

type fakeStore struct {
	mu      sync.Mutex
	loads   atomic.Int32
	saves   atomic.Int32
	gate    chan struct{}
	snap    *store.EngagementSnapshot
	started time.Time
}

func (f *fakeStore) EngagementInput(ctx context.Context, _ string, now time.Time) (engagement.Input, error) {
	f.loads.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	st := f.started
	return engagement.Input{Now: now, Webinar: engagement.Webinar{StartedAt: &st}}, nil
}

func (f *fakeStore) EngagementSnapshot(context.Context, string, int) (store.EngagementSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.snap == nil {
		return store.EngagementSnapshot{}, store.ErrNotFound
	}
	return *f.snap, nil
}

func (f *fakeStore) SaveEngagement(_ context.Context, _ string, _ int, at time.Time, payload []byte, _ []engagement.Scored) (bool, error) {
	f.saves.Add(1)
	f.mu.Lock()
	f.snap = &store.EngagementSnapshot{Payload: payload, ComputedAt: at}
	f.mu.Unlock()
	return true, nil
}

func webinar(status string, started, ended *time.Time) store.EngagementWebinar {
	return store.EngagementWebinar{ID: "w", Slug: "s", Status: status, StartedAt: started, EndedAt: ended}
}

func TestConcurrentRequestsShareOneCompute(t *testing.T) {
	now := time.Now()
	fs := &fakeStore{gate: make(chan struct{}), started: now.Add(-time.Hour)}
	svc := New(fs, nil, Config{}, nil)
	w := webinar("ended", &fs.started, &now)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := svc.Summary(context.Background(), w); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(fs.gate)
	wg.Wait()
	if fs.loads.Load() != 1 || fs.saves.Load() != 1 {
		t.Fatalf("loads %d saves %d, want one each", fs.loads.Load(), fs.saves.Load())
	}
	if _, err := svc.Summary(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	if fs.loads.Load() != 1 {
		t.Fatal("a fresh snapshot of an ended webinar must be served from storage")
	}
}

func TestLiveSnapshotExpiresAfterTTL(t *testing.T) {
	start := time.Now().Add(-time.Hour)
	fs := &fakeStore{started: start}
	svc := New(fs, nil, Config{LiveTTL: 30 * time.Second}, nil)
	clock := time.Now()
	svc.now = func() time.Time { return clock }
	w := webinar("live", &start, nil)

	for i := 0; i < 3; i++ {
		if _, err := svc.Summary(context.Background(), w); err != nil {
			t.Fatal(err)
		}
	}
	if fs.loads.Load() != 1 {
		t.Fatalf("recomputed %d times inside the TTL", fs.loads.Load())
	}
	clock = clock.Add(31 * time.Second)
	_, _ = svc.Summary(context.Background(), w)
	if fs.loads.Load() != 2 {
		t.Fatalf("loads %d after the TTL, want 2", fs.loads.Load())
	}
}

func TestSnapshotFromBeforeTheEndIsStale(t *testing.T) {
	start := time.Now().Add(-2 * time.Hour)
	end := time.Now().Add(-time.Minute)
	fs := &fakeStore{started: start, snap: &store.EngagementSnapshot{Payload: []byte(`{}`), ComputedAt: end.Add(-time.Minute)}}
	svc := New(fs, nil, Config{}, nil)
	if _, err := svc.Summary(context.Background(), webinar("ended", &start, &end)); err != nil {
		t.Fatal(err)
	}
	if fs.loads.Load() != 1 {
		t.Fatal("a snapshot taken while live must be recomputed once the webinar ends")
	}
}

func TestNotStartedIsComputedButNotStored(t *testing.T) {
	fs := &fakeStore{}
	svc := New(fs, nil, Config{}, nil)
	if _, err := svc.Summary(context.Background(), webinar("scheduled", nil, nil)); err != nil {
		t.Fatal(err)
	}
	if fs.saves.Load() != 0 {
		t.Fatal("stored a snapshot for a webinar that never started")
	}
}

func TestCallerCancellationDoesNotCancelTheCompute(t *testing.T) {
	now := time.Now()
	fs := &fakeStore{gate: make(chan struct{}), started: now.Add(-time.Hour)}
	svc := New(fs, nil, Config{}, nil)
	w := webinar("ended", &fs.started, &now)
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { _, err := svc.Summary(ctx, w); errc <- err }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("the cancelled caller should get its context error")
	}
	close(fs.gate)
	deadline := time.Now().Add(2 * time.Second)
	for fs.saves.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("compute was abandoned with its first caller")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
