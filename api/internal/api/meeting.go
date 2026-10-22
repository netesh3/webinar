package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* Meetings: everyone admitted is on the stage.
 *
 * A meeting is a webinar row with kind 'meeting' (migration 0124), and almost everything a
 * webinar has it keeps — the room, the host's controls, chat, recording, removals. What it does
 * NOT have is an audience. There is no attendee role in a meeting: the host lets somebody in and
 * they arrive with a microphone and a camera, as a panelist does. So the edge feed, the CDN mix,
 * stream destinations and simulive are all things a meeting never touches, and the stage
 * actions (promote, allow everyone to speak, hide the audience) have nothing to act on.
 *
 * THE DOOR IS DIFFERENT. A webinar's guest door is a name and straight in; a meeting's is a
 * name and a wait. Somebody with the link knocks (POST /meeting/knock), gets a join key back,
 * and polls the ordinary POST /join with it. Until the host admits them that answers 409
 * waiting_for_host; a denial is 403 lobby_denied; admitted, it is a stage token. The lobby is
 * the pending-registration mechanism manual approval already uses — see store/meeting_lobby.go
 * for why that, and not a table of its own.
 *
 * THE SIZE IS THE WHOLE ROOM. meetingCapForHost (10 by default, an admin up to 50) counts
 * everyone present including the host, and it is checked twice: when the host admits (so the
 * host is told the meeting is full while they can still do something about it) and again when
 * the admitted guest actually joins (because admitting is not attending, and five admitted
 * people can arrive in any order). The SFU's own ceiling sits a few seats above it — see
 * ensureRoom — for reconnect overlap and a recorder, never as the number that decides.
 *
 * Meetings do not go behind a feature switch: anybody who can host can hold one. A meeting
 * needs nothing a host does not already have, and it costs less to run than a webinar of the
 * same headcount, not more.
 */

func isMeeting(wb types.Webinar) bool { return wb.Kind == types.KindMeeting }

/* refuseInMeeting answers a stage action on a meeting and reports that it did.
 *
 * 422 rather than a quiet success: a client offering "bring on stage" in a meeting is a bug in
 * that client, and telling it so is how the bug gets found. Ordinary moderation — mute, remove,
 * mute everyone — is not refused, because it means the same thing in both. */
func refuseInMeeting(w http.ResponseWriter, wb types.Webinar) bool {
	if !isMeeting(wb) {
		return false
	}
	httpx.Error(w, http.StatusUnprocessableEntity, "not_in_meeting",
		"Everyone in a meeting is already on the stage, so there is nothing to change here.")
	return true
}

/* applyMeetingShape forces the settings a meeting has no choice about, and reports the ones
 * it cannot quietly fix.
 *
 * Forced rather than refused for everything that only makes sense with an audience —
 * registration, approval, a passcode, custom questions, hidden attendees, edge delivery —
 * because a create form built for webinars will send all of those with its own defaults, and
 * a meeting has exactly one answer to each. Refused for what would change WHERE the meeting
 * runs (Zoom) or WHAT it is (a recurring series, a simulive recording): those are a host asking
 * for something a meeting is not, and turning it silently into something else would be worse.
 *
 * The attendee limit is the most any meeting may hold, not this host's cap: the cap is read at
 * join time (meetingCapForHost), so an admin raising it applies to meetings already scheduled.
 */
func applyMeetingShape(in *types.WebinarInput, fields map[string]string, ceiling int) {
	in.Delivery = types.DeliveryStandard
	in.RegistrationRequired = false
	in.Approval = types.ApprovalAutomatic
	in.Passcode = ""
	in.CustomQuestions = nil
	in.SimuliveRecordingID = ""
	in.Controls.HideAttendees = false
	in.AttendeeLimit = max(1, min(types.MaxMeetingCapOverride, ceiling))
	if in.Venue != "" && in.Venue != zoom.VenueApp {
		fields["venue"] = "A meeting runs in this app."
	}
	if in.Recurrence != nil {
		fields["recurrence"] = "A meeting can't repeat yet. Its link can be reused, so schedule one and keep the link."
	}
}

// meetingDoorMessage is what the other two doors say when pointed at a meeting.
const meetingDoorMessage = "This is a meeting. Ask to join, and the host will let you in."

// refuseMeetingDoor answers /register and /guest-join for a meeting: the only way in is the
// lobby, so neither may mint a credential that skips it.
func refuseMeetingDoor(w http.ResponseWriter, wb types.Webinar) bool {
	if !isMeeting(wb) {
		return false
	}
	httpx.Error(w, http.StatusConflict, "meeting_knock", meetingDoorMessage)
	return true
}

func writeMeetingFull(w http.ResponseWriter, capacity int) {
	httpx.Error(w, http.StatusConflict, "meeting_full", fmt.Sprintf(
		"This meeting is full: it holds %d people at once, including the host.", capacity))
}

