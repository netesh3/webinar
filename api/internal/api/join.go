package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

// emptyTimeoutSec is how long the SFU keeps an empty room before tearing it
// down. Long enough that a host reloading their tab does not end the webinar for
// everyone still connected.
const emptyTimeoutSec = 300

/* edgeDepartureTimeoutSec is how long an edge webinar's room outlives its last participant.
 *
 * The server default (livekit.yaml departure_timeout, 20s) closes a room twenty seconds after
 * the last person leaves, and egress does not count as a person. In a standard webinar the
 * audience keeps the room open; in an edge one the audience is not in the room at all, so a
 * host whose laptop drops or who refreshes for half a minute emptied it — the room closed,
 * the compositor ended ("Source closed"), and every viewer saw black until the host came back
 * and a new mix booted (production, 2026-10-18). Three minutes covers a reconnect, a refresh
 * and a browser restart; a webinar the host really walked out of is still ended by the
 * empty-room sweep. */
const edgeDepartureTimeoutSec = 180

// departureFor is the departure timeout to create this webinar's room with; 0 is the
// server's default.
func departureFor(wb types.Webinar) uint32 {
	if wb.Delivery == types.DeliveryEdge {
		return edgeDepartureTimeoutSec
	}
	return 0
}

// stageHeadroom is how many seats above the attendee limit exist for the host
// and panelists, so a full audience never locks the presenter out of their own
// webinar.
const stageHeadroom = 5

/* joinGrace is how long before the scheduled start the doors open.
 *
 * There was no window at all, and the room deliberately shows "Waiting for the host to
 * start" to anyone who arrives before the host does — so an attendee who registered for a
 * session three weeks out could press Join, have an SFU room created for them, and sit in
 * it alone under a message implying the host was late. The honest answer at that point is
 * the date, not a waiting spinner.
 *
 * Fifteen minutes, because early arrivals are real: people join a webinar while they are
 * still finding their headphones. Applied only to the audience — a host or panelist has to
 * be able to get in well beforehand to set up, which is what a practice session is.
 *
 * Once the host has actually started, this stops applying entirely: a session that begins
 * late must not lock out the people waiting for it.
 */
const joinGrace = 15 * time.Minute

// handleAttendeeJoin is the security-critical endpoint.
//
// It must never mint a publishing token for someone who isn't the host, a
// panelist or an attendee the host explicitly promoted, and never mint any
// token for someone without an approved registration. The role is derived
// server-side from database state — a client cannot ask for a role.
func (s *Server) handleAttendeeJoin(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req types.JoinRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	reg, ok := s.resolveRegistration(w, r, slug, req.JoinKey)
	if !ok {
		return
	}

	wb, err := s.loadSynced(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "join: load webinar", err)
		return
	}
	/* A meeting answers from its lobby rather than from the approval gate below: pending there
	 * means "waiting at the door", which the waiting page polls through, not "the host has not
	 * reviewed your registration". See meeting.go. */
	if isMeeting(wb) {
		s.joinMeeting(w, r, wb, reg)
		return
	}

	if reg.State == types.RegUnverified {
		httpx.Error(w, http.StatusForbidden, "email_unverified",
			"Verify your email to get your join link.")
		return
	}
	if reg.State != types.RegApproved {
		httpx.Error(w, http.StatusForbidden, "not_approved",
			"The host hasn't approved your registration yet.")
		return
	}
	// A refresh or a reopened link must not undo the host removing somebody.
	if isRejoin(r) && s.refuseRemoved(w, r, slug, attendeeIdentity(reg.JoinKey)) {
		return
	}
	s.joinAsAttendee(w, r, wb, reg)
}

/* joinAsAttendee is every gate between a valid registration and a token, in one place.
 *
 * Extracted so the guest door (handleGuestJoin) goes through it rather than beside it. A second
 * copy is how a guest quietly ends up exempt from the attendee ceiling, or from the lock, after
 * somebody edits only the path they were looking at.
 *
 * Takes an already-resolved registration and an already-loaded webinar, because the two callers
 * obtain those differently: one resolves a join key or a session, the other has just created the
 * row itself.
 */
