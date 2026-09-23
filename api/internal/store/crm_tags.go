package store

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Tags: the labels a host puts on people, and who carries them.
 *
 * Every function takes hostID and filters on it, for the reason the rest of the CRM does
 * (see crm.go): these rows name other people's phone numbers. A tag id from another
 * account reads as ErrNotFound, and applying one is checked on both sides — the contact
 * and the tag have to belong to the same host, which is what crm_contact_tags does not
 * store and therefore cannot be trusted to enforce.
 *
 * Three other features read what is written here: the broadcast audience, the `tag_added`
 * sequence trigger and the bot step that sets one. That is why the name is normalised in
 * one place and matched case-insensitively — two labels that read the same on screen would
 * make every one of those three a coin toss.
 */

// tagName trims and single-spaces a label. A host who typed two spaces meant one, and
// "VIP " and "VIP" have to be the same tag for the unique index to mean anything.
func tagName(name string) string {
	return strings.Join(strings.Fields(name), " ")
}

/* Tags lists a host's labels alphabetically, each with how many contacts carry it.
 *
 * The count is a correlated subquery rather than a GROUP BY join, so a tag nobody has
 * still appears — a freshly created label the host is about to apply is exactly the one
 * they are looking at.
 */
func (s *Store) Tags(ctx context.Context, hostID string) ([]types.CRMTag, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id::text, t.name, t.created_at,
		       (SELECT count(*) FROM crm_contact_tags ct WHERE ct.tag_id = t.id)
		  FROM crm_tags t
		 WHERE t.host_id = $1
		 ORDER BY lower(t.name), t.id`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Never nil: an account with no tags is an empty list on the wire.
	out := make([]types.CRMTag, 0, 8)
	for rows.Next() {
		var (
			t       types.CRMTag
			created time.Time
		)
		if err := rows.Scan(&t.ID, &t.Name, &created, &t.Contacts); err != nil {
			return nil, err
		}
		t.CreatedAt = created.Format(time.RFC3339)
		out = append(out, t)
	}
	return out, rows.Err()
}

/* CreateTag adds a label, or returns the one already there.
 *
 * A duplicate is not an error. Asking for a label that exists is what a host does when
 * they have forgotten whether they made it — and the thing they want in both cases is the
 * tag. So ON CONFLICT DO NOTHING, then read it back: the caller gets a tag either way and
 * has no case to handle.
 *
 * ErrFull at TagMaxPerHost. The cap is checked before the insert and is therefore racy by
 * a tag or two under simultaneous requests, which is the right trade: the number exists so
 * the picker stays pickable, not because 101 labels breaks anything.
 */
func (s *Store) CreateTag(ctx context.Context, hostID, name string) (types.CRMTag, error) {
	clean := tagName(name)
	if clean == "" || len(clean) > types.TagMaxLength {
		return types.CRMTag{}, ErrInvalid
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.CRMTag{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var existing int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM crm_tags WHERE host_id = $1`, hostID).Scan(&existing); err != nil {
		return types.CRMTag{}, err
	}

	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO crm_tags (host_id, name) VALUES ($1, $2)
		ON CONFLICT (host_id, lower(name)) DO NOTHING
		RETURNING id::text`, hostID, clean).Scan(&id)
	switch {
	case noRows(err):
		// Already there. Hand back the tag that won, under its original spelling —
		// this is a lookup, not a rename.
		if err := tx.QueryRow(ctx, `
			SELECT id::text FROM crm_tags
			 WHERE host_id = $1 AND lower(name) = lower($2)`, hostID, clean).Scan(&id); err != nil {
			return types.CRMTag{}, err
		}
	case err != nil:
		return types.CRMTag{}, err
	case existing >= types.TagMaxPerHost:
		/* The cap is applied only to a tag that is actually new, which is why it is
		 * checked here and not before the insert: a host sitting on the limit asking
		 * for a label they already have is asking for nothing, and refusing that would
		 * break the duplicate-is-a-lookup behaviour above. The transaction rolls back,
		 * so nothing was created. */
		return types.CRMTag{}, ErrFull
	}

	t, err := tagByID(ctx, tx, hostID, id)
	if err != nil {
		return types.CRMTag{}, err
	}
	return t, tx.Commit(ctx)
}

func tagByID(ctx context.Context, q querier, hostID, id string) (types.CRMTag, error) {
	var (
		t       types.CRMTag
		created time.Time
	)
	err := q.QueryRow(ctx, `
		SELECT t.id::text, t.name, t.created_at,
		       (SELECT count(*) FROM crm_contact_tags ct WHERE ct.tag_id = t.id)
		  FROM crm_tags t
		 WHERE t.id = $1::uuid AND t.host_id = $2::uuid`, id, hostID).
		Scan(&t.ID, &t.Name, &created, &t.Contacts)
	if noRows(err) {
		return types.CRMTag{}, ErrNotFound
	}
	if err != nil {
		return types.CRMTag{}, err
	}
	t.CreatedAt = created.Format(time.RFC3339)
	return t, nil
}

// Tag reads one of a host's labels. Used to check a tag belongs to the caller before
// anything is done with it.
func (s *Store) Tag(ctx context.Context, hostID, id string) (types.CRMTag, error) {
	return tagByID(ctx, s.pool, hostID, id)
}

/* RenameTag changes a label's name, keeping everything it is on.
 *
 * ErrConflict when the new name is another tag's — merging two labels is a different
 * operation with a different cost (every contact on one moves to the other, and the
 * sequences pointing at it change meaning), and silently doing it because the names
 * collided would be the worst possible way to offer it.
 */
func (s *Store) RenameTag(ctx context.Context, hostID, id, name string) (types.CRMTag, error) {
	clean := tagName(name)
	if clean == "" || len(clean) > types.TagMaxLength {
		return types.CRMTag{}, ErrInvalid
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_tags SET name = $3
		 WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID, clean)
	if isUniqueViolation(err) {
		return types.CRMTag{}, ErrConflict
	}
	if err != nil {
		return types.CRMTag{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.CRMTag{}, ErrNotFound
	}
	return tagByID(ctx, s.pool, hostID, id)
}

/* DeleteTag removes a label from the account and from everybody who carries it.
 *
 * The contacts go with it by CASCADE, which is right: a label that no longer exists is
 * not a fact about anybody. Bot steps that set it survive with nothing to apply (SET
 * NULL), and the builder shows them as broken.
 *
 * ErrInUse when a sequence triggers on it. That one is RESTRICT at the schema level
 * because NULL in crm_drips.trigger_tag_id means "any tag": clearing it would widen the
 * rule from one label to every label and start messaging people the host never chose. So
 * the sequence has to stop naming it first, and the handler says which sequence.
 */
func (s *Store) DeleteTag(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM crm_tags WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID)
	if isForeignKeyViolation(err) {
		return ErrInUse
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* DripsUsingTag names the sequences that trigger on a tag, for the refusal above.
 *
 * Read after the failure rather than before the delete, so the check that decides is the
 * database's own constraint and this is only the explanation.
 */
func (s *Store) DripsUsingTag(ctx context.Context, hostID, tagID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT name FROM crm_drips
		 WHERE host_id = $1 AND trigger_tag_id = $2::uuid
		 ORDER BY lower(name) LIMIT 5`, hostID, tagID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

