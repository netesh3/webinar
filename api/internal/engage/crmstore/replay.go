package crmstore

import "context"

// ReplayRecipient is one approved registrant who is also a contact with a phone.
type ReplayRecipient struct {
	RegistrationID string
	Email          string
	Name           string
	ContactID      string
	Phone          string
	// OptIn is the computed consent: opted in, and not opted out since.
	OptIn bool
}

/* WhatsAppReplayRecipients is the WhatsApp half of store.ReplayRecipients: the same approved
 * registrants, each with the CRM contact they became, if any.
 *
 * The contact is matched two ways. A contact carries the registration that created it,
 * which is the exact link — but only for the FIRST webinar that person registered for,
 * because UpsertContact keeps the original. Everyone else is matched by address,
 * lower-cased, the same rule UpsertContact matched them by. DISTINCT ON keeps one row per
 * registration when both match, preferring the exact one.
 *
 * Phone is not matched on: the numbers in crm_contacts are normalised and the ones in
 * registrations are whatever somebody typed. Missing one costs a WhatsApp message the
 * email already covers, which is the right way for this to fail. A best match with no
 * phone is returned as it is (Phone empty) rather than swapped for a worse one that has a
 * phone, so the caller decides, exactly as the combined query used to.
 */
func (s *Store) WhatsAppReplayRecipients(ctx context.Context, slug string, limit int) ([]ReplayRecipient, error) {
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (r.id)
		       r.id::text, r.email,
		       btrim(btrim(r.first_name) || ' ' || btrim(r.last_name)),
		       c.id::text, c.phone,
		       (c.whatsapp_opt_in_at IS NOT NULL
		        AND (c.whatsapp_opt_out_at IS NULL OR c.whatsapp_opt_in_at > c.whatsapp_opt_out_at))
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		  JOIN crm_contacts c
		    ON c.host_id = w.host_id
		   AND (c.registration_id = r.id OR lower(c.email) = lower(r.email))
		 WHERE w.slug = $1 AND r.state = 'approved' AND r.email <> ''
		 ORDER BY r.id, (c.registration_id = r.id) DESC NULLS LAST, c.created_at
		 LIMIT $2`, slug, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ReplayRecipient{}
	for rows.Next() {
		var p ReplayRecipient
		if err := rows.Scan(&p.RegistrationID, &p.Email, &p.Name,
			&p.ContactID, &p.Phone, &p.OptIn); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