func (s *Server) joinAsAttendee(
	w http.ResponseWriter, r *http.Request, wb types.Webinar, reg types.Registration,
) {
	slug := wb.ID
	if zoom.IsVenue(wb.Venue) {
		s.joinZoomAttendee(w, r, wb, reg)
		return
	}
	if b := s.audienceBarrier(wb); b != nil {
		if b.code == "ended" {
			// Nothing left to rejoin.
			s.clearRejoinCookie(w, slug)
		}
		httpx.Error(w, b.status, b.code, b.message)
		return
	}

	room := lk.RoomName(slug)
	limit := min(wb.AttendeeLimit, s.ceilingForHost(r.Context(), wb.Host.ID))

	// Room is created here rather than by auto_create so the participant
	// ceiling is enforced by the SFU itself, not just by our own counting.
	//
	// It also decides WHICH LiveKit project this webinar lives on, the first time anybody
	// joins, and hands back the client for it — so the token minted below is signed by the
	// same project the room was created on. See sfu.go.
	sfu, count, known, err := s.ensureRoom(r.Context(), wb, room)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	// Check live occupancy, not the registration count: registrations are
	// usually 3-4x the people who actually show up, so counting registrations
	// would turn away attendees while the room was half empty.
	//
	// The number normally arrives with the room above, so this second call to the
	// SFU is a fallback rather than the path. It is the difference between one and
	// two round trips on every join, and a full audience arrives all at once.
	if wb.Delivery == types.DeliveryEdge {
		/* An edge audience is not on the video server, so the server's count is only the
		 * stage. The viewers are the open event streams (edgeOccupancy). Counted the same
		 * way for someone being let back onto the stage, which errs towards admitting. */
		count, err = s.edgeOccupancy(r.Context(), slug)
	} else if !known {
		count, err = sfu.ParticipantCount(r.Context(), room)
	}
	if err != nil {
		s.log.Warn("join: participant count failed, allowing", "error", err, "room", room)
	} else if count >= limit {
		httpx.Error(w, http.StatusConflict, "room_full",
			"This webinar has reached its attendee limit.")
		return
	}

	// Identity must be stable and unique per person: LiveKit disconnects an
	// older session when a duplicate identity joins, which is what we want when
	// someone opens the room twice, and it keeps chat attribution honest.
	identity := attendeeIdentity(reg.JoinKey)
	display := strings.TrimSpace(reg.FirstName + " " + reg.LastName)
	if display == "" {
		display = "Attendee"
	}

	// A host who promoted this person earlier in the session gets them back on
	// stage after a reconnect, instead of having to promote them again — with the
	// same scope they were given, so "allowed to speak" does not silently become a
	// camera on reconnect, and a host mute is not lifted by a reload.
	role := types.RoleAttendee
	grant, err := s.store.StageGrant(r.Context(), slug, identity)
	if err != nil {
		s.log.Warn("join: stage grant lookup failed, treating as attendee",
			"error", err, "identity", identity)
		grant = store.StageGrant{}
	} else if grant.Granted {
		role = types.RolePanelist
	}

	/* Edge delivery: no LiveKit token at all for the audience, only the LL-HLS playlist and
	 * the event-stream token (edge.go). Someone the host has put on the stage falls through
	 * to the ordinary token below; on demotion their browser joins again and lands here. */
	if playback, edge := s.edgeAudience(r.Context(), wb, grant.Granted); edge {
		s.setRejoinCookie(w, wb, reg)
		if s.issueEdgeAudience(w, r, wb, identity, display, playback) {
			_ = s.store.TouchAttendance(r.Context(), slug, identity, reg.ID, display)
			if wb.Status == types.StatusLive {
				go s.startBroadcastIfEnabled(context.Background(), wb, sfu) // #nosec G118 -- background work that must outlive the request; it carries its own timeout
			}
			s.announceAttendeeJoined(r, sfu, wb, room, identity, display)
		}
		return
	}

	/* A simulive attendee plays the recording (HLS or a file) in the broadcast room rather
	 * than joining the SFU. That is the only "broadcast" attendee left: the per-account CDN
	 * Broadcast mode, which sent live attendees a WHEP feed from the SFU box, was retired
	 * (2026-10-20) — Edge delivery is the big-audience path — and its hosts are on standard. */
	cdnBroadcast := false
	isCdnAttendee := false
	var cdnStreamURL string
	var cdnLowLatency bool
	// Live after the recording, the audience is in the ordinary live room instead.
	if simuliveReplaying(wb) {
		if u := s.simulivePlaybackURL(r.Context(), wb); u != "" {
			cdnBroadcast = true
			isCdnAttendee = !grant.Granted
			cdnStreamURL = u
		}
	}

	// The way back after a refresh (rejoin.go). Set before the token is written,
	// because a header cannot follow the body. A failed token leaves a cookie that
	// only works for a registration that already passed every gate above.
	s.setRejoinCookie(w, wb, reg)

	// canRecord is false down this path without qualification, including for
	// someone the host promoted. A promotion is a microphone and a camera; it is
	// not an account on the stage roster, which is what the recording endpoints
	// require, and a button that 401s on every press is worse than no button.
	ok := s.issueToken(w, r, wb, sfu, lk.Spec{
		Role:        role,
		Room:        room,
		Identity:    identity,
		Name:        display,
		AudioOnly:   grant.AudioOnly,
		MutedByHost: grant.MutedByHost,
		// A seat the host gave this person, which has to survive their reconnect
		// along with its scope — see Metadata.Promoted.
		Promoted: grant.Granted,
		DataOnly: isCdnAttendee,
	}, false, cdnBroadcast, cdnStreamURL, cdnLowLatency)
	if ok {
		_ = s.store.TouchAttendance(r.Context(), slug, identity, reg.ID, display)
		s.announceAttendeeJoined(r, sfu, wb, room, identity, display)
	}
}

