package crmstore

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Contact imports and saved lists. See migrations/0111.
 *
 * Every query filters on the host, as the rest of the CRM does: these rows are other
 * people's phone numbers, and a list or import id from another account reads as
 * store.ErrNotFound.
 */

// ImportPerson is one person an import writes, already normalised by the caller.
type ImportPerson struct {
	Name       string
	Email      string
	Phone      string
	ServiceTag string
	Attributes map[string]string
}

// CreateImport stores an upload for preview, keeping the file for the commit.
func (s *Store) CreateImport(ctx context.Context, hostID, fileName, raw string, counts any) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO crm_imports (host_id, file_name, raw, counts)
		VALUES ($1::uuid, $2, $3, $4) RETURNING id::text`,
		hostID, fileName, raw, counts).Scan(&id)
	return id, err
}

// ImportFile is a previewed upload waiting to be committed.
func (s *Store) ImportFile(ctx context.Context, hostID, id string) (fileName, raw, status string, err error) {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return "", "", "", store.ErrNotFound
	}
	err = s.pool.QueryRow(ctx, `
		SELECT file_name, raw, status FROM crm_imports
		 WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID).Scan(&fileName, &raw, &status)
	if noRows(err) {
		return "", "", "", store.ErrNotFound
	}
	return fileName, raw, status, err
}

