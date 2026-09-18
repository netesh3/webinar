package api

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Chat that survives.
 *
 * Every message is written to Postgres on the way through the relay, which is why the
 * relay had to become the ONLY path for chat — the host and the panelists used to
 * publish straight onto the data channel, and a transcript missing everything the
 * presenter said is not a transcript. See handleSay.
 *
 * Three things follow:
 *
 *   reconnection    A client asks for everything after the highest seq it holds. One
 *                   request, no duplicates, and the same audience filter that applied
 *                   when the messages were sent — replaying history must not hand a
 *                   late joiner the panelists-only lines the SFU refused to deliver.
 *   images          Uploaded through here, stored in the same object store the
 *                   recordings use, and served back through a handler that checks the
 *                   caller is in this webinar. The payload carries a URL to us, never a
 *                   bucket URL: that would be a link outliving the session.
 *   the archive     There is nothing to archive at the end, because nothing was ever
 *                   only in a cache. Ending the session stamps it and the transcript is
 *                   already permanent; the export is a read.
 */

// zeroTime tells ServeContent not to send Last-Modified. The stored bytes never
// change, so an immutable Cache-Control says everything a validator would.
var zeroTime = time.Time{}

// chatMillis turns the stored RFC3339 stamp into the epoch milliseconds the wire format
// carries. The server's clock, so five hundred browsers order a conversation the same
// way and one machine with a wrong time cannot pin its messages to the top.
func chatMillis(stamp string) int64 {
	t, err := time.Parse(time.RFC3339, stamp)
	if err != nil {
		return time.Now().UnixMilli()
	}
	return t.UnixMilli()
}

// maxChatImageBytes caps one upload. Five megabytes is a generous screenshot and a
// mean photograph, which is the right way round — the client compresses before it gets
// here, and something arriving at the cap has usually skipped that step.
const maxChatImageBytes = 5 << 20

// imageTypes is the closed set. Checked against the bytes rather than the header,
// because a Content-Type is whatever the sender typed.
var imageTypes = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
}

/* sniffImage identifies the format from the leading bytes.
 *
 * The declared Content-Type is a claim by the uploader and this endpoint writes to disk
 * and hands back a URL other people will load, so the claim is checked. A file that
 * says image/png and is not gets refused here rather than becoming a broken thumbnail
 * in five hundred browsers — or worse, something a browser decides to treat as markup.
 */
func sniffImage(b []byte) (mime string, ok bool) {
	switch {
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png", true
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg", true
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp", true
	}
	return "", false
}

// ---------------------------------------------------------------- reconnection

/* handleChatBacklog is what a reconnecting client asks for.
 *
 * `since` is the highest seq it already holds — zero on a fresh join, which returns the
 * conversation so far. That is the same request either way, deliberately: "catch up
 * after a dropped connection" and "read what was said before I arrived" are the same
 * question with a different cursor, and one code path cannot disagree with itself.
 */
func (s *Server) handleChatBacklog(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	from, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey"))
	if !ok {
		return
	}

	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if since < 0 {
		since = 0
	}

	onStage := from.Role == types.RoleHost || from.Role == types.RolePanelist
	// The viewer's own identity travels in the context so their own panelists-only
	// messages come back to them. A chat that swallows what you just said looks broken.
	ctx := store.WithChatViewer(r.Context(), from.Identity)

	backlog, err := s.store.ChatBacklog(ctx, slug, since, onStage)
	if err != nil {
		s.fail(w, r, "chat backlog", err)
		return
	}
	httpx.JSON(w, http.StatusOK, backlog)
}

// ------------------------------------------------------------------- images

/* handleChatImage takes an upload and posts it as a message.
 *
 * One request, not two. An upload endpoint that returns a handle for a second call to
 * reference leaves an orphan every time the second call does not happen — a tab closed,
 * a connection dropped — and orphaned bytes in object storage are the kind of thing
 * nobody notices until the disk is full. Storing and posting together means the row and
 * the file arrive or neither does.
 *
 * The body is the raw image. Multipart would be the conventional choice and it buys
 * nothing here: there is one part, and the metadata that would travel beside it is
 * three query parameters.
 */
