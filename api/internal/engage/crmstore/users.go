package crmstore

/* The users.whatsapp_* columns: a host's connected WhatsApp Business number.

They sit on the users row, which the core store reads (store.User carries them so /me can
say whether a host is connected), but only the CRM writes them — through the three
functions below — and only the CRM looks a user up by them.
*/

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

/* SetUserWhatsAppRegistered records that this host's number has been registered with
 * Cloud API. The PIN that did it is not a parameter: see migrations/0048.
 */
func (s *Store) SetUserWhatsAppRegistered(ctx context.Context, userID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET whatsapp_registered_at = now() WHERE id = $1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

/* UserByWhatsAppPhoneNumberID finds the host a webhook delivery belongs to.
 *
 * Meta says which number a message arrived on and nothing about which account of
 * ours owns it, so this is the whole of the routing: one phone-number id, one
 * host, one CRM. It is also the only user lookup in this package that is driven by
 * a stranger's request rather than a session, which is why the caller treats an
 * unknown id as "not ours, drop it" instead of an error.
 *
 * The id stays unique across accounts by Meta's own arrangement — a WhatsApp
 * number belongs to exactly one WABA — and a host who disconnects has the column
 * cleared, so a former host's traffic stops resolving to them.
 */
func (s *Store) UserByWhatsAppPhoneNumberID(ctx context.Context, phoneNumberID string) (store.User, error) {
	id := strings.TrimSpace(phoneNumberID)
	if id == "" {
		return store.User{}, store.ErrNotFound
	}
	/* The id first, then the ordinary user read: the column list and scanner for a user
	 * belong to the core store, and a webhook costs one extra indexed lookup for it. */
	var userID string
	err := s.pool.QueryRow(ctx, `
		SELECT id::text FROM users
		 WHERE whatsapp_phone_number_id = $1 AND whatsapp_access_token <> ''
		 ORDER BY whatsapp_connected_at DESC NULLS LAST LIMIT 1`, id).Scan(&userID)
	if noRows(err) {
		return store.User{}, store.ErrNotFound
	}
	if err != nil {
		return store.User{}, err
	}
	return s.UserByID(ctx, userID)
}

/* SetUserWhatsApp stores the grant Embedded Signup produced, or clears it.
 *
 * An empty token is the disconnect: every other column goes with it, including
 * the ids, so a half-cleared row can never be read as "connected to something,
 * details unknown". whatsapp_connected_at is derived here rather than passed in —
 * it is the time the grant was stored, which is a fact this function owns.
 *
 * expiresAt is nil for the usual non-expiring business token; see wa.Token.
 */
func (s *Store) SetUserWhatsApp(ctx context.Context, userID, token, wabaID, phoneNumberID, displayPhone, verifiedName string, expiresAt *time.Time) error {
	connectedAt := (*time.Time)(nil)
	if strings.TrimSpace(token) != "" {
		now := time.Now().UTC()
		connectedAt = &now
	} else {
		// Disconnecting: drop everything, not just the token.
		wabaID, phoneNumberID, displayPhone, verifiedName, expiresAt = "", "", "", "", nil
	}

	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET whatsapp_access_token = $2,
		       whatsapp_waba_id = $3,
		       whatsapp_phone_number_id = $4,
		       whatsapp_display_phone = $5,
		       whatsapp_verified_name = $6,
		       whatsapp_token_expires_at = $7,
		       whatsapp_connected_at = $8
		 WHERE id = $1`,
		userID, token, wabaID, phoneNumberID, displayPhone, verifiedName, expiresAt, connectedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}
