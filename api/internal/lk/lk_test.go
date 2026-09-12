package lk

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/types"
)

// TestGrantFor is the most important test in this repo.
//
// LiveKit treats a nil permission pointer as "grant everything". If an attendee
// grant ever ships with CanPublish nil, every attendee can broadcast video and
// audio into the webinar. These assertions check the pointers are non-nil AND
// have the right value, because "not set" and "set to false" look identical if
// you only check the dereferenced value.
func TestGrantFor(t *testing.T) {
	const room = "webinar_test"

	tests := []struct {
		role          types.Role
		wantPublish   bool
		wantSubscribe bool
		wantData      bool
		wantRoomAdmin bool
	}{
		{types.RoleHost, true, true, true, true},
		{types.RolePanelist, true, true, true, false},
		// wantData false: an attendee sends chat, Q&A, hands and reactions through
		// POST /say, so the SERVER picks the recipients. See GrantFor.
		{types.RoleAttendee, false, true, false, false},
	}

	for _, tc := range tests {
		t.Run(string(tc.role), func(t *testing.T) {
			// hidden=false here so the Hidden assertion below is meaningful for
			// every role. TestGrantForHidden covers hidden=true separately.
			g, err := GrantFor(Spec{Role: tc.role, Room: room, Hidden: false})
			if err != nil {
				t.Fatalf("GrantFor(%q) returned error: %v", tc.role, err)
			}

			if g.Room != room {
				t.Errorf("Room = %q, want %q", g.Room, room)
			}
			if !g.RoomJoin {
				t.Error("RoomJoin = false, want true (nobody can join without it)")
			}

			// Explicitly-set pointers, not nil.
			if g.CanPublish == nil {
				t.Fatal("CanPublish is nil — LiveKit reads nil as ALL PERMISSIONS GRANTED")
			}
			if g.CanSubscribe == nil {
				t.Fatal("CanSubscribe is nil — must be explicit")
			}
			if g.CanPublishData == nil {
				t.Fatal("CanPublishData is nil — must be explicit")
			}

			if *g.CanPublish != tc.wantPublish {
				t.Errorf("CanPublish = %v, want %v", *g.CanPublish, tc.wantPublish)
			}
			if *g.CanSubscribe != tc.wantSubscribe {
				t.Errorf("CanSubscribe = %v, want %v", *g.CanSubscribe, tc.wantSubscribe)
			}
			if *g.CanPublishData != tc.wantData {
				t.Errorf("CanPublishData = %v, want %v", *g.CanPublishData, tc.wantData)
			}
			if g.RoomAdmin != tc.wantRoomAdmin {
				t.Errorf("RoomAdmin = %v, want %v", g.RoomAdmin, tc.wantRoomAdmin)
			}

			// No role should ever be able to create arbitrary rooms or act as a
			// recorder from a join token.
			if g.RoomCreate {
				t.Error("RoomCreate = true; join tokens must not create rooms")
			}
			if g.Recorder {
				t.Error("Recorder = true; only the egress service should hold this")
			}
			if g.Hidden {
				t.Error("Hidden = true; participants would be invisible to each other")
			}
		})
	}
}

// A promoted attendee has to be distinguishable from a scheduled panelist.
//
// They hold identical permissions, and the difference decides whether the
// room-wide "panelists may not unmute themselves" switch applies. Without the
// flag, bringing someone on stage after a mute-all gave them a camera and a
// microphone button that did nothing.
func TestMetadataMarksAPromotion(t *testing.T) {
	t.Run("a promoted attendee is marked", func(t *testing.T) {
		m := metadataFor(Spec{Role: types.RolePanelist, Identity: "att_KEY", Promoted: true})
		if !m.Promoted {
			t.Error("Promoted = false; the room-wide unmute switch would silence them")
		}
	})

	t.Run("a scheduled panelist is not", func(t *testing.T) {
		m := metadataFor(Spec{Role: types.RolePanelist, Identity: "user_1"})
		if m.Promoted {
			t.Error("Promoted = true for a scheduled panelist; the host's unmute switch would not apply to them")
		}
	})

	t.Run("somebody sent back to the audience is not", func(t *testing.T) {
		m := metadataFor(Spec{Role: types.RoleAttendee, Identity: "att_KEY", Promoted: true})
		if m.Promoted {
			t.Error("Promoted survived a demotion")
		}
	})

	// Silencing a promoted attendee and letting them speak again goes through
	// specOf, which rebuilds the spec from what the SFU holds. Losing the flag
	// there would quietly turn them into a scheduled panelist.
	t.Run("it survives a round trip through specOf", func(t *testing.T) {
		raw, err := json.Marshal(metadataFor(Spec{
			Role: types.RolePanelist, Identity: "att_KEY", Promoted: true, AudioOnly: true,
		}))
		if err != nil {
			t.Fatal(err)
		}
		spec, ok := specOf(&livekit.ParticipantInfo{
			Identity: "att_KEY",
			Metadata: string(raw),
			Permission: &livekit.ParticipantPermission{
				CanPublish: true, CanSubscribe: true,
			},
		})
		if !ok {
			t.Fatal("specOf refused a promoted panelist")
		}
		if !spec.Promoted {
			t.Error("Promoted was dropped; a host mute would demote them to a scheduled panelist")
		}
		if !spec.AudioOnly {
			t.Error("AudioOnly was dropped")
		}
	})
}