/* announceAttendeeJoined tells the host someone from the audience just joined,
 * so they don't have to watch the participant count to notice.
 *
 * Sent to the host alone, by identity — not broadcast to the room — for the same
 * reason chat destinations are chosen server-side rather than left to a filter on
 * the receiving end: a well-attended session can have people joining every few
 * seconds, and turning that into a toast for the whole audience would be a
 * notification storm for everyone but the one person it is actually for.
 *
 * A reconnect (a dropped wifi, a reloaded tab) announces itself again — this endpoint
 * has no memory of who already joined once, and adding one to suppress a rare double
 * toast is not worth the state.
 *
 * Best-effort, like announcePolls: a missed notification costs nothing beyond the
 * toast itself, since the host's own roster poll (see useHostRoster) finds the
 * new attendee within a few seconds regardless.
 */
func (s *Server) announceAttendeeJoined(r *http.Request, sfu RoomManager, wb types.Webinar, room, identity, name string) {
	body, err := json.Marshal(wirePacket{
		Kind: attendeeJoinedKind,
		From: wireSender{Identity: identity, Name: name, Role: types.RoleAttendee},
		At:   time.Now().UnixMilli(),
	})
	if err != nil {
		s.log.Warn("announce attendee joined: marshal", "slug", wb.ID, "error", err)
		return
	}
	if err := sfu.SendData(r.Context(), room, dataTopic, body, []string{hostIdentity(wb.Host.ID)}); err != nil {
		s.log.Warn("announce attendee joined: send", "slug", wb.ID, "error", err)
	}
}

/* barrier is a refusal the audience is allowed to see: a status, a code the client switches
 * on, and a sentence for the person reading it.
 *
 * A type rather than four return values because it is returned as nil for "come in", and
 * `(0, "", "", false)` is the shape that gets misread. */
type barrier struct {
	status  int
	code    string
	message string
}

/* audienceBarrier is every reason the audience cannot come in that can be decided from the
 * webinar record alone, in one place.
 *
 * Two callers, and the second one is why this is a function. joinAsAttendee runs it on the way
 * to a token; handleGuestJoin runs it BEFORE it creates anything, so a guest turned away three
 * weeks early does not leave behind a registration row with no email on it that the host cannot
 * usefully do anything about. Written twice, the guest door is one edit away from being the door
 * that ignores the lock.
 *
 * Deliberately NOT including the attendee ceiling. That one needs live occupancy from the SFU —
 * a network call, and a different answer for a guest, whose seat is counted inside
 * store.RegisterGuest's transaction so two arriving together cannot both take the last one.
 */
func (s *Server) audienceBarrier(wb types.Webinar) *barrier {
	/* Ended and not-yet-started are different refusals.
	 *
	 * A finished session is over: status ended, including one markLapsed rewrote
	 * on read because the scheduled end passed and it never went live. Retrying
	 * will not open it, so the code is `ended` and the sentence is not "isn't
	 * running". A draft has not started; that is `not_started`, not the same
	 * answer. A scheduled session the host has not started is neither of these.
	 * Too early stays `too_early`, and once the doors are open the attendee
	 * comes in and waits.
	 */
	switch wb.Status {
	case types.StatusEnded:
		return &barrier{http.StatusConflict, "ended",
			"Thanks for your interest. The host has ended this session."}
	case types.StatusDraft:
		return &barrier{http.StatusConflict, "not_started",
			"The host hasn't started this session yet."}
	}
	if wb.Controls.Locked {
		return &barrier{http.StatusConflict, "locked",
			"The host has locked this webinar to new attendees."}
	}

	// Live means open, whatever the clock says: a session that starts late must not shut out
	// the people already waiting for it.
	if wb.Status == types.StatusLive {
		return nil
	}

	// Too early, and the message says when rather than making them guess. A malformed
	// StartsAt is not a reason to refuse anybody, so an unparseable time opens the doors.
	startsAt, err := time.Parse(time.RFC3339, wb.StartsAt)
	if err != nil {
		s.log.Warn("join: unparseable startsAt, allowing",
			"slug", wb.ID, "starts_at", wb.StartsAt, "error", err)
		return nil
	}
	// A simulive's doors open when its host chose (Options.SimuliveDoorsOpenMin): its
	// audience waits in the room, chatting, with no video until the start.
	opens := startsAt.Add(-joinGrace)
	if wb.Kind == types.KindSimulive {
		// Brought forward by the host's "Open doors now" or an earlier start set from the room.
		opens, _ = simuliveDoorsOpenAt(wb)
	}
	if time.Now().Before(opens) {
		return &barrier{http.StatusConflict, "too_early",
			"This webinar hasn't opened yet. You can join from " +
				localTime(opens, wb.TimeZone) + "."}
	}
	return nil
}