func writeMeetingEnded(w http.ResponseWriter) {
	httpx.Error(w, http.StatusConflict, "meeting_ended", "The host has ended this meeting.")
}

/* meetingPresent is how many people are in the meeting's room now, leaving out `except` (a
 * guest reconnecting, who already holds the seat they are asking for).
 *
 * From the SFU's participant list, which already leaves out egress and recorders, so a cloud
 * recording does not take somebody's seat. Unknown is reported as an error and the callers let
 * the person through: an unreachable SFU is reported by the step that actually needs it, the
 * same rule the webinar ceiling follows. */
func (s *Server) meetingPresent(ctx context.Context, sfu RoomManager, wb types.Webinar, except string) (int, error) {
	parts, err := sfu.Participants(ctx, lk.RoomName(wb.ID))
	if err != nil {
		return 0, err
	}
	n := 0
	for _, p := range parts {
		if p.Identity != except {
			n++
		}
	}
	return n, nil
}

// ------------------------------------------------------------------- knock

/* handleMeetingKnock is the meeting's front door: a name, and a place in the lobby.
 *
 * 404 for anything that is not a published meeting, so the endpoint says nothing about what a
 * slug is. A browser that already knocked sends its key back and is told where it stands — still
 * waiting, or admitted — rather than taking a second place in the queue; a key the host denied
 * is told so, because a new knock from the same browser a second later is not a new request,
 * it is the same person asking again.
 *
 * Not refused before the scheduled start. A webinar's fifteen-minute door is about an audience
 * arriving to an empty room; in a meeting the host is the door, and a host who opened the room
 * early to let someone in has decided the meeting has started.
 */
func (s *Server) handleMeetingKnock(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req types.MeetingKnockRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) || (err == nil && (!isMeeting(wb) || wb.Status == types.StatusDraft)) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That meeting doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "knock: load meeting", err)
		return
	}
	if wb.Status == types.StatusEnded {
		writeMeetingEnded(w)
		return
	}

	// A browser that knocked already keeps its place. Checked before the name, so a reload that
	// sends only the key is answered.
	if key := strings.ToUpper(strings.TrimSpace(req.JoinKey)); key != "" {
		reg, err := s.store.ByJoinKey(r.Context(), key)
		switch {
		case err == nil && reg.WebinarID == slug:
			switch reg.State {
			case types.RegApproved:
				httpx.JSON(w, http.StatusOK, types.MeetingKnockResponse{JoinKey: reg.JoinKey, State: types.LobbyAdmitted})
				return
			case types.RegPending:
				httpx.JSON(w, http.StatusOK, types.MeetingKnockResponse{JoinKey: reg.JoinKey, State: types.LobbyWaiting})
				return
			case types.RegDeclined:
				httpx.Error(w, http.StatusForbidden, "lobby_denied", "The host didn't let you into this meeting.")
				return
			}
		case err != nil && !errors.Is(err, store.ErrNotFound):
			s.fail(w, r, "knock: lookup key", err)
			return
		}
		// Unknown, or another meeting's: a fresh knock below.
	}

	name := strings.Join(strings.Fields(req.Name), " ")
	/* A signed-in visitor is not asked who they are: the door knocks with an empty name and
	 * the account's name stands in (or one made from the email, for an account without a
	 * name). Still a knock: the host admits them like anyone else. */
	if name == "" {
		if user, signedIn := s.optionalUser(r); signedIn {
			name = strings.Join(strings.Fields(user.Name), " ")
			if name == "" {
				name = store.NameFromEmail(user.Email)
			}
			if utf8.RuneCountInString(name) > guestNameMax {
				name = string([]rune(name)[:guestNameMax])
			}
		}
	}
	switch {
	case name == "":
		httpx.Fields(w, map[string]string{"name": "Required."})
		return
	case utf8.RuneCountInString(name) > guestNameMax:
		httpx.Fields(w, map[string]string{"name": "Please keep this under 60 characters."})
		return
	}
	if wb.Controls.Locked {
		httpx.Error(w, http.StatusConflict, "locked", "The host has locked this meeting.")
		return
	}

	reg, err := s.store.Knock(r.Context(), slug, name)
	switch {
	case errors.Is(err, store.ErrFull):
		httpx.Error(w, http.StatusConflict, "lobby_full",
			"Too many people are waiting to join this meeting. Try again in a moment.")
		return
	case errors.Is(err, store.ErrNotFound):
		// Ended or unpublished between the read above and the lock.
		writeMeetingEnded(w)
		return
	case err != nil:
		s.fail(w, r, "knock", err)
		return
	}
	s.log.Info("meeting knock", "meeting", slug)
	s.announceLobby(r.Context(), wb)
	httpx.JSON(w, http.StatusOK, types.MeetingKnockResponse{JoinKey: reg.JoinKey, State: types.LobbyWaiting})
}

