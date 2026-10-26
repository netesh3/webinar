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

/* A box room has a dispatcher only while something will take the dispatch: the worker on the
 * video box (CAPTIONS_PROVIDER=deepgram) or the captions box (CAPTIONS_BOX_ENABLED with
 * CAPTIONS_PROVIDER=local set explicitly). Without either the room must be told server
 * captions are unavailable (it captions on-device). */
func TestDispatcherForBoxRoomNeedsAWorker(t *testing.T) {
	s := &Server{cfg: config.Config{CaptionsSecret: "0123456789abcdef0123456789abcdef"},
		box: &boxManager{cfg: config.SFUBox{Project: "do-blr"}}}
	room := boxRoom{RoomManager: fakeAgentRoom{}, s: s}

	if d, ok := dispatcherFor(edgeRoom{RoomManager: room}); ok || d != nil {
		t.Fatalf("no worker: dispatcher %v, %v; want none", d, ok)
	}
	// CAPTIONS_BOX_ENABLED alone (local only by default) makes no captions box.
	s.box.cfg.Captions.On = true
	if _, ok := dispatcherFor(edgeRoom{RoomManager: room}); ok || s.captionsOn() {
		t.Fatal("CAPTIONS_BOX_ENABLED without an explicit CAPTIONS_PROVIDER=local turned the captions box on")
	}
	s.cfg.CaptionsProvider = config.CaptionsProvider{Name: "local", Explicit: true}
	d, ok := dispatcherFor(edgeRoom{RoomManager: room})
	if !ok {
		t.Fatal("captions box on: no dispatcher")
	}
	if _, isBox := d.(boxDispatcher); !isBox {
		t.Fatalf("captions box on: dispatcher %T, want the box guard's", d)
	}
	// Deepgram on the video box: a dispatcher, and never the captions box, whatever CAPTIONS_BOX_ENABLED says.
	s.cfg.CaptionsProvider = config.CaptionsProvider{Name: "deepgram", DeepgramKey: "k0123456789abcdefghij"}
	if d, ok := dispatcherFor(edgeRoom{RoomManager: room}); !ok {
		t.Fatal("deepgram on the video box: no dispatcher")
	} else if _, isBox := d.(boxDispatcher); !isBox {
		t.Fatalf("deepgram: dispatcher %T, want the box guard's", d)
	}
	if s.captionsOn() {
		t.Fatal("deepgram turned the captions box on")
	}
	// A room not on the box is unaffected.
	if _, ok := dispatcherFor(fakeAgentRoom{}); !ok {
		t.Fatal("a plain LiveKit room lost its dispatcher")
	}
}
