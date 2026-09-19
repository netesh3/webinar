// Package lk wraps LiveKit: room lifecycle, access-token minting and the
// in-session moderation actions a host performs.
//
// This is the security-critical part of the service. A LiveKit token is a
// bearer credential that tells the SFU what its holder may do, so the mapping
// from application role to VideoGrant is the boundary between "webinar" and
// "anyone can hijack the stage".
package lk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/netkumar/webcast/api/types"
)

type Client struct {
	url       string // ws:// for browsers
	apiKey    string
	apiSecret string
	tokenTTL  time.Duration
	rooms     *lksdk.RoomServiceClient
	egress    *lksdk.EgressClient
}

// New builds a client. httpURL is the http(s) form used for the server-side
// API; wsURL is the ws(s) form handed to browsers.
func New(wsURL, httpURL, apiKey, apiSecret string, tokenTTL time.Duration) *Client {
	return &Client{
		url:       wsURL,
		apiKey:    apiKey,
		apiSecret: apiSecret,
		tokenTTL:  tokenTTL,
		rooms:     lksdk.NewRoomServiceClient(httpURL, apiKey, apiSecret),
		egress:    lksdk.NewEgressClient(httpURL, apiKey, apiSecret),
	}
}

func (c *Client) URL() string       { return c.url }
func (c *Client) APIKey() string    { return c.apiKey }
func (c *Client) APISecret() string { return c.apiSecret }

// ptr is needed because VideoGrant's permission fields are *bool.
func ptr(b bool) *bool { return &b }

// Metadata travels with the participant and is readable by every client that
// can see them. Role is here so a browser can label and group participants
// without asking our API, and without trusting the identity string.
//
// Nothing secret goes in here: it is public to the room by design.
type Metadata struct {
	Role types.Role `json:"role"`
	// AudioOnly distinguishes "allowed to speak" from "on the stage", which is a
	// labelling difference the UI cares about and permissions alone don't say.
	AudioOnly bool `json:"audioOnly,omitempty"`
	// MutedByHost says the missing microphone is a host decision rather than a
	// role. The permission alone cannot say that — an attendee and a silenced
	// speaker both simply lack it — and the two need different words on screen and
	// different actions in the host's panel.
	MutedByHost bool `json:"mutedByHost,omitempty"`
	// Promoted marks someone the host lifted out of the audience, as opposed to a
	// panelist who was on the bill. Both hold the same permissions, and the
	// difference decides whether the room-wide "panelists may not unmute
	// themselves" switch applies to them: a promotion is a per-person decision the
	// host made AFTER that switch, and it would otherwise hand the person a dead
	// microphone button — which is what "bring on stage" did after a mute-all.
	Promoted bool `json:"promoted,omitempty"`
	// CoHost marks a panelist the host made equal to themselves: full moderation
	// rights over the room, not just the stage. See GrantFor's RolePanelist case
	// for what that actually grants, and Spec.CoHost for where it comes from.
	CoHost bool `json:"coHost,omitempty"`
}

// Spec is everything that shapes one participant's permissions.
//
// A struct rather than a parameter list because the list had already reached four
// values and two of them were bools — and `Token(role, room, id, name, true,
// false)` is a call nobody can review.
type Spec struct {
	Role     types.Role
	Room     string
	Identity string
	Name     string
	// Hidden keeps this participant out of every other client's roster. Only ever
	// set for attendees — see HiddenFor.
	Hidden bool
	// AudioOnly restricts a stage grant to the microphone and a screen share: the
	// host's "allow to speak", where an attendee gets to talk and present without
	// also getting a camera they did not ask for. See stageSources.
	AudioOnly bool
	// MutedByHost takes the microphone out of a stage grant. This is what makes a
	// host mute stick: the participant is still on the stage, but the SFU will not
	// accept audio from them until the host allows it again — so clicking unmute,
	// or reloading the page, or running a patched client, all achieve nothing.
	MutedByHost bool
	// Promoted says this stage seat was granted to one person by the host, rather
	// than being a scheduled panelist's. See Metadata.Promoted.
	Promoted bool
	// CoHost makes a panelist the host's equal: RoomAdmin, and an unrestricted
	// publish grant regardless of MutedByHost. Only meaningful with Role ==
	// RolePanelist — see GrantFor and metadataFor, which both narrow it there.
	CoHost bool
	// DataOnly restricts the participant to data channels only (no WebRTC audio/video subscription).
	// Used for CDN broadcast attendees to receive Chat/Polls/Q&A without consuming SFU media bandwidth.
	DataOnly bool
}

// MicrophoneSource is LiveKit's name for the microphone in a grant's source list.
// The wire format is the lower-cased TrackSource enum name.
const MicrophoneSource = "microphone"