// resolveRegistration finds the caller's registration either from a join key or
// from their session, writing the error response itself.
//
// Two credentials for the same thing is deliberate: someone who registered from
// an emailed link has a join key and no account, and someone who registered
// while signed in has an account and should not have to keep a key.
func (s *Server) resolveRegistration(w http.ResponseWriter, r *http.Request, slug, rawKey string) (types.Registration, bool) {
	joinKey := strings.ToUpper(strings.TrimSpace(rawKey))

	if joinKey == "" {
		user, signedIn := s.optionalUser(r)
		if !signedIn {
			// A guest whose browser lost the key but kept the rejoin cookie from an
			// earlier join of this webinar (rejoin.go). The cookie is only ever an
			// automatic way back, so a removal refuses it.
			reg, ok, err := s.rejoinCookieRegistration(r, slug)
			if err != nil {
				s.fail(w, r, "join: rejoin cookie", err)
				return types.Registration{}, false
			}
			if ok {
				if s.refuseRemoved(w, r, slug, attendeeIdentity(reg.JoinKey)) {
					return types.Registration{}, false
				}
				return reg, true
			}
			httpx.Error(w, http.StatusUnauthorized, "no_join_key",
				"You need to register for this webinar first.")
			return types.Registration{}, false
		}
		reg, err := s.store.RegistrationForUser(r.Context(), slug, user.ID)
		if errors.Is(err, store.ErrNotFound) && s.cfg.AuthBypass {
			// AUTH_BYPASS: registering is the last form standing between opening the
			// URL and being in the room, so fill it in from the account and carry on.
			// The row is real, which is what keeps the roster, the stage grants and
			// the attendee count working exactly as they do normally.
			reg, err = s.store.Register(r.Context(), slug, types.RegisterRequest{
				FirstName: user.Name,
				Email:     user.Email,
			}, user.ID)
			if err != nil {
				s.fail(w, r, "join: auto-register", err)
				return types.Registration{}, false
			}
			return reg, true
		}
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusForbidden, "not_registered",
				"You're signed in, but not registered for this webinar yet.")
			return types.Registration{}, false
		}
		if err != nil {
			s.fail(w, r, "join: registration for user", err)
			return types.Registration{}, false
		}
		return reg, true
	}

	reg, err := s.store.ByJoinKey(r.Context(), joinKey)
	if errors.Is(err, store.ErrNotFound) {
		// Same response for "no such key" and "key for another webinar" so the
		// endpoint can't be used to probe which keys exist.
		httpx.Error(w, http.StatusUnauthorized, "invalid_join_key",
			"That join link isn't valid for this webinar.")
		return types.Registration{}, false
	}
	if err != nil {
		s.fail(w, r, "join: lookup key", err)
		return types.Registration{}, false
	}
	if reg.WebinarID != slug {
		same, err := s.store.SameSeries(r.Context(), reg.WebinarID, slug)
		if err != nil {
			s.fail(w, r, "join: series", err)
			return types.Registration{}, false
		}
		// One registration covers every session in the series. The join key
		// was issued for whichever session they signed up on.
		if !same {
			httpx.Error(w, http.StatusUnauthorized, "invalid_join_key",
				"That join link isn't valid for this webinar.")
			return types.Registration{}, false
		}
	}
	return reg, true
}

