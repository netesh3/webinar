package api

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// maxDurationMin caps a scheduled session at 24 hours. Anything longer is a
// typo, and an uncapped duration makes the "ends at" arithmetic meaningless.
const maxDurationMin = 24 * 60

func (s *Server) handleHostWebinars(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	list, err := s.store.ByHost(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "host webinars", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}

// handleStageWebinars lists sessions this account is a panelist on but does not
// own, so a panelist can find the room without the host sending them a link.
func (s *Server) handleStageWebinars(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	list, err := s.store.OnStageFor(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "stage webinars", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}

func (s *Server) handleHostWebinar(w http.ResponseWriter, r *http.Request) {
	wb, err := s.store.WebinarBySlug(r.Context(), slugFromContext(r.Context()))
	if err != nil {
		s.fail(w, r, "host webinar", err)
		return
	}
	httpx.JSON(w, http.StatusOK, wb)
}

// ------------------------------------------------------------------- create

func (s *Server) handleCreateWebinar(w http.ResponseWriter, r *http.Request) {
	var in types.WebinarInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	in, fields := s.normalizeWebinarInput(in, true)
	if len(fields) > 0 {
		httpx.Fields(w, fields)
		return
	}

	user := userFromContext(r.Context())
	wb, err := s.store.CreateWebinar(r.Context(), user.ID, in)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
		return
	}
	if err != nil {
		s.fail(w, r, "create webinar", err)
		return
	}
	s.log.Info("webinar created", "slug", wb.ID, "host", user.ID, "status", wb.Status)
	httpx.JSON(w, http.StatusCreated, wb)
}

func (s *Server) handleUpdateWebinar(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	var in types.WebinarInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	in, fields := s.normalizeWebinarInput(in, false)
	if len(fields) > 0 {
		httpx.Fields(w, fields)
		return
	}

	wb, err := s.store.UpdateWebinar(r.Context(), slug, in)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
		return
	}
	if err != nil {
		s.fail(w, r, "update webinar", err)
		return
	}

	// A session already running has to hear about changed controls. Best-effort, including
	// the project lookup: the edit is saved either way, and refusing the host's save because
	// the SFU is unreachable would be the wrong trade.
	if sfu, err := s.sfuFor(r.Context(), wb); err != nil {
		s.log.Warn("update webinar: could not resolve the livekit project",
			"slug", wb.ID, "error", err)
	} else {
		s.pushRoomMetadata(r, sfu, wb)
	}
	httpx.JSON(w, http.StatusOK, wb)
}

// ------------------------------------------------------------------- image

// maxWebinarImageBytes caps one upload of a cover image. The client compresses to
// at most 1MB before it gets here — see web/lib/webinar-image.ts — so this is the
// backstop for a client that skipped that step, not the working limit.
const maxWebinarImageBytes = 3 << 20

/* handleUploadWebinarImage stores a webinar's cover image and points the row at it.
 *
 * Bytes go straight into Postgres (see store.SetWebinarImage), not into
 * s.recordings — this deployment runs the API on Cloud Run with recording
 * storage off, because Cloud Run's disk does not survive a cold start. A cover
 * image capped at a megabyte has no such problem living in the database this
 * deployment already depends on being up.
 *
 * The body is the raw, already-compressed image, same convention as chat images:
 * one part, so multipart buys nothing here.
 */
func (s *Server) handleUploadWebinarImage(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	// MaxBytesReader rather than checking Content-Length: a chunked upload has no
	// length to check, and trusting one is how a size cap becomes a promise nobody
	// enforced.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebinarImageBytes+1))
	if err != nil || len(body) > maxWebinarImageBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large",
			fmt.Sprintf("Images must be under %dMB.", maxWebinarImageBytes>>20))
		return
	}
	if len(body) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty", "That upload was empty.")
		return
	}

	// Sniffed rather than trusted from Content-Type: this is stored and served
	// back to every visitor of a public page, so a mislabelled upload is refused
	// here rather than becoming something a browser decides to treat as markup.
	mime, sniffed := sniffImage(body)
	if !sniffed {
		httpx.Error(w, http.StatusUnsupportedMediaType, "bad_image",
			"Images must be PNG, JPEG or WebP.")
		return
	}

	if err := s.store.SetWebinarImage(r.Context(), slug, mime, body); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return
		}
		s.fail(w, r, "webinar image: store", err)
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "webinar image: reload", err)
		return
	}
	httpx.JSON(w, http.StatusOK, wb)
}

// handleDeleteWebinarImage removes a webinar's cover image, returning the webinar
// to having none — the same state a webinar that never had one is in.
func (s *Server) handleDeleteWebinarImage(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	if err := s.store.ClearWebinarImage(r.Context(), slug); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return
		}
		s.fail(w, r, "webinar image: clear", err)
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "webinar image: reload", err)
		return
	}
	httpx.JSON(w, http.StatusOK, wb)
}

/* handleDeleteWebinar removes a webinar and every trace of it.
 *
 * Three kinds of thing have to go, and only the first is automatic:
 *
 *   1. the rows — registrations, chat, polls and their votes, recordings, panelists, stage
 *      grants, custom questions. ON DELETE CASCADE, decided by the schema.
 *   2. the bytes — chat images and recording files in object storage. Nothing cascades into
 *      a filesystem or a bucket, so these are collected before the rows that name them are
 *      gone. Recording files were previously left behind entirely, which on a busy instance
 *      is gigabytes nothing references.
 *   3. the live session — if people are in the room right now, the SFU still has a room and
 *      they are still in it, connected to a webinar that no longer exists.
 *
 * The order is deliberate: room first, then rows, then bytes. Ending the session before the
 * rows go means nobody is holding a token for a webinar mid-delete; deleting the bytes last
 * means a storage failure cannot leave rows pointing at files that are already gone, which is
 * the one direction of inconsistency that shows up in the UI as a broken download.
 */
