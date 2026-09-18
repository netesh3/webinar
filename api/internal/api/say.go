package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The realtime relay: an attendee's half of chat, Q&A, hands and reactions.
 *
 * Everything the audience sends passes through here, because attendee tokens
 * carry canPublishData=false and the SFU drops a packet they try to publish
 * themselves. Three things follow from that, and they are the reason the endpoint
 * exists rather than being a round trip we could have avoided:
 *
 *   1. The RECIPIENTS are chosen here. An attendee's chat goes wherever the
 *      host's chat_destination says, and the SFU is handed that list — so a
 *      panelists-only message is never sent to the audience's browsers at all.
 *      Nothing is left to a receiving client to filter out.
 *
 *   2. The SENDER is stamped here, from the credential. `from` used to be
 *      whatever the sending browser wrote, which meant an attendee could label
 *      themselves Host in everybody's chat.
 *
 *   3. chatEnabled, qaEnabled, raiseHandEnabled and reactionsEnabled become real.
 *      They were previously enforced by the sender's own UI, so turning chat off
 *      stopped the compose box appearing and stopped nothing else.
 *
 * The host and the panelists still publish straight onto the data channel: they
 * are the stage, a panelists-only message is addressed to them by definition, and
 * their messages should not wait on an HTTP round trip. This endpoint accepts them
 * too, as a fallback, and honours the destination they ask for.
 */

// dataTopic must match DATA_TOPIC in web/lib/realtime.ts. Packets on other topics
// are ignored by the receiving end.
const dataTopic = "webcast"

// pollsChangedKind tells the room to re-read its polls. Not in RoomMessageKind
// because no client may ever send it: it is the server announcing a host action, and
// the audience's copy of a poll differs from the host's — see announcePolls.
const pollsChangedKind types.RoomMessageKind = "polls-changed"

// attendeeJoinedKind tells the host someone from the audience just joined. Not in
// RoomMessageKind for the same reason as pollsChangedKind: it is the server
// announcing an event only it can observe (the join endpoint), addressed to the
// host alone — see announceAttendeeJoined in join.go.
const attendeeJoinedKind types.RoomMessageKind = "joined"

// chatDeletedKind tells every client to remove one message. Not in RoomMessageKind
// for the same reason as pollsChangedKind: it is the server announcing a
// moderation action, never something a client may claim happened itself — see
// handleDeleteChat in chat.go. Carries the deleted message's id in wirePacket.ID,
// the same field a chat message's own id already travels in.
const chatDeletedKind types.RoomMessageKind = "chat-deleted"

// Limits mirrored from web/lib/realtime.ts. Enforced here as well because that
// file runs on the sender's machine.
const (
	maxChatChars     = 2000
	maxQuestionChars = 600
	maxIDChars       = 64
)

// reactions is the closed set a client may send. Anything else is refused rather
// than forwarded — this list ends up rendered in 500 browsers.
var reactions = map[string]bool{
	"👏": true, "👍": true, "❤️": true, "😂": true, "🎉": true, "😮": true,
}

// sayPerMin is the per-person budget for realtime messages.
//
// Keyed on the sender rather than on their IP, which is the whole reason it lives
// in the handler instead of in the middleware: an entire corporate audience
// arrives from one egress address, and a per-IP bucket tight enough to stop one
// person spamming would silence the room. Generous, because tapping a reaction six
// times is enthusiasm, not abuse.
const sayPerMin = 90

// wireSender is the sender as every client sees them. Assigned from the
// credential, never from the request body.
type wireSender struct {
	Identity string     `json:"identity"`
	Name     string     `json:"name"`
	Role     types.Role `json:"role"`
}