// handleHostJoin mints a publishing token. Requires a session AND ownership of
// (or a panelist seat on) this webinar.
func (s *Server) handleHostJoin(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	user := userFromContext(r.Context())

	role, err := s.stageRole(r.Context(), slug, user.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "host join: stage lookup", err)
		return
	}
	if role == "" {
		// Authenticated, but not on this webinar's stage.
		httpx.Error(w, http.StatusForbidden, "forbidden",
			"You're not the host or a panelist on this webinar.")
		return
	}

	wb, err := s.loadSynced(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "host join: load webinar", err)
		return
	}
	if wb.Status == types.StatusEnded {
		httpx.Error(w, http.StatusConflict, "ended",
			"This webinar has ended. Reopen it from the dashboard to run it again.")
		return
	}
	if zoom.IsVenue(wb.Venue) {
		if role != types.RoleHost {
			httpx.Error(w, http.StatusConflict, "runs_in_zoom",
				"This session runs in Zoom. The host starts it there.")
			return
		}
		s.zoomGoLive(w, r, wb)
		return
	}

	room := lk.RoomName(slug)
	sfu, _, _, err := s.ensureRoom(r.Context(), wb, room)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	identity := hostIdentity(user.ID)
	// A panelist the host removed does not come back on a refresh. The host cannot
	// be removed from their own stage, so only a panelist is checked.
	if role == types.RolePanelist && isRejoin(r) && s.refuseRemoved(w, r, slug, identity) {
		return
	}
	// A scheduled panelist arriving at a stage already filled by promoted attendees waits
	// for a seat. Never the host, and never someone already on stage (a reconnect).
	// In a meeting the whole room is the stage, so a panelist waits for a seat in the meeting
	// instead — the same cap an admitted guest is held to.
	if role == types.RolePanelist && isMeeting(wb) {
		if ok, capacity := s.meetingHasRoom(r.Context(), sfu, wb, identity); !ok {
			writeMeetingFull(w, capacity)
			return
		}
	} else if role == types.RolePanelist {
		if ok, capacity := s.stageHasRoom(r.Context(), sfu, wb, identity); !ok {
			writeStageFull(w, capacity)
			return
		}
	}

	// A panelist the host muted comes back muted, and a panelist the host made
	// co-host comes back co-host — a dropped connection must not be a way to
	// lose either. Only the latch/flag is read here — the right to be on this
	// stage comes from the panelist list, not from a grant — and both are
	// ignored for the host, who is neither mutable nor promotable by anyone.
	muted := false
	coHost := false
	if role == types.RolePanelist {
		grant, err := s.store.StageGrant(r.Context(), slug, identity)
		if err != nil {
			s.log.Warn("host join: grant lookup failed, treating as an ordinary panelist",
				"error", err, "identity", identity)
		} else {
			muted = grant.MutedByHost
			coHost = grant.CoHost
		}
	}

	// Live after a simulive's recording: one of the host team is back within the grace.
	if wb.SimuliveHostGoneAt != "" {
		_ = s.store.ClearSimuliveHostGone(r.Context(), slug)
	}

	// Same as attendee join / Start: do not block the host token on egress RPC.
	if wb.Status == types.StatusLive {
		go s.startBroadcastIfEnabled(context.Background(), wb, sfu) // #nosec G118 -- background work that must outlive the request; it carries its own timeout
	}
	/* The host arriving at a live session brings the caption agent in if the session wants it
	 * and it is not there: Start cannot dispatch it while the video server is still booting,
	 * and a dispatch that failed is retried on the host's next join. A no-op otherwise. */
	if role == types.RoleHost && wb.Status == types.StatusLive && s.syncCaptionAgent(r.Context(), wb, sfu) {
		if fresh, err := s.store.WebinarBySlug(r.Context(), slug); err == nil {
			wb = fresh
			s.pushRoomMetadata(r, sfu, wb)
		}
	}

	// Reaching here means stageRole returned host or panelist for a real
	// account, which is the same check the recording endpoints make — so this
	// is the one path that may record. Not gated on s.recordings any more: that
	// only decides whether CLOUD recording works, and local, on-device
	// recording needs no server storage — see AppConfig.CloudRecordingEnabled
	// for the storage half of the question.
	/* A simulive's host team drops in to watch, chat and answer: they get the recording the
	 * audience plays and a grant with no audio or video at all (Spec.NoMedia), so nothing of
	 * theirs can reach anyone. Nor a record control — a simulive is never recorded. */
	/* Once its recording has ended with them there (live after), they are on an ordinary
	 * stage — still not recorded (issueToken). */
	simulive := simuliveReplaying(wb)
	streamURL := ""
	if simulive {
		streamURL = s.simulivePlaybackURL(r.Context(), wb)
	}
	s.issueToken(w, r, wb, sfu, lk.Spec{
		Role:        role,
		Room:        room,
		Identity:    identity,
		Name:        user.Name,
		MutedByHost: muted,
		CoHost:      coHost,
		NoMedia:     simulive,
	}, wb.Kind != types.KindSimulive, streamURL != "", streamURL, false)
}