func (s *Server) handleDeleteWebinar(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	deleted, err := s.deleteWebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "delete webinar", err)
		return
	}

	s.logWebinarDeleted(slug, deleted)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

/* deleteWebinarBySlug is handleDeleteWebinar's body, factored out so the admin
 * panel's "delete any webinar" can do exactly the same three-step teardown
 * (room, then rows, then bytes — see the comment above handleDeleteWebinar for
 * why that order) without a second copy of it to keep in sync. Logging and the
 * HTTP response stay with each caller, since an admin deletion is worth
 * recording as an admin action rather than folding into the same log line a
 * host's own delete produces.
 */
func (s *Server) deleteWebinarBySlug(ctx context.Context, slug string) (store.Deleted, error) {
	/* Close the room first, and only for a webinar that is actually live.
	 *
	 * DeleteRoom on a room that does not exist is not an error worth failing the request
	 * over — the common case by far is a scheduled webinar nobody has opened — so the status
	 * check is a way to keep the log honest rather than a correctness requirement. */
	if wb, err := s.store.WebinarBySlug(ctx, slug); err == nil && wb.Status == types.StatusLive {
		if sfu, err := s.sfuFor(ctx, wb); err != nil {
			s.log.Warn("delete webinar: could not resolve the livekit project",
				"slug", slug, "error", err)
		} else {
			if err := sfu.DeleteRoom(ctx, lk.RoomName(slug)); err != nil {
				// Logged, not fatal. The alternative is refusing to delete a webinar because
				// the SFU is unreachable, which leaves the caller unable to do the one thing
				// they asked for.
				s.log.Warn("delete webinar: could not close the room", "slug", slug, "error", err)
			}
		}
	}

	deleted, err := s.store.DeleteWebinar(ctx, slug)
	if err != nil {
		return deleted, err
	}

	/* The bytes. Every failure is logged individually and none of them fails the caller: the
	 * rows are already gone, so the webinar IS deleted from every point of view that matters,
	 * and returning an error would say otherwise. What is left is a disk-space problem for
	 * whoever reads the logs. */
	if s.recordings != nil {
		for _, key := range deleted.BlobKeys {
			if err := s.recordings.Delete(ctx, key); err != nil {
				deleted.FilesLeftBehind++
				s.log.Warn("delete webinar: file left behind",
					"slug", slug, "key", key, "error", err)
			}
		}
	} else if len(deleted.BlobKeys) > 0 {
		// No storage configured but rows referenced keys. Worth saying out loud.
		deleted.FilesLeftBehind = len(deleted.BlobKeys)
		s.log.Warn("delete webinar: no storage backend, files not removed",
			"slug", slug, "files", len(deleted.BlobKeys))
	}

	return deleted, nil
}

func (s *Server) logWebinarDeleted(slug string, deleted store.Deleted) {
	s.log.Info("webinar deleted",
		"slug", slug, "was", deleted.Status,
		"registrations", deleted.Registrations, "chat_messages", deleted.ChatMessages,
		"polls", deleted.Polls, "poll_votes", deleted.PollVotes,
		"recordings", deleted.Recordings, "panelists", deleted.Panelists,
		"stage_grants", deleted.StageGrants, "questions", deleted.Questions,
		"files", len(deleted.BlobKeys), "files_left_behind", deleted.FilesLeftBehind)
}

/* The display zone a webinar gets when nobody chose one.
 *
 * Not a constant in the config because it is a default, not a policy: a host in another zone
 * picks their own on the form and it is stored per webinar. This is only what happens in its
 * absence — an API client that omitted the field, or a seed row.
 */
const defaultTimeZone = "Asia/Kolkata"

/* localTime renders an instant the way the webinar's audience reads a clock.
 *
 * For error messages that quote a time. "You can join from 19:26 UTC" is technically true and
 * useless to somebody in Bengaluru looking at 00:56 on their own clock: they have to know what
 * UTC is and do the arithmetic before they know whether to wait or come back tomorrow. So the
 * webinar's own display zone is used, and its abbreviation (IST, EDT) is printed so the reader
 * can tell it is not their zone if it isn't.
 *
 * An empty or unknown zone falls back to defaultTimeZone rather than to UTC, matching what the
 * webinar was created with. `time.LoadLocation` reads the embedded tzdata in the API image.
 */
func localTime(at time.Time, zone string) string {
	if zone == "" {
		zone = defaultTimeZone
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		if loc, err = time.LoadLocation(defaultTimeZone); err != nil {
			// Neither zone is loadable, which means no tzdata at all. UTC beats no answer.
			return at.UTC().Format("15:04 on 2 January 2006") + " UTC"
		}
	}
	return at.In(loc).Format("15:04 on 2 January 2006 MST")
}

/* normalizeWebinarInput fills defaults, clamps limits and reports field errors.
 *
 * Clamping rather than rejecting where a value is merely out of range: a host
 * who types 5000 attendees means "as many as possible", and failing the whole
 * form over it teaches them nothing the clamped value doesn't.
 *
 * `isCreate` gates the one check that must NOT apply to an edit: a brand new
 * scheduled webinar starting in the past is always a mistake — a stale date left
 * over from a copy-paste, or a timezone picked wrong — and there is no cost to
 * refusing it before it exists. An EXISTING webinar can legitimately have a past
 * startsAt (it ran, or it is a draft nobody has gotten back to), and a host
 * fixing an unrelated typo on one must not be blocked by a date they did not
 * touch. Drafts are exempt even on create: a draft is not a commitment to run at
 * that instant, and it is normal to sketch one out before picking a real time.
 */