// stageSources decides which sources one stage grant covers.
//
// Two independent narrowings meet here, and the order they combine in is the
// whole security question. AudioOnly narrows the grant TO the microphone;
// MutedByHost takes the microphone AWAY. Both at once leaves nothing — and
// because LiveKit reads an EMPTY source list as "every source", "nothing" has to
// be expressed as CanPublish=false. An empty list would hand a silenced attendee
// a camera and a screen share.
//
// A nil list with canPublish true means unrestricted, which is the ordinary
// panelist case.
func stageSources(spec Spec) (sources []livekit.TrackSource, canPublish bool) {
	switch {
	case spec.AudioOnly && spec.MutedByHost:
		return nil, false
	case spec.AudioOnly:
		// "Allow to speak" is a microphone plus a screen share — not just a
		// microphone. A speaker walking through a document or a slide while
		// talking is an ordinary case, and it should not need the host to widen
		// them to a full stage seat (which would also hand them a camera nobody
		// asked for) just to click Share. Camera stays withheld; that is what
		// still separates this from "Bring on stage" below, where sources is
		// nil and every source — including the camera — is allowed.
		return []livekit.TrackSource{
			livekit.TrackSource_MICROPHONE,
			livekit.TrackSource_SCREEN_SHARE,
			livekit.TrackSource_SCREEN_SHARE_AUDIO,
		}, true
	case spec.MutedByHost:
		// Everything except audio. Listed explicitly, because the alternative —
		// an empty list — means every source including the microphone.
		//
		// SCREEN_SHARE_AUDIO is left out with the microphone: it is a live audio
		// track, and on some platforms a microphone can be routed into it. A
		// silenced participant sharing a video with the sound off is a smaller
		// surprise than one the host cannot actually silence.
		return []livekit.TrackSource{
			livekit.TrackSource_CAMERA,
			livekit.TrackSource_SCREEN_SHARE,
		}, true
	default:
		return nil, true
	}
}

// GrantFor maps an application role onto a LiveKit VideoGrant.
//
// DANGER: CanPublish/CanSubscribe/CanPublishData are *bool, and LiveKit treats
// nil as "grant everything" — per its own docs, "if none of the permissions are
// set explicitly it will be granted with all publish and subscribe
// permissions". So an attendee grant MUST set CanPublish to an explicit false.
// Leaving it nil silently lets every attendee broadcast video to the room.
// lk_test.go asserts this for every role.
func GrantFor(spec Spec) (*auth.VideoGrant, error) {
	base := &auth.VideoGrant{
		Room:     spec.Room,
		RoomJoin: true,
	}
	switch spec.Role {
	case types.RoleHost:
		base.RoomAdmin = true // mute others, remove participants, end the webinar
		base.CanPublish = ptr(true)
		base.CanSubscribe = ptr(true)
		base.CanPublishData = ptr(true)
		base.CanUpdateOwnMetadata = ptr(true)
	case types.RolePanelist:
		if spec.CoHost {
			// Full parity with the host, not an unusually wide panelist grant — a
			// co-host is the room's other moderator. RoomAdmin lets them mute,
			// remove and moderate exactly as the host can, and the grant is
			// unrestricted the same way the host's is. Deliberately NOT routed
			// through stageSources: MutedByHost does not apply here, the same as
			// it does not apply to the host — the whole point of making someone
			// equal to the host is that nobody, including a previous host mute
			// that predates the promotion, can silence them but themselves.
			base.RoomAdmin = true
			base.CanPublish = ptr(true)
			base.CanSubscribe = ptr(true)
			base.CanPublishData = ptr(true)
			base.CanUpdateOwnMetadata = ptr(true)
			break
		}
		sources, canPublish := stageSources(spec)
		base.CanPublish = ptr(canPublish)
		base.CanSubscribe = ptr(true)
		base.CanPublishData = ptr(true)
		base.CanUpdateOwnMetadata = ptr(canPublish)
		if len(sources) > 0 {
			// SetCanPublishSources rather than hand-written strings: LiveKit owns
			// the enum-to-wire mapping, and a misspelt source name is not an error
			// anywhere — it silently matches nothing.
			base.SetCanPublishSources(sources)
		}
	case types.RoleAttendee:
		// The entire webinar/meeting distinction is these three lines: receive
		// media, publish nothing, and send nothing directly.
		base.CanPublish = ptr(false)
		if spec.DataOnly {
			base.CanSubscribe = ptr(false)
		} else {
			base.CanSubscribe = ptr(true)
		}
		// canPublishData=false is what makes the host's chat destination
		// enforceable rather than advisory.
		//
		// Attendees still chat, ask questions, raise hands and react — but through
		// POST /webinars/{slug}/say, where the SERVER decides the recipients and
		// stamps the sender. With the grant on, a patched bundle could put a packet
		// straight on the data channel addressed to the whole room, and no amount of
		// receiver-side filtering would help: an attendee is hidden in a
		// hidden-audience session, so their packets arrive looking exactly like the
		// server's own. The SFU refuses the packet outright instead
		// (ParticipantImpl.onDataMessage checks CanPublishData), which is a rule no
		// client can be patched out of.
		//
		// It also ends sender spoofing: `from` used to be whatever the sending
		// browser wrote, so an attendee could label themselves Host.
		base.CanPublishData = ptr(false)
		base.CanUpdateOwnMetadata = ptr(false)
		// Hidden is what makes "attendees cannot see each other" a property of
		// the SFU rather than a filter in our JavaScript. A patched client
		// bundle still cannot enumerate the audience, because the server never
		// sends it their participant records.
		base.Hidden = spec.Hidden
	default:
		return nil, fmt.Errorf("unknown role %q", spec.Role)
	}
	return base, nil
}

// CanPublish reports whether a role may send media. Echoed to the UI so it can
// render the right controls without decoding the JWT.
func CanPublish(role types.Role) bool {
	return role == types.RoleHost || role == types.RolePanelist
}

// HiddenFor turns the session's "hide attendees" setting into a decision about
// one participant. It is the single place that rule lives, because the same
// question is asked when minting a token, when promoting someone mid-session and
// when a host flips the control — and three copies of it would eventually
// disagree about whether a promoted attendee is still hidden.
//
// Only the audience is ever hidden. A hidden panelist is a voice with no tile,
// and a hidden host is invisible to the audience they are presenting to.
func HiddenFor(role types.Role, hideAttendees bool) bool {
	return hideAttendees && role == types.RoleAttendee
}

