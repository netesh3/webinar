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
	"github.com/netkumar/webcast/api/types"
)

// emptyTimeoutSec is how long the SFU keeps an empty room before tearing it
// down. Long enough that a host reloading their tab does not end the webinar for
// everyone still connected.
const emptyTimeoutSec = 300

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
	if reg.State != types.RegApproved {
		httpx.Error(w, http.StatusForbidden, "not_approved",
			"The host hasn't approved your registration yet.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "join: load webinar", err)
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
	if b := s.audienceBarrier(wb); b != nil {
		httpx.Error(w, b.status, b.code, b.message)
		return
	}

	room := lk.RoomName(slug)
	limit := min(wb.AttendeeLimit, s.cfg.MaxAttendees)

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
	if !known {
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

	// Check if host has CDN broadcast capability enabled
	cdnBroadcast, err := s.store.HostCanCdnBroadcast(r.Context(), wb.Host.ID)
	if err != nil {
		s.log.Warn("join: host cdn broadcast lookup failed", "host", wb.Host.ID, "error", err)
	}
	isCdnAttendee := cdnBroadcast && !grant.Granted
	var cdnStreamURL string
	if isCdnAttendee {
		cdnStreamURL = s.cdnStreamURL(wb.ID)
		if wb.Status == types.StatusLive {
			go s.startHlsBroadcastIfEnabled(context.Background(), wb, sfu)
		}
	}

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
	}, false, isCdnAttendee, cdnStreamURL)
	if ok {
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
	if wb.Status == types.StatusEnded || wb.Status == types.StatusDraft {
		return &barrier{http.StatusConflict, "not_joinable", "This webinar isn't running."}
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
	if opens := startsAt.Add(-joinGrace); time.Now().Before(opens) {
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
		httpx.Error(w, http.StatusUnauthorized, "invalid_join_key",
			"That join link isn't valid for this webinar.")
		return types.Registration{}, false
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

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "host join: load webinar", err)
		return
	}
	if wb.Status == types.StatusEnded {
		httpx.Error(w, http.StatusConflict, "ended",
			"This webinar has ended. Reopen it from the dashboard to run it again.")
		return
	}

	room := lk.RoomName(slug)
	sfu, _, _, err := s.ensureRoom(r.Context(), wb, room)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	identity := hostIdentity(user.ID)

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

	// Check if HLS broadcast should be active if the session is already live
	if wb.Status == types.StatusLive {
		s.startHlsBroadcastIfEnabled(r.Context(), wb, sfu)
	}

	// Reaching here means stageRole returned host or panelist for a real
	// account, which is the same check the recording endpoints make — so this
	// is the one path that may record. Not gated on s.recordings any more: that
	// only decides whether CLOUD recording works, and local, on-device
	// recording needs no server storage — see AppConfig.CloudRecordingEnabled
	// for the storage half of the question.
	s.issueToken(w, r, wb, sfu, lk.Spec{
		Role:        role,
		Room:        room,
		Identity:    identity,
		Name:        user.Name,
		MutedByHost: muted,
		CoHost:      coHost,
	}, true, false, "")
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

	limit := min(wb.AttendeeLimit, s.cfg.MaxAttendees)
	meta, err := s.roomMetadata(ctx, wb)
	if err != nil {
		return nil, 0, false, err
	}
	size := uint32(limit + stageHeadroom)

	count, known, err := sfu.EnsureRoom(ctx, room, size, emptyTimeoutSec, meta)
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
		count, known, retryErr := moved.EnsureRoom(ctx, room, size, emptyTimeoutSec, meta)
		if retryErr != nil {
			return nil, 0, false, err
		}
		s.log.Info("followed a concurrent failover to another livekit project",
			"slug", wb.ID, "from", project, "to", latest.SFUProject)
		return moved, count, known, nil
	}

	for _, next := range s.sfu.Candidates() {
		if next == project {
			continue
		}
		alt, getErr := s.sfu.Get(next)
		if getErr != nil {
			continue
		}
		altCount, altKnown, altErr := alt.EnsureRoom(ctx, room, size, emptyTimeoutSec, meta)
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
	recording, err := s.store.ActiveRecording(ctx, wb.ID)
	if err != nil {
		// Better to under-claim than to over-claim: a missing indicator is a bug,
		// a false one tells people they are being recorded when they are not.
		s.log.Warn("room metadata: could not read recording state",
			"slug", wb.ID, "error", err)
	}
	b, err := json.Marshal(types.RoomMeta{
		Controls:       wb.Controls,
		Status:         wb.Status,
		Topic:          wb.Topic,
		StartedAt:      wb.StartedAt,
		EndedAt:        wb.EndedAt,
		Recording:      recording,
		MaxDurationMin: wb.MaxDurationMin,
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
	spec lk.Spec, canRecord bool, cdnBroadcast bool, cdnStreamURL string,
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
	httpx.JSON(w, http.StatusOK, types.JoinResponse{
		Token: tok,
		// The project's OWN address, not a global one. This is why the client is threaded
		// all the way down here: a token signed by project B alongside project A's URL is a
		// browser authenticating against a room it is not connected to.
		URL:            sfu.URL(),
		Room:           spec.Room,
		Role:           spec.Role,
		Identity:       spec.Identity,
		DisplayName:    spec.Name,
		CanPublish:     lk.CanPublish(spec.Role),
		Controls:       wb.Controls,
		Topic:          wb.Topic,
		StartedAt:      wb.StartedAt,
		EndedAt:        wb.EndedAt,
		Hidden:         spec.Hidden,
		CanRecord:      canRecord,
		JoinKey:        joinKeyFromIdentity(spec.Identity),
		MaxDurationMin: wb.MaxDurationMin,
		CdnBroadcast:   cdnBroadcast,
		CdnStreamURL:   cdnStreamURL,
	})
	return true
}

func (s *Server) cdnStreamURL(slug string) string {
	return fmt.Sprintf("/api/webinars/%s/broadcast/live.m3u8", slug)
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