// TestGrantForHidden is the second half of the "attendees cannot see each other"
// guarantee: it must apply to the audience and to nobody else.
//
// A hidden host is the failure that matters. The SFU would keep them out of
// every attendee's roster, so 500 people would sit watching a stage they cannot
// see anyone on — and the symptom looks like a broken camera, not a permission
// bug.
func TestGrantForHidden(t *testing.T) {
	t.Run("attendee is hidden when asked", func(t *testing.T) {
		g, err := GrantFor(Spec{Role: types.RoleAttendee, Room: "room", Hidden: true})
		if err != nil {
			t.Fatal(err)
		}
		if !g.Hidden {
			t.Error("Hidden = false; attendees would be visible to each other")
		}
		// No attendee publishes data, hidden or not — their messages are relayed by
		// the API so the host's chat destination is enforced at the SFU. Asserted here
		// too, because hiding is the case where a client-side check would have been
		// the only alternative and could not have worked: a hidden attendee's packets
		// arrive with no participant attached, indistinguishable from the server's.
		if g.CanPublishData == nil || *g.CanPublishData {
			t.Error("a hidden attendee may publish data — a patched client could address the whole room")
		}
		if g.CanSubscribe == nil || !*g.CanSubscribe {
			t.Error("a hidden attendee lost CanSubscribe — they would see nothing")
		}
	})

	for _, role := range []types.Role{types.RoleHost, types.RolePanelist} {
		t.Run("stage role is never hidden: "+string(role), func(t *testing.T) {
			g, err := GrantFor(Spec{Role: role, Room: "room", Hidden: true})
			if err != nil {
				t.Fatal(err)
			}
			if g.Hidden {
				t.Errorf("%s minted with Hidden=true; the audience could not see them", role)
			}
		})
	}
}