func (s *Server) normalizeWebinarInput(in types.WebinarInput, isCreate bool) (types.WebinarInput, map[string]string) {
	fields := map[string]string{}

	in.Topic = strings.TrimSpace(in.Topic)
	if in.Topic == "" {
		fields["topic"] = "Required."
	} else if len(in.Topic) > 200 {
		fields["topic"] = "Keep the topic under 200 characters."
	}

	var startsAt time.Time
	if strings.TrimSpace(in.StartsAt) == "" {
		fields["startsAt"] = "Pick a date and time."
	} else if parsed, err := time.Parse(time.RFC3339, in.StartsAt); err != nil {
		fields["startsAt"] = "That date and time couldn't be read."
	} else {
		startsAt = parsed
	}

	switch {
	case in.Duration <= 0:
		fields["durationMin"] = "Pick how long it runs."
	case in.Duration > maxDurationMin:
		fields["durationMin"] = "A session can't be longer than 24 hours."
	}

	/* The zone a webinar's times are DISPLAYED in, which is not where they are stored.
	 *
	 * `webinars.starts_at` is `timestamptz`, so Postgres holds a UTC instant whatever is
	 * written to it — the zone below never changes the moment, only how it is rendered. Two
	 * separate things that are easy to conflate: the instant is absolute, the zone is a
	 * presentation choice belonging to whoever scheduled it.
	 *
	 * Defaults to Asia/Kolkata rather than UTC. A default is only ever right for somebody, and
	 * UTC is right for nobody who is actually attending: it made a webinar created through the
	 * API render five and a half hours away from when it happens. An unknown IANA zone stays a
	 * field error rather than a silent fallback, because silently rendering the wrong hour is
	 * worse than refusing the form.
	 */
	if in.TimeZone = strings.TrimSpace(in.TimeZone); in.TimeZone == "" {
		in.TimeZone = defaultTimeZone
	} else if _, err := time.LoadLocation(in.TimeZone); err != nil {
		fields["timeZone"] = "That isn't a recognised time zone."
	}

	switch in.Kind {
	case types.KindLive, types.KindSimulive, types.KindRecurring:
	case "":
		in.Kind = types.KindLive
	default:
		fields["kind"] = "Pick live, simulive or a recurring series."
	}

	switch in.Status {
	case types.StatusScheduled, types.StatusDraft:
	case "":
		in.Status = types.StatusScheduled
	default:
		// live/ended are reached through start and end, which have SFU side
		// effects. Letting a form set them would leave a room behind.
		fields["status"] = "A webinar can only be saved as scheduled or a draft."
	}

	/* A brand new scheduled webinar starting in the past is always a mistake — a
	 * stale date left over from a copy-paste, or a timezone picked wrong — and
	 * there is no cost to refusing it before it exists.
	 *
	 * isCreate: an EXISTING webinar can legitimately have a past startsAt (it
	 * ran, or it is a draft nobody has gotten back to), and a host fixing an
	 * unrelated typo on one must not be blocked by a date they did not touch.
	 *
	 * status == scheduled: a draft is not a commitment to run at that instant,
	 * so it is normal to sketch one out before picking a real time — this only
	 * bites the moment somebody actually schedules it.
	 *
	 * fields["startsAt"] == "": skipped when the date was already rejected above
	 * (empty or unparsable) so this does not overwrite that message with a less
	 * useful one about a zero time.Time being "in the past". */
	if isCreate && in.Status == types.StatusScheduled &&
		fields["startsAt"] == "" && startsAt.Before(time.Now()) {
		fields["startsAt"] = "Pick a date and time that hasn't already passed."
	}

	switch in.Approval {
	case types.ApprovalAutomatic, types.ApprovalManual:
	case "":
		in.Approval = types.ApprovalAutomatic
	default:
		fields["approval"] = "Approval is either automatic or manual."
	}

	/* An omitted limit gets the DEFAULT, not the ceiling.
	 *
	 * This was s.cfg.MaxAttendees, so a request that said nothing about seats was given every
	 * seat the server has. The scheduling form now offers 50/100/200/300/400/500 and defaults
	 * to 50; this keeps an API caller that omits the field on the same footing rather than
	 * silently more generous than the UI.
	 */
	if in.AttendeeLimit <= 0 {
		in.AttendeeLimit = s.cfg.DefaultAttendeeLimit
	}
	/* Belt and braces. Config validation refuses a DefaultAttendeeLimit below 1, so this
	 * cannot fire from a loaded config — but a Config built by hand (the tests do) would
	 * otherwise write attendee_limit 0 and produce a webinar that refuses its first
	 * registrant, which is a confusing way to learn about a zero value. */
	if in.AttendeeLimit <= 0 {
		in.AttendeeLimit = 1
	}
	/* Still clamped, and a clamp rather than a 422 on purpose: the ceiling is the operator's
	 * business, and a coach asking for 600 seats wants a webinar, not a validation error. */
	in.AttendeeLimit = min(in.AttendeeLimit, s.cfg.MaxAttendees)

	if len(in.Passcode) > 32 {
		fields["passcode"] = "Keep the passcode under 32 characters."
	}
	if len(in.CustomQuestions) > 20 {
		fields["customQuestions"] = "Twenty questions is the most a registration form can carry."
	}
	for _, email := range in.PanelistEmails {
		if e := strings.TrimSpace(email); e != "" {
			if _, err := mail.ParseAddress(e); err != nil {
				fields["panelistEmails"] = fmt.Sprintf("%q isn't an email address.", e)
				break
			}
		}
	}

	return in, fields
}

// ------------------------------------------------------------- start and end

