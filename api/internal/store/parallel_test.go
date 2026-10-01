package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestRunParallelOverlaps(t *testing.T) {
	var (
		mu        sync.Mutex
		in, maxIn int
	)
	fn := func(context.Context) error {
		mu.Lock()
		in++
		if in > maxIn {
			maxIn = in
		}
		mu.Unlock()
		time.Sleep(40 * time.Millisecond)
		mu.Lock()
		in--
		mu.Unlock()
		return nil
	}
	if err := RunParallel(context.Background(), fn, fn, fn); err != nil {
		t.Fatal(err)
	}
	if maxIn < 2 {
		t.Fatalf("reads ran one at a time (max in flight %d)", maxIn)
	}
}

func TestRunParallelReturnsFirstErrorAndCancels(t *testing.T) {
	boom := errors.New("boom")
	started := make(chan struct{})
	err := RunParallel(context.Background(),
		func(context.Context) error {
			close(started)
			return boom
		},
		func(ctx context.Context) error {
			<-started
			<-ctx.Done()
			return ctx.Err()
		},
	)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
}
