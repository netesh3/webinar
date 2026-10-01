package store

import "context"

/* ZoomConnection is one host's grant. Refresh is ciphertext. Callers must not
 * log it, and must not log zoom_start_url or a registrant's join URL.
 */
type ZoomConnection struct {
	UserID     string
	ZoomUserID string
	AccountID  string
	Email      string
	Refresh    []byte
	Invalid    bool
}

func (s *Store) ZoomConnection(ctx context.Context, userID string) (ZoomConnection, error) {
	var c ZoomConnection
	err := s.pool.QueryRow(ctx, `
		SELECT user_id::text, zoom_user_id, zoom_account_id, email, refresh_token, token_invalid
		  FROM zoom_connections
		 WHERE user_id = $1::uuid`, userID).Scan(
		&c.UserID, &c.ZoomUserID, &c.AccountID, &c.Email, &c.Refresh, &c.Invalid)
	if noRows(err) {
		return ZoomConnection{}, ErrNotFound
	}
	return c, err
}

func (s *Store) SaveZoomConnection(ctx context.Context, c ZoomConnection) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO zoom_connections
			(user_id, zoom_user_id, zoom_account_id, email, refresh_token, token_invalid, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, false, now())
		ON CONFLICT (user_id) DO UPDATE SET
			zoom_user_id = EXCLUDED.zoom_user_id,
			zoom_account_id = EXCLUDED.zoom_account_id,
			email = EXCLUDED.email,
			refresh_token = EXCLUDED.refresh_token,
			token_invalid = false,
			updated_at = now()`,
		c.UserID, c.ZoomUserID, c.AccountID, c.Email, c.Refresh)
	return err
}

func (s *Store) SaveZoomRefresh(ctx context.Context, userID string, cipher []byte) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE zoom_connections
		   SET refresh_token = $2, token_invalid = false, updated_at = now()
		 WHERE user_id = $1::uuid`, userID, cipher)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) MarkZoomInvalid(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE zoom_connections SET token_invalid = true, updated_at = now()
		 WHERE user_id = $1::uuid`, userID)
	return err
}

func (s *Store) DeleteZoomConnection(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM zoom_connections WHERE user_id = $1::uuid`, userID)
	return err
}

func (s *Store) DeleteZoomByZoomUser(ctx context.Context, zoomUserID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM zoom_connections WHERE zoom_user_id = $1`, zoomUserID)
	return err
}

/* SetWebinarZoom writes the venue and the Zoom id. startURL is the host link.
 * It is stored and never selected onto the public webinar. */
func (s *Store) SetWebinarZoom(ctx context.Context, slug, venue, zoomID, startURL string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars
		   SET venue = $2, zoom_id = $3, zoom_start_url = $4, updated_at = now()
		 WHERE slug = $1`, slug, venue, zoomID, startURL)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ZoomStartURL(ctx context.Context, slug string) (string, error) {
	var u string
	err := s.pool.QueryRow(ctx, `SELECT zoom_start_url FROM webinars WHERE slug = $1`, slug).Scan(&u)
	if noRows(err) {
		return "", ErrNotFound
	}
	return u, err
}

func (s *Store) SetZoomStartURL(ctx context.Context, slug, startURL string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET zoom_start_url = $2, updated_at = now() WHERE slug = $1`, slug, startURL)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SaveZoomRegistrant(ctx context.Context, regID, registrantID, joinURL, note string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE registrations
		   SET zoom_registrant_id = $2, zoom_join_url = $3, zoom_push_error = $4
		 WHERE id = $1::uuid`, regID, registrantID, joinURL, note)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ZoomPushNote(ctx context.Context, regID string) (string, error) {
	var note string
	err := s.pool.QueryRow(ctx, `
		SELECT coalesce(zoom_push_error, '') FROM registrations WHERE id = $1::uuid`, regID).Scan(&note)
	if noRows(err) {
		return "", ErrNotFound
	}
	return note, err
}

func (s *Store) RegistrationZoomJoin(ctx context.Context, regID string) (string, error) {
	var u string
	err := s.pool.QueryRow(ctx, `
		SELECT coalesce(zoom_join_url, '') FROM registrations WHERE id = $1::uuid`, regID).Scan(&u)
	if noRows(err) {
		return "", ErrNotFound
	}
	return u, err
}

func (s *Store) ZoomPushedCount(ctx context.Context, slug string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND r.zoom_registrant_id <> ''`, slug).Scan(&n)
	return n, err
}
