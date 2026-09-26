package store

import "context"

// deletedChatLimit bounds the moderation list a reconnecting client is sent. Deletions
// are rare and the client holds at most a few hundred messages, so the newest few
// hundred removals cover anything it could still be showing.
const deletedChatLimit = 500

/* DeletedChatIDs is which messages up to `through` moderation has removed.
 *
 * Kept out of ChatBacklog on purpose: the backlog is "what is new after my cursor", and
 * a deletion is a change to something BEFORE the cursor — a message the client already
 * holds and was told to drop by a packet it may have missed while disconnected. Only
 * attendee messages can be deleted (see DeleteChat), and only ids leave the server.
 */
func (s *Store) DeletedChatIDs(ctx context.Context, slug string, through int64) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id FROM chat_messages m
		  JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1 AND m.seq <= $2 AND m.deleted_at IS NOT NULL
		 ORDER BY m.seq DESC
		 LIMIT $3`, slug, through, deletedChatLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