// wirePacket is the data-channel message format.
//
// Its counterpart is `decode` in web/lib/realtime.ts, which is the only way a
// message enters the frontend — so a field renamed here has to be renamed there,
// and TestSayPacketWireFormat pins the JSON so the two cannot drift silently.
//
// `Destination` carries the audience a chat message was sent to. It is per-message
// on purpose: the host flipping the setting must not rewrite what has already been
// said, so each message keeps the destination it was delivered with.
type wirePacket struct {
	Kind types.RoomMessageKind `json:"kind"`
	ID   string                `json:"id,omitempty"`
	// Seq is the transcript's total order, carried so a client can advance its sync
	// cursor from a live message instead of re-reading the backlog to find out where
	// it got to. Zero for the kinds that are not persisted.
	Seq         int64                 `json:"seq,omitempty"`
	From        wireSender            `json:"from"`
	Text        string                `json:"text,omitempty"`
	Destination types.ChatDestination `json:"destination,omitempty"`
	// The image, for a chat message that is one. A URL to our own API, checked on
	// read — see handleChatMedia.
	MediaURL    string `json:"mediaUrl,omitempty"`
	MediaMime   string `json:"mediaMime,omitempty"`
	MediaWidth  int    `json:"mediaWidth,omitempty"`
	MediaHeight int    `json:"mediaHeight,omitempty"`
	Anonymous   bool   `json:"anonymous,omitempty"`
	QuestionID  string `json:"questionId,omitempty"`
	Raised      bool   `json:"raised,omitempty"`
	Emoji       string `json:"emoji,omitempty"`
	// At is the server's clock, so 500 browsers order a conversation the same way
	// and one machine with a wrong time cannot pin its messages to the top.
	At int64 `json:"at"`
}

// handleSay delivers one realtime message on the sender's behalf.
func (s *Server) handleSay(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req types.SendMessageRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	from, ok := s.resolveSender(w, r, slug, req.JoinKey)
	if !ok {
		return
	}

	if allowed, retry := s.sayLimit.Allow(from.Identity); !allowed {
		w.Header().Set("Retry-After", retryAfterSeconds(retry))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
			"You're sending messages too quickly. Give it a moment.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "say: load webinar", err)
		return
	}
	if wb.Status != types.StatusLive {
		httpx.Error(w, http.StatusConflict, "not_live", "This webinar isn't running.")
		return
	}

	/* The project this room is on, resolved once for the whole request.
	 *
	 * This is the hottest LiveKit path in the product — every chat line, question, raised
	 * hand and reaction from every attendee — so it reads the pin off the webinar already
	 * loaded above rather than going back to the database. A live webinar is always pinned,
	 * because the host had to join to start it, so this is a map lookup.
	 */
	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	onStage := from.Role == types.RoleHost || from.Role == types.RolePanelist

	packet, ok := buildPacket(w, req, from, wb.Controls, onStage)
	if !ok {
		return
	}

	room := lk.RoomName(slug)

	/* Chat is written down before it is sent.
	 *
	 * That order is deliberate and it is the reason chat no longer has a direct path:
	 * the host and the panelists used to publish onto the data channel themselves, and a
	 * transcript missing everything the presenter said is not a transcript. A message
	 * recorded but not delivered arrives on everyone's next sync; a message delivered
	 * but not recorded is gone the moment a tab reloads.
	 *
	 * The other kinds — questions, hands, reactions — are not persisted and take the
	 * path below unchanged.
	 */
	if packet.Kind == types.MsgChat {
		msg, err := s.store.AppendChat(r.Context(), store.ChatEntry{
			ID: packet.ID, Slug: slug,
			SenderID: from.Identity, SenderName: from.Name, SenderRole: from.Role,
			UserID:      userIDFor(from),
			Type:        types.ChatText,
			Destination: packet.Destination,
			Content:     packet.Text,
		})
		if errors.Is(err, store.ErrInvalid) {
			httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
			return
		}
		if err != nil {
			s.fail(w, r, "say: record chat", err)
			return
		}

		if err := s.deliverChat(r, sfu, slug, msg, onStage); err != nil {
			// In the transcript but not on the wire. Reported as a success: every client
			// picks it up on its next sync, and failing the request would have the
			// sender type it again into a chat that already has it.
			s.log.Warn("say: chat delivery failed",
				"slug", slug, "message", msg.ID, "error", err)
		}
		httpx.JSON(w, http.StatusOK, types.SendMessageResponse{
			Destination: msg.Destination,
			Recipients:  0,
		})
		return
	}

	// Recipients. Only chat is ever narrowed, and chat has already returned above: a
	// question, a raised hand and a reaction are addressed to the room by design.
	var to []string
	if packet.Kind == types.MsgChat && packet.Destination == types.ChatToPanelists {
		to, err = s.stageIdentities(r.Context(), sfu, room, from.Identity)
		if err != nil {
			s.fail(w, r, "say: list participants", err)
			return
		}
		// An empty list would mean "no filter" to the SFU, so a message meant for
		// the stage would broadcast to the whole audience. Refuse instead. In
		// practice this only happens when the host is not connected either, since
		// they are on the stage too.
		if len(to) <= 1 {
			httpx.Error(w, http.StatusConflict, "no_panelists",
				"No panelists are currently available.")
			return
		}
	}

	body, err := json.Marshal(packet)
	if err != nil {
		s.fail(w, r, "say: marshal packet", err)
		return
	}
	if err := sfu.SendData(r.Context(), room, dataTopic, body, to); err != nil {
		s.fail(w, r, "say: send data", err)
		return
	}

	httpx.JSON(w, http.StatusOK, types.SendMessageResponse{
		Destination: packet.Destination,
		Recipients:  len(to),
	})
}