// metadataFor keeps the public description of a participant in step with their
// permissions. Both are derived from the same Spec, in one place, because a
// participant whose metadata says "speaker" while the SFU says otherwise produces
// a UI that argues with itself.
func metadataFor(spec Spec) Metadata {
	return Metadata{
		Role:      spec.Role,
		AudioOnly: spec.AudioOnly,
		// Only meaningful for someone who would otherwise be speaking. An attendee
		// has no microphone to take away.
		MutedByHost: spec.MutedByHost && spec.Role == types.RolePanelist,
		// Same narrowing: somebody back in the audience is not a promoted anybody.
		Promoted: spec.Promoted && spec.Role == types.RolePanelist,
		CoHost:   spec.CoHost && spec.Role == types.RolePanelist,
	}
}

// Token mints a join token for one participant.
func (c *Client) Token(spec Spec) (string, error) {
	grant, err := GrantFor(spec)
	if err != nil {
		return "", err
	}
	meta, err := json.Marshal(metadataFor(spec))
	if err != nil {
		return "", fmt.Errorf("marshal metadata: %w", err)
	}
	at := auth.NewAccessToken(c.apiKey, c.apiSecret).
		SetIdentity(spec.Identity).
		SetName(spec.Name).
		SetMetadata(string(meta)).
		SetValidFor(c.tokenTTL).
		SetVideoGrant(grant)

	tok, err := at.ToJWT()
	if err != nil {
		return "", fmt.Errorf("sign token: %w", err)
	}
	return tok, nil
}

// EnsureRoom creates the room if it doesn't exist, and carries the session
// controls in room metadata so every client learns them on connect.
//
// livekit.yaml sets auto_create: false deliberately — with auto-create on, any
// valid token can conjure a room, which makes capacity limits unenforceable.
// Creating rooms here is what makes maxParticipants a real ceiling.
// It also returns how many people are already in the room, because CreateRoom
// answers with the room object and that object carries the count. The join path
// needs exactly this number to enforce the ceiling, and asking for it separately
// costs a second round trip to the SFU on every single join — 500 of them when a
// full audience arrives at the top of the hour, each one delaying somebody's
// connection. `known` is false only when the SFU answers AlreadyExists without a
// body, in which case the caller has to ask.
func (c *Client) EnsureRoom(
	ctx context.Context, room string, maxParticipants, emptyTimeoutSec uint32, metadata string,
) (participants int, known bool, err error) {
	res, err := c.rooms.CreateRoom(ctx, &livekit.CreateRoomRequest{
		Name:            room,
		MaxParticipants: maxParticipants,
		EmptyTimeout:    emptyTimeoutSec,
		Metadata:        metadata,
	})
	if err != nil {
		if isAlreadyExists(err) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("create room %q: %w", room, err)
	}
	if res == nil {
		return 0, false, nil
	}
	return int(res.NumParticipants), true, nil
}

// SetMetadata broadcasts session state to everyone in the room.
//
// This is how a control the host flips reaches 500 browsers: one write here,
// and the SFU pushes a RoomMetadataChanged event down the existing signalling
// connection. The alternative — every client polling our API — is 500 requests
// per interval for state that changes twice an hour.
func (c *Client) SetMetadata(ctx context.Context, room, metadata string) error {
	_, err := c.rooms.UpdateRoomMetadata(ctx, &livekit.UpdateRoomMetadataRequest{
		Room:     room,
		Metadata: metadata,
	})
	if err != nil && isNotFound(err) {
		return nil // nobody is in the room yet; the next EnsureRoom carries it
	}
	return err
}

// SendData delivers one realtime packet to a room, or to a named subset of it.
//
// This is where "who is allowed to see this message" is decided and enforced. An
// empty `to` broadcasts; a non-empty one is forwarded by the SFU to exactly those
// identities and to nobody else. The packet is never sent to the other browsers
// at all, so a panelist-only message is not something a receiving client is
// trusted to hide — which is the difference between a privacy control and a
// naming convention.
//
// Server-sent packets carry no participant identity, which is why the sender
// travels inside the payload. See web/lib/realtime.ts for the receiving end.
func (c *Client) SendData(ctx context.Context, room, topic string, data []byte, to []string) error {
	_, err := c.rooms.SendData(ctx, &livekit.SendDataRequest{
		Room:                  room,
		Data:                  data,
		Kind:                  livekit.DataPacket_RELIABLE,
		DestinationIdentities: to,
		Topic:                 &topic,
	})
	if err != nil && isNotFound(err) {
		// The room has not been created yet, so there is nobody to deliver to. Not
		// an error worth showing the sender.
		return nil
	}
	return err
}

// isEgressOrRecorder identifies internal LiveKit Egress or Recorder bot participants
// so they are never counted as attendees or displayed in the moderation roster.
func isEgressOrRecorder(p *livekit.ParticipantInfo) bool {
	if strings.HasPrefix(p.Identity, "EG_") || strings.HasPrefix(p.Identity, "REC_") {
		return true
	}
	if p.Permission != nil && (p.Permission.Recorder || p.Permission.Agent) {
		return true
	}
	if p.Kind == livekit.ParticipantInfo_EGRESS {
		return true
	}
	return false
}

// ParticipantCount is used by the join path to enforce the attendee ceiling
// against reality rather than against the registration count.
func (c *Client) ParticipantCount(ctx context.Context, room string) (int, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return 0, nil // room not created yet, so nobody is in it
		}
		return 0, err
	}
	count := 0
	for _, p := range res.Participants {
		if !isEgressOrRecorder(p) {
			count++
		}
	}
	return count, nil
}

