package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* The stage cap: how many people may publish in one webinar at once, per plan
 * (types.PlanStageCap). Checked wherever someone new gets onto the stage — a promotion
 * (invite and accept), the two bulk actions, a panelist added, and a panelist joining —
 * never against someone already there, so a downgrade or a full stage never throws a
 * speaker off mid-sentence. */

var errStageFull = errors.New("stage full")

// stageCapForHost is the admin's override for this host if one is set, else the plan's cap.
// A failed read is the no-plan cap, so an outage never allows more than a plan does.
func (s *Server) stageCapForHost(ctx context.Context, hostID string) int {
	plan, override, err := s.store.StageCapForUser(ctx, hostID)
	if err != nil {
		s.log.Warn("stage cap: could not read plan", "host", hostID, "error", err)
		return types.PlanStageCap("")
	}
	if override != nil && *override > 0 {
		return *override
	}
	return types.PlanStageCap(plan)
}

// meetingCapForHost is how many people one of this host's meetings holds: the admin's
// override if set, else the plan's. A failed read is the plan default, never more.
func (s *Server) meetingCapForHost(ctx context.Context, hostID string) int {
	plan, override, err := s.store.MeetingCapForUser(ctx, hostID)
	if err != nil {
		s.log.Warn("meeting cap: could not read plan", "host", hostID, "error", err)
		return types.PlanMeetingCap("")
	}
	if override != nil && *override > 0 {
		return *override
	}
	return types.PlanMeetingCap(plan)
}

// onStage reports whether a live participant is publishing: anyone with a stage role,
// or an attendee allowed to speak.
func onStage(p types.LiveParticipant) bool {
	return p.Role != types.RoleAttendee || p.CanSpeak || p.CanPublish
}

// stageCount is how many people are on the stage now, leaving out `except` (the person
// being added, who may already hold a seat).
func stageCount(parts []types.LiveParticipant, except string) int {
	n := 0
	for _, p := range parts {
		if p.Identity != except && onStage(p) {
			n++
		}
	}
	return n
}

// stageFullMessage is what the host (or the attendee accepting) reads.
func stageFullMessage(capacity int) string {
	return fmt.Sprintf("The stage is full: your plan allows %d people on stage at once. "+
		"Move someone back to the audience first.", capacity)
}

func writeStageFull(w http.ResponseWriter, capacity int) {
	httpx.Error(w, http.StatusConflict, "stage_full", stageFullMessage(capacity))
}

// stageHasRoom is true when `identity` can take a seat on wb's stage. A failed room
// read lets it through: the SFU being unreachable is reported by the step that needs it.
func (s *Server) stageHasRoom(ctx context.Context, sfu RoomManager, wb types.Webinar, identity string) (bool, int) {
	capacity := s.stageCapForHost(ctx, wb.Host.ID)
	parts, err := sfu.Participants(ctx, lk.RoomName(wb.ID))
	if err != nil {
		return true, capacity
	}
	return stageCount(parts, identity) < capacity, capacity
}

/* bulkStageFits refuses "allow everyone to speak" / "bring everyone on stage" when the
 * whole room would not fit on the stage, and says by how much. All or nothing rather than
 * the first N: which attendees got a seat would be an accident of listing order. Writes
 * the response and returns false when it refuses. */
func (s *Server) bulkStageFits(w http.ResponseWriter, r *http.Request, sfu RoomManager, wb types.Webinar) bool {
	parts, err := sfu.Participants(r.Context(), lk.RoomName(wb.ID))
	if err != nil {
		return true
	}
	capacity := s.stageCapForHost(r.Context(), wb.Host.ID)
	total := len(parts)
	if total <= capacity {
		return true
	}
	httpx.Error(w, http.StatusConflict, "stage_full", fmt.Sprintf(
		"That would put %d people on stage, and your plan allows %d at once. "+
			"Bring people on one at a time instead.", total, capacity))
	return false
}

func panelistCapMessage(capacity int) string {
	return fmt.Sprintf("Your plan allows %d people on stage, including you, so at most %d panelists.",
		capacity, capacity-1)
}

// panelistCapField is the validation message when the host plus these panelists would not
// fit on the stage, or "".
func panelistCapField(emails []string, capacity int) string {
	seen := map[string]bool{}
	for _, e := range emails {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			seen[e] = true
		}
	}
	if len(seen)+1 > capacity {
		return panelistCapMessage(capacity)
	}
	return ""
}