// ExistingContacts counts how many of these people the host already has, by phone or email.
func (s *Store) ExistingContacts(ctx context.Context, hostID string, phones, emails []string) (int, error) {
	if phones == nil {
		phones = []string{}
	}
	if emails == nil {
		emails = []string{}
	}
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM crm_contacts c
		 WHERE c.host_id = $1::uuid
		   AND ((c.phone <> '' AND c.phone = ANY($2::text[]))
		     OR (c.email <> '' AND lower(c.email) = ANY($3::text[])))`,
		hostID, phones, emails).Scan(&n)
	return n, err
}

/* CommitImport writes a previewed import in one transaction: the contacts, the list,
 * the service tags, and — only when the host confirmed it — the WhatsApp opt-in.
 *
 * A contact is matched by phone, then by email, and only blanks are filled: an import
 * never renames somebody or overwrites a number. Consent is recorded only for people
 * with no opt-in and no opt-out on file, so an import never opts back in someone who
 * asked to stop. No drip or bot trigger fires: the service tags are written directly,
 * because a coach importing 900 students did not mean to start a sequence for each. */
func (s *Store) CommitImport(ctx context.Context, hostID, importID, listID, listName string, consent bool,
	people []ImportPerson, invalid int) (types.CRMImportResult, error) {
	var res types.CRMImportResult
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx, `
		SELECT status FROM crm_imports WHERE id = $1::uuid AND host_id = $2::uuid FOR UPDATE`,
		importID, hostID).Scan(&status)
	if noRows(err) {
		return res, store.ErrNotFound
	}
	if err != nil {
		return res, err
	}
	if status != "preview" {
		return res, store.ErrConflict
	}

	var name string
	if listID != "" {
		// Into an existing list: it has to be this host's. Members already on it stay once.
		if !uuidPattern.MatchString(listID) {
			return res, store.ErrNotFound
		}
		err := tx.QueryRow(ctx, `
			UPDATE crm_lists SET updated_at = now()
			 WHERE id = $1::uuid AND host_id = $2::uuid RETURNING name`, listID, hostID).Scan(&name)
		if noRows(err) {
			return res, store.ErrNotFound
		}
		if err != nil {
			return res, err
		}
	} else {
		listID, name, err = createList(ctx, tx, hostID, listName)
		if err != nil {
			return res, err
		}
	}

	tags := map[string]string{}
	var tagCount int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM crm_tags WHERE host_id = $1::uuid`, hostID).Scan(&tagCount); err != nil {
		return res, err
	}
	for _, p := range people {
		attrs, _ := json.Marshal(p.Attributes)
		var id string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM crm_contacts
			 WHERE host_id = $1::uuid AND ((phone <> '' AND phone = $2) OR ($3 <> '' AND lower(email) = $3))
			 ORDER BY (phone = $2) DESC LIMIT 1`, hostID, p.Phone, p.Email).Scan(&id)
		switch {
		case noRows(err):
			if err := tx.QueryRow(ctx, `
				INSERT INTO crm_contacts (host_id, phone, email, name, source, attributes)
				VALUES ($1::uuid, $2, $3, $4, 'import', $5) RETURNING id::text`,
				hostID, p.Phone, p.Email, p.Name, attrs).Scan(&id); err != nil {
				return res, err
			}
			res.Created++
		case err != nil:
			return res, err
		default:
			if _, err := tx.Exec(ctx, `
				UPDATE crm_contacts c SET
				       name = CASE WHEN c.name = '' THEN $3 ELSE c.name END,
				       phone = CASE WHEN c.phone = '' THEN $4 ELSE c.phone END,
				       email = CASE WHEN c.email = '' AND $5 <> '' AND NOT EXISTS (
				                  SELECT 1 FROM crm_contacts o WHERE o.host_id = c.host_id
				                     AND lower(o.email) = $5 AND o.id <> c.id) THEN $5 ELSE c.email END,
				       attributes = c.attributes || $6::jsonb
				 WHERE c.id = $1::uuid AND c.host_id = $2::uuid`,
				id, hostID, p.Name, p.Phone, p.Email, attrs); err != nil {
				return res, err
			}
			res.Updated++
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm_list_members (list_id, contact_id) VALUES ($1::uuid, $2::uuid)
			ON CONFLICT DO NOTHING`, listID, id); err != nil {
			return res, err
		}
		if p.ServiceTag != "" {
			tagID, ok := tags[strings.ToLower(p.ServiceTag)]
			if !ok {
				err := tx.QueryRow(ctx, `
					SELECT id::text FROM crm_tags WHERE host_id = $1::uuid AND lower(name) = lower($2)`,
					hostID, p.ServiceTag).Scan(&tagID)
				if noRows(err) && tagCount < types.TagMaxPerHost {
					err = tx.QueryRow(ctx, `
						INSERT INTO crm_tags (host_id, name) VALUES ($1::uuid, $2) RETURNING id::text`,
						hostID, p.ServiceTag).Scan(&tagID)
					tagCount++
				} else if noRows(err) {
					err = nil // at the tag limit: the attribute still records the service
				}
				if err != nil {
					return res, err
				}
				tags[strings.ToLower(p.ServiceTag)] = tagID
			}
			if tagID != "" {
				if _, err := tx.Exec(ctx, `
					INSERT INTO crm_contact_tags (contact_id, tag_id) VALUES ($1::uuid, $2::uuid)
					ON CONFLICT DO NOTHING`, id, tagID); err != nil {
					return res, err
				}
			}
		}
		var optedOut bool
		if err := tx.QueryRow(ctx, `
			SELECT whatsapp_opt_out_at IS NOT NULL
			   AND (whatsapp_opt_in_at IS NULL OR whatsapp_opt_out_at >= whatsapp_opt_in_at)
			  FROM crm_contacts WHERE id = $1::uuid`, id).Scan(&optedOut); err != nil {
			return res, err
		}
		if optedOut {
			res.OptedOut++
			continue
		}
		if consent {
			tag, err := tx.Exec(ctx, `
				UPDATE crm_contacts SET whatsapp_opt_in_at = now(),
				       whatsapp_opt_in_source = 'import', whatsapp_opt_in_import_id = $2::uuid
				 WHERE id = $1::uuid AND whatsapp_opt_in_at IS NULL AND whatsapp_opt_out_at IS NULL`,
				id, importID)
			if err != nil {
				return res, err
			}
			res.OptedIn += int(tag.RowsAffected())
		}
	}
	res.Invalid = invalid

	counts, _ := json.Marshal(map[string]int{
		"created": res.Created, "updated": res.Updated, "optedIn": res.OptedIn,
		"optedOut": res.OptedOut, "invalid": res.Invalid,
	})
	if _, err := tx.Exec(ctx, `
		UPDATE crm_imports SET status = 'committed', raw = '', list_id = $3::uuid,
		       consent_confirmed = $4, confirmed_by = CASE WHEN $4 THEN $2::uuid END,
		       confirmed_at = CASE WHEN $4 THEN now() END, counts = $5, committed_at = now()
		 WHERE id = $1::uuid AND host_id = $2::uuid`, importID, hostID, listID, consent, counts); err != nil {
		return res, err
	}
	l, err := listByID(ctx, tx, hostID, listID)
	if err != nil {
		return res, err
	}
	l.Name = name
	res.List = l
	return res, tx.Commit(ctx)
}

