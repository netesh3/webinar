package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The host's hand-over, webinars and meetings alike.
 *
 * The rules (the founder's, 2026-10-25):
 *
 *   - Only the host makes or unmakes a co-host (the two co-host routes sit behind
 *     requireTrueOwner in api.go). A co-host cannot grant or revoke co-host.
 *   - When the host leaves they may hand the host role to one of the co-hosts: "Make <name>
 *     the host and leave" in the host's Leave menu. Only a co-host can take over — the host
 *     makes somebody co-host first, which is the moment they decide who could run the room.
 *   - Exactly one host at a time. webinars.host_id is the only place the host lives, and
 *     store.TransferHost moves it atomically (row lock, conditional update on the current
 *     host), so two racing hand-overs cannot both win. In LiveKit the role "host" is only
 *     ever minted for the account in host_id (stageRole for the host door, attendeeIsHost
 *     for an attendee identity), and this handler demotes every other connection holding it.
 *
 * A host whose tab simply closes hands nothing over: the session carries on as before, the
 * host can rejoin, and nobody is made host automatically. */

// handleTransferHost hands a live session to a co-host already in the room.
//
// Ownership moves in Postgres so host endpoints (end, mute-all, controls) keep working for
// the new host; LiveKit roles move so everyone else sees the right label without a reconnect.
// The previous host becomes an ordinary panelist and is expected to leave from the client
// after this call succeeds.
//
// The target is a co-host by LiveKit identity: an invited panelist ("user_<id>"), or an
// attendee brought on stage / a meeting guest ("att_<joinKey>") whose registration on this
// webinar is linked to a confirmed account — the same resolution "Make co-host" uses
// (setAttendeeCoHost). That account becomes the owner.
func (s *Server) handleTransferHost(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	user := userFromContext(r.Context())

	var body types.TransferHostRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	identity := strings.TrimSpace(body.Identity)

	var toID string
	switch {
	case strings.HasPrefix(identity, "user_") && len(identity) > len("user_"):
		toID = strings.TrimPrefix(identity, "user_")
	case strings.HasPrefix(identity, attendeePrefix) && len(identity) > len(attendeePrefix):
		acct, err := s.store.RegistrantAccount(r.Context(), slug, strings.TrimPrefix(identity, attendeePrefix))
		if errors.Is(err, store.ErrNotFound) {
			writeNotACoHost(w)
			return
		}
		if err != nil {
			s.fail(w, r, "transfer host: load registration", err)
			return
		}
		if acct.UserID == "" || !acct.EmailVerified {
			writeNotACoHost(w)
			return
		}
		toID = acct.UserID
	default:
		writeNotACoHost(w)
		return
	}
	if toID == user.ID {
		httpx.Error(w, http.StatusUnprocessableEntity, "same_host",
			"You are already the host.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "transfer host: load webinar", err)
		return
	}
	if wb.Status != types.StatusLive {
		what := "webinar"
		if isMeeting(wb) {
			what = "meeting"
		}
		httpx.Error(w, http.StatusConflict, "not_live",
			"Host can only be handed off while the "+what+" is live.")
		return
	}

	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	room := lk.RoomName(slug)
	list, err := sfu.Participants(r.Context(), room)
	if err != nil {
		s.fail(w, r, "transfer host: list participants", err)
		return
	}
	var target *types.LiveParticipant
	for i := range list {
		if list[i].Identity == identity {
			target = &list[i]
			break
		}
	}
	if target == nil {
		httpx.Error(w, http.StatusNotFound, "not_in_room",
			"That person has left.")
		return
	}
	// Role is enough: a muted co-host still holds a stage seat. Whether they are a co-host
	// is the database's answer (store.TransferHost), not the roster's.
	if target.Role != types.RolePanelist {
		writeNotACoHost(w)
		return
	}

	if _, err := s.store.UserByID(r.Context(), toID); errors.Is(err, store.ErrNotFound) {
		writeNotACoHost(w)
		return
	} else if err != nil {
		s.fail(w, r, "transfer host: load target", err)
		return
	}

	switch err := s.store.TransferHost(r.Context(), slug, user.ID, toID, identity); {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	case errors.Is(err, store.ErrConflict):
		// Another hand-over got there first: this caller is no longer the host.
		httpx.Error(w, http.StatusConflict, "host_changed",
			"The host has already been handed to somebody else.")
		return
	case errors.Is(err, store.ErrInvalid):
		writeNotACoHost(w)
		return
	case err != nil:
		s.fail(w, r, "transfer host", err)
		return
	}

	// Host endpoints require can_host. A guest speaker (or a meeting guest) made co-host often
	// does not have it yet; granting it here is what makes mute-all / end work for them after
	// they take over, without an admin round-trip mid-session.
	if targetUser, err := s.store.UserByID(r.Context(), toID); err == nil && !targetUser.CanHost {
		if _, err := s.store.SetHostCapability(r.Context(), toID, true); err != nil {
			s.log.Warn("transfer host: could not grant hosting capability",
				"slug", slug, "user", toID, "error", err)
		}
	}

	if err := sfu.SetRole(r.Context(), lk.Spec{
		Role:     types.RoleHost,
		Room:     room,
		Identity: identity,
		Name:     target.Name,
		NoMedia:  simuliveReplaying(wb),
	}); err != nil && !errors.Is(err, lk.ErrNotInRoom) {
		s.log.Warn("transfer host: could not promote new host in the room",
			"slug", slug, "identity", identity, "error", err)
	}
	// One host in the room: every other connection holding the role is demoted, not just the
	// caller's "user_" seat — the previous host may be connected as an attendee identity
	// (an earlier hand-over to them), or twice.
	for _, p := range list {
		if p.Identity == identity || p.Role != types.RoleHost {
			continue
		}
		if err := sfu.SetRole(r.Context(), s.formerHostSpec(r, wb, p)); err != nil && !errors.Is(err, lk.ErrNotInRoom) {
			s.log.Warn("transfer host: could not demote previous host in the room",
				"slug", slug, "identity", p.Identity, "error", err)
		}
	}

	wb, err = s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "transfer host: reload webinar", err)
		return
	}
	s.log.Info("host transferred", "slug", slug, "from", user.ID, "to", toID, "identity", identity)
	httpx.JSON(w, http.StatusOK, wb)
}

