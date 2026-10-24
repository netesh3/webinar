package api

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
)

/* announceLeft tells the room that a participant's connection is gone, from the SFU's own
 * participant_left webhook, so the mix (the recorder template) can drop their tile.
 *
 * A client's own view of who is in the room is only as good as the updates it was sent. The
 * mix kept a co-host who had left normally on the audience stream for twenty minutes, an
 * avatar tile with the mic off, while the SFU listed him gone and a fresh mix did not show
 * him (instant-webinar-2050, 2026-10-24). The webhook is the SFU's word on the departure;
 * this repeats it to everyone, the hidden egress included (no destinations is the whole
 * room), with the connection's sid, so a rejoin, which is a new sid, is not dropped with it.
 *
 * Best-effort, like every room packet: a missed one leaves things as they were before. The
 * mix, the caption agent and recorders leaving are not stage tiles, so they are skipped. */
func (s *Server) announceLeft(ctx context.Context, slug, identity, sid string) {
	if sid == "" || internalIdentity(identity) {
		return
	}
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := s.sendRoomPacket(ctx, sfu, slug, nil, map[string]any{
		"kind":     "participant-left",
		"identity": identity,
		"sid":      sid,
		"at":       time.Now().UnixMilli(),
	}); err != nil {
		s.log.Warn("livekit webhook: could not announce a departure",
			"slug", slug, "identity", identity, "error", err)
	}
}

// internalIdentity is an egress, recorder or caption agent: never a tile on the stage.
func internalIdentity(identity string) bool {
	return strings.HasPrefix(identity, "EG_") || strings.HasPrefix(identity, "REC_") ||
		strings.HasPrefix(identity, lk.CaptionAgentPrefix)
}