/* announceLobby tells whoever runs the meeting how many are waiting: {"kind":"lobby","waiting":N}.
 *
 * To the host and any co-host in the room, by identity — a guest has no use for the queue
 * behind them. Best-effort, like announceAttendeeJoined: the host's lobby list polls as well,
 * so a lost packet is a few seconds' delay, not a person left at the door.
 *
 * Only for a meeting already on a video server. Resolving one for an unpinned meeting would
 * claim a project for a room nobody has opened, and there is nobody in it to tell. */
func (s *Server) announceLobby(ctx context.Context, wb types.Webinar) {
	if wb.SFUProject == "" {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	waiting, err := s.store.LobbyWaitingCount(ctx, wb.ID)
	if err != nil {
		s.log.Warn("lobby: count", "slug", wb.ID, "error", err)
		return
	}
	to := []string{hostIdentity(wb.Host.ID)}
	if parts, err := sfu.Participants(ctx, lk.RoomName(wb.ID)); err == nil {
		for _, p := range parts {
			if p.CoHost && p.Identity != to[0] {
				to = append(to, p.Identity)
			}
		}
	}
	if err := s.sendRoomPacket(ctx, sfu, wb.ID, to, map[string]any{
		"kind":    "lobby",
		"waiting": waiting,
		"at":      time.Now().UnixMilli(),
	}); err != nil {
		s.log.Warn("lobby: announce", "slug", wb.ID, "error", err)
	}
}

// -------------------------------------------------------------------- join

/* joinMeeting is handleAttendeeJoin for a meeting: the lobby's answer, then a stage token.
 *
 * Every refusal here is one the waiting page switches on, so each has its own code: still
 * waiting (409 waiting_for_host — the page keeps polling), denied (403 lobby_denied — it stops),
 * full (409 meeting_full), ended (409 meeting_ended).
 *
 * A removal is refused on every join, not only on a rejoin as a webinar does. A webinar
 * attendee the host removed may still hold a registration the host approved; in a meeting the
 * admission WAS the host's decision, and removing them is that decision reversed. Knocking
 * again is a new request the host can answer.
 *
 * The token is RolePanelist, not promoted (they were not lifted out of an audience; there is
 * none) and not data-only. A host mute persists through a reconnect the same way a panelist's
 * does, from the grant row SetGrantMuted writes.
 */
func (s *Server) joinMeeting(w http.ResponseWriter, r *http.Request, wb types.Webinar, reg types.Registration) {
	slug := wb.ID
	switch reg.State {
	case types.RegApproved:
	case types.RegPending:
		httpx.Error(w, http.StatusConflict, "waiting_for_host",
			"The host will let you in soon.")
		return
	case types.RegDeclined:
		httpx.Error(w, http.StatusForbidden, "lobby_denied",
			"The host didn't let you into this meeting.")
		return
	default:
		httpx.Error(w, http.StatusForbidden, "not_approved",
			"The host hasn't let you into this meeting yet.")
		return
	}
	identity := attendeeIdentity(reg.JoinKey)
	if s.refuseRemoved(w, r, slug, identity) {
		return
	}
	switch wb.Status {
	case types.StatusEnded:
		s.clearRejoinCookie(w, slug)
		writeMeetingEnded(w)
		return
	case types.StatusDraft:
		httpx.Error(w, http.StatusConflict, "not_started", "The host hasn't started this meeting yet.")
		return
	}

	room := lk.RoomName(slug)
	sfu, _, _, err := s.ensureRoom(r.Context(), wb, room)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	capacity := s.meetingCapForHost(r.Context(), wb.Host.ID)
	if present, err := s.meetingPresent(r.Context(), sfu, wb, identity); err != nil {
		s.log.Warn("meeting join: participant count failed, allowing", "error", err, "room", room)
	} else if present >= capacity {
		writeMeetingFull(w, capacity)
		return
	}

	display := strings.TrimSpace(reg.FirstName + " " + reg.LastName)
	if display == "" {
		display = "Guest"
	}
	grant, err := s.store.StageGrant(r.Context(), slug, identity)
	if err != nil {
		s.log.Warn("meeting join: grant lookup failed", "error", err, "identity", identity)
		grant = store.StageGrant{}
	}

	s.setRejoinCookie(w, wb, reg)
	if s.issueToken(w, r, wb, sfu, lk.Spec{
		Role:        types.RolePanelist,
		Room:        room,
		Identity:    identity,
		Name:        display,
		MutedByHost: grant.MutedByHost,
	}, false, false, "", false) {
		_ = s.store.TouchAttendance(r.Context(), slug, identity, reg.ID, display)
		s.announceAttendeeJoined(r, sfu, wb, room, identity, display)
	}
}

// meetingHasRoom is the cap for someone joining through the host door (a panelist): the host
// is never refused their own meeting, and a reconnect does not count against itself.
func (s *Server) meetingHasRoom(ctx context.Context, sfu RoomManager, wb types.Webinar, identity string) (bool, int) {
	capacity := s.meetingCapForHost(ctx, wb.Host.ID)
	present, err := s.meetingPresent(ctx, sfu, wb, identity)
	if err != nil {
		return true, capacity
	}
	return present < capacity, capacity
}

// -------------------------------------------------------------- host lobby

// lobbyMeeting loads the meeting in the URL for a lobby action, refusing anything else.
func (s *Server) lobbyMeeting(w http.ResponseWriter, r *http.Request) (types.Webinar, bool) {
	wb, err := s.store.WebinarBySlug(r.Context(), slugFromContext(r.Context()))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That meeting doesn't exist.")
		return types.Webinar{}, false
	}
	if err != nil {
		s.fail(w, r, "lobby: load meeting", err)
		return types.Webinar{}, false
	}
	if !isMeeting(wb) {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_meeting",
			"Only a meeting has a lobby. A webinar's attendees are approved from Registrants.")
		return types.Webinar{}, false
	}
	return wb, true
}

