package store

import (
	"context"

	"github.com/netkumar/webcast/api/types"
)

/* SetAccountKind is an admin moving an account between the customer list and the
 * webinar-audience list. Records who did it and when. Moving does not grant or
 * take away hosting; that stays SetHostCapability. */
func (s *Store) SetAccountKind(ctx context.Context, userID string, kind types.AccountKind, adminID string) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET account_kind = $2, account_kind_set_by = NULLIF($3, '')::uuid, account_kind_set_at = now()
		 WHERE id = $1::uuid
		RETURNING `+userColumns, userID, string(kind), adminID))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* PromoteToCustomer makes an audience account a customer, because it did
 * something only a customer does: signed in from the app itself, paid, started
 * a trial, or was given a plan or hosting. A no-op for a customer already.
 * set_by stays empty, which is how an automatic move reads apart from an admin's. */
func (s *Store) PromoteToCustomer(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET account_kind = 'customer', account_kind_set_by = NULL, account_kind_set_at = now()
		 WHERE id = $1::uuid AND account_kind = 'audience'`, userID)
	return err
}

// MarkAudience records that an account just created came from a webinar page.
func (s *Store) MarkAudience(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET account_kind = 'audience' WHERE id = $1::uuid`, userID)
	return err
}

// AdminAccountCounts is the size of each admin list.
func (s *Store) AdminAccountCounts(ctx context.Context) (types.AdminAccountCounts, error) {
	var c types.AdminAccountCounts
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE account_kind = 'customer'),
		       count(*) FILTER (WHERE account_kind = 'audience')
		  FROM users`).Scan(&c.Customers, &c.Audience)
	return c, err
}