// Participants is the host's moderation roster.
//
// It deliberately reads from the server API rather than from the host's browser.
// Hidden attendees are excluded from every *client's* roster, which is the
// point of hiding them — but the host still has to be able to mute or remove
// someone. The server-side list includes hidden participants, so moderation
// keeps working on exactly the people the audience cannot see.
func (c *Client) Participants(ctx context.Context, room string) ([]types.LiveParticipant, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return []types.LiveParticipant{}, nil
		}
		return nil, err
	}

	out := make([]types.LiveParticipant, 0, len(res.Participants))
	for _, p := range res.Participants {
		if isEgressOrRecorder(p) {
			continue
		}
		out = append(out, describe(p))
	}
	return out, nil
}

func describe(p *livekit.ParticipantInfo) types.LiveParticipant {
	lp := types.LiveParticipant{
		Identity:   p.Identity,
		Name:       p.Name,
		Role:       roleOf(p),
		JoinedAt:   time.Unix(p.JoinedAt, 0).UTC().Format(time.RFC3339),
		Publishing: []string{},
		// Nothing published means nothing to hear, which reads the same as
		// muted in the UI and avoids showing a live mic on someone silent.
		AudioMuted: true,
	}
	if perm := p.Permission; perm != nil {
		lp.CanPublish = perm.CanPublish
		lp.Hidden = perm.Hidden
		// An empty source list means every source is allowed, so a publisher can
		// always speak unless the list exists and leaves the microphone out.
		lp.CanSpeak = perm.CanPublish &&
			(len(perm.CanPublishSources) == 0 ||
				slices.Contains(perm.CanPublishSources, livekit.TrackSource_MICROPHONE))
	}
	if p.Metadata != "" {
		var m Metadata
		if err := json.Unmarshal([]byte(p.Metadata), &m); err == nil {
			lp.MutedByHost = m.MutedByHost
			lp.AudioOnly = m.AudioOnly
			lp.CoHost = m.CoHost
		}
	}
	for _, t := range p.Tracks {
		lp.Publishing = append(lp.Publishing, t.Type.String()+"/"+t.Source.String())
		if t.Source == livekit.TrackSource_MICROPHONE {
			lp.AudioMuted = t.Muted
		}
	}
	return lp
}

// roleOf trusts the metadata we minted into the token, not the identity string.
// Identity prefixes are a convenience for humans reading logs; metadata is what
// the SFU echoes back verbatim from a token we signed.
func roleOf(p *livekit.ParticipantInfo) types.Role {
	if p.Metadata != "" {
		var m Metadata
		if err := json.Unmarshal([]byte(p.Metadata), &m); err == nil {
			switch m.Role {
			case types.RoleHost, types.RolePanelist, types.RoleAttendee:
				return m.Role
			}
		}
	}
	// A participant with publish permission and no usable metadata is on the
	// stage; anything else is treated as audience. Erring towards "attendee"
	// keeps an unknown participant out of moderation actions aimed at the stage.
	if p.Permission != nil && p.Permission.CanPublish {
		return types.RolePanelist
	}
	return types.RoleAttendee
}

// MuteTrack mutes or unmutes one published track. LiveKit needs the track sid,
// so the caller identifies a participant and a source and we resolve it here.
func (c *Client) MuteTrack(ctx context.Context, room, identity string, source livekit.TrackSource, muted bool) error {
	p, err := c.rooms.GetParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room: room, Identity: identity,
	})
	if err != nil {
		if isNotFound(err) {
			return ErrNotInRoom
		}
		return err
	}
	for _, t := range p.Tracks {
		if t.Source != source {
			continue
		}
		if t.Muted == muted {
			return nil // already in the requested state
		}
		_, err := c.rooms.MutePublishedTrack(ctx, &livekit.MuteRoomTrackRequest{
			Room: room, Identity: identity, TrackSid: t.Sid, Muted: muted,
		})
		if err != nil && isRemoteUnmuteDisabled(err) {
			return ErrRemoteUnmute
		}
		return err
	}
	// Nothing published from that source: silence is the requested state when
	// muting, and there is nothing to switch on when unmuting.
	if muted {
		return nil
	}
	return ErrNoTrack
}

// MuteAll mutes every published microphone except the identities in keep.
//
// Returns how many tracks it actually changed so the host sees "muted 4" rather
// than a silent success on an empty room. Errors on individual participants are
// collected rather than aborting: a participant who left mid-loop must not stop
// the rest of the room being muted.
func (c *Client) MuteAll(ctx context.Context, room string, keep map[string]bool) (int, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return 0, nil
		}
		return 0, err
	}

	muted := 0
	var errs []error
	for _, p := range res.Participants {
		if keep[p.Identity] || isEgressOrRecorder(p) {
			continue
		}
		for _, t := range p.Tracks {
			if t.Source != livekit.TrackSource_MICROPHONE || t.Muted {
				continue
			}
			if _, err := c.rooms.MutePublishedTrack(ctx, &livekit.MuteRoomTrackRequest{
				Room: room, Identity: p.Identity, TrackSid: t.Sid, Muted: true,
			}); err != nil {
				if !isNotFound(err) {
					errs = append(errs, fmt.Errorf("%s: %w", p.Identity, err))
				}
				continue
			}
			muted++
		}
	}
	return muted, errors.Join(errs...)
}

