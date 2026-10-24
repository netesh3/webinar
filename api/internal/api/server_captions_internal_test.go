package api

import (
	"context"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
)

// fakeAgentRoom is a RoomManager that can also dispatch the caption agent.
type fakeAgentRoom struct{ RoomManager }

func (fakeAgentRoom) DispatchAgent(context.Context, string, string, string) (string, error) {
	return "d", nil
}
func (fakeAgentRoom) StopAgent(context.Context, string, string) error { return nil }

/* The video box never runs the caption agent, so a box room has a dispatcher only while the
 * captions box is on: without it nothing would take the dispatch, and the room must be told
 * server captions are unavailable (it captions on-device). */
func TestDispatcherForBoxRoomNeedsTheCaptionsBox(t *testing.T) {
	s := &Server{cfg: config.Config{CaptionsSecret: "0123456789abcdef0123456789abcdef"},
		box: &boxManager{cfg: config.SFUBox{Project: "do-blr"}}}
	room := boxRoom{RoomManager: fakeAgentRoom{}, s: s}

	if d, ok := dispatcherFor(edgeRoom{RoomManager: room}); ok || d != nil {
		t.Fatalf("captions box off: dispatcher %v, %v; want none", d, ok)
	}
	s.box.cfg.Captions.On = true
	d, ok := dispatcherFor(edgeRoom{RoomManager: room})
	if !ok {
		t.Fatal("captions box on: no dispatcher")
	}
	if _, isBox := d.(boxDispatcher); !isBox {
		t.Fatalf("captions box on: dispatcher %T, want the box guard's", d)
	}
	// A room not on the box is unaffected.
	if _, ok := dispatcherFor(fakeAgentRoom{}); !ok {
		t.Fatal("a plain LiveKit room lost its dispatcher")
	}
}