/* AddContactTag puts a label on a contact and reports whether it was new.
 *
 * The boolean is what makes the `tag_added` trigger honest: re-applying a tag somebody
 * already carries must not restart a sequence, and the only place that can tell is the
 * insert. ON CONFLICT DO NOTHING, and a second call returns false.
 *
 * Both ids are checked against the host in one statement — the SELECTs in the VALUES do
 * the scoping, so a tag from another account inserts nothing and comes back ErrNotFound
 * rather than being written against a contact it has no business on.
 */
func (s *Store) AddContactTag(ctx context.Context, hostID, contactID, tagID string) (bool, error) {
	var inserted bool
	err := s.pool.QueryRow(ctx, `
		WITH ok AS (
		     SELECT c.id AS contact_id, t.id AS tag_id
		       FROM crm_contacts c, crm_tags t
		      WHERE c.id = $2::uuid AND c.host_id = $1::uuid
		        AND t.id = $3::uuid AND t.host_id = $1::uuid
		), ins AS (
		     INSERT INTO crm_contact_tags (contact_id, tag_id)
		     SELECT contact_id, tag_id FROM ok
		     ON CONFLICT DO NOTHING
		     RETURNING 1
		)
		SELECT EXISTS (SELECT 1 FROM ins) FROM ok`, hostID, contactID, tagID).Scan(&inserted)
	if noRows(err) {
		// The WITH matched nothing: one of the two ids is not this host's.
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	return inserted, nil
}

/* RemoveContactTag takes a label off a contact.
 *
 * Silent when it was not there. Unlike adding, nothing downstream depends on whether this
 * changed anything — no trigger fires on a tag being removed — and a host clicking the
 * chip away twice has got what they wanted both times.
 */
func (s *Store) RemoveContactTag(ctx context.Context, hostID, contactID, tagID string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM crm_contact_tags ct
		 USING crm_contacts c
		 WHERE ct.contact_id = c.id AND c.host_id = $1::uuid
		   AND ct.contact_id = $2::uuid AND ct.tag_id = $3::uuid`, hostID, contactID, tagID)
	return err
}

/* ContactTags reads one contact's labels, alphabetically.
 *
 * No count on these: the number of contacts carrying a tag is a fact about the tag, and
 * asking for it once per chip on a thread would be a subquery per label per read.
 */
func (s *Store) ContactTags(ctx context.Context, hostID, contactID string) ([]types.CRMTag, error) {
	byContact, err := tagsForContacts(ctx, s.pool, hostID, []string{contactID})
	if err != nil {
		return nil, err
	}
	if tags := byContact[contactID]; tags != nil {
		return tags, nil
	}
	return []types.CRMTag{}, nil
}

/* AttachTags fills in the Tags on a page of contacts.
 *
 * One extra query for the whole page rather than a join on the contacts list. The list
 * query is already a LATERAL for the last message, and adding a second one-to-many to it
 * would multiply the rows and force the aggregation into SQL for no gain — whereas this is
 * one indexed read keyed by the ids already in hand.
 *
 * Contacts with no tags are left with an empty list, never nil: see CRMContact.Tags.
 */
func (s *Store) AttachTags(ctx context.Context, hostID string, contacts []types.CRMContact) error {
	ids := make([]string, 0, len(contacts))
	for _, c := range contacts {
		ids = append(ids, c.ID)
	}
	byContact, err := tagsForContacts(ctx, s.pool, hostID, ids)
	if err != nil {
		return err
	}
	for i := range contacts {
		if tags := byContact[contacts[i].ID]; tags != nil {
			contacts[i].Tags = tags
		} else {
			contacts[i].Tags = []types.CRMTag{}
		}
	}
	return nil
}

func tagsForContacts(ctx context.Context, q querier, hostID string, contactIDs []string) (map[string][]types.CRMTag, error) {
	out := map[string][]types.CRMTag{}
	if len(contactIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT ct.contact_id::text, t.id::text, t.name, t.created_at
		  FROM crm_contact_tags ct
		  JOIN crm_tags t ON t.id = ct.tag_id
		  JOIN crm_contacts c ON c.id = ct.contact_id
		 WHERE c.host_id = $1 AND ct.contact_id = ANY($2::uuid[])
		 ORDER BY lower(t.name), t.id`, hostID, contactIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			contactID string
			t         types.CRMTag
			created   time.Time
		)
		if err := rows.Scan(&contactID, &t.ID, &t.Name, &created); err != nil {
			return nil, err
		}
		t.CreatedAt = created.Format(time.RFC3339)
		out[contactID] = append(out[contactID], t)
	}
	return out, rows.Err()
}