// buildPacket validates one request against the session controls and turns it
// into the packet the room will see. Writes its own error response.
//
// The controls are checked here rather than in the browser that is sending,
// because "the host turned chat off" has to mean the message does not arrive —
// not that a compose box was hidden from the person who wanted to send it.
func buildPacket(
	w http.ResponseWriter,
	req types.SendMessageRequest,
	from wireSender,
	controls types.SessionControls,
	onStage bool,
) (wirePacket, bool) {
	packet := wirePacket{
		Kind: req.Kind,
		ID:   clamp(req.ID, maxIDChars),
		From: from,
		At:   time.Now().UnixMilli(),
	}

	// The stage is exempt from every one of these: the controls govern what the
	// AUDIENCE may do, and a host who turned chat off still has to be able to
	// explain why.
	closed := func(what string) {
		httpx.Error(w, http.StatusForbidden, "closed", "The host has turned off "+what+".")
	}

	switch req.Kind {
	case types.MsgChat:
		if !controls.ChatEnabled && !onStage {
			closed("chat")
			return wirePacket{}, false
		}
		text := clamp(req.Text, maxChatChars)
		if text == "" {
			httpx.Error(w, http.StatusBadRequest, "empty", "There's nothing to send.")
			return wirePacket{}, false
		}
		packet.Text = text
		// The id is the transcript's primary key and what makes a resend idempotent, so
		// a chat message without one is refused rather than given a server id the sender
		// could not match up.
		if len(packet.ID) < 8 {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "That message is missing an id.")
			return wirePacket{}, false
		}
		// The one line this whole feature is about. An attendee's audience is the
		// host's setting; only the stage may name its own.
		if onStage {
			packet.Destination = req.Destination.OrDefault()
		} else {
			packet.Destination = controls.ChatDestination.OrDefault()
		}

	case types.MsgQuestion:
		if !controls.QAEnabled && !onStage {
			closed("Q&A")
			return wirePacket{}, false
		}
		text := clamp(req.Text, maxQuestionChars)
		if text == "" {
			httpx.Error(w, http.StatusBadRequest, "empty", "There's nothing to send.")
			return wirePacket{}, false
		}
		packet.Text = text
		packet.Anonymous = req.Anonymous

	case types.MsgUpvote:
		if !controls.QAEnabled && !onStage {
			closed("Q&A")
			return wirePacket{}, false
		}
		packet.QuestionID = clamp(req.QuestionID, maxIDChars)
		if packet.QuestionID == "" {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "That question is missing.")
			return wirePacket{}, false
		}

	case types.MsgHand:
		if !controls.RaiseHandEnabled && !onStage {
			closed("raise hand")
			return wirePacket{}, false
		}
		packet.Raised = req.Raised

	case types.MsgReaction:
		if !controls.ReactionsEnabled && !onStage {
			closed("reactions")
			return wirePacket{}, false
		}
		if !reactions[req.Emoji] {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "That reaction isn't available.")
			return wirePacket{}, false
		}
		packet.Emoji = req.Emoji

	default:
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Unknown message kind.")
		return wirePacket{}, false
	}

	return packet, true
}

