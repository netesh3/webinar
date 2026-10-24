package lk

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
)

// fakeDispatch is LiveKit's agent dispatch service, in memory.
type fakeDispatch struct {
	mu       sync.Mutex
	list     []*livekit.AgentDispatch
	created  int
	deleted  []string
	nextID   int
	lastMeta string
}

func (f *fakeDispatch) CreateDispatch(_ context.Context, r *livekit.CreateAgentDispatchRequest) (*livekit.AgentDispatch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	d := &livekit.AgentDispatch{Id: "AD_new", AgentName: r.AgentName, Room: r.Room, Metadata: r.Metadata}
	f.list = append(f.list, d)
	f.created++
	f.lastMeta = r.Metadata
	return d, nil
}

func (f *fakeDispatch) DeleteDispatch(_ context.Context, r *livekit.DeleteAgentDispatchRequest) (*livekit.AgentDispatch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, r.DispatchId)
	for i, d := range f.list {
		if d.Id == r.DispatchId {
			f.list = append(f.list[:i], f.list[i+1:]...)
			return d, nil
		}
	}
	return &livekit.AgentDispatch{}, nil
}

func (f *fakeDispatch) ListDispatch(_ context.Context, _ *livekit.ListAgentDispatchRequest) (*livekit.ListAgentDispatchResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &livekit.ListAgentDispatchResponse{AgentDispatches: append([]*livekit.AgentDispatch(nil), f.list...)}, nil
}

func job(status livekit.JobStatus) *livekit.Job {
	return &livekit.Job{State: &livekit.JobState{Status: status}}
}

func TestRedispatchIdleOnlyTouchesDispatchesWithoutALiveJob(t *testing.T) {
	f := &fakeDispatch{}
	srv := httptest.NewServer(livekit.NewAgentDispatchServiceServer(f))
	defer srv.Close()
	c := New("ws://x", srv.URL, "key", "secret-secret-secret-secret-secret-32", time.Hour)
	ctx := context.Background()

	// No dispatch: nothing (the session's own sync makes the first one).
	if did, err := c.RedispatchIdle(ctx, "webinar_a", "webinar-captions"); err != nil || did {
		t.Fatalf("no dispatch: %v %v", did, err)
	}
	// A running job: left alone, so a room never gets a second agent.
	f.list = []*livekit.AgentDispatch{{Id: "AD_1", AgentName: "webinar-captions", Room: "webinar_a", Metadata: `{"slug":"a"}`,
		State: &livekit.AgentDispatchState{Jobs: []*livekit.Job{job(livekit.JobStatus_JS_RUNNING)}}}}
	if did, err := c.RedispatchIdle(ctx, "webinar_a", "webinar-captions"); err != nil || did || f.created != 0 {
		t.Fatalf("running job: %v %v, %d created", did, err, f.created)
	}
	// Another agent's dispatch is not ours.
	f.list[0].AgentName = "other"
	f.list[0].State = nil
	if did, _ := c.RedispatchIdle(ctx, "webinar_a", "webinar-captions"); did {
		t.Fatal("re-created another agent's dispatch")
	}
	// No job (made before a worker registered) or only a failed one: re-created with its metadata.
	f.list[0].AgentName = "webinar-captions"
	f.list[0].State = &livekit.AgentDispatchState{Jobs: []*livekit.Job{job(livekit.JobStatus_JS_FAILED)}}
	did, err := c.RedispatchIdle(ctx, "webinar_a", "webinar-captions")
	if err != nil || !did || f.created != 1 || len(f.deleted) != 1 || f.deleted[0] != "AD_1" || f.lastMeta != `{"slug":"a"}` {
		t.Fatalf("idle dispatch: %v %v, created %d deleted %v meta %q", did, err, f.created, f.deleted, f.lastMeta)
	}
}