// handleStartWebinar moves the webinar live and makes the SFU room exist before
// the host's browser tries to connect, so the first attendee never races room
// creation.
func (s *Server) handleStartWebinar(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	wb, err := s.store.SetStatus(r.Context(), slug, types.StatusLive)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "start webinar", err)
		return
	}

	room := lk.RoomName(slug)
	sfu, _, _, err := s.ensureRoom(r.Context(), wb, room)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	// EnsureRoom only carries metadata when it creates the room, so an existing
	// room needs the update pushed explicitly.
	s.pushRoomMetadata(r, sfu, wb)

	s.log.Info("webinar started", "slug", slug, "room", room)
	httpx.JSON(w, http.StatusOK, wb)
}

// handleTransferHost hands a live session to another panelist already in the room.
//
// Ownership moves in Postgres so host endpoints (end, mute-all, controls) keep
// working for the new host; LiveKit roles move so everyone else sees the right
// label without a reconnect. The previous host becomes a panelist and is expected
// to leave from the client after this call succeeds.
func (s *Server) handleTransferHost(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	user := userFromContext(r.Context())

	var body types.TransferHostRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	identity := strings.TrimSpace(body.Identity)
	toID, ok := strings.CutPrefix(identity, "user_")
	if !ok || toID == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_panelist",
			"Pick a panelist who is signed in on the stage. Audience seats cannot take over as host.")
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
		httpx.Error(w, http.StatusConflict, "not_live",
			"Host can only be handed off while the webinar is live.")
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
		p := &list[i]
		if p.Identity != identity {
			continue
		}
		target = p
		break
	}
	if target == nil {
		httpx.Error(w, http.StatusNotFound, "not_in_room",
			"That person has left the webinar.")
		return
	}
	// Role is enough: a muted panelist still owns a stage seat and can take over.
	// Requiring CanPublish hid exactly those people from the Leave picker (and
	// would 422 here after we listed them). SetRole below restores host grants.
	if target.Role != types.RolePanelist {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_on_stage",
			"Only a panelist already on the stage can take over as host.")
		return
	}

	if _, err := s.store.UserByID(r.Context(), toID); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_panelist",
			"That account is no longer available.")
		return
	} else if err != nil {
		s.fail(w, r, "transfer host: load target", err)
		return
	}

	if err := s.store.TransferHost(r.Context(), slug, user.ID, toID); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	} else if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_a_panelist",
			"Pick someone who is already a panelist on this webinar.")
		return
	} else if err != nil {
		s.fail(w, r, "transfer host", err)
		return
	}

	// Host endpoints require can_host. A guest speaker invited as a panelist often
	// does not have it yet; granting it here is what makes mute-all / end work for
	// them after they take over, without an admin round-trip mid-session.
	if targetUser, err := s.store.UserByID(r.Context(), toID); err == nil && !targetUser.CanHost {
		if _, err := s.store.SetHostCapability(r.Context(), toID, true); err != nil {
			s.log.Warn("transfer host: could not grant hosting capability",
				"slug", slug, "user", toID, "error", err)
		}
	}

	fromIdentity := hostIdentity(user.ID)
	if err := sfu.SetRole(r.Context(), lk.Spec{
		Role:     types.RoleHost,
		Room:     room,
		Identity: identity,
		Name:     target.Name,
	}); err != nil && !errors.Is(err, lk.ErrNotInRoom) {
		s.log.Warn("transfer host: could not promote new host in the room",
			"slug", slug, "identity", identity, "error", err)
	}
	if err := sfu.SetRole(r.Context(), lk.Spec{
		Role:     types.RolePanelist,
		Room:     room,
		Identity: fromIdentity,
		Name:     user.Name,
	}); err != nil && !errors.Is(err, lk.ErrNotInRoom) {
		s.log.Warn("transfer host: could not demote previous host in the room",
			"slug", slug, "identity", fromIdentity, "error", err)
	}

	wb, err = s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "transfer host: reload webinar", err)
		return
	}
	s.log.Info("host transferred", "slug", slug, "from", user.ID, "to", toID)
	httpx.JSON(w, http.StatusOK, wb)
}

// handleEndWebinar ends the session for everyone.
//
// Deleting the room is the point: disconnecting the host alone would leave the
// audience watching a dead stage, waiting for them to come back.
func (s *Server) handleEndWebinar(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	wb, err := s.store.SetStatus(r.Context(), slug, types.StatusEnded)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "end webinar", err)
		return
	}

	if sfu, err := s.sfuFor(r.Context(), wb); err != nil {
		s.log.Warn("end webinar: could not resolve the livekit project",
			"slug", slug, "error", err)
	} else if err := sfu.DeleteRoom(r.Context(), lk.RoomName(slug)); err != nil {
		// The database already says ended, which is the state that decides
		// whether anyone can rejoin. A room that outlives it empties itself
		// after empty_timeout, so this is a warning rather than a failure.
		s.log.Warn("end webinar: could not delete room", "slug", slug, "error", err)
	}
	// Promotions are scoped to one session.
	if err := s.store.ClearStageGrants(r.Context(), slug); err != nil {
		s.log.Warn("end webinar: could not clear stage grants", "slug", slug, "error", err)
	}
	// The room is gone, so no more chunks are coming. Closing the recording here
	// is what turns "recording" into a file somebody can download, rather than a
	// row stuck open until the staleness sweep notices.
	if err := s.store.FinishActiveRecordings(r.Context(), slug); err != nil {
		s.log.Warn("end webinar: could not finalise recordings", "slug", slug, "error", err)
	}
	// A poll left open on a room nobody is in would still be accepting votes, and
	// its tally would still be labelled provisional when it is in fact the result.
	if err := s.store.CloseOpenPolls(r.Context(), slug); err != nil {
		s.log.Warn("end webinar: could not close open polls", "slug", slug, "error", err)
	}
	/* The chat archive.
	 *
	 * There is nothing to move. Messages are written to Postgres as they are sent, so
	 * ending a session does not migrate a transcript out of a cache — it closes one that
	 * was already permanent. What happens here is that the summary is logged, which is
	 * the line an operator looks for when asked whether a session's chat was kept.
	 *
	 * This is the step a Redis-backed design would have to get right, and the reason
	 * there is no Redis: a flush that failed here would lose the whole conversation, and
	 * it would fail exactly when the process was going down.
	 */
	if stats, err := s.store.ChatStats(r.Context(), slug); err != nil {
		s.log.Warn("end webinar: could not summarise chat", "slug", slug, "error", err)
	} else {
		s.log.Info("chat archived",
			"slug", slug, "messages", stats.Messages, "images", stats.Images,
			"senders", stats.Senders, "media_bytes", stats.MediaBytes,
			"to_panelists", stats.ToPanelists)
	}

	s.log.Info("webinar ended", "slug", slug)
	httpx.JSON(w, http.StatusOK, wb)
}

