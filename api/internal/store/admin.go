package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Granting the hosting capability.
 *
 * There used to be no such thing: hosting was a checkbox on the signup form and a field on the
 * profile form, so anybody who reached the site could create webinars and start collecting
 * strangers' names, emails and phone numbers. This file is the replacement — one writer for
 * can_host, reachable only by an admin.
 *
 * The chain has to start outside the application. There is deliberately no method here that
 * makes somebody an admin from a request: a privilege that can be granted in-band can be
 * granted by whoever takes over a single account, and then the distinction has bought nothing.
 * PromoteAdmins reads a list an operator set in the environment, at boot.
 */

/* EnsureAdminAccount creates an admin's account if it is not there, and does nothing if it is.
 *
 * The gap this closes: PromoteAdmins can only promote an account that already exists, so on a
 * fresh database — or after the data is cleared — ADMIN_EMAILS named somebody who had to sign up
 * through the public form before they could administer anything. That is a chicken-and-egg
 * problem on every new deployment.
 *
 * CREATE-IF-MISSING, never update. An existing account is left completely alone, including its
 * password. The alternative — resetting the password to match the environment on every boot —
 * would mean an admin who rotated their password silently had it reverted by the next deploy,
 * and would make ADMIN_PASSWORD a permanent back door into a live account rather than a
 * bootstrap value.
 *
 * Reports whether it created anything, so the caller can log a privilege-creating event
 * rather than leaving it to be inferred.
 */
func (s *Store) EnsureAdminAccount(ctx context.Context, email, name, passwordHash string) (bool, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || passwordHash == "" {
		return false, nil
	}

	// can_host false here: PromoteAdmins sets both is_admin and can_host immediately after, and
	// having one writer for those two columns is what keeps them from disagreeing.
	_, err := s.CreateUser(ctx, email, passwordHash, name, "", "", false)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, ErrConflict):
		// Already there. The whole point.
		return false, nil
	default:
		return false, err
	}
}

/* NameFromEmail is a passable display name for an account nobody filled in a form for.
 *
 * "admin@gmail.com" becomes "Admin". Crude, and better than an empty name: the avatar derives
 * its initials from this, and a blank one renders as an empty circle in every roster.
 */
func NameFromEmail(email string) string {
	local := strings.SplitN(strings.TrimSpace(email), "@", 2)[0]
	local = strings.NewReplacer(".", " ", "_", " ", "-", " ", "+", " ").Replace(local)
	parts := strings.Fields(local)
	for i, part := range parts {
		r := []rune(part)
		parts[i] = strings.ToUpper(string(r[:1])) + string(r[1:])
	}
	if len(parts) == 0 {
		return "Administrator"
	}
	return strings.Join(parts, " ")
}

/* PromoteAdmins reconciles the admin set with the operator's list, and does it in both
 * directions.
 *
 * Removing an email from ADMIN_EMAILS therefore demotes that account on the next restart,
 * which is the behaviour an operator expects from a config value: the file says who the admins
 * are, not who they have ever been. A one-way version would mean a departing admin keeps the
 * privilege until somebody remembers there is no UI for taking it away.
 *
 * Emails that match no account are ignored rather than erroring. An operator naming somebody
 * who has not signed up yet is a normal sequence — put them in the config, they create an
 * account, they are an admin on the next boot — and refusing to start over it would turn a
 * typo into an outage.
 */
func (s *Store) PromoteAdmins(ctx context.Context, emails []string) (promoted, demoted int, err error) {
	clean := make([]string, 0, len(emails))
	for _, e := range emails {
		if t := strings.ToLower(strings.TrimSpace(e)); t != "" {
			clean = append(clean, t)
		}
	}

	// Demote first, so a list that is emptied really does clear the set.
	tag, err := s.pool.Exec(ctx, `
		UPDATE users SET is_admin = false
		 WHERE is_admin AND lower(email) <> ALL($1)`, clean)
	if err != nil {
		return 0, 0, err
	}
	demoted = int(tag.RowsAffected())

	if len(clean) == 0 {
		return 0, demoted, nil
	}

	/* An admin is also given can_host.
	 *
	 * Not for tidiness: an admin who cannot host has no way to try the thing they are
	 * granting, and the first question anybody asks after being made an admin is "does this
	 * work". It is also the bootstrap path — on a fresh deployment the operator's own account
	 * is the only one that can do anything at all.
	 */
	tag, err = s.pool.Exec(ctx, `
		UPDATE users SET is_admin = true, can_host = true
		 WHERE lower(email) = ANY($1) AND NOT is_admin`, clean)
	if err != nil {
		return 0, demoted, err
	}
	return int(tag.RowsAffected()), demoted, nil
}

/* SetHostCapability is the only writer of can_host outside PromoteAdmins.
 *
 * Returns ErrNotFound for an unknown id so the handler can answer 404 rather than reporting a
 * successful no-op — an admin who mistypes an id needs to know the grant did not land.
 */
func (s *Store) SetHostCapability(ctx context.Context, userID string, canHost bool) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET can_host = $2 WHERE id = $1
		RETURNING `+userColumns, userID, canHost))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* AdminUsers lists every account for the admin panel.
 *
 * Includes the count of webinars each account owns, because that is the fact an admin needs
 * before revoking: taking hosting from somebody who owns scheduled sessions leaves those
 * sessions with registrants attached and nobody able to start them. The UI warns on it rather
 * than refusing — an operator removing a departed colleague genuinely does want that — but it
 * cannot warn about a number it was not given.
 */
func (s *Store) AdminUsers(ctx context.Context, search string, limit int) ([]types.AdminUser, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// Empty search matches everything: ILIKE '%%' rather than a second query.
	like := "%" + strings.ToLower(strings.TrimSpace(search)) + "%"

	rows, err := s.pool.Query(ctx, `
		SELECT u.id::text, u.email, u.name, u.title, u.org, u.initials, u.hue,
		       u.can_host, u.is_admin, u.created_at,
		       (SELECT count(*) FROM webinars w WHERE w.host_id = u.id)
		  FROM users u
		 WHERE lower(u.email) LIKE $1 OR lower(u.name) LIKE $1
		 ORDER BY u.is_admin DESC, u.can_host DESC, u.created_at DESC
		 LIMIT $2`, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.AdminUser{}
	for rows.Next() {
		var (
			u         types.AdminUser
			createdAt time.Time
		)
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Title, &u.Org, &u.Initials,
			&u.Hue, &u.CanHost, &u.IsAdmin, &createdAt, &u.WebinarCount); err != nil {
			return nil, err
		}
		u.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, u)
	}
	return out, rows.Err()
}