// SetRole changes a participant's permissions in place, which is how an attendee
// reaches the stage — or is merely allowed to speak — without rejoining.
//
// spec.Hidden is the already-decided value for this participant; see HiddenFor.
//
// LiveKit revokes publish permission by dropping the offending tracks, so
// demoting someone who is on camera also stops their video — no second call. The
// same applies to narrowing a full stage grant down to audio only: their camera
// track is dropped by the permission change itself.
func (c *Client) SetRole(ctx context.Context, spec Spec) error {
	meta, err := json.Marshal(metadataFor(spec))
	if err != nil {
		return err
	}

	_, err = c.rooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:       spec.Room,
		Identity:   spec.Identity,
		Metadata:   string(meta),
		Permission: permissionFor(spec),
	})
	if err != nil && isNotFound(err) {
		return ErrNotInRoom
	}
	return err
}

/* permissionFor is the live-connection counterpart of GrantFor: the same
 * decision, expressed as a ParticipantPermission instead of a token grant.
 * Both read stageSources, so promoting someone mid-session and minting them
 * a fresh token cannot disagree about what they are allowed to publish.
 *
 * One thing GrantFor decides that this cannot echo: RoomAdmin. LiveKit's
 * ParticipantPermission proto has no admin field at all — RoomAdmin lives
 * only in the JWT a token carries, so it is set once at mint time and stays
 * fixed for the life of that connection. A co-host granted while already in
 * the room gets everything below live — publish rights, metadata, the "you
 * are equal to the host now" the UI reads — but not RoomAdmin itself until
 * their next reconnect. Nothing in this app currently depends on a
 * participant's own RoomAdmin grant for moderation — every host and co-host
 * action goes through our own server API key, not the participant's token —
 * so this gap has no functional effect today; it is called out here so it
 * stays a known, deliberate limit rather than a surprise the next time
 * RoomAdmin is reached for.
 */
func permissionFor(spec Spec) *livekit.ParticipantPermission {
	perm := &livekit.ParticipantPermission{
		CanSubscribe: true,
		// Follows the role, exactly as in GrantFor. Set unconditionally here once,
		// and a host sending someone back to the audience would leave them holding
		// direct data-channel access — the one thing standing between the chat
		// destination being a rule and being a preference.
		CanPublishData: spec.Role == types.RoleHost || spec.Role == types.RolePanelist,
		Hidden:         spec.Hidden,
	}
	switch spec.Role {
	case types.RoleHost:
		perm.CanPublish = true
		perm.CanUpdateMetadata = true
	case types.RolePanelist:
		if spec.CoHost {
			// Mirrors GrantFor's CoHost branch exactly — see the comment there for
			// why this bypasses stageSources rather than narrowing through it.
			perm.CanPublish = true
			perm.CanUpdateMetadata = true
			break
		}
		sources, canPublish := stageSources(spec)
		perm.CanPublish = canPublish
		perm.CanUpdateMetadata = canPublish
		perm.CanPublishSources = sources
	default:
		perm.CanPublish = false
	}
	return perm
}

// SetSpeaking is the host's mute latch, applied to a live participant.
//
// blocked=true takes the microphone out of their grant; false gives it back. The
// participant's role and the scope of their grant are read back from the SFU and
// preserved, so silencing a full panelist does not quietly demote them to
// audio-only when the host lets them speak again.
//
// Muting the published track is a separate call, and both are needed: this stops
// them sending audio in future, MuteTrack silences what they are sending now.
func (c *Client) SetSpeaking(ctx context.Context, room, identity string, blocked bool) error {
	p, err := c.rooms.GetParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room: room, Identity: identity,
	})
	if err != nil {
		if isNotFound(err) {
			return ErrNotInRoom
		}
		return err
	}

	switch roleOf(p) {
	case types.RoleHost:
		// The host's own microphone. There is no latch to apply — a host can
		// unmute themselves by right — and their permissions are not this
		// endpoint's to rewrite, since the token also carries RoomAdmin.
		return ErrIsHost
	case types.RoleAttendee:
		// No microphone to take away.
		return ErrNotSpeaking
	}

	spec, ok := specOf(p)
	if !ok {
		return ErrNotSpeaking
	}
	// A co-host is the host's equal, and MutedByHost applies to them no more
	// than it applies to the host — see GrantFor's CoHost branch, which grants
	// them a full connection regardless of this latch. Refusing here rather
	// than letting the call through and having permissionFor silently ignore
	// it: applying a latch that never takes effect would write mutedByHost:true
	// into their own metadata, which is what would show a co-host as "muted by
	// you" in the host's roster despite their microphone actually working.
	if spec.CoHost {
		return ErrIsHost
	}
	spec.Room = room
	spec.Identity = identity
	spec.MutedByHost = blocked

	meta, err := json.Marshal(metadataFor(spec))
	if err != nil {
		return err
	}
	_, err = c.rooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:       room,
		Identity:   identity,
		Metadata:   string(meta),
		Permission: permissionFor(spec),
	})
	if err != nil && isNotFound(err) {
		return ErrNotInRoom
	}
	return err
}

// BlockSpeakingAll latches the mute for every speaker except the identities in
// keep, so "mute everyone" is not undone by the first person to click unmute.
// Errors on individuals are collected, for the same reason as MuteAll.
func (c *Client) BlockSpeakingAll(ctx context.Context, room string, keep map[string]bool) (int, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return 0, nil
		}
		return 0, err
	}

	blocked := 0
	var errs []error
	for _, p := range res.Participants {
		if keep[p.Identity] || isEgressOrRecorder(p) {
			continue
		}
		if spec, ok := specOf(p); !ok || spec.MutedByHost {
			continue // not a speaker, or already latched
		}
		if err := c.SetSpeaking(ctx, room, p.Identity, true); err != nil {
			if !errors.Is(err, ErrNotInRoom) && !errors.Is(err, ErrNotSpeaking) &&
				!errors.Is(err, ErrIsHost) {
				errs = append(errs, fmt.Errorf("%s: %w", p.Identity, err))
			}
			continue
		}
		blocked++
	}
	return blocked, errors.Join(errs...)
}

