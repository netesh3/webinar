package crmstore

import "context"

/* ContactOptedIn reports whether this host already has the person as a contact who
 * may be messaged on WhatsApp: matched by normalised phone or by email, opted in and
 * not opted out since. The webinar register flow asks for consent when this is false.
 * Consent is per host, so another coach's opt-in never counts. */
func (s *Store) ContactOptedIn(ctx context.Context, hostID, email, phone string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM crm_contacts c
		   WHERE c.host_id = $1::uuid
		     AND (($3 <> '' AND c.phone = $3) OR ($2 <> '' AND lower(c.email) = lower($2)))
		     AND `+optedInNow+`)`, hostID, email, normalisePhone(phone)).Scan(&ok)
	return ok, err
}