// --------------------------------------------------------------- controls

// handleUpdateControls is the host's in-session control panel.
//
// Two things happen for every change: the new state is persisted so it applies
// to whoever joins next, and it is pushed into room metadata so the browsers
// already connected react immediately. Hiding attendees needs a third step,
// because permissions of people already in the room have to be rewritten too.
func (s *Server) handleUpdateControls(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	var p types.ControlsPatch
	if err := httpx.DecodeJSON(w, r, &p); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	// Refused rather than coerced. A destination we don't recognise would fall
	// through to the widest audience, which is the wrong way for this particular
	// setting to fail: the host asked to narrow who sees attendee chat, and
	// quietly broadcasting it instead is worse than a 400.
	if p.ChatDestination != nil && !p.ChatDestination.Valid() {
		httpx.Fields(w, map[string]string{
			"chatDestination": "Must be everyone or panelists.",
		})
		return
	}

	wb, err := s.store.UpdateControls(r.Context(), slug, p)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "update controls", err)
		return
	}

	room := lk.RoomName(slug)

	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	// Visibility is enforced by the SFU per participant, so flipping it
	// mid-session has to reach the attendees who are already connected.
	// Without this the toggle would only apply to future joins.
	if p.HideAttendees != nil {
		changed, err := sfu.HideAll(r.Context(), room, types.RoleAttendee, *p.HideAttendees)
		if err != nil {
			s.log.Warn("update controls: hide attendees partially applied",
				"slug", slug, "changed", changed, "error", err)
		} else if changed > 0 {
			s.log.Info("attendee visibility changed",
				"slug", slug, "hidden", *p.HideAttendees, "participants", changed)
		}
	}

	s.pushRoomMetadata(r, sfu, wb)
	httpx.JSON(w, http.StatusOK, wb)
}

// pushRoomMetadata mirrors session state to every connected client. Best-effort:
// the database is the source of truth, and a client that misses the broadcast
// picks the state up on its next join.
//
// Takes the resolved client rather than resolving one, because every caller has just done that
// to perform the action this is announcing — and pushing metadata to a different project than
// the one the action landed on would be worse than not pushing it at all.
func (s *Server) pushRoomMetadata(r *http.Request, sfu RoomManager, wb types.Webinar) {
	meta, err := s.roomMetadata(r.Context(), wb)
	if err != nil {
		s.log.Warn("could not encode room metadata", "slug", wb.ID, "error", err)
		return
	}
	if err := sfu.SetMetadata(r.Context(), lk.RoomName(wb.ID), meta); err != nil {
		s.log.Warn("could not push room metadata", "slug", wb.ID, "error", err)
	}
}

// ----------------------------------------------------------- participants

func (s *Server) handleParticipants(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "participants: load webinar", err)
		return
	}

	// From the SFU's server API, which includes hidden attendees. The host's own
	// browser cannot see them — that is what hiding means — so moderating the
	// people they hid has to be answered from here.
	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	list, err := sfu.Participants(r.Context(), lk.RoomName(slug))
	if err != nil {
		s.fail(w, r, "participants", err)
		return
	}

	attendees, onStage := 0, 0
	for _, p := range list {
		if p.Role == types.RoleAttendee {
			attendees++
		} else {
			onStage++
		}
	}

	httpx.JSON(w, http.StatusOK, types.LiveRoom{
		Room:         lk.RoomName(slug),
		Status:       wb.Status,
		Controls:     wb.Controls,
		Participants: list,
		Attendees:    attendees,
		OnStage:      onStage,
	})
}

// handleMuteAll mutes every microphone in the room except the host's own.
//
// The host is exempt because muting yourself with a "mute everyone" button is
// the kind of surprise that ends with someone presenting in silence.
func (s *Server) handleMuteAll(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	user := userFromContext(r.Context())

	room := lk.RoomName(slug)
	keep := map[string]bool{hostIdentity(user.ID): true}

	sfu, err := s.sfuForSlug(r.Context(), slug)
	if err != nil {
		s.failSFU(w, r, types.Webinar{ID: slug}, err)
		return
	}

	muted, err := sfu.MuteAll(r.Context(), room, keep)
	if err != nil {
		// A partial result is still worth reporting: some participants may have
		// left mid-loop, and the ones that were muted stay muted.
		s.log.Warn("mute all partially applied", "slug", slug, "muted", muted, "error", err)
	}

	// Take the microphone out of every speaker's grant as well. The room-wide
	// self-unmute control below covers scheduled panelists, but an attendee the
	// host allowed to speak holds an individual grant that overrides it — without
	// this, they are the one person "mute everyone" does not apply to.
	if blocked, err := sfu.BlockSpeakingAll(r.Context(), room, keep); err != nil {
		s.log.Warn("mute all: speaking latch partially applied",
			"slug", slug, "blocked", blocked, "error", err)
	}
	// Persisted for the promoted attendees, who hold a grant. A scheduled panelist
	// needs no row here: mute-on-entry and the self-unmute switch below are both
	// latched off room-wide, so they come back muted and stay that way.
	if err := s.store.MuteAllGrants(r.Context(), slug); err != nil {
		s.log.Warn("mute all: could not persist speaking latches", "slug", slug, "error", err)
	}

	// Latch the room into mute-on-entry so somebody joining ten seconds later
	// does not arrive live. Without this, "mute all" only means "mute the people
	// who happen to be here".
	off := false
	if _, err := s.store.UpdateControls(r.Context(), slug, types.ControlsPatch{
		MuteOnEntry: boolPtr(true),
		AllowUnmute: &off,
	}); err != nil {
		s.log.Warn("mute all: could not latch mute-on-entry", "slug", slug, "error", err)
	} else if wb, err := s.store.WebinarBySlug(r.Context(), slug); err == nil {
		s.pushRoomMetadata(r, sfu, wb)
	}

	s.log.Info("mute all", "slug", slug, "muted", muted)
	httpx.JSON(w, http.StatusOK, types.MuteAllResponse{Muted: muted})
}

