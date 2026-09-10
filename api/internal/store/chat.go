package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The chat transcript.
 *
 * One row per message, written as it is sent rather than gathered up at the end. That
 * choice is the whole design: a message that is only in flight is a message that a
 * reload loses, a late joiner cannot read, and nobody can produce afterwards.
 *
 * Three properties are the database's rather than a handler's:
 *
 *   idempotent delivery  The primary key is the SENDER's message id, so a resend after
 *                        a lost response collides and is ignored. A reconnecting client
 *                        merging a backlog cannot produce a duplicate line.
 *   total order          A sequence, not a timestamp. Two messages in the same
 *                        millisecond still need an order, and "everything after 214" is
 *                        a question a timestamp cannot answer without a gap or an
 *                        overlap at the boundary.
 *   the audience rule    Each row carries the destination it was sent to, so replaying
 *                        history applies the same filter live delivery did. Without it,
 *                        a late joiner would be handed the panelists-only messages the
 *                        SFU had refused to deliver to them.
 */

// backlogLimit caps one read. A long session has thousands of lines and a client
// resuming after an hour must not receive them in a single response; ChatBacklog.More
// tells it to ask again.
const backlogLimit = 300

// ChatEntry is one message on its way in. The media fields are set only for an image.
type ChatEntry struct {
	ID          string
	Slug        string
	SenderID    string
	SenderName  string
	SenderRole  types.Role
	UserID      string
	Type        types.ChatMessageType
	Destination types.ChatDestination
	Content     string

	MediaKey    string
	MediaMime   string
	MediaBytes  int64
	MediaWidth  int
	MediaHeight int
}

/* AppendChat records one message and returns it as the sender will see it.
 *
 * ON CONFLICT DO NOTHING, then read back. The read is not a second round trip for
 * convenience — it is how a duplicate becomes a success: a client that resends is told
 * "here is your message, at the sequence it already had", which is exactly what it
 * needs to reconcile. Reporting a conflict as an error would make every dropped
 * response look like a failure to the person who sent it.
 */
func (s *Store) AppendChat(ctx context.Context, in ChatEntry) (types.ChatMessage, error) {
	if strings.TrimSpace(in.ID) == "" {
		return types.ChatMessage{}, fmt.Errorf("%w: a message needs an id", ErrInvalid)
	}
	if in.Type == "" {
		in.Type = types.ChatText
	}
	if in.Type == types.ChatText && strings.TrimSpace(in.Content) == "" {
		return types.ChatMessage{}, fmt.Errorf("%w: a text message needs content", ErrInvalid)
	}
	if in.Type == types.ChatImage && in.MediaKey == "" {
		return types.ChatMessage{}, fmt.Errorf("%w: an image message needs an upload", ErrInvalid)
	}

	if _, err := s.pool.Exec(ctx, `
		INSERT INTO chat_messages
			(id, webinar_id, sender_identity, sender_name, sender_role, sender_user_id,
			 message_type, destination, content,
			 media_key, media_mime, media_bytes, media_width, media_height)
		SELECT $1, w.id, $3, $4, $5, $6::uuid, $7, $8, $9,
		       nullif($10, ''), nullif($11, ''), nullif($12, 0), nullif($13, 0), nullif($14, 0)
		  FROM webinars w WHERE w.slug = $2
		ON CONFLICT (id) DO NOTHING`,
		in.ID, in.Slug, in.SenderID, in.SenderName, string(in.SenderRole), nullUUID(in.UserID),
		string(in.Type), string(in.Destination.OrDefault()), in.Content,
		in.MediaKey, in.MediaMime, in.MediaBytes, in.MediaWidth, in.MediaHeight,
	); err != nil {
		return types.ChatMessage{}, err
	}

	return s.chatMessage(ctx, in.Slug, in.ID)
}

func (s *Store) chatMessage(ctx context.Context, slug, id string) (types.ChatMessage, error) {
	row := s.pool.QueryRow(ctx, chatSelect+`
		 WHERE w.slug = $1 AND m.id = $2`, slug, id)
	msg, err := scanChat(row)
	if noRows(err) {
		return types.ChatMessage{}, ErrNotFound
	}
	return msg, err
}

/* ChatBacklog returns what the caller has not seen, in order.
 *
 * `since` is the highest seq they hold; zero for somebody joining. `forStage` is the
 * caller's entitlement, decided by the handler — false filters out the panelists-only
 * messages, which is the same rule the SFU applied when they were sent. Replaying
 * without it would deliver in history what was withheld in the moment.
 */
func (s *Store) ChatBacklog(
	ctx context.Context, slug string, since int64, forStage bool,
) (types.ChatBacklog, error) {
	// Asked for one more than the limit, so "is there more" is answered by the same
	// query rather than by a follow-up count over the whole session.
	rows, err := s.pool.Query(ctx, chatSelect+`
		 WHERE w.slug = $1 AND m.seq > $2
		   AND ($3 OR m.destination = 'everyone' OR m.sender_identity = $4)
		 ORDER BY m.seq
		 LIMIT $5`,
		slug, since, forStage, chatViewer(ctx), backlogLimit+1)
	if err != nil {
		return types.ChatBacklog{}, err
	}
	defer rows.Close()

	out := types.ChatBacklog{Messages: []types.ChatMessage{}, Cursor: since}
	for rows.Next() {
		msg, err := scanChat(rows)
		if err != nil {
			return types.ChatBacklog{}, err
		}
		out.Messages = append(out.Messages, msg)
	}
	if err := rows.Err(); err != nil {
		return types.ChatBacklog{}, err
	}

	if len(out.Messages) > backlogLimit {
		out.Messages = out.Messages[:backlogLimit]
		out.More = true
	}
	if n := len(out.Messages); n > 0 {
		out.Cursor = out.Messages[n-1].Seq
	}
	return out, nil
}