// ensureRoom creates the room with the capacity ceiling and seeds its metadata
// with the current session controls, so a client learns them on connect rather
// than by asking.
// ensureRoom also reports current occupancy, which CreateRoom returns for free.
// `known` is false when the SFU could not tell us and the caller must ask.
func (s *Server) ensureRoom(
	ctx context.Context, wb types.Webinar, room string,
) (sfu RoomManager, participants int, known bool, err error) {
	project, sfu, fresh, err := s.resolveSFU(ctx, wb)
	if err != nil {
		return nil, 0, false, err
	}
	// A stopped SFU box is started here and the caller told to retry — before any call to
	// it, so the failover below never mistakes a box that is booting for one that refused.
	if err := s.sfuReady(ctx, project); err != nil {
		return nil, 0, false, err
	}

	limit := min(wb.AttendeeLimit, s.ceilingForHost(ctx, wb.Host.ID))
	if isMeeting(wb) {
		/* A meeting's room is sized to the meeting, not to the attendee ceiling: the headroom
		 * below is for a reconnect overlapping its own old session and for a recorder, and the
		 * number that actually turns people away is the meeting cap joinMeeting checks. */
		limit = s.meetingCapForHost(ctx, wb.Host.ID)
	}
	meta, err := s.roomMetadata(ctx, wb)
	if err != nil {
		return nil, 0, false, err
	}
	size := uint32(limit + stageHeadroom) // #nosec G115 -- attendee cap plus a small headroom, far below 2^32

	count, known, err := sfu.EnsureRoom(ctx, room, size, emptyTimeoutSec, departureFor(wb), meta)
	if err == nil {
		return sfu, count, known, nil
	}

	/* The project refused the room. Try the next one — but only if this webinar was pinned a
	 * moment ago and has not started.
	 *
	 * This is what makes an exhausted LiveKit Cloud allowance survivable without anybody
	 * being paged: the first project stops accepting rooms, and the next session quietly
	 * lands on the spare. It is deliberately narrow.
	 *
	 * `fresh` is the whole condition, and it is sufficient. It means the pin was empty
	 * immediately before this request, under a row lock — and nobody can be connected to a
	 * webinar that has never been pinned, because a token is only ever minted after this
	 * function claims one. So there is no audience to split.
	 *
	 * It is deliberately NOT also gated on the webinar being scheduled rather than live. That
	 * looked like a safe extra condition and would have disabled the feature in the case it
	 * exists for: handleStartWebinar sets the status to live and THEN calls this, so a host
	 * pressing Start on an exhausted project is a live webinar with a brand-new pin. A test
	 * caught it.
	 *
	 * A refusal that is really a network blip therefore costs one extra empty room on the
	 * spare project, which is cheap and self-correcting. The alternative is a session that
	 * fails to start because one HTTP call timed out.
	 */
	if !fresh {
		/* Not ours to move — but somebody else may have just moved it.
		 *
		 * The thundering herd at the top of the hour: two hundred people arrive at a webinar
		 * whose project has run out of allowance. Exactly one of them wins the row lock in
		 * ClaimSFUProject and gets `fresh`, so exactly one is licensed to fail over. Without
		 * this re-read the other hundred and ninety-nine would each be told the session is
		 * unavailable, moments before it became available.
		 *
		 * One re-read and one retry, on an error path only. Bounded deliberately: a loop here
		 * would turn a genuinely dead project into a request that never returns.
		 */
		latest, readErr := s.store.WebinarBySlug(ctx, wb.ID)
		if readErr != nil || latest.SFUProject == project {
			return nil, 0, false, err
		}
		moved, getErr := s.sfu.Get(latest.SFUProject)
		if getErr != nil {
			return nil, 0, false, err
		}
		count, known, retryErr := moved.EnsureRoom(ctx, room, size, emptyTimeoutSec, departureFor(wb), meta)
		if retryErr != nil {
			return nil, 0, false, err
		}
		s.log.Info("followed a concurrent failover to another livekit project",
			"slug", wb.ID, "from", project, "to", latest.SFUProject)
		return moved, count, known, nil
	}

	/* The on-demand box never fails over (sfu_box.go): its sessions wait for it rather than
	 * land on another provider. A refusal here is a box that said ready a moment ago and is
	 * not answering: tell the caller to wait, and let the next look re-read its state. */
	if s.managesProject(project) {
		s.log.Warn("on-demand video server refused a room; not failing over", "slug", wb.ID, "project", project, "error", err)
		s.box.invalidate()
		return nil, 0, false, errSFUStarting
	}
	for _, next := range s.sfu.Candidates() {
		if next == project {
			continue
		}
		alt, getErr := s.sfu.Get(next)
		if getErr != nil {
			continue
		}
		altCount, altKnown, altErr := alt.EnsureRoom(ctx, room, size, emptyTimeoutSec, departureFor(wb), meta)
		if altErr != nil {
			s.log.Warn("livekit project also refused the room, trying the next",
				"slug", wb.ID, "project", next, "error", altErr)
			continue
		}
		if repinErr := s.store.RepinSFUProject(ctx, wb.ID, next); repinErr != nil {
			/* The room now exists on `next`, but the database still says `project`.
			 *
			 * Refusing is the only safe answer: the very next join would read the old pin,
			 * create a second room on the old project, and split the audience across the
			 * two. An empty room on `next` expires by itself after emptyTimeoutSec.
			 */
			return nil, 0, false, fmt.Errorf(
				"created room on %s but could not record it: %w", next, repinErr)
		}
		s.log.Warn("livekit project refused a new room; moved the webinar to the next one",
			"slug", wb.ID, "from", project, "to", next, "error", err)
		return alt, altCount, altKnown, nil
	}

	return nil, 0, false, err
}