// AllowAllToSpeak grants every attendee currently in the room the same thing
// "Allow to speak" grants one at a time — a microphone and a screen share, no
// camera — in a single pass, for a host who wants the whole room able to
// jump in rather than promoting people one by one.
//
// Only the audience moves. The host and anyone already a panelist — whether
// scheduled or already promoted — are left exactly as they are: widening an
// existing full stage seat down to audio-only would be a real demotion
// dressed up as a bulk grant, not what a host asking for this expects.
//
// Returns how many attendees it actually promoted, for the same reason
// MuteAll does — a host bulk-granting an empty or already-promoted room
// needs to see that nothing silently failed, not just a bare success.
func (c *Client) AllowAllToSpeak(ctx context.Context, room string, hideAttendees bool) ([]string, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	var granted []string
	var errs []error
	for _, p := range res.Participants {
		if isEgressOrRecorder(p) || roleOf(p) != types.RoleAttendee {
			continue
		}
		spec := Spec{
			Role:      types.RolePanelist,
			Room:      room,
			Identity:  p.Identity,
			Name:      p.Name,
			Hidden:    HiddenFor(types.RolePanelist, hideAttendees),
			AudioOnly: true,
			Promoted:  true,
		}
		if err := c.SetRole(ctx, spec); err != nil {
			if !errors.Is(err, ErrNotInRoom) {
				errs = append(errs, fmt.Errorf("%s: %w", p.Identity, err))
			}
			continue
		}
		granted = append(granted, p.Identity)
	}
	return granted, errors.Join(errs...)
}

// BringAllOnStage is AllowAllToSpeak's wider sibling: every attendee gets a
// full stage seat — camera, microphone and screen share, the same grant
// "Bring on stage" gives one at a time — rather than the microphone-and-
// screen-share-only "Allow to speak" scope. Same shape otherwise: only the
// audience moves, an existing panelist (scheduled or already promoted) is
// left exactly as they are, and the count returned is what a host bulk-
// granting an empty or already-promoted room needs to see that nothing
// silently failed.
func (c *Client) BringAllOnStage(ctx context.Context, room string, hideAttendees bool) ([]string, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	var granted []string
	var errs []error
	for _, p := range res.Participants {
		if isEgressOrRecorder(p) || roleOf(p) != types.RoleAttendee {
			continue
		}
		spec := Spec{
			Role:     types.RolePanelist,
			Room:     room,
			Identity: p.Identity,
			Name:     p.Name,
			Hidden:   HiddenFor(types.RolePanelist, hideAttendees),
			Promoted: true,
			// AudioOnly deliberately omitted (false): the whole difference from
			// AllowAllToSpeak is that this is the unrestricted, "Bring on stage"
			// grant — see stageSources' default case.
		}
		if err := c.SetRole(ctx, spec); err != nil {
			if !errors.Is(err, ErrNotInRoom) {
				errs = append(errs, fmt.Errorf("%s: %w", p.Identity, err))
			}
			continue
		}
		granted = append(granted, p.Identity)
	}
	return granted, errors.Join(errs...)
}

// RevokeAllSpeaking sends every attendee the host had promoted — via "Allow
// to speak" or "Bring on stage", one at a time or through AllowAllToSpeak or
// BringAllOnStage — back to the audience in one pass, muting them on the way
// out the same as a single revoke does. This is the one-click "take back
// permission" that undoes either bulk grant above, or any mix of individual
// promotions: it does not distinguish how someone came to be promoted, only
// that they were.
//
// A scheduled panelist is not "speaking permission the host granted" — they
// are on the bill — so unlike AllowAllToSpeak's mirror image, this does not
// touch them; only identities specOf reports as Promoted move. That is the
// same distinction the room already draws for "mute everyone" (see
// BlockSpeakingAll's own keep-scheduled-panelists reasoning) applied to the
// wider grant instead of just the microphone.
func (c *Client) RevokeAllSpeaking(ctx context.Context, room string, hideAttendees bool) ([]string, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	var revoked []string
	var errs []error
	for _, p := range res.Participants {
		if isEgressOrRecorder(p) {
			continue
		}
		spec, ok := specOf(p)
		if !ok || !spec.Promoted {
			continue
		}
		// Muting the track first, same reasoning as handleSetStage: the audience
		// stops hearing them at the moment the host clicks rather than whenever
		// the permission-driven unpublish lands.
		if source, ok := SourceFor("microphone"); ok {
			if err := c.MuteTrack(ctx, room, p.Identity, source, true); err != nil &&
				!errors.Is(err, ErrNotInRoom) && !errors.Is(err, ErrNoTrack) {
				errs = append(errs, fmt.Errorf("%s: mute on the way out: %w", p.Identity, err))
			}
		}
		down := Spec{
			Role:     types.RoleAttendee,
			Room:     room,
			Identity: p.Identity,
			Name:     p.Name,
			Hidden:   HiddenFor(types.RoleAttendee, hideAttendees),
		}
		if err := c.SetRole(ctx, down); err != nil {
			if !errors.Is(err, ErrNotInRoom) {
				errs = append(errs, fmt.Errorf("%s: %w", p.Identity, err))
			}
			continue
		}
		revoked = append(revoked, p.Identity)
	}
	return revoked, errors.Join(errs...)
}