// handleAllowAllToSpeak is handleSetStage's "allow to speak" grant (mic and
// screen share, no camera) applied to every attendee in the room at once,
// for a host who wants the whole audience able to jump in rather than
// promoting people one at a time. Anyone already a panelist — scheduled or
// previously promoted — is left untouched; see AllowAllToSpeak.
func (s *Server) handleAllowAllToSpeak(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "allow all: load webinar", err)
		return
	}

	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	granted, err := sfu.AllowAllToSpeak(r.Context(), lk.RoomName(slug), wb.Controls.HideAttendees)
	if err != nil {
		// A partial result is still worth reporting — see handleMuteAll's own
		// reasoning: some attendees may have left mid-loop, and the ones already
		// granted stay granted.
		s.log.Warn("allow all partially applied", "slug", slug, "granted", len(granted), "error", err)
	}

	// Persisted so each promotion survives a reconnect, same as a single "allow
	// to speak" does. Best-effort per identity, same reasoning as handleSetStage:
	// the live grant already landed and is not worth failing the host's click
	// over.
	for _, identity := range granted {
		if err := s.store.GrantStage(r.Context(), slug, identity, "", true); err != nil {
			s.log.Warn("allow all: could not record grant",
				"slug", slug, "identity", identity, "error", err)
		}
	}

	s.log.Info("allow all to speak", "slug", slug, "granted", len(granted))
	httpx.JSON(w, http.StatusOK, types.StageAllResponse{Count: len(granted)})
}

// handleRevokeAllSpeaking sends every attendee the host had promoted back to
// the audience in one pass — the bulk mirror of "Remove speaker permission".
// Scheduled panelists are not touched; see RevokeAllSpeaking.
func (s *Server) handleRevokeAllSpeaking(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "revoke all: load webinar", err)
		return
	}

	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	revoked, err := sfu.RevokeAllSpeaking(r.Context(), lk.RoomName(slug), wb.Controls.HideAttendees)
	if err != nil {
		s.log.Warn("revoke all partially applied", "slug", slug, "revoked", len(revoked), "error", err)
	}

	// Every row in webinar_stage_grants for this slug IS a host-granted
	// promotion — a scheduled panelist has no row there at all — so clearing
	// the whole table is the bulk equivalent of RevokeStage per identity, not
	// an approximation of it.
	if err := s.store.ClearStageGrants(r.Context(), slug); err != nil {
		s.log.Warn("revoke all: could not clear grants", "slug", slug, "error", err)
	}

	s.log.Info("revoke all speaking", "slug", slug, "revoked", len(revoked))
	httpx.JSON(w, http.StatusOK, types.StageAllResponse{Count: len(revoked)})
}

// handleMuteOne mutes one participant, or lets them speak again.
//
// Muting is two operations, and both are needed. MuteTrack silences the audio
// they are sending right now; the latch stops them sending any more. With only the
// first, the participant clicks unmute half a second later and the host's action
// meant nothing — which is what this endpoint used to do.
//
// Unmuting reverses it: lift the latch first, because a participant with no
// microphone in their grant has no track to unmute.
func (s *Server) handleMuteOne(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	identity := chi.URLParam(r, "identity")

	var body types.MutePatch
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	source, ok := lk.SourceFor("microphone")
	if !ok {
		s.fail(w, r, "mute one", fmt.Errorf("microphone source unmapped"))
		return
	}
	room := lk.RoomName(slug)

	sfu, err := s.sfuForSlug(r.Context(), slug)
	if err != nil {
		s.failSFU(w, r, types.Webinar{ID: slug}, err)
		return
	}

	if !body.Muted {
		// Restore the permission before touching the track.
		if err := s.setSpeaking(r, sfu, slug, identity, false); err != nil &&
			!errors.Is(err, lk.ErrIsHost) {
			s.speakingError(w, r, "unmute one", err)
			return
		}
		err := sfu.MuteTrack(r.Context(), room, identity, source, false)
		switch {
		case errors.Is(err, lk.ErrNotInRoom):
			httpx.Error(w, http.StatusNotFound, "not_in_room", "That person has left the webinar.")
			return
		case errors.Is(err, lk.ErrNoTrack), errors.Is(err, lk.ErrRemoteUnmute):
			// Their permission is back, but only their own browser can open a
			// microphone: either there is no track to switch on, or the SFU refuses
			// to switch one on from the server — which is a protection worth
			// keeping. Both are a success with one more step, not a failure.
			s.log.Info("participant may speak again", "slug", slug, "identity", identity)
			httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "allowed"})
			return
		case err != nil:
			s.fail(w, r, "unmute one", err)
			return
		}
		s.log.Info("participant unmuted", "slug", slug, "identity", identity)
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
		return
	}

	// Silence what is live now. Missing permission or a missing track are both
	// already the requested outcome, so neither is an error worth reporting.
	if err := sfu.MuteTrack(r.Context(), room, identity, source, true); err != nil {
		if errors.Is(err, lk.ErrNotInRoom) {
			httpx.Error(w, http.StatusNotFound, "not_in_room", "That person has left the webinar.")
			return
		}
		s.fail(w, r, "mute one", err)
		return
	}
	// A host muting their own microphone from the roster needs no latch: the track
	// mute above is the whole action, and they can turn it back on themselves.
	if err := s.setSpeaking(r, sfu, slug, identity, true); err != nil &&
		!errors.Is(err, lk.ErrIsHost) {
		s.speakingError(w, r, "mute one", err)
		return
	}

	s.log.Info("participant muted", "slug", slug, "identity", identity)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// setSpeaking applies the latch to the live connection and to the record that
