package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/types"
)

/* The server half of one screen share at a time. Unit tests, no database: the rule is
 * pure, and enforcement only needs a roster and somewhere to record mutes.
 *
 * pickShare must agree with web/lib/share-lock.ts case for case — the browsers and the
 * server each decide independently, and a disagreement is two people each told they
 * won. The cases below are the ones web/lib/share-lock.test.mts pins down. */

func TestPickShareMatchesTheBrowserRule(t *testing.T) {
	sh := func(id string, at int64, privileged, muted bool) shareCandidate {
		return shareCandidate{Identity: id, StartedAt: at, Privileged: privileged, Muted: muted}
	}
	tests := []struct {
		name   string
		shares []shareCandidate
		want   string
	}{
		{"nobody sharing", nil, ""},
		{"one share", []shareCandidate{sh("pan_a", 100, false, false)}, "pan_a"},
		{"two panelists: first keeps it",
			[]shareCandidate{sh("pan_a", 100, false, false), sh("pan_b", 200, false, false)}, "pan_a"},
		{"later host takes over",
			[]shareCandidate{sh("pan_a", 100, false, false), sh("host", 200, true, false)}, "host"},
		{"later panelist does not take over",
			[]shareCandidate{sh("host", 100, true, false), sh("pan_a", 200, false, false)}, "host"},
		{"newest of host and co-host",
			[]shareCandidate{sh("host", 100, true, false), sh("cohost", 200, true, false)}, "cohost"},
		{"undated panelist share is newest",
			[]shareCandidate{sh("pan_a", 100, false, false), sh("pan_b", 0, false, false)}, "pan_a"},
		{"undated host share is newest",
			[]shareCandidate{sh("host", 100, true, false), sh("cohost", 0, true, false)}, "cohost"},
		{"tie broken by identity",
			[]shareCandidate{sh("pan_b", 100, false, false), sh("pan_a", 100, false, false)}, "pan_a"},
		{"muted share does not count",
			[]shareCandidate{sh("pan_a", 100, false, true), sh("pan_b", 200, false, false)}, "pan_b"},
		{"muted host share does not count",
			[]shareCandidate{sh("host", 300, true, true), sh("pan_a", 100, false, false)}, "pan_a"},
	}
	for _, tt := range tests {
		if got := pickShare(tt.shares); got != tt.want {
			t.Errorf("%s: pickShare = %q, want %q", tt.name, got, tt.want)
		}
	}
}

/* shareRooms is the slice of RoomManager enforcement touches: a roster to read and a
 * mute to record. Embedding the interface leaves every other method nil, so a call this
 * rule should never make panics the test instead of passing quietly. */
type shareRooms struct {
	RoomManager
	roster []types.LiveParticipant
	muted  []string
}

func (f *shareRooms) Participants(context.Context, string) ([]types.LiveParticipant, error) {
	return f.roster, nil
}

func (f *shareRooms) MuteTrack(_ context.Context, _, identity string, source livekit.TrackSource, muted bool) error {
	f.muted = append(f.muted, fmt.Sprintf("%s/%s=%v", identity, source, muted))
	return nil
}

func shareServer(roster []types.LiveParticipant) (*Server, *shareRooms) {
	return &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil))}, &shareRooms{roster: roster}
}

func sharing(identity string, role types.Role, at int64) types.LiveParticipant {
	return types.LiveParticipant{
		Identity:    identity,
		Role:        role,
		ScreenShare: &types.LiveScreenShare{StartedAtMicro: at},
	}
}

// A host taking over: the panelist's older share is muted, video and sound both.
func TestEnforceOneShareHostTakesOver(t *testing.T) {
	s, rooms := shareServer([]types.LiveParticipant{
		sharing("pan_A", types.RolePanelist, 100),
		sharing("host_H", types.RoleHost, 200),
		{Identity: "att_X", Role: types.RoleAttendee},
	})
	muted, err := s.enforceOneShare(context.Background(), rooms, "webinar_x")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(muted, []string{"pan_A"}) {
		t.Fatalf("muted = %v, want the panelist only", muted)
	}
	// One call for the share, one for its audio.
	if !slices.Equal(rooms.muted, []string{"pan_A/SCREEN_SHARE=true", "pan_A/SCREEN_SHARE_AUDIO=true"}) {
		t.Errorf("mute calls = %v", rooms.muted)
	}
}

// A panelist who slipped past their own blocked button loses to the share already up.
func TestEnforceOneSharePanelistIsBlocked(t *testing.T) {
	s, rooms := shareServer([]types.LiveParticipant{
		sharing("host_H", types.RoleHost, 100),
		sharing("pan_A", types.RolePanelist, 200),
	})
	muted, _ := s.enforceOneShare(context.Background(), rooms, "webinar_x")
	if !slices.Equal(muted, []string{"pan_A"}) {
		t.Errorf("muted = %v, want the late panelist", muted)
	}

	s, rooms = shareServer([]types.LiveParticipant{
		sharing("pan_B", types.RolePanelist, 300),
		sharing("pan_A", types.RolePanelist, 100),
	})
	muted, _ = s.enforceOneShare(context.Background(), rooms, "webinar_x")
	if !slices.Equal(muted, []string{"pan_B"}) {
		t.Errorf("two panelists: muted = %v, want the second", muted)
	}
}

// A co-host counts as a host: their newer share takes over the host's.
func TestEnforceOneShareCoHostTakesOver(t *testing.T) {
	cohost := sharing("pan_C", types.RolePanelist, 200)
	cohost.CoHost = true
	s, rooms := shareServer([]types.LiveParticipant{sharing("host_H", types.RoleHost, 100), cohost})
	muted, _ := s.enforceOneShare(context.Background(), rooms, "webinar_x")
	if !slices.Equal(muted, []string{"host_H"}) {
		t.Errorf("muted = %v, want the host's older share", muted)
	}
}

// One share, or one live share plus an already-muted one, is left alone — so a retried
// webhook does not mute anything twice.
func TestEnforceOneShareLeavesASingleShareAlone(t *testing.T) {
	s, rooms := shareServer([]types.LiveParticipant{sharing("pan_A", types.RolePanelist, 100)})
	if muted, _ := s.enforceOneShare(context.Background(), rooms, "webinar_x"); len(muted) != 0 {
		t.Errorf("a lone share was muted: %v", muted)
	}

	loser := sharing("pan_A", types.RolePanelist, 100)
	loser.ScreenShare.Muted = true
	s, rooms = shareServer([]types.LiveParticipant{loser, sharing("host_H", types.RoleHost, 200)})
	if muted, _ := s.enforceOneShare(context.Background(), rooms, "webinar_x"); len(muted) != 0 {
		t.Errorf("an already-muted share was muted again: %v", muted)
	}
	if len(rooms.muted) != 0 {
		t.Errorf("mute calls = %v, want none", rooms.muted)
	}
}