// specOf reconstructs the Spec behind a live participant, so a permission change
// can be expressed as a change to one field rather than as a fresh grant built
// from assumptions. Reports false for anyone whose speaking is not the host's to
// adjust: the host themselves, and the audience.
func specOf(p *livekit.ParticipantInfo) (Spec, bool) {
	if roleOf(p) != types.RolePanelist {
		return Spec{}, false
	}
	spec := Spec{Role: types.RolePanelist, Name: p.Name}
	if p.Permission != nil {
		spec.Hidden = p.Permission.Hidden
	}
	// Read from metadata rather than inferred from the permission: once the
	// microphone has been taken away, an audio-only grant and a full one look
	// identical from the permission side, and guessing would widen the grant when
	// the host lets them speak again.
	if p.Metadata != "" {
		var m Metadata
		if err := json.Unmarshal([]byte(p.Metadata), &m); err == nil {
			spec.AudioOnly = m.AudioOnly
			spec.MutedByHost = m.MutedByHost
			// Carried through, or silencing a promoted attendee and then letting
			// them speak again would quietly turn them into a scheduled panelist and
			// subject them to the room-wide unmute switch.
			spec.Promoted = m.Promoted
			// Carried through for the same reason: this Spec is round-tripped
			// straight back into metadataFor and permissionFor by every caller
			// (SetSpeaking, BlockSpeakingAll's mute-everyone). Missing this field
			// once wrote CoHost:false back into a co-host's own metadata the very
			// first time anyone muted them — silently revoking their standing on
			// the live connection while the database, unaffected, still granted
			// them every REST action a co-host may take. The two disagreeing is
			// exactly what "co-host isn't working" looks like from the room.
			spec.CoHost = m.CoHost
		}
	}
	return spec, true
}

// SetHidden flips one participant's visibility without touching anything else.
//
// Used when a host toggles "hide attendees" mid-session: the people already
// connected need their permission updated, not just the people who join next.
func (c *Client) SetHidden(ctx context.Context, room, identity string, hidden bool) error {
	p, err := c.rooms.GetParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room: room, Identity: identity,
	})
	if err != nil {
		if isNotFound(err) {
			return ErrNotInRoom
		}
		return err
	}
	perm := p.Permission
	if perm == nil {
		return ErrNoPermission
	}
	if perm.Hidden == hidden {
		return nil
	}
	updated := &livekit.ParticipantPermission{
		CanSubscribe:      perm.CanSubscribe,
		CanPublish:        perm.CanPublish,
		CanPublishData:    perm.CanPublishData,
		CanPublishSources: perm.CanPublishSources,
		CanUpdateMetadata: perm.CanUpdateMetadata,
		Recorder:          perm.Recorder,
		Agent:             perm.Agent,
		Hidden:            hidden,
	}
	_, err = c.rooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: room, Identity: identity, Permission: updated,
	})
	return err
}

// HideAll applies a visibility change to every participant matching role.
// Errors on individuals are collected, for the same reason as MuteAll.
func (c *Client) HideAll(ctx context.Context, room string, role types.Role, hidden bool) (int, error) {
	res, err := c.rooms.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isNotFound(err) {
			return 0, nil
		}
		return 0, err
	}

	changed := 0
	var errs []error
	for _, p := range res.Participants {
		if roleOf(p) != role || p.Permission == nil || p.Permission.Hidden == hidden {
			continue
		}
		if err := c.SetHidden(ctx, room, p.Identity, hidden); err != nil {
			if !errors.Is(err, ErrNotInRoom) {
				errs = append(errs, fmt.Errorf("%s: %w", p.Identity, err))
			}
			continue
		}
		changed++
	}
	return changed, errors.Join(errs...)
}

// RemoveParticipant backs the host's "remove from webinar" action.
func (c *Client) RemoveParticipant(ctx context.Context, room, identity string) error {
	_, err := c.rooms.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{
		Room: room, Identity: identity,
	})
	if err != nil && isNotFound(err) {
		return ErrNotInRoom
	}
	return err
}

// DeleteRoom ends the session for everyone. This is what "End webinar for all"
// does: disconnecting the host alone would leave 500 people watching a dead
// stage, waiting for them to come back.
func (c *Client) DeleteRoom(ctx context.Context, room string) error {
	_, err := c.rooms.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room})
	if err != nil && isNotFound(err) {
		return nil // already gone is the desired end state
	}
	return err
}

// RoomName derives the SFU room name from a webinar slug. Prefixed so the
// namespace stays clear if this cluster ever hosts anything else.
func RoomName(slug string) string { return "webinar_" + slug }

// SourceFor maps a wire-level track name onto LiveKit's enum. Returns false for
// anything unrecognised rather than defaulting, so a typo cannot silently mute
// the wrong track.
func SourceFor(name string) (livekit.TrackSource, bool) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "microphone", "audio":
		return livekit.TrackSource_MICROPHONE, true
	case "camera", "video":
		return livekit.TrackSource_CAMERA, true
	case "screen", "screen_share", "screenshare":
		return livekit.TrackSource_SCREEN_SHARE, true
	}
	return livekit.TrackSource_UNKNOWN, false
}

// LiveKit surfaces these as twirp errors and does not export typed values for
// them, so message matching is the only option available.
func isAlreadyExists(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "already exists") || strings.Contains(msg, "AlreadyExists")
}

// isRemoteUnmuteDisabled recognises LiveKit refusing to switch someone's
// microphone back on from the server.
//
// This is the SFU's default and it is the right one: nobody should be able to open
// a microphone in someone else's room from an API call. The product works with it
// rather than around it — the host asks, over the data channel, and the person's
// own browser decides. `room.enable_remote_unmute` in livekit.yaml would turn the
// protection off; we deliberately leave it alone.
func isRemoteUnmuteDisabled(err error) bool {
	return err != nil && strings.Contains(err.Error(), "remote unmute not enabled")
}

