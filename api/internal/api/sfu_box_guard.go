package api

import (
	"context"
	"fmt"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The guard in front of the on-demand box's LiveKit (sfu_box.go).
 *
 * While the box is down, being created, being deleted or failed, nothing answers on its
 * address: until the reserved IP is moved onto the new droplet it still points at the park
 * droplet, which drops the packets. A LiveKit call then waits for its context, and the
 * sweepers make one per live session every tick. On 24 Oct 2026 that ate the whole tick, so
 * the box step that moves the IP started with an expired context, so the box never came
 * up, so the sessions stayed live: a deadlock that only a redeploy could break.
 *
 * So every call to the box's LiveKit goes through boxRoom:
 *
 *   - while the box is not up (down, creating, booting, deleting, failed) it is not made at
 *     all — booting included: until its health check passes nobody can be on it, and a join
 *     whose own probe passes marks it ready (boxProbeNow) before it mints a token — it fails at once with errBoxNotReady (an errSFUStarting), which every caller
 *     already treats as "the server could not say" — never as an empty room;
 *   - otherwise a single call gets boxCallTimeout, so a box that stops answering costs
 *     seconds, not the tick. Bulk calls (one per participant) and egress starts keep the
 *     caller's context: they are host actions on a box that is up.
 *
 * EnsureRoom is not touched: the join path gates it on boxReady already, and a timeout there
 * would read as a refusal and trigger ensureRoom's failover. */

// boxCallTimeout bounds one LiveKit call to the box.
const boxCallTimeout = 3 * time.Second

// boxSkipLogEvery throttles the "skipped a call" line.
const boxSkipLogEvery = time.Minute

var errBoxNotReady = fmt.Errorf("video server not reachable yet: %w", errSFUStarting)

// boxPool wraps the SFU pool so the box project's room manager is a boxRoom.
type boxPool struct {
	SFUPool
	s *Server
}

func (p boxPool) Get(id string) (RoomManager, error) {
	rm, err := p.SFUPool.Get(id)
	if err != nil || rm == nil || !p.s.managesProject(id) {
		return rm, err
	}
	return boxRoom{RoomManager: rm, s: p.s}, nil
}

// unwrapRoom is the room manager behind the edge tap and the box guard.
func unwrapRoom(rm RoomManager) RoomManager {
	for {
		switch r := rm.(type) {
		case edgeRoom:
			rm = r.RoomManager
		case boxRoom:
			rm = r.RoomManager
		default:
			return rm
		}
	}
}

// boxReachable is whether the box's LiveKit is up (ready, or draining and still serving).
// A state that cannot be read counts as reachable (the call
// is still bounded by boxCallTimeout).
func (s *Server) boxReachable(ctx context.Context, what string) bool {
	if s.box == nil {
		return true
	}
	sctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	st, err := s.boxState(sctx)
	cancel()
	if err != nil {
		return true
	}
	switch st.Actual {
	case store.BoxReady, store.BoxDraining:
		return true
	}
	b := s.box
	b.mu.Lock()
	quiet := time.Since(b.lastSkipLog) < boxSkipLogEvery
	if !quiet {
		b.lastSkipLog = time.Now()
	}
	b.mu.Unlock()
	if !quiet {
		s.log.Info("sfu box: not reachable yet, skipping livekit calls", "project", b.cfg.Project,
			"state", st.Actual, "call", what)
	}
	return false
}

// boxRoom is the box project's room manager behind the guard.
type boxRoom struct {
	RoomManager
	s *Server
}

// call is the guard for one quick call: a bounded context, or errBoxNotReady.
func (r boxRoom) call(ctx context.Context, what string) (context.Context, context.CancelFunc, error) {
	if !r.s.boxReachable(ctx, what) {
		return nil, nil, errBoxNotReady
	}
	c, cancel := context.WithTimeout(ctx, boxCallTimeout)
	return c, cancel, nil
}

// bulk is the guard for a long call: skipped while unreachable, the caller's context otherwise.
func (r boxRoom) bulk(ctx context.Context, what string) error {
	if !r.s.boxReachable(ctx, what) {
		return errBoxNotReady
	}
	return nil
}

func (r boxRoom) SetMetadata(ctx context.Context, room, metadata string) error {
	c, cancel, err := r.call(ctx, "SetMetadata")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.SetMetadata(c, room, metadata)
}

func (r boxRoom) SendData(ctx context.Context, room, topic string, data []byte, to []string) error {
	c, cancel, err := r.call(ctx, "SendData")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.SendData(c, room, topic, data, to)
}

func (r boxRoom) ParticipantCount(ctx context.Context, room string) (int, error) {
	c, cancel, err := r.call(ctx, "ParticipantCount")
	if err != nil {
		return 0, err
	}
	defer cancel()
	return r.RoomManager.ParticipantCount(c, room)
}

func (r boxRoom) Participants(ctx context.Context, room string) ([]types.LiveParticipant, error) {
	c, cancel, err := r.call(ctx, "Participants")
	if err != nil {
		return nil, err
	}
	defer cancel()
	return r.RoomManager.Participants(c, room)
}

func (r boxRoom) MuteTrack(ctx context.Context, room, identity string, source livekit.TrackSource, muted bool) error {
	c, cancel, err := r.call(ctx, "MuteTrack")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.MuteTrack(c, room, identity, source, muted)
}

func (r boxRoom) SetRole(ctx context.Context, spec lk.Spec) error {
	c, cancel, err := r.call(ctx, "SetRole")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.SetRole(c, spec)
}

func (r boxRoom) SetSpeaking(ctx context.Context, room, identity string, blocked bool) error {
	c, cancel, err := r.call(ctx, "SetSpeaking")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.SetSpeaking(c, room, identity, blocked)
}

func (r boxRoom) RemoveParticipant(ctx context.Context, room, identity string) error {
	c, cancel, err := r.call(ctx, "RemoveParticipant")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.RemoveParticipant(c, room, identity)
}

func (r boxRoom) DeleteRoom(ctx context.Context, room string) error {
	c, cancel, err := r.call(ctx, "DeleteRoom")
	if err != nil {
		return err
	}
	defer cancel()
	return r.RoomManager.DeleteRoom(c, room)
}

func (r boxRoom) ListEgress(ctx context.Context, roomName string) ([]*livekit.EgressInfo, error) {
	c, cancel, err := r.call(ctx, "ListEgress")
	if err != nil {
		return nil, err
	}
	defer cancel()
	return r.RoomManager.ListEgress(c, roomName)
}

func (r boxRoom) StopEgress(ctx context.Context, egressID string) (*livekit.EgressInfo, error) {
	c, cancel, err := r.call(ctx, "StopEgress")
	if err != nil {
		return nil, err
	}
	defer cancel()
	return r.RoomManager.StopEgress(c, egressID)
}

func (r boxRoom) MuteAll(ctx context.Context, room string, keep map[string]bool) (int, error) {
	if err := r.bulk(ctx, "MuteAll"); err != nil {
		return 0, err
	}
	return r.RoomManager.MuteAll(ctx, room, keep)
}

func (r boxRoom) BlockSpeakingAll(ctx context.Context, room string, keep map[string]bool) (int, error) {
	if err := r.bulk(ctx, "BlockSpeakingAll"); err != nil {
		return 0, err
	}
	return r.RoomManager.BlockSpeakingAll(ctx, room, keep)
}

func (r boxRoom) AllowAllToSpeak(ctx context.Context, room string, hideAttendees bool) ([]string, error) {
	if err := r.bulk(ctx, "AllowAllToSpeak"); err != nil {
		return nil, err
	}
	return r.RoomManager.AllowAllToSpeak(ctx, room, hideAttendees)
}

func (r boxRoom) BringAllOnStage(ctx context.Context, room string, hideAttendees bool) ([]string, error) {
	if err := r.bulk(ctx, "BringAllOnStage"); err != nil {
		return nil, err
	}
	return r.RoomManager.BringAllOnStage(ctx, room, hideAttendees)
}

func (r boxRoom) RevokeAllSpeaking(ctx context.Context, room string, hideAttendees bool) ([]string, error) {
	if err := r.bulk(ctx, "RevokeAllSpeaking"); err != nil {
		return nil, err
	}
	return r.RoomManager.RevokeAllSpeaking(ctx, room, hideAttendees)
}

func (r boxRoom) HideAll(ctx context.Context, room string, role types.Role, hidden bool) (int, error) {
	if err := r.bulk(ctx, "HideAll"); err != nil {
		return 0, err
	}
	return r.RoomManager.HideAll(ctx, room, role, hidden)
}

func (r boxRoom) StartRoomCompositeEgress(ctx context.Context, roomName string, storageKey string, s3Opts lk.EgressS3Options, templateURL string, preset livekit.EncodingOptionsPreset) (*livekit.EgressInfo, error) {
	if err := r.bulk(ctx, "StartRoomCompositeEgress"); err != nil {
		return nil, err
	}
	return r.RoomManager.StartRoomCompositeEgress(ctx, roomName, storageKey, s3Opts, templateURL, preset)
}

func (r boxRoom) StartBroadcastEgress(ctx context.Context, roomName string, templateURL string, preset livekit.EncodingOptionsPreset, rtmpURL string, extraURLs []string) (*livekit.EgressInfo, error) {
	if err := r.bulk(ctx, "StartBroadcastEgress"); err != nil {
		return nil, err
	}
	return r.RoomManager.StartBroadcastEgress(ctx, roomName, templateURL, preset, rtmpURL, extraURLs)
}

func (r boxRoom) StartBroadcastEgressEncoded(ctx context.Context, roomName string, templateURL string, enc lk.BroadcastEncoding, rtmpURL string, extraURLs []string) (*livekit.EgressInfo, error) {
	if err := r.bulk(ctx, "StartBroadcastEgressEncoded"); err != nil {
		return nil, err
	}
	return r.RoomManager.StartBroadcastEgressEncoded(ctx, roomName, templateURL, enc, rtmpURL, extraURLs)
}

func (r boxRoom) StartCombinedEgress(ctx context.Context, roomName string, templateURL string, preset livekit.EncodingOptionsPreset, rtmpURL string, storageKey string, s3Opts lk.EgressS3Options, extraURLs []string) (*livekit.EgressInfo, error) {
	if err := r.bulk(ctx, "StartCombinedEgress"); err != nil {
		return nil, err
	}
	return r.RoomManager.StartCombinedEgress(ctx, roomName, templateURL, preset, rtmpURL, storageKey, s3Opts, extraURLs)
}

func (r boxRoom) UpdateStream(ctx context.Context, egressID string, add, remove []string) (*livekit.EgressInfo, error) {
	if err := r.bulk(ctx, "UpdateStream"); err != nil {
		return nil, err
	}
	return r.RoomManager.UpdateStream(ctx, egressID, add, remove)
}

// boxDispatcher is the caption agent's dispatcher behind the guard.
type boxDispatcher struct {
	agentDispatcher
	r boxRoom
}

func (d boxDispatcher) DispatchAgent(ctx context.Context, room, agentName, metadata string) (string, error) {
	c, cancel, err := d.r.call(ctx, "DispatchAgent")
	if err != nil {
		return "", err
	}
	defer cancel()
	return d.agentDispatcher.DispatchAgent(c, room, agentName, metadata)
}

func (d boxDispatcher) StopAgent(ctx context.Context, room, agentName string) error {
	c, cancel, err := d.r.call(ctx, "StopAgent")
	if err != nil {
		return err
	}
	defer cancel()
	return d.agentDispatcher.StopAgent(c, room, agentName)
}