/* createList makes a list, numbering the name when the host already has one by that
 * name ("Students", "Students (2)") rather than refusing the import. */
func createList(ctx context.Context, tx pgx.Tx, hostID, name string) (string, string, error) {
	base := strings.Join(strings.Fields(name), " ")
	if r := []rune(base); len(r) > 110 {
		base = strings.TrimSpace(string(r[:110]))
	}
	if base == "" {
		base = "Imported contacts"
	}
	for n := 1; n <= 50; n++ {
		candidate := base
		if n > 1 {
			candidate = base + " (" + strconv.Itoa(n) + ")"
		}
		var id string
		err := tx.QueryRow(ctx, `
			INSERT INTO crm_lists (host_id, name) VALUES ($1::uuid, $2)
			ON CONFLICT (host_id, lower(name)) DO NOTHING RETURNING id::text`, hostID, candidate).Scan(&id)
		if noRows(err) {
			continue
		}
		return id, candidate, err
	}
	return "", "", store.ErrConflict
}

const listColumns = `
	SELECT l.id::text, l.name, l.source, l.created_at, l.updated_at,
	       (SELECT count(*) FROM crm_list_members m WHERE m.list_id = l.id),
	       (SELECT count(*) FROM crm_list_members m JOIN crm_contacts c ON c.id = m.contact_id
	         WHERE m.list_id = l.id AND ` + optedInNow + `)
	  FROM crm_lists l`

func scanList(row pgx.Row) (types.CRMList, error) {
	var l types.CRMList
	var created, updated time.Time
	if err := row.Scan(&l.ID, &l.Name, &l.Source, &created, &updated, &l.Size, &l.OptedIn); err != nil {
		return l, err
	}
	l.CreatedAt = created.Format(time.RFC3339)
	l.UpdatedAt = updated.Format(time.RFC3339)
	return l, nil
}

/* RenameList renames a saved list. A name another of the host's lists has is
 * store.ErrConflict; a blank or over-long name is store.ErrInvalid. */
func (s *Store) RenameList(ctx context.Context, hostID, id, name string) (types.CRMList, error) {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return types.CRMList{}, store.ErrNotFound
	}
	clean := strings.Join(strings.Fields(name), " ")
	if clean == "" || len([]rune(clean)) > 120 {
		return types.CRMList{}, store.ErrInvalid
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_lists SET name = $3, updated_at = now()
		 WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID, clean)
	if isUniqueViolation(err) {
		return types.CRMList{}, store.ErrConflict
	}
	if err != nil {
		return types.CRMList{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.CRMList{}, store.ErrNotFound
	}
	return listByID(ctx, s.pool, hostID, id)
}

func listByID(ctx context.Context, q querier, hostID, id string) (types.CRMList, error) {
	l, err := scanList(q.QueryRow(ctx, listColumns+` WHERE l.id = $1::uuid AND l.host_id = $2::uuid`, id, hostID))
	if noRows(err) {
		return types.CRMList{}, store.ErrNotFound
	}
	return l, err
}

// List reads one of the host's saved lists.
func (s *Store) List(ctx context.Context, hostID, id string) (types.CRMList, error) {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return types.CRMList{}, store.ErrNotFound
	}
	return listByID(ctx, s.pool, hostID, id)
}

// Lists returns the host's saved lists, newest first.
func (s *Store) Lists(ctx context.Context, hostID string) ([]types.CRMList, error) {
	rows, err := s.pool.Query(ctx, listColumns+` WHERE l.host_id = $1::uuid ORDER BY l.updated_at DESC, l.created_at DESC`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.CRMList{}
	for rows.Next() {
		l, err := scanList(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// DeleteList removes a saved list. The contacts stay; broadcasts that used it keep their copies.
func (s *Store) DeleteList(ctx context.Context, hostID, id string) error {
	if !uuidPattern.MatchString(strings.TrimSpace(id)) {
		return store.ErrNotFound
	}
	tag, err := s.pool.Exec(ctx, `DELETE FROM crm_lists WHERE id = $1::uuid AND host_id = $2::uuid`, id, hostID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}