func (s *Server) handleChatImage(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "storage_disabled",
			"Image sharing is turned off on this instance.")
		return
	}

	from, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey"))
	if !ok {
		return
	}
	if allowed, retry := s.sayLimit.Allow(from.Identity); !allowed {
		w.Header().Set("Retry-After", retryAfterSeconds(retry))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
			"You're sending images too quickly. Give it a moment.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "chat image: load webinar", err)
		return
	}

	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}

	onStage := from.Role == types.RoleHost || from.Role == types.RolePanelist
	if !wb.Controls.ChatEnabled && !onStage {
		httpx.Error(w, http.StatusForbidden, "closed", "The host has turned off chat.")
		return
	}

	id := clamp(r.URL.Query().Get("id"), maxIDChars)
	if len(id) < 8 {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "That upload is missing an id.")
		return
	}

	// MaxBytesReader rather than checking Content-Length: a chunked upload has no
	// length to check, and trusting one is how a five-megabyte cap becomes a
	// five-hundred-megabyte write.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChatImageBytes+1))
	if err != nil || len(body) > maxChatImageBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large",
			fmt.Sprintf("Images must be under %d MB.", maxChatImageBytes>>20))
		return
	}
	if len(body) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty", "That upload was empty.")
		return
	}

	mime, sniffed := sniffImage(body)
	if !sniffed {
		httpx.Error(w, http.StatusUnsupportedMediaType, "bad_image",
			"Images must be PNG, JPEG or WebP.")
		return
	}

	key := "chat/" + slug + "/" + id + imageTypes[mime]
	if _, err := s.recordings.Append(r.Context(), key, strings.NewReader(string(body))); err != nil {
		s.fail(w, r, "chat image: store", err)
		return
	}

	width, _ := strconv.Atoi(r.URL.Query().Get("w"))
	height, _ := strconv.Atoi(r.URL.Query().Get("h"))

	destination := wb.Controls.ChatDestination.OrDefault()
	if onStage {
		destination = types.ChatDestination(r.URL.Query().Get("destination")).OrDefault()
	}

	msg, err := s.store.AppendChat(r.Context(), store.ChatEntry{
		ID: id, Slug: slug,
		SenderID: from.Identity, SenderName: from.Name, SenderRole: from.Role,
		UserID:      userIDFor(from),
		Type:        types.ChatImage,
		Destination: destination,
		MediaKey:    key, MediaMime: mime, MediaBytes: int64(len(body)),
		MediaWidth: width, MediaHeight: height,
	})
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
		return
	}
	if err != nil {
		// The bytes are stored and the row is not, so remove them rather than leaving
		// an object nothing references.
		_ = s.recordings.Delete(r.Context(), key)
		s.fail(w, r, "chat image: record", err)
		return
	}

	if err := s.deliverChat(r, sfu, slug, msg, onStage); err != nil {
		// Stored and recorded; only the live delivery failed. Reported as a success
		// because the message IS in the transcript and every client will pick it up on
		// its next sync — losing it now would be the wrong half to discard.
		s.log.Warn("chat image: delivery failed", "slug", slug, "message", msg.ID, "error", err)
	}
	httpx.JSON(w, http.StatusCreated, types.ChatImageResponse{Message: msg})
}

/* handleChatMedia streams a stored image.
 *
 * Behind the same credential as the rest of the room. A bucket URL in the message
 * payload would have been simpler and would also have been a link that works for
 * anybody who ever saw it, long after the session ended — so the URL points here and
 * this checks.
 */
func (s *Server) handleChatMedia(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id := chi.URLParam(r, "id")

	if s.recordings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "storage_disabled", "Image sharing is off.")
		return
	}
	if _, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey")); !ok {
		return
	}

	key, mime, err := s.store.ChatMedia(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such image.")
		return
	}
	if err != nil {
		s.fail(w, r, "chat media: lookup", err)
		return
	}

	reader, size, err := s.recordings.Open(r.Context(), key)
	if errors.Is(err, media.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That image is no longer stored.")
		return
	}
	if err != nil {
		s.fail(w, r, "chat media: open", err)
		return
	}
	defer func() { _ = reader.Close() }()

	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	// An image in a transcript never changes, so it is worth caching hard. Private,
	// because it is behind a credential and a shared proxy must not keep it.
	w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	// Belt and braces against a stored file being interpreted as markup: the type is
	// sniffed on upload, and this stops a browser second-guessing it anyway.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", zeroTime, reader)
}

// ------------------------------------------------------------------- archive

/* handleChatTranscript is the host's export.
 *
 * JSON by default and CSV on request, because the two audiences are different: a
 * reporting pipeline wants the former and somebody opening it in a spreadsheet wants
 * the latter. Unfiltered — this is the archive, and it includes the panelists-only
 * lines the audience never saw.
 */
func (s *Server) handleChatTranscript(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	messages, err := s.store.ChatTranscript(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "chat transcript", err)
		return
	}

	if r.URL.Query().Get("format") != "csv" {
		stats, err := s.store.ChatStats(r.Context(), slug)
		if err != nil {
			s.fail(w, r, "chat stats", err)
			return
		}
		httpx.JSON(w, http.StatusOK, struct {
			Stats    types.ChatStats     `json:"stats"`
			Messages []types.ChatMessage `json:"messages"`
		}{stats, messages})
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+slug+`-chat.csv"`)

	out := csv.NewWriter(w)
	// The header row names the archival contract. Anyone reading this file later should
	// not have to guess which column is which.
	_ = out.Write([]string{
		"sessionId", "messageId", "seq", "timestamp",
		"senderId", "userId", "senderName", "senderRole",
		"messageType", "destination", "messageContent",
		"mediaUrl", "mediaMime", "mediaBytes",
	})
	for _, m := range messages {
		_ = out.Write([]string{
			slug, m.ID, strconv.FormatInt(m.Seq, 10), m.Timestamp,
			m.SenderID, m.UserID, m.SenderName, string(m.SenderRole),
			string(m.Type), string(m.Destination), m.Message,
			m.MediaURL, m.MediaMime, strconv.FormatInt(m.MediaBytes, 10),
		})
	}
	out.Flush()
	if err := out.Error(); err != nil {
		s.log.Warn("chat transcript: csv write failed", "slug", slug, "error", err)
	}
}