// survives a reconnect. The live change is the one that has to succeed; a failure
// to persist would only mean the latch is lost if they reload, which is not worth
// failing the host's click over.
func (s *Server) setSpeaking(
	r *http.Request, sfu RoomManager, slug, identity string, blocked bool,
) error {
	if err := sfu.SetSpeaking(r.Context(), lk.RoomName(slug), identity, blocked); err != nil {
		return err
	}
	if err := s.store.SetGrantMuted(r.Context(), slug, identity, blocked); err != nil {
		s.log.Warn("could not persist speaking latch",
			"slug", slug, "identity", identity, "blocked", blocked, "error", err)
	}
	return nil
}

func (s *Server) speakingError(w http.ResponseWriter, r *http.Request, op string, err error) {
	switch {
	case errors.Is(err, lk.ErrNotInRoom):
		httpx.Error(w, http.StatusNotFound, "not_in_room", "That person has left the webinar.")
	case errors.Is(err, lk.ErrNotSpeaking):
		httpx.Error(w, http.StatusConflict, "not_speaking",
			"They aren't on the stage, so there is no microphone to change. Allow them to speak first.")
	default:
		s.fail(w, r, op, err)
	}
}

// handleSetStage promotes an attendee to the stage or sends them back.
//
// LiveKit applies the permission change to the live connection, so the person
// gains or loses their publish controls without rejoining. The grant is also
// recorded, so a promoted attendee who reconnects comes back on stage.
func (s *Server) handleSetStage(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	identity := chi.URLParam(r, "identity")

	var body types.StageRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	switch body.Role {
	case types.RolePanelist, types.RoleAttendee:
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_role",
			"Role must be panelist or attendee.")
		return
	}

	// Refuse to demote the owner. Their token carries RoomAdmin, so stripping
	// publish permission would leave a host who can moderate but not present.
	if strings.HasPrefix(identity, "user_") {
		httpx.Error(w, http.StatusUnprocessableEntity, "not_an_attendee",
			"Panelists and hosts are managed from the webinar's panelist list, not here.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "set stage: load webinar", err)
		return
	}

	// Promoting someone has to un-hide them: the audience would otherwise hear a
	// voice coming from an empty tile.
	promoting := body.Role == types.RolePanelist
	audioOnly := promoting && body.AudioOnly
	room := lk.RoomName(slug)

	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	// Removing speaker permission mutes them on the way out. Revoking the
	// permission drops their tracks by itself, but muting first means the audience
	// stops hearing them at the moment the host clicks rather than whenever the
	// unpublish lands.
	if !promoting {
		if source, ok := lk.SourceFor("microphone"); ok {
			if err := sfu.MuteTrack(r.Context(), room, identity, source, true); err != nil &&
				!errors.Is(err, lk.ErrNotInRoom) && !errors.Is(err, lk.ErrNoTrack) {
				s.log.Warn("set stage: could not mute on the way out",
					"slug", slug, "identity", identity, "error", err)
			}
		}
	}

	// A promotion always comes with a microphone: it is the host saying this person
	// may speak, which is exactly what lifts an earlier mute.
	err = sfu.SetRole(r.Context(), lk.Spec{
		Role:        body.Role,
		Room:        room,
		Identity:    identity,
		Hidden:      lk.HiddenFor(body.Role, wb.Controls.HideAttendees),
		AudioOnly:   audioOnly,
		MutedByHost: false,
		// The host choosing this person overrides the room-wide self-unmute switch
		// for them. Without it, bringing somebody on stage after "mute everyone"
		// gave them a camera and a microphone button that did nothing.
		Promoted: promoting,
	})
	if errors.Is(err, lk.ErrNotInRoom) {
		httpx.Error(w, http.StatusNotFound, "not_in_room", "That person has left the webinar.")
		return
	}
	if err != nil {
		s.fail(w, r, "set stage", err)
		return
	}

	if promoting {
		err = s.store.GrantStage(r.Context(), slug, identity, "", audioOnly)
	} else {
		err = s.store.RevokeStage(r.Context(), slug, identity)
	}
	if err != nil {
		// The live change already landed; only the survives-a-reconnect part
		// failed, which is not worth failing the host's click over.
		s.log.Warn("set stage: could not record grant",
			"slug", slug, "identity", identity, "error", err)
	}

	s.log.Info("stage change", "slug", slug, "identity", identity,
		"role", body.Role, "audio_only", audioOnly)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

func (s *Server) handleRemoveParticipant(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	identity := chi.URLParam(r, "identity")

	sfu, err := s.sfuForSlug(r.Context(), slug)
	if err != nil {
		s.failSFU(w, r, types.Webinar{ID: slug}, err)
		return
	}

	if err := sfu.RemoveParticipant(r.Context(), lk.RoomName(slug), identity); err != nil {
		if errors.Is(err, lk.ErrNotInRoom) {
			// Already gone is the requested end state.
			httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "removed"})
			return
		}
		s.fail(w, r, "remove participant", err)
		return
	}
	// Removing someone who was promoted should not let them return to the stage
	// by rejoining with the same key.
	if err := s.store.RevokeStage(r.Context(), slug, identity); err != nil {
		s.log.Warn("remove participant: could not revoke stage grant",
			"slug", slug, "identity", identity, "error", err)
	}

	s.log.Info("participant removed", "slug", slug, "identity", identity)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "removed"})
}