// stageIdentities is the recipient list for a panelists-only message: the host,
// the panelists, and the sender themselves.
//
// From the SFU's own participant list rather than from the sending browser,
// because a hidden-audience session deliberately keeps clients from enumerating
// the room — and because the sender is the last party who should be deciding who
// receives their message.
//
// Membership is read from role metadata rather than from publish permission. A
// panelist the host has silenced holds no publish grant at all, and keying on that
// would quietly drop them out of the panelist conversation at the moment they most
// need to be in it.
//
// The sender is included so their own message comes back to them. Server-sent
// packets are not echoed to a sender the way a published one is skipped, so this
// is also how an attendee sees what they just said.
func (s *Server) stageIdentities(
	ctx context.Context, sfu RoomManager, room, sender string,
) ([]string, error) {
	people, err := sfu.Participants(ctx, room)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(people))
	seen := false
	for _, p := range people {
		if p.Role == types.RoleHost || p.Role == types.RolePanelist {
			out = append(out, p.Identity)
			if p.Identity == sender {
				seen = true
			}
		}
	}
	if !seen {
		out = append(out, sender)
	}
	return out, nil
}

// resolveSender establishes who is speaking, from the credential rather than from
// the body. Writes its own error response.
//
// Three kinds of caller reach this endpoint, and all three are identified the same
// way they were when their token was minted — the identity has to match, or the
// SFU would deliver a panelists-only message to the wrong list and a sender would
// not see their own words.
func (s *Server) resolveSender(
	w http.ResponseWriter, r *http.Request, slug, joinKey string,
) (wireSender, bool) {
	// A signed-in host or panelist. Checked first because they hold no
	// registration: hosting is not attending. Skipped when a join key is presented,
	// so a host who is also watching from an attendee link stays the person that
	// link belongs to.
	if user, signedIn := s.optionalUser(r); signedIn && strings.TrimSpace(joinKey) == "" {
		role, err := s.stageRole(r.Context(), slug, user.ID)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return wireSender{}, false
		}
		if err != nil {
			s.fail(w, r, "say: stage role", err)
			return wireSender{}, false
		}
		if role != "" {
			return wireSender{
				Identity: hostIdentity(user.ID),
				Name:     user.Name,
				Role:     role,
			}, true
		}
	}

	// An attendee, by join key or by session. Same resolution as the join
	// endpoint, so the identity comes out identical.
	reg, ok := s.resolveRegistration(w, r, slug, joinKey)
	if !ok {
		return wireSender{}, false
	}
	if reg.State != types.RegApproved {
		httpx.Error(w, http.StatusForbidden, "not_approved",
			"The host hasn't approved your registration yet.")
		return wireSender{}, false
	}

	identity := attendeeIdentity(reg.JoinKey)
	name := strings.TrimSpace(reg.FirstName + " " + reg.LastName)
	if name == "" {
		name = "Attendee"
	}

	// A promoted attendee is on the stage, and their messages have to be labelled
	// and routed as such — the same grant lookup the join path does.
	role := types.RoleAttendee
	if grant, err := s.store.StageGrant(r.Context(), slug, identity); err != nil {
		s.log.Warn("say: stage grant lookup failed, treating as attendee",
			"error", err, "identity", identity)
	} else if grant.Granted {
		role = types.RolePanelist
	}

	return wireSender{Identity: identity, Name: name, Role: role}, true
}

// retryAfterSeconds formats a Retry-After header, rounding up so a client that
// obeys it to the second does not come back one request too early.
func retryAfterSeconds(d time.Duration) string {
	return strconv.Itoa(int(d.Seconds()) + 1)
}

// clamp trims and truncates one field from an untrusted body.
func clamp(v string, max int) string {
	v = strings.TrimSpace(v)
	if len(v) > max {
		// Cut on a rune boundary so a truncated message is still valid UTF-8.
		for max > 0 && !utf8StartsAt(v, max) {
			max--
		}
		v = v[:max]
	}
	return v
}

// utf8StartsAt reports whether i is the start of a rune in v.
func utf8StartsAt(v string, i int) bool {
	return i >= len(v) || v[i]&0xC0 != 0x80
}
