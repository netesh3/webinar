package store

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Notes: what the host knows about somebody that the CRM does not.
 *
 * The only table in the CRM whose rows are never sent anywhere. A note is not a message,
 * not a merge field and not visible to the person it is about — which is what makes it
 * useful ("asked us to call after 5") and what makes it the one thing here with no Meta
 * rule attached.
 *
 * There is no update. See migrations/0048: a note is a dated observation, and editing one
 * rewrites what the host knew in February.
 */

/* Notes reads one contact's notes, newest first.
 *
 * The author's name is joined in rather than stored on the row, so an account that changed
 * its display name does not leave old notes signed with the old one. ON DELETE SET NULL on
 * the author means a deleted account leaves the note with no name, which is honest: the
 * observation still stands, nobody is left to ask about it.
 */
func (s *Store) Notes(ctx context.Context, hostID, contactID string) ([]types.CRMNote, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT n.id::text, n.contact_id::text, n.body, coalesce(a.name,''), n.created_at
		  FROM crm_notes n
		  LEFT JOIN users a ON a.id = n.author_id
		 WHERE n.host_id = $1 AND n.contact_id = $2::uuid
		 ORDER BY n.created_at DESC, n.id DESC
		 LIMIT $3`, hostID, contactID, crmNotesMax)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]types.CRMNote, 0, 8)
	for rows.Next() {
		var (
			n       types.CRMNote
			created time.Time
		)
		if err := rows.Scan(&n.ID, &n.ContactID, &n.Body, &n.Author, &created); err != nil {
			return nil, err
		}
		n.CreatedAt = created.Format(time.RFC3339)
		out = append(out, n)
	}
	return out, rows.Err()
}

// crmNotesMax caps one contact's notes in a read. High enough that no real host hits it,
// low enough that a scripted import cannot make the thread endpoint slow for everybody.
const crmNotesMax = 200

/* AddNote writes one down against a contact.
 *
 * ErrNotFound for a contact that is not this host's — checked by the INSERT's own SELECT
 * rather than by a read first, so there is no window between the two.
 */
func (s *Store) AddNote(ctx context.Context, hostID, contactID, authorID, body string) (types.CRMNote, error) {
	clean := strings.TrimSpace(body)
	if clean == "" || len(clean) > types.NoteMaxLength {
		return types.CRMNote{}, ErrInvalid
	}

	var (
		n       types.CRMNote
		created time.Time
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO crm_notes (host_id, contact_id, author_id, body)
		SELECT $1::uuid, c.id, $3::uuid, $4
		  FROM crm_contacts c
		 WHERE c.id = $2::uuid AND c.host_id = $1::uuid
		RETURNING id::text, contact_id::text, body, created_at`,
		hostID, contactID, authorID, clean).
		Scan(&n.ID, &n.ContactID, &n.Body, &created)
	if noRows(err) {
		return types.CRMNote{}, ErrNotFound
	}
	if err != nil {
		return types.CRMNote{}, err
	}
	n.CreatedAt = created.Format(time.RFC3339)
	return n, nil
}

// DeleteNote removes one. The only way to correct a note, and the reason there is no edit.
func (s *Store) DeleteNote(ctx context.Context, hostID, noteID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM crm_notes WHERE id = $1::uuid AND host_id = $2::uuid`, noteID, hostID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