// lobbyRoom is how many more people the meeting can take right now, and its cap. A meeting
// nobody has opened has the whole cap free; a failed read is the whole cap too, and the join
// re-checks.
func (s *Server) lobbyRoom(ctx context.Context, wb types.Webinar) (free, capacity int) {
	capacity = s.meetingCapForHost(ctx, wb.Host.ID)
	if wb.SFUProject == "" {
		return capacity, capacity
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return capacity, capacity
	}
	present, err := s.meetingPresent(ctx, sfu, wb, "")
	if err != nil {
		return capacity, capacity
	}
	return max(0, capacity-present), capacity
}

func (s *Server) handleLobby(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.lobbyMeeting(w, r)
	if !ok {
		return
	}
	list, err := s.store.LobbyWaiting(r.Context(), wb.ID)
	if err != nil {
		s.fail(w, r, "lobby", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}

/* handleLobbyAdmit lets one waiting guest in, unless the meeting is already full.
 *
 * Full is decided from who is in the room now. That can let in one more than fits — two
 * admitted guests arriving to the last seat — which is why the join checks again; the check
 * here is for the host, who should hear "full" while they are looking at the button. */
func (s *Server) handleLobbyAdmit(w http.ResponseWriter, r *http.Request) {
	s.decideLobby(w, r, types.RegApproved)
}

// handleLobbyDeny turns one waiting guest away. Their next poll answers lobby_denied.
func (s *Server) handleLobbyDeny(w http.ResponseWriter, r *http.Request) {
	s.decideLobby(w, r, types.RegDeclined)
}

func (s *Server) decideLobby(w http.ResponseWriter, r *http.Request, state types.RegistrationState) {
	wb, ok := s.lobbyMeeting(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "That person isn't waiting any more.")
		return
	}
	if state == types.RegApproved {
		if free, capacity := s.lobbyRoom(r.Context(), wb); free <= 0 {
			writeMeetingFull(w, capacity)
			return
		}
	}
	err := s.store.DecideLobby(r.Context(), wb.ID, id, state)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That person isn't waiting any more.")
		return
	}
	if err != nil {
		s.fail(w, r, "lobby decide", err)
		return
	}
	s.log.Info("lobby decision", "meeting", wb.ID, "state", state)
	s.announceLobby(r.Context(), wb)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

/* handleLobbyAdmitAll lets in as many waiting guests as fit, longest-waiting first.
 *
 * Unlike "bring everyone on stage", which is all or nothing, this admits up to the cap and
 * reports who is left: the people at the door are a queue with an order, and the first five of
 * them getting in is the fair answer, not an accident of listing. */
func (s *Server) handleLobbyAdmitAll(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.lobbyMeeting(w, r)
	if !ok {
		return
	}
	free, _ := s.lobbyRoom(r.Context(), wb)
	admitted, err := s.store.AdmitOldest(r.Context(), wb.ID, free)
	if err != nil {
		s.fail(w, r, "lobby admit all", err)
		return
	}
	left, err := s.store.LobbyWaitingCount(r.Context(), wb.ID)
	if err != nil {
		s.fail(w, r, "lobby admit all: count", err)
		return
	}
	s.log.Info("lobby admit all", "meeting", wb.ID, "admitted", admitted, "left", left)
	s.announceLobby(r.Context(), wb)
	httpx.JSON(w, http.StatusOK, types.LobbyAdmitAllResponse{Admitted: admitted, Left: left})
}