/* chatViewer carries the caller's own identity into the backlog filter.
 *
 * An attendee has to see their OWN panelists-only messages — they sent them, and a
 * chat that swallows what you just said looks broken. Passed through the context
 * rather than added to the signature because every other caller of ChatBacklog wants
 * the default of "nobody", and a parameter nobody sets is a parameter somebody
 * eventually sets wrongly.
 */
type chatViewerKey struct{}

// WithChatViewer marks the identity whose own messages are always visible.
func WithChatViewer(ctx context.Context, identity string) context.Context {
	return context.WithValue(ctx, chatViewerKey{}, identity)
}

func chatViewer(ctx context.Context) string {
	identity, _ := ctx.Value(chatViewerKey{}).(string)
	return identity
}

// ChatTranscript is the whole session, unfiltered, for the host's export. No limit and
// no cursor: this is the archive, and paging an export is how half of one gets saved.
func (s *Store) ChatTranscript(ctx context.Context, slug string) ([]types.ChatMessage, error) {
	rows, err := s.pool.Query(ctx, chatSelect+` WHERE w.slug = $1 ORDER BY m.seq`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.ChatMessage{}
	for rows.Next() {
		msg, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, msg)
	}
	return out, rows.Err()
}

// ChatStats is the per-session summary. One pass, so a report does not read the
// transcript to count it.
func (s *Store) ChatStats(ctx context.Context, slug string) (types.ChatStats, error) {
	var (
		st      types.ChatStats
		firstAt *time.Time
		lastAt  *time.Time
	)
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::int,
		       count(*) FILTER (WHERE m.message_type = 'image')::int,
		       count(DISTINCT m.sender_identity)::int,
		       min(m.created_at), max(m.created_at),
		       coalesce(sum(m.media_bytes), 0)::bigint,
		       count(*) FILTER (WHERE m.destination = 'panelists')::int
		  FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1`, slug,
	).Scan(&st.Messages, &st.Images, &st.Senders, &firstAt, &lastAt,
		&st.MediaBytes, &st.ToPanelists)
	if err != nil {
		return types.ChatStats{}, err
	}
	st.WebinarID = slug
	if firstAt != nil {
		st.FirstAt = firstAt.Format(time.RFC3339)
	}
	if lastAt != nil {
		st.LastAt = lastAt.Format(time.RFC3339)
	}
	return st, nil
}

// ChatMedia resolves an image message to its storage key, scoped to the webinar.
//
// Scoped deliberately: the key is looked up through the slug the caller asked about, so
// a message id from one session cannot be used to read bytes through another's URL.
func (s *Store) ChatMedia(ctx context.Context, slug, id string) (key, mime string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT coalesce(m.media_key, ''), coalesce(m.media_mime, '')
		  FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1 AND m.id = $2 AND m.message_type = 'image'`,
		slug, id).Scan(&key, &mime)
	if noRows(err) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if key == "" {
		return "", "", ErrNotFound
	}
	return key, mime, nil
}

/* Chat image keys used to be listed here, for the webinar delete to clean up after.
 *
 * Folded into DeleteWebinar (store/webinars.go), which needs recording files in the same
 * breath and now collects both in one query inside the deleting transaction. Two functions
 * answering "what does this webinar own in storage" is how one of them ends up missing a
 * table — which is exactly what happened: this one knew about chat images and not about
 * recordings, so every deleted webinar left its recording files on disk.
 */

// chatSelect is shared by every read so the scan order cannot drift. media_key is
// deliberately absent: it is an internal storage key and never leaves the server.
const chatSelect = `
	SELECT m.id, m.seq, m.sender_identity, m.sender_name, m.sender_role,
	       coalesce(m.sender_user_id::text, ''), m.message_type, m.destination, m.content,
	       coalesce(m.media_key, ''), coalesce(m.media_mime, ''),
	       coalesce(m.media_bytes, 0), coalesce(m.media_width, 0), coalesce(m.media_height, 0),
	       m.created_at, w.slug
	  FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id`

func scanChat(row scanner) (types.ChatMessage, error) {
	var (
		m         types.ChatMessage
		mediaKey  string
		createdAt time.Time
		slug      string
	)
	if err := row.Scan(
		&m.ID, &m.Seq, &m.SenderID, &m.SenderName, &m.SenderRole,
		&m.UserID, &m.Type, &m.Destination, &m.Message,
		&mediaKey, &m.MediaMime, &m.MediaBytes, &m.MediaWidth, &m.MediaHeight,
		&createdAt, &slug,
	); err != nil {
		return types.ChatMessage{}, err
	}
	m.Timestamp = createdAt.Format(time.RFC3339)
	// Built here rather than stored, so the route can change without a migration — and
	// so what leaves the server is a URL our own handler authorizes, not a storage key.
	if mediaKey != "" {
		m.MediaURL = fmt.Sprintf("/api/webinars/%s/chat/media/%s", slug, m.ID)
	}
	return m, nil
}