// roomMetadata is the state every client in the room reads off the SFU.
//
// `recording` is queried rather than passed in: the flag has to be right in every
// metadata write, and threading it through half a dozen call sites is how one of
// them ends up publishing "not recording" over a room that is. One indexed lookup
// on a path that runs when a host changes a control is not worth optimising away.
func (s *Server) roomMetadata(ctx context.Context, wb types.Webinar) (string, error) {
	recording, recordingSince, err := s.store.ActiveRecording(ctx, wb.ID)
	if err != nil {
		// Better to under-claim than to over-claim: a missing indicator is a bug,
		// a false one tells people they are being recorded when they are not.
		s.log.Warn("room metadata: could not read recording state",
			"slug", wb.ID, "error", err)
	}
	recordingStartedAt := ""
	if recording && !recordingSince.IsZero() {
		recordingStartedAt = recordingSince.UTC().Format(time.RFC3339Nano)
	}
	b, err := json.Marshal(types.RoomMeta{
		Controls:           wb.Controls,
		Status:             wb.Status,
		Topic:              wb.Topic,
		StartedAt:          wb.StartedAt,
		EndedAt:            wb.EndedAt,
		Recording:          recording,
		RecordingStartedAt: recordingStartedAt,
		MaxDurationMin:     wb.MaxDurationMin,
		SimuliveStartAt:    wb.SimuliveStartAt,
		SimuliveDoorsOpen:  wb.SimuliveDoorsOpen,
		SimuliveLiveAt:     wb.SimuliveLiveAt,
		SimuliveLiveWith:   simuliveLiveWith(wb),
	})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// issueToken is the single place a join response is built, so the two join paths
// cannot disagree about what they told the client.
//
// canRecord is a parameter rather than something derived from spec.Role, because
// the role cannot express it: a promoted attendee and an invited panelist both
// arrive here as RolePanelist, and only one of them has an account the recording
// endpoints will accept. The caller knows which; this function cannot.
//
// Reports whether a token was actually issued, so a caller that wants to act
// on a successful join — announceAttendeeJoined, below — does not fire for a
// request that ends in an error response.
func (s *Server) issueToken(
	w http.ResponseWriter, r *http.Request, wb types.Webinar, sfu RoomManager,
	spec lk.Spec, canRecord bool, cdnBroadcast bool, cdnStreamURL string, cdnLowLatency bool,
) bool {
	spec.Hidden = lk.HiddenFor(spec.Role, wb.Controls.HideAttendees)

	// Timed and logged only behind TelemetryEnabled: minting a token is on the
	// hot path of every join, and this is a temporary instrument for one test
	// window, not a standing per-request log line.
	started := time.Now()
	tok, err := sfu.Token(spec)
	if s.cfg.TelemetryEnabled {
		event := "token_issuance"
		if err != nil {
			event = "token_issuance_error"
		}
		logTelemetryEvent(types.TelemetryEvent{
			Event:     event,
			Timestamp: started.UnixMilli(),
			Payload: map[string]any{
				"durationMs": float64(time.Since(started).Milliseconds()),
				"roomName":   spec.Room,
				"role":       string(spec.Role),
			},
		})
	}
	if err != nil {
		s.fail(w, r, "mint token", err)
		return false
	}
	s.log.Info("token issued",
		"room", spec.Room, "role", spec.Role, "identity", spec.Identity,
		"hidden", spec.Hidden, "audio_only", spec.AudioOnly, "cdn", cdnBroadcast)
	simulive := simuliveReplaying(wb)
	simuliveLive := wb.Kind == types.KindSimulive && !simulive
	publishes := lk.CanPublish(spec.Role) && !spec.NoMedia
	// A simulive is never recorded, whoever asks (refuseSimuliveRecording) — nor its live part.
	canRecord = canRecord && wb.Kind != types.KindSimulive
	var simuliveLength int64
	if simulive {
		simuliveLength, _ = s.store.SimuliveLengthMs(r.Context(), wb.ID)
	}
	httpx.JSON(w, http.StatusOK, types.JoinResponse{
		Token: tok,
		// The project's OWN address, not a global one. This is why the client is threaded
		// all the way down here: a token signed by project B alongside project A's URL is a
		// browser authenticating against a room it is not connected to.
		URL:         sfu.URL(),
		Room:        spec.Room,
		Role:        spec.Role,
		Identity:    spec.Identity,
		DisplayName: spec.Name,
		CanPublish:  publishes,
		Controls:    wb.Controls,
		Topic:       wb.Topic,
		StartedAt:   wb.StartedAt,
		EndedAt:     wb.EndedAt,
		Hidden:      spec.Hidden,
		CanRecord:   canRecord,
		// Only the stage is offered the record control, so attendees skip the lookup.
		CloudRecording: canRecord && s.hostCloudRecording(r.Context(), wb.Host.ID),
		// The stage only, and not an attendee promoted onto it: they watch the
		// board like the rest of the audience. See JoinResponse.Whiteboard.
		// Nor a meeting guest: they are on the stage because everyone is, not because the host
		// chose them to present, so the board stays with the host and the panelists.
		Whiteboard: publishes && !spec.Promoted &&
			!(isMeeting(wb) && joinKeyFromIdentity(spec.Identity) != "") &&
			s.hostFeature(r.Context(), wb.Host.ID, types.FeatureWhiteboard),
		JoinKey:          joinKeyFromIdentity(spec.Identity),
		MaxDurationMin:   wb.MaxDurationMin,
		CdnBroadcast:     cdnBroadcast,
		CdnStreamURL:     cdnStreamURL,
		CdnLowLatency:    cdnLowLatency,
		EdgeWebinar:      wb.Delivery == types.DeliveryEdge && !isMeeting(wb),
		Meeting:          isMeeting(wb),
		Simulive:         simulive,
		ReplayEngage:     simulive && s.replayAvailable(r.Context(), wb),
		SimuliveCaptions: simulive && s.simuliveHasCaptions(r.Context(), wb),
		StartsAt:         wb.StartsAt,
		SimuliveManual:   simulive && simuliveManual(wb),
		SimuliveStartAt:  wb.SimuliveStartAt,
		SimuliveLengthMs: simuliveLength,
		SimuliveLive:     simuliveLive && wb.Status == types.StatusLive,
	})
	return true
}

func (s *Server) simulivePlaybackURL(ctx context.Context, wb types.Webinar) string {
	if wb.Kind != types.KindSimulive || wb.SimuliveRecordingID == "" {
		return ""
	}
	f, err := s.store.RecordingFileByID(ctx, wb.SimuliveRecordingID)
	if err != nil || strings.TrimSpace(f.StorageKey) == "" {
		return ""
	}
	if cdn := strings.TrimRight(s.cfg.RecordingsCDNBaseURL, "/"); cdn != "" {
		return cdn + "/" + strings.TrimPrefix(f.StorageKey, "/")
	}
	if f.IsUpload() {
		// No webinar to address it by; without a CDN only its host can play it here.
		return "/api/host/videos/" + f.ID + "/file"
	}
	return "/api/webinars/" + f.Webinar + "/recordings/" + f.ID + "/file"
}

// Identities are prefixed by kind so a log line or an SFU dashboard reads
// clearly, and so the two namespaces can never collide.
const attendeePrefix = "att_"

func attendeeIdentity(joinKey string) string { return attendeePrefix + joinKey }
func hostIdentity(userID string) string      { return "user_" + userID }

/* joinKeyFromIdentity inverts attendeeIdentity, and returns "" for anything else.
 *
 * Derived rather than threaded through issueToken as a second parameter, because the identity
 * IS the join key on this path and two arguments that must always agree is a worse contract
 * than one that cannot disagree. A host or panelist identity has no key behind it, which is
 * exactly what the empty string means here.
 */
func joinKeyFromIdentity(identity string) string {
	if !strings.HasPrefix(identity, attendeePrefix) {
		return ""
	}
	return strings.TrimPrefix(identity, attendeePrefix)
}

// pinnedProject is the project the webinar's room is on now, falling back to wb's copy
// when the store cannot be read.
func (s *Server) pinnedProject(ctx context.Context, wb types.Webinar) string {
	project, err := s.store.SFUProjectOf(ctx, wb.ID)
	if err != nil {
		s.log.Warn("sfu: could not read the webinar's project", "slug", wb.ID, "error", err)
		return wb.SFUProject
	}
	return project
}
