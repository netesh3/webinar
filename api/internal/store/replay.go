package store

import (
	"context"
)

/* Who to tell when a recording is published.
 *
 * The replay is the one message this application owed people and never sent. A host
 * records a session, switches the recording to public, copies the link — and then has
 * to go and find the four hundred addresses themselves, in a spreadsheet, outside the
 * product that already knows every one of them.
 *
 * Email only. The CRM's WhatsApp version of the same list, which joins its contacts for a
 * phone number and consent, is engage/crmstore.WhatsAppReplayRecipients.
 */

// ReplayRecipient is one person owed the replay of a webinar.
type ReplayRecipient struct {
	RegistrationID string
	Email          string
	Name           string
}

/* ReplayRecipients lists the approved registrants of one webinar.
 *
 * Only 'approved', and only with an address: a declined registration is somebody the
 * host decided not to admit, and sending them the recording afterwards would hand
 * over the thing they were refused.
 */
func (s *Store) ReplayRecipients(ctx context.Context, slug string, limit int) ([]ReplayRecipient, error) {
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.email,
		       btrim(btrim(r.first_name) || ' ' || btrim(r.last_name))
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND r.state = 'approved' AND r.email <> ''
		 ORDER BY r.id
		 LIMIT $2`, slug, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ReplayRecipient{}
	for rows.Next() {
		var p ReplayRecipient
		if err := rows.Scan(&p.RegistrationID, &p.Email, &p.Name); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