// ----------------------------------------------------------- registrants

func (s *Server) handleHostRegistrants(w http.ResponseWriter, r *http.Request) {
	rows, err := s.store.Registrants(r.Context(), slugFromContext(r.Context()), 500)
	if err != nil {
		s.fail(w, r, "registrants", err)
		return
	}
	httpx.JSON(w, http.StatusOK, rows)
}

// handleExportRegistrants streams the registration list as CSV.
//
// Written straight to the response rather than buffered: a 500-row export is
// small, but the streaming shape is the one that stays correct when a host with
// a year of webinars asks for all of them.
func (s *Server) handleExportRegistrants(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	rows, err := s.store.Registrants(r.Context(), slug, 500)
	if err != nil {
		s.fail(w, r, "export registrants", err)
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s-registrants.csv"`, slug))

	cw := csv.NewWriter(w)
	// `phone` after `email`, because the two contact columns belong together — a host opening
	// this in a spreadsheet is looking for how to reach somebody.
	// `guest` last, and present even when there are none: a column that appears and
	// disappears depending on the data breaks whatever the host built on top of this export.
	_ = cw.Write([]string{
		"name", "email", "phone", "company", "job title", "state", "registered at",
		"has account", "guest",
	})
	for _, row := range rows {
		/* The number is prefixed with a tab.
		 *
		 * Excel and Sheets both read a bare `+919876543210` as a formula or a number and
		 * mangle it — the plus is an operator and the leading digits lose their zeros. A
		 * leading tab makes it text in both, and is invisible in every other consumer. This
		 * is the difference between an export a host can dial from and one they cannot. */
		phone := row.Phone
		if phone != "" {
			phone = "\t" + phone
		}
		_ = cw.Write([]string{
			row.Name, row.Email, phone, row.Company, row.JobTitle,
			string(row.State), row.CreatedAt, fmt.Sprint(row.HasAccount),
			fmt.Sprint(row.IsGuest),
		})
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		// Headers are already sent, so this can only be logged.
		s.log.Error("export registrants: write failed", "slug", slug, "error", err)
	}
}

func (s *Server) handleApproveAll(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	n, err := s.store.ApproveAllPending(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "approve all", err)
		return
	}
	s.log.Info("approved all pending", "slug", slug, "count", n)
	httpx.JSON(w, http.StatusOK, types.MuteAllResponse{Muted: n})
}

// handleSetRegistrationState is not under requireOwnership: the registration id
// is the only thing in the URL, so it looks up the webinar and checks ownership
// itself before mutating anything.
func (s *Server) handleSetRegistrationState(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var body struct {
		State types.RegistrationState `json:"state"`
	}
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	switch body.State {
	case types.RegApproved, types.RegDeclined, types.RegPending:
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_state",
			"State must be approved, declined or pending.")
		return
	}

	// Authorize BEFORE mutating: confirm this registration belongs to a webinar
	// the caller hosts.
	slug, err := s.store.WebinarSlugForRegistration(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such registration.")
		return
	}
	if err != nil {
		s.fail(w, r, "registration lookup", err)
		return
	}
	if !s.ownsWebinar(w, r, slug) {
		return
	}

	if _, err := s.store.SetRegistrationState(r.Context(), id, body.State); err != nil {
		s.fail(w, r, "set registration state", err)
		return
	}
	s.log.Info("registration state changed", "id", id, "state", body.State)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// ------------------------------------------------------------- panelists

func (s *Server) handleAddPanelist(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	var body types.PanelistRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	email := strings.TrimSpace(body.Email)
	if _, err := mail.ParseAddress(email); err != nil {
		httpx.Fields(w, map[string]string{"email": "That doesn't look like an email address."})
		return
	}

	person, err := s.store.AddPanelist(r.Context(), slug, email)
	if errors.Is(err, store.ErrNotFound) {
		// A panelist needs an account, because a panelist publishes and the
		// publish token is minted from a session.
		httpx.Fields(w, map[string]string{
			"email": "Nobody with that address has an account yet. Ask them to sign up first.",
		})
		return
	}
	if err != nil {
		s.fail(w, r, "add panelist", err)
		return
	}
	s.log.Info("panelist added", "slug", slug, "user", person.ID)
	httpx.JSON(w, http.StatusOK, person)
}

func (s *Server) handleRemovePanelist(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	userID := chi.URLParam(r, "userID")

	if err := s.store.RemovePanelist(r.Context(), slug, userID); err != nil {
		s.fail(w, r, "remove panelist", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "removed"})
}

// ownsWebinar writes the error response itself and reports whether to continue.
// Used by the handlers that are not under requireOwnership because their URL
// does not carry a slug.
func (s *Server) ownsWebinar(w http.ResponseWriter, r *http.Request, slug string) bool {
	user := userFromContext(r.Context())
	hostID, err := s.store.HostIDFor(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return false
	}
	if err != nil {
		s.fail(w, r, "ownership check", err)
		return false
	}
	if hostID != user.ID {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return false
	}
	return true
}

func boolPtr(b bool) *bool { return &b }