// "Allow to talk" narrows a stage grant to the microphone plus the camera —
// not the microphone alone, so a speaker can be seen while they talk without
// the host having to widen them to a full stage seat (and hand them a screen
// share nobody asked for) just to turn their camera on. The trap is that
// LiveKit reads an EMPTY CanPublishSources as "every source", so a grant that
// forgets to name its sources explicitly hands over screen share as well —
// which is the one thing that still has to stay withheld here.
func TestGrantForAudioOnly(t *testing.T) {
	g, err := GrantFor(Spec{Role: types.RolePanelist, Room: "room", AudioOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if g.CanPublish == nil || !*g.CanPublish {
		t.Fatal("an audio-only grant still has to allow publishing — CanPublishSources is what narrows it")
	}
	if len(g.CanPublishSources) == 0 {
		t.Fatal("CanPublishSources is empty, which LiveKit reads as ALL SOURCES — screen share included")
	}
	for _, want := range []string{MicrophoneSource, "camera"} {
		if !slices.Contains(g.CanPublishSources, want) {
			t.Errorf("CanPublishSources = %v, want it to contain %q", g.CanPublishSources, want)
		}
	}
	if slices.Contains(g.CanPublishSources, "screen_share") {
		t.Error("audio-only grant permits \"screen_share\" — that is what still distinguishes it from a full stage seat")
	}

	// A full stage grant must stay unrestricted, not accidentally inherit a
	// source list from the audio-only path.
	full, err := GrantFor(Spec{Role: types.RolePanelist, Room: "room"})
	if err != nil {
		t.Fatal(err)
	}
	if len(full.CanPublishSources) != 0 {
		t.Errorf("a full panelist grant restricted sources to %v", full.CanPublishSources)
	}

	// AudioOnly is meaningless for the audience and must not quietly grant them
	// publish permission.
	att, err := GrantFor(Spec{Role: types.RoleAttendee, Room: "room", AudioOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if att.CanPublish == nil || *att.CanPublish {
		t.Error("AudioOnly gave an attendee publish permission")
	}
}

// A host mute is enforced by taking the microphone out of the grant, and that is
// where LiveKit's empty-list rule turns dangerous in the other direction: removing
// the only source an audio-only speaker had leaves an EMPTY list, which the SFU
// reads as "every source". Getting this wrong would answer "mute this person" by
// handing them a camera and a screen share.
func TestGrantForMutedByHost(t *testing.T) {
	t.Run("audio-only speaker loses publishing entirely", func(t *testing.T) {
		g, err := GrantFor(Spec{
			Role: types.RolePanelist, Room: "room", AudioOnly: true, MutedByHost: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if g.CanPublish == nil {
			t.Fatal("CanPublish is nil, which LiveKit reads as permission to publish everything")
		}
		if *g.CanPublish {
			t.Error("a silenced audio-only speaker can still publish")
		}
		if len(g.CanPublishSources) != 0 {
			t.Errorf("CanPublishSources = %v on a grant that permits nothing", g.CanPublishSources)
		}
	})

	t.Run("full panelist keeps video and loses audio", func(t *testing.T) {
		g, err := GrantFor(Spec{Role: types.RolePanelist, Room: "room", MutedByHost: true})
		if err != nil {
			t.Fatal(err)
		}
		if g.CanPublish == nil || !*g.CanPublish {
			t.Fatal("a muted panelist should still be able to show their camera")
		}
		if len(g.CanPublishSources) == 0 {
			t.Fatal("CanPublishSources is empty, which LiveKit reads as ALL SOURCES — the microphone included")
		}
		if slices.Contains(g.CanPublishSources, MicrophoneSource) {
			t.Errorf("CanPublishSources = %v still contains the microphone", g.CanPublishSources)
		}
		if !slices.Contains(g.CanPublishSources, "camera") {
			t.Errorf("CanPublishSources = %v, want the camera left alone", g.CanPublishSources)
		}
	})

	t.Run("the audience is unaffected", func(t *testing.T) {
		g, err := GrantFor(Spec{Role: types.RoleAttendee, Room: "room", MutedByHost: true})
		if err != nil {
			t.Fatal(err)
		}
		if g.CanPublish == nil || *g.CanPublish {
			t.Error("MutedByHost changed an attendee's publish permission")
		}
		if g.CanPublishData == nil || *g.CanPublishData {
			t.Error("MutedByHost changed an attendee's data permission")
		}
	})

	t.Run("the host is never silenced by their own control", func(t *testing.T) {
		g, err := GrantFor(Spec{Role: types.RoleHost, Room: "room", MutedByHost: true})
		if err != nil {
			t.Fatal(err)
		}
		if g.CanPublish == nil || !*g.CanPublish {
			t.Error("the host lost publish permission")
		}
		if len(g.CanPublishSources) != 0 {
			t.Errorf("the host's sources were restricted to %v", g.CanPublishSources)
		}
	})
}

// The metadata is what tells a browser "your microphone was taken away by the
// host" rather than "you are not a speaker". Both look identical in the
// permissions, and they need different words on screen.
func TestMetadataDistinguishesAHostMute(t *testing.T) {
	muted := metadataFor(Spec{Role: types.RolePanelist, AudioOnly: true, MutedByHost: true})
	if !muted.MutedByHost {
		t.Error("a silenced speaker's metadata does not say so")
	}
	if !muted.AudioOnly {
		t.Error("the scope of the grant was lost, so restoring it would widen it")
	}

	// An attendee has no microphone to take away, and labelling them "muted by the
	// host" would explain a control they never had.
	att := metadataFor(Spec{Role: types.RoleAttendee, MutedByHost: true})
	if att.MutedByHost {
		t.Error("an attendee was marked muted by the host")
	}
}

func TestTokenCarriesAudioOnlyMetadata(t *testing.T) {
	const secret = "testsecrettestsecrettestsecret32"
	c := New("ws://x", "http://x", "k", secret, time.Hour)

	tok, err := c.Token(Spec{
		Role: types.RolePanelist, Room: "r",
		Identity: "att_KEY", Name: "Asker", AudioOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	v, err := auth.ParseAPIToken(tok)
	if err != nil {
		t.Fatal(err)
	}
	_, grants, err := v.Verify(secret)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(grants.Video.CanPublishSources, MicrophoneSource) {
		t.Errorf("signed token sources = %v", grants.Video.CanPublishSources)
	}

	// The UI labels "allowed to talk" differently from "on the stage", and cannot
	// tell them apart from permissions alone.
	var meta Metadata
	if err := json.Unmarshal([]byte(grants.Metadata), &meta); err != nil {
		t.Fatalf("metadata unreadable: %v", err)
	}
	if !meta.AudioOnly || meta.Role != types.RolePanelist {
		t.Errorf("metadata = %+v, want panelist audio-only", meta)
	}
}

// HiddenFor is the single place the hide-attendees rule is decided, so it is
// where the "only the audience" invariant is pinned.
func TestHiddenFor(t *testing.T) {
	if !HiddenFor(types.RoleAttendee, true) {
		t.Error("an attendee must be hidden when the session hides attendees")
	}
	if HiddenFor(types.RoleAttendee, false) {
		t.Error("an attendee must be visible when the session does not hide them")
	}
	// The case that matters: promoting an attendee un-hides them, even while the
	// session is still hiding the rest of the audience.
	for _, role := range []types.Role{types.RoleHost, types.RolePanelist} {
		if HiddenFor(role, true) {
			t.Errorf("%s would be hidden; the audience could not see the stage", role)
		}
	}
	if HiddenFor("nonsense", true) {
		t.Error("an unknown role must not be hidden by default")
	}
}

// An attendee must not be able to publish even if a caller passes a role that
// looks close to a privileged one.
func TestGrantForRejectsUnknownRole(t *testing.T) {
	for _, bad := range []types.Role{"", "Host", "HOST", "admin", "panellist", "attendee "} {
		if _, err := GrantFor(Spec{Role: bad, Room: "room"}); err == nil {
			t.Errorf("GrantFor(%q) succeeded; unknown roles must be rejected, not defaulted", bad)
		}
	}
}

func TestCanPublish(t *testing.T) {
	if !CanPublish(types.RoleHost) || !CanPublish(types.RolePanelist) {
		t.Error("host and panelist must be able to publish")
	}
	if CanPublish(types.RoleAttendee) {
		t.Error("attendee must not be able to publish")
	}
	if CanPublish("nonsense") {
		t.Error("unknown role must default to no publishing")
	}
}

// The minted JWT must actually carry the restrictive grant — a bug in signing
// would not be caught by testing GrantFor alone.
func TestTokenCarriesAttendeeRestriction(t *testing.T) {
	const key, secret = "testkey", "testsecrettestsecrettestsecret32"
	c := New("ws://localhost:7880", "http://localhost:7880", key, secret, time.Hour)

	tok, err := c.Token(Spec{
		Role: types.RoleAttendee, Room: "webinar_x",
		Identity: "att_ABC", Name: "Test Attendee", Hidden: true,
	})
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok == "" {
		t.Fatal("empty token")
	}

	verifier, err := auth.ParseAPIToken(tok)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	_, grants, err := verifier.Verify(secret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if grants.Video == nil {
		t.Fatal("no video grant in token")
	}
	if grants.Video.CanPublish == nil || *grants.Video.CanPublish {
		t.Errorf("attendee token allows publishing: CanPublish=%v", grants.Video.CanPublish)
	}
	if grants.Video.CanSubscribe == nil || !*grants.Video.CanSubscribe {
		t.Error("attendee token must allow subscribing")
	}
	// Asserted on the signed token, not just on the grant struct: this is the
	// value the SFU actually reads, and it is what makes the host's chat
	// destination something a patched client cannot get around.
	if grants.Video.CanPublishData == nil || *grants.Video.CanPublishData {
		t.Errorf("attendee token allows publishing data: CanPublishData=%v",
			grants.Video.CanPublishData)
	}
	if grants.Video.Room != "webinar_x" {
		t.Errorf("Room = %q, want webinar_x", grants.Video.Room)
	}
	if grants.Video.RoomAdmin {
		t.Error("attendee token must not carry RoomAdmin")
	}
	if !grants.Video.Hidden {
		t.Error("hidden was requested but the signed token does not carry it")
	}
	// The role travels in metadata so a client can label participants without
	// trusting the identity string, and so the server can classify a
	// participant it reads back out of the SFU.
	var meta Metadata
	if err := json.Unmarshal([]byte(grants.Metadata), &meta); err != nil {
		t.Fatalf("token metadata is not readable: %v (%q)", err, grants.Metadata)
	}
	if meta.Role != types.RoleAttendee {
		t.Errorf("metadata role = %q, want attendee", meta.Role)
	}
}

// A token signed with the wrong secret must not verify — guards against a
// misconfigured deployment silently accepting foreign tokens.
func TestTokenRejectsWrongSecret(t *testing.T) {
	c := New("ws://x", "http://x", "k", "correcthorsebatterystaple-32chars!", time.Hour)
	tok, err := c.Token(Spec{Role: types.RoleHost, Room: "r", Identity: "i", Name: "n"})
	if err != nil {
		t.Fatal(err)
	}
	v, err := auth.ParseAPIToken(tok)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.Verify("a-completely-different-secret-value"); err == nil {
		t.Error("token verified against the wrong secret")
	}
}

func TestRoomName(t *testing.T) {
	if got := RoomName("scaling-webrtc-10k"); got != "webinar_scaling-webrtc-10k" {
		t.Errorf("RoomName = %q", got)
	}
}

// roleOf decides who a moderation action applies to, so getting it wrong means
// "mute everyone" reaching the host or skipping a promoted attendee.
func TestRoleOf(t *testing.T) {
	meta := func(role types.Role) string {
		b, err := json.Marshal(Metadata{Role: role})
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	tests := []struct {
		name string
		in   *livekit.ParticipantInfo
		want types.Role
	}{
		{
			name: "metadata wins",
			in: &livekit.ParticipantInfo{
				Identity: "att_ABC", Metadata: meta(types.RoleHost),
			},
			want: types.RoleHost,
		},
		{
			// A promoted attendee keeps their att_ identity but gains publish
			// permission. Classifying on the prefix would keep treating them as
			// audience and leave them out of the stage controls.
			name: "promoted attendee is a panelist",
			in: &livekit.ParticipantInfo{
				Identity: "att_ABC", Metadata: meta(types.RolePanelist),
			},
			want: types.RolePanelist,
		},
		{
			name: "no metadata falls back to permission",
			in: &livekit.ParticipantInfo{
				Identity:   "user_1",
				Permission: &livekit.ParticipantPermission{CanPublish: true},
			},
			want: types.RolePanelist,
		},
		{
			// Unparseable metadata must not be trusted into a privileged role.
			name: "garbage metadata is audience",
			in: &livekit.ParticipantInfo{
				Identity: "att_X", Metadata: "{not json",
				Permission: &livekit.ParticipantPermission{CanPublish: false},
			},
			want: types.RoleAttendee,
		},
		{
			name: "unknown role string is audience",
			in: &livekit.ParticipantInfo{
				Identity: "att_X", Metadata: `{"role":"superuser"}`,
			},
			want: types.RoleAttendee,
		},
		{
			name: "nothing known at all is audience",
			in:   &livekit.ParticipantInfo{Identity: "?"},
			want: types.RoleAttendee,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := roleOf(tc.in); got != tc.want {
				t.Errorf("roleOf = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSourceFor(t *testing.T) {
	for _, name := range []string{"", "microphone", "audio", "AUDIO"} {
		if got, ok := SourceFor(name); !ok || got != livekit.TrackSource_MICROPHONE {
			t.Errorf("SourceFor(%q) = %v, %v; want MICROPHONE, true", name, got, ok)
		}
	}
	if got, ok := SourceFor("screen"); !ok || got != livekit.TrackSource_SCREEN_SHARE {
		t.Errorf("SourceFor(screen) = %v, %v", got, ok)
	}
	// Unrecognised names must not fall through to a default: silently muting
	// the wrong source is worse than refusing.
	if _, ok := SourceFor("mikrofon"); ok {
		t.Error("SourceFor accepted an unknown source name")
	}
}

// describe is what the host's participant panel is built from, so a muted
// microphone has to read as muted and a silent participant must not read as
// live.
func TestDescribe(t *testing.T) {
	p := &livekit.ParticipantInfo{
		Identity:   "att_KEY",
		Name:       "Ada One",
		JoinedAt:   1700000000,
		Permission: &livekit.ParticipantPermission{CanPublish: false, Hidden: true},
	}
	got := describe(p)
	if !got.AudioMuted {
		t.Error("a participant publishing nothing must read as muted")
	}
	if !got.Hidden || got.CanPublish {
		t.Errorf("permission not carried through: %+v", got)
	}
	if got.Publishing == nil {
		t.Error("Publishing must be an empty slice, not nil — it is serialised to JSON")
	}

	p.Tracks = []*livekit.TrackInfo{
		{Sid: "TR_1", Type: livekit.TrackType_AUDIO, Source: livekit.TrackSource_MICROPHONE, Muted: false},
	}
	if describe(p).AudioMuted {
		t.Error("an unmuted microphone must not read as muted")
	}
}