func (s *Server) handleChatStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.ChatStats(r.Context(), slugFromContext(r.Context()))
	if err != nil {
		s.fail(w, r, "chat stats", err)
		return
	}
	httpx.JSON(w, http.StatusOK, stats)
}

// -------------------------------------------------------------- moderation

/* handleDeleteChat removes one attendee's message from the room, for the host,
 * a co-host, or a panelist.
 *
 * A co-host is stored as an ordinary panelist with an extra grant (see
 * stageRole) rather than its own role, so the same onStage check that gates a
 * stage-only chat message gates this too — nothing extra is needed for "host,
 * co-host and panelist" as a group.
 *
 * Store.DeleteChat is what actually restricts this to an attendee's own
 * messages, in the query itself: there is no sender_role of "system" in this
 * schema at all (chat_messages' own CHECK constraint only allows host,
 * panelist, attendee), so there is nothing else to accidentally delete.
 *
 * Soft-deleted, not erased — see DeleteChat's own comment. Live delivery here
 * is best-effort, matching every other realtime nudge in this file: the
 * database is the source of truth, and a client that misses the broadcast
 * still stops seeing the message on its next backlog sync, which ChatBacklog
 * now filters on deleted_at.
 */
func (s *Server) handleDeleteChat(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id := chi.URLParam(r, "id")

	from, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey"))
	if !ok {
		return
	}
	if from.Role != types.RoleHost && from.Role != types.RolePanelist {
		httpx.Error(w, http.StatusForbidden, "forbidden",
			"Only the host or a panelist can delete a message.")
		return
	}

	if err := s.store.DeleteChat(r.Context(), slug, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found",
				"That message can't be deleted — it may already be gone, or it wasn't sent by an attendee.")
			return
		}
		s.fail(w, r, "delete chat: update", err)
		return
	}

	sfu, err := s.sfuForSlug(r.Context(), slug)
	if err != nil {
		s.log.Warn("delete chat: resolve project", "slug", slug, "error", err)
	} else {
		body, mErr := json.Marshal(wirePacket{Kind: chatDeletedKind, ID: id})
		if mErr != nil {
			s.log.Warn("delete chat: marshal", "slug", slug, "error", mErr)
		} else if sErr := sfu.SendData(r.Context(), lk.RoomName(slug), dataTopic, body, nil); sErr != nil {
			s.log.Warn("delete chat: send", "slug", slug, "error", sErr)
		}
	}

	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

// ------------------------------------------------------------------- delivery

/* deliverChat puts a recorded message on the wire.
 *
 * Recorded first, then delivered — that order is the point. A message delivered but not
 * recorded is one the transcript is missing and a reconnecting client will never see
 * again; a message recorded but not delivered arrives a moment late on everyone's next
 * sync. Only one of those is recoverable.
 */
func (s *Server) deliverChat(
	r *http.Request, sfu RoomManager, slug string, msg types.ChatMessage, senderOnStage bool,
) error {
	packet := wirePacket{
		Kind: types.MsgChat,
		ID:   msg.ID,
		Seq:  msg.Seq,
		From: wireSender{
			Identity: msg.SenderID,
			Name:     msg.SenderName,
			Role:     msg.SenderRole,
		},
		Text:        msg.Message,
		Destination: msg.Destination,
		MediaURL:    msg.MediaURL,
		MediaMime:   msg.MediaMime,
		MediaWidth:  msg.MediaWidth,
		MediaHeight: msg.MediaHeight,
		// The wall clock the row was stamped with, not the sender's: every browser has
		// to order the conversation the same way, and one machine with a wrong clock
		// must not be able to pin its messages to the top.
		At: chatMillis(msg.Timestamp),
	}

	var to []string
	if msg.Destination == types.ChatToPanelists {
		identities, err := s.stageIdentities(r.Context(), sfu, lk.RoomName(slug), msg.SenderID)
		if err != nil {
			return err
		}
		// An empty list means "no filter" to the SFU, which would broadcast a
		// stage-only message to the whole audience. Nothing is sent instead — the
		// message is already in the transcript and the stage will see it on their next
		// sync.
		if len(identities) <= 1 {
			return nil
		}
		to = identities
	}

	body, err := json.Marshal(packet)
	if err != nil {
		return err
	}
	return sfu.SendData(r.Context(), lk.RoomName(slug), dataTopic, body, to)
}

// userIDFor extracts the account id from a sender identity, when there is one.
//
// hostIdentity is "user_<uuid>"; an attendee's is "att_<joinKey>" and has no account
// behind it, which is the normal case for an audience.
func userIDFor(from wireSender) string {
	if id, ok := strings.CutPrefix(from.Identity, "user_"); ok {
		return id
	}
	return ""
}