func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "not found") ||
		strings.Contains(msg, "NotFound") ||
		strings.Contains(msg, "does not exist")
}

var (
	ErrRoomFull     = errors.New("room at capacity")
	ErrNotInRoom    = errors.New("participant is not in the room")
	ErrNoTrack      = errors.New("participant is not publishing that source")
	ErrNoPermission = errors.New("participant has no permission record")
	ErrNotSpeaking  = errors.New("participant has no speaking grant to change")
	// ErrIsHost is not a failure at either call site: muting the host's track is
	// allowed, latching it is neither possible nor wanted.
	ErrIsHost = errors.New("participant is the host")
// ErrRemoteUnmute means the SFU will not switch a live microphone back on from
	// the server. See isRemoteUnmuteDisabled — this is a protection, not a fault.
	ErrRemoteUnmute = errors.New("the media server does not allow remote unmute")
)

// EgressS3Options configures Backblaze B2 or any S3-compatible destination for Egress.
type EgressS3Options struct {
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string
}

// StartRoomCompositeEgress launches server-side recording with LiveKit Egress.
func (c *Client) StartRoomCompositeEgress(
	ctx context.Context,
	roomName string,
	storageKey string,
	s3Opts EgressS3Options,
	templateURL string,
	preset livekit.EncodingOptionsPreset,
) (*livekit.EgressInfo, error) {
	if c.egress == nil {
		return nil, errors.New("egress is not configured on this client")
	}

	endpoint := strings.TrimSpace(s3Opts.Endpoint)
	if endpoint != "" && !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}

	req := &livekit.RoomCompositeEgressRequest{
		RoomName: roomName,
		FileOutputs: []*livekit.EncodedFileOutput{
			{
				FileType: livekit.EncodedFileType_MP4,
				Filepath: storageKey,
				Output: &livekit.EncodedFileOutput_S3{
					S3: &livekit.S3Upload{
						Endpoint:       endpoint,
						Bucket:         strings.TrimSpace(s3Opts.Bucket),
						Region:         strings.TrimSpace(s3Opts.Region),
						AccessKey:      strings.TrimSpace(s3Opts.AccessKey),
						Secret:         strings.TrimSpace(s3Opts.SecretKey),
						ForcePathStyle: true, // Backblaze B2 uses path-style addressing
					},
				},
			},
		},
	}

	if templateURL != "" {
		req.CustomBaseUrl = templateURL
		req.Layout = "custom"
	} else {
		req.Layout = "speaker"
	}

	req.Options = &livekit.RoomCompositeEgressRequest_Preset{
		Preset: preset,
	}

	return c.egress.StartRoomCompositeEgress(ctx, req)
}

// StartHlsBroadcastEgress begins an HLS segmented egress stream for live CDN distribution.
//
// rtmpURL, when set, is a second output on the same Chromium job: LiveKit pushes
// the mixed program to MediaMTX (or any RTMP origin) so attendees can play
// LL-HLS from the live origin instead of waiting on S3 segments. The S3
// playlist stays as the slow fallback; one encoder, two pipes.
func (c *Client) StartHlsBroadcastEgress(
	ctx context.Context,
	roomName string,
	prefix string,
	playlistName string,
	s3Opts EgressS3Options,
	templateURL string,
	preset livekit.EncodingOptionsPreset,
	rtmpURL string,
) (*livekit.EgressInfo, error) {
	if c.egress == nil {
		return nil, errors.New("egress is not configured on this client")
	}

	endpoint := strings.TrimSpace(s3Opts.Endpoint)
	if endpoint != "" && !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}

	req := &livekit.RoomCompositeEgressRequest{
		RoomName: roomName,
		SegmentOutputs: []*livekit.SegmentedFileOutput{
			{
				Protocol:         livekit.SegmentedFileProtocol_HLS_PROTOCOL,
				FilenamePrefix:   prefix,
				PlaylistName:     playlistName,
				LivePlaylistName: "live.m3u8",
				SegmentDuration:  2,
				Output: &livekit.SegmentedFileOutput_S3{
					S3: &livekit.S3Upload{
						Endpoint:       endpoint,
						Bucket:         strings.TrimSpace(s3Opts.Bucket),
						Region:         strings.TrimSpace(s3Opts.Region),
						AccessKey:      strings.TrimSpace(s3Opts.AccessKey),
						Secret:         strings.TrimSpace(s3Opts.SecretKey),
						ForcePathStyle: true,
					},
				},
			},
		},
	}
	if u := strings.TrimSpace(rtmpURL); u != "" {
		req.StreamOutputs = []*livekit.StreamOutput{
			{
				Protocol: livekit.StreamProtocol_RTMP,
				Urls:     []string{u},
			},
		}
	}

	if templateURL != "" {
		req.CustomBaseUrl = templateURL
		req.Layout = "custom"
	} else {
		req.Layout = "speaker"
	}

	req.Options = &livekit.RoomCompositeEgressRequest_Preset{
		Preset: preset,
	}

	return c.egress.StartRoomCompositeEgress(ctx, req)
}

// StopEgress requests LiveKit Egress to finalize recording and upload the file.
func (c *Client) StopEgress(ctx context.Context, egressID string) (*livekit.EgressInfo, error) {
	if c.egress == nil {
		return nil, errors.New("egress is not configured on this client")
	}
	return c.egress.StopEgress(ctx, &livekit.StopEgressRequest{
		EgressId: egressID,
	})
}

