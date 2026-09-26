package api

import (
	"context"
	"strings"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* @mentions in chat.
 *
 * A chat message carries the IDENTITIES it mentions alongside its text, so a tag
 * survives two people in the room sharing a name. The text still reads "@Name" on its
 * own, which is what an older client shows and all the transcript export needs.
 *
 * The list the composer sends is a request, like the destination is. What is stored
 * and delivered is what survives filterMentions, and the rules there are the same
 * ones the picker applies — enforced here because the picker runs on the sender's
 * machine:
 *
 *   exists       the identity is somebody in this room right now, or the host.
 *   may mention  the stage may mention anyone; the audience may mention the stage,
 *                and each other only when the host has not hidden attendees.
 *   can read     a panelists-only message may only mention people who will receive
 *                it. Tagging an attendee in a line they can never read would be a
 *                notification about nothing.
 *
 * Invalid entries are DROPPED rather than failing the message. A mention is garnish on
 * something somebody took the trouble to write, and refusing the whole line because
 * the person tagged left a second ago would be the wrong trade.
 */

// maxMentions caps one message. Enough for "@Alex @Sam can one of you take this",
// far short of a way to page the whole audience one identity at a time.
const maxMentions = 10

// mentionEveryone is the one mention that is not an identity. Host and co-host only;
// it notifies everybody who can read the message, and nobody else, because the
// destination already decided who that is.
const mentionEveryone = types.MentionEveryone

/* filterMentions is the whole permission matrix, pure so it can be tested without a
 * room.
 *
 * `people` is who is plausibly in the room, keyed by identity, with their role as the
 * server sees it — which includes hidden attendees, since this is the server's list
 * and not a client's. `senderCoHost` is the grant, not a role: a co-host is a panelist
 * with moderation rights, and only that right unlocks @everyone.
 *
 * Order is preserved and duplicates removed, so the stored list reads in the order the
 * sender typed it.
 */
func filterMentions(
	requested []string,
	sender wireSender,
	senderCoHost bool,
	people map[string]types.Role,
	hideAttendees bool,
	destination types.ChatDestination,
) []string {
	if len(requested) == 0 {
		return nil
	}
	senderOnStage := sender.Role == types.RoleHost || sender.Role == types.RolePanelist
	out := make([]string, 0, min(len(requested), maxMentions))
	seen := make(map[string]bool, len(requested))

	for _, raw := range requested {
		if len(out) == maxMentions {
			break
		}
		id := strings.TrimSpace(raw)
		if id == "" || len(id) > 200 || seen[id] {
			continue
		}
		seen[id] = true

		if id == mentionEveryone {
			if sender.Role == types.RoleHost || senderCoHost {
				out = append(out, id)
			}
			continue
		}
		// Mentioning yourself notifies nobody and highlights nothing useful.
		if id == sender.Identity {
			continue
		}
		role, ok := people[id]
		if !ok {
			continue
		}
		targetOnStage := role == types.RoleHost || role == types.RolePanelist

		if !targetOnStage {
			// An attendee cannot read a panelists-only line, whoever wrote it.
			if destination == types.ChatToPanelists {
				continue
			}
			// The audience finding each other through the picker is exactly what hiding
			// attendees is meant to stop. The stage can see everyone regardless.
			if !senderOnStage && hideAttendees {
				continue
			}
		}
		out = append(out, id)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

/* resolveMentions reads the room and applies filterMentions.
 *
 * Only called when the message asks to mention somebody, so an ordinary chat line
 * costs no extra round trip to the SFU. A failed read drops the mentions rather than
 * the message: the text still says "@Name", and nothing is highlighted that the server
 * could not check.
 */
func (s *Server) resolveMentions(
	ctx context.Context,
	sfu RoomManager,
	wb types.Webinar,
	from wireSender,
	destination types.ChatDestination,
	requested []string,
) []string {
	if len(requested) == 0 {
		return nil
	}

	people := map[string]types.Role{
		// The host is always a plausible mention, connected or not: the transcript
		// outlives their connection and they read it on their next join.
		hostIdentity(wb.Host.ID): types.RoleHost,
	}
	onlyEveryone := true
	for _, id := range requested {
		if id != mentionEveryone {
			onlyEveryone = false
			break
		}
	}
	if !onlyEveryone {
		list, err := sfu.Participants(ctx, lk.RoomName(wb.ID))
		if err != nil {
			s.log.Warn("say: mention roster failed, dropping mentions",
				"slug", wb.ID, "error", err)
			return nil
		}
		for _, p := range list {
			if isRecorderIdentity(p.Identity) {
				continue
			}
			people[p.Identity] = p.Role
		}
	}

	coHost := false
	if from.Role == types.RolePanelist {
		for _, id := range requested {
			if id != mentionEveryone {
				continue
			}
			grant, err := s.store.StageGrant(ctx, wb.ID, from.Identity)
			if err == nil {
				coHost = grant.CoHost
			}
			break
		}
	}

	return filterMentions(requested, from, coHost, people,
		wb.Controls.HideAttendees, destination)
}

// isRecorderIdentity matches the egress and recorder participants the SFU lists
// alongside people. Mirrors isBotOrEgress in web/lib/roster.ts.
func isRecorderIdentity(identity string) bool {
	return strings.HasPrefix(identity, "EG_") || strings.HasPrefix(identity, "REC_")
}
