package api

import (
	"context"
	"math"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/types"
)

/* One screen share at a time: the server's half.
 *
 * The rule lives in web/lib/share-lock.ts and the browsers enforce it themselves — a
 * panelist's Share button refuses while somebody is sharing, and a share that has been
 * outranked stops itself. This is the backstop for whatever gets past that: two people
 * pressing Share in the same instant (each saw an empty stage), or a browser on an old
 * bundle that never checks.
 *
 * It runs on LiveKit's track_published webhook. Every live share in the room is ranked by
 * the same rule as the browsers' pickShare, and every share but the winner is muted. A muted
 * share is what the browser side reads as "you lost": it stops the share and says why.
 *
 * The order comes from TrackInfo.Version — the SFU's own clock, stamped once when a share's
 * media first arrives. The browsers read the same field, so both halves agree without
 * trusting anybody's clock or a timestamp a participant wrote about themselves. */

// shareCandidate is one live screen share, the Go twin of share-lock.ts's ShareCandidate.
type shareCandidate struct {
	Identity   string
	Privileged bool
	// StartedAt is the SFU's publish stamp in microseconds; 0 when unknown.
	StartedAt int64
	Muted     bool
}

/* pickShare is web/lib/share-lock.ts pickShare, rule for rule:
 *
 *   - muted shares do not count;
 *   - if any host or co-host is sharing, the NEWEST of theirs wins (a takeover);
 *   - otherwise the OLDEST share wins (first come, first served);
 *   - an unknown stamp counts as newest;
 *   - a tie goes to the smaller identity.
 *
 * Returns the winner's identity, or "" when nobody is presenting. */
func pickShare(shares []shareCandidate) string {
	at := func(s shareCandidate) int64 {
		if s.StartedAt <= 0 {
			return math.MaxInt64
		}
		return s.StartedAt
	}
	var live, privileged []shareCandidate
	for _, s := range shares {
		if s.Muted {
			continue
		}
		live = append(live, s)
		if s.Privileged {
			privileged = append(privileged, s)
		}
	}
	if len(live) == 0 {
		return ""
	}
	if len(privileged) > 0 {
		best := privileged[0]
		for _, s := range privileged[1:] {
			if at(s) > at(best) || (at(s) == at(best) && s.Identity < best.Identity) {
				best = s
			}
		}
		return best.Identity
	}
	best := live[0]
	for _, s := range live[1:] {
		if at(s) < at(best) || (at(s) == at(best) && s.Identity < best.Identity) {
			best = s
		}
	}
	return best.Identity
}

// shareCandidates reads every live screen share out of a room's roster.
func shareCandidates(roster []types.LiveParticipant) []shareCandidate {
	var out []shareCandidate
	for _, p := range roster {
		if p.ScreenShare == nil {
			continue
		}
		out = append(out, shareCandidate{
			Identity:   p.Identity,
			Privileged: p.Role == types.RoleHost || p.CoHost,
			StartedAt:  p.ScreenShare.StartedAtMicro,
			Muted:      p.ScreenShare.Muted,
		})
	}
	return out
}

/* enforceOneShare mutes every screen share in the room except the one pickShare chose.
 *
 * Reads the room fresh rather than trusting the webhook's own participant: by the time a
 * retried webhook lands, the share it describes may already have been stopped, and the
 * room as it is now is the only thing worth enforcing against. Returns the identities it
 * muted, for the log and the tests. */
func (s *Server) enforceOneShare(ctx context.Context, rooms RoomManager, room string) ([]string, error) {
	roster, err := rooms.Participants(ctx, room)
	if err != nil {
		return nil, err
	}
	shares := shareCandidates(roster)
	winner := pickShare(shares)
	if winner == "" {
		return nil, nil
	}
	var muted []string
	for _, sh := range shares {
		if sh.Muted || sh.Identity == winner {
			continue
		}
		if err := rooms.MuteTrack(ctx, room, sh.Identity, livekit.TrackSource_SCREEN_SHARE, true); err != nil {
			s.log.Warn("share lock: could not mute a losing screen share",
				"room", room, "identity", sh.Identity, "winner", winner, "error", err)
			continue
		}
		// And its sound, or a shared video keeps playing under the winner's. No audio
		// track is not an error here: MuteTrack treats muting nothing as done.
		if err := rooms.MuteTrack(ctx, room, sh.Identity, livekit.TrackSource_SCREEN_SHARE_AUDIO, true); err != nil {
			s.log.Warn("share lock: could not mute a losing share's audio",
				"room", room, "identity", sh.Identity, "error", err)
		}
		muted = append(muted, sh.Identity)
	}
	if len(muted) > 0 {
		s.log.Info("share lock: one screen share at a time",
			"room", room, "kept", winner, "muted", muted)
	}
	return muted, nil
}

// handleSharePublished is the track_published branch of the LiveKit webhook.
func (s *Server) handleSharePublished(ctx context.Context, event *livekit.WebhookEvent) {
	if event.Track == nil || event.Track.Source != livekit.TrackSource_SCREEN_SHARE {
		return
	}
	slug := slugFromRoom(event.Room)
	if slug == "" {
		return
	}
	rooms, err := s.sfuForSlug(ctx, slug)
	if err != nil {
		s.log.Warn("share lock: no SFU for webinar", "slug", slug, "error", err)
		return
	}
	if _, err := s.enforceOneShare(ctx, rooms, event.Room.Name); err != nil {
		s.log.Warn("share lock: could not read the room", "slug", slug, "error", err)
	}
}
