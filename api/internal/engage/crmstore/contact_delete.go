package crmstore

import (
	"context"
	"strings"

	"github.com/netkumar/webcast/api/internal/store"
)

/* ContactMediaKeys lists the stored attachment files for one of this host's
 * contacts, so they can be removed before the rows that name them. ErrNotFound
 * is a missing contact, another host's, or an id that is not a uuid. */
func (s *Store) ContactMediaKeys(ctx context.Context, hostID, contactID string) ([]string, error) {
	if !uuidPattern.MatchString(strings.TrimSpace(contactID)) {
		return nil, store.ErrNotFound
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM crm_contacts WHERE id = $1::uuid AND host_id = $2::uuid)`,
		contactID, hostID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, store.ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.storage_key
		  FROM crm_message_media c
		  JOIN crm_messages m ON m.id = c.message_id
		 WHERE m.contact_id = $1::uuid AND m.host_id = $2::uuid AND c.storage_key <> ''`,
		contactID, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

/* DeleteContact erases one of this host's contacts.
 *
 * Everything keyed to the contact cascades: messages (and their media rows),
 * tags, notes, engagement, drip enrollments, bot sessions, and notifications —
 * which is also every WhatsApp send still queued for them, so nothing goes out
 * afterwards. The host's registrations are webinar records and stay; see the
 * handler. Files go first, through ContactMediaKeys. */
func (s *Store) DeleteContact(ctx context.Context, hostID, contactID string) error {
	if !uuidPattern.MatchString(strings.TrimSpace(contactID)) {
		return store.ErrNotFound
	}
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM crm_contacts WHERE id = $1::uuid AND host_id = $2::uuid`, contactID, hostID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}