// formerHostSpec is the live grant for a connection that held the host role and no longer
// does: an ordinary panelist, keeping whatever stage grant their identity already has (an
// attendee identity in a webinar keeps its promotion and its scope).
func (s *Server) formerHostSpec(r *http.Request, wb types.Webinar, p types.LiveParticipant) lk.Spec {
	spec := lk.Spec{
		Role:     types.RolePanelist,
		Room:     lk.RoomName(wb.ID),
		Identity: p.Identity,
		Name:     p.Name,
		Hidden:   lk.HiddenFor(types.RolePanelist, wb.Controls.HideAttendees),
		NoMedia:  simuliveReplaying(wb),
	}
	if strings.HasPrefix(p.Identity, attendeePrefix) && !isMeeting(wb) {
		spec.Promoted = true
		if grant, err := s.store.StageGrant(r.Context(), wb.ID, p.Identity); err == nil {
			spec.AudioOnly = grant.AudioOnly
		}
	}
	return spec
}

func writeNotACoHost(w http.ResponseWriter) {
	httpx.Error(w, http.StatusUnprocessableEntity, "not_a_cohost",
		"Only a co-host in the room can take over as host. Make them co-host first.")
}

/* attendeeIsHost reports whether an attendee identity's join is the host coming back: the
 * request is signed in as the account behind this join key's registration on this webinar,
 * and that account is the webinar's host. That is how somebody handed the host role as a
 * promoted attendee or a meeting guest (handleTransferHost) keeps it across a reconnect —
 * from host_id, the one place it lives, not from a flag of its own. The bare join key (a
 * forwarded link, or a browser not signed in) is never the host. */
func (s *Server) attendeeIsHost(r *http.Request, wb types.Webinar, joinKey string) bool {
	user, signedIn := s.optionalUser(r)
	if !signedIn || user.ID != wb.Host.ID {
		return false
	}
	acct, err := s.store.RegistrantAccount(r.Context(), wb.ID, joinKey)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.log.Warn("join: host account lookup failed", "error", err, "webinar", wb.ID)
		}
		return false
	}
	return acct.UserID != "" && acct.EmailVerified && acct.UserID == wb.Host.ID
}
