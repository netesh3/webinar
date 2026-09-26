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
	_, err := s.CreateUser(ctx, email, passwordHash, name, "", "", "", false)
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

/* SetUserMaxDuration configures a custom maximum meeting length in minutes for an account.
 * Passing nil resets the account to use the system default.
 */
func (s *Store) SetUserMaxDuration(ctx context.Context, userID string, maxDurationMin *int) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET max_duration_min = $2 WHERE id = $1
		RETURNING `+userColumns, userID, maxDurationMin))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* SetCdnBroadcastCapability configures whether an account's webinars stream to attendees via CDN HLS.
 */
func (s *Store) SetCdnBroadcastCapability(ctx context.Context, userID string, canCdnBroadcast bool) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users SET can_cdn_broadcast = $2 WHERE id = $1
		RETURNING `+userColumns, userID, canCdnBroadcast))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* SetFeature switches one per-account feature on or off.
 *
 * Set arithmetic in SQL rather than read-modify-write in Go, which is what makes it
 * safe for two admins on two screens: array_remove then append touches only the key
 * being changed, so a request about `crm_tags` cannot undo a decision about
 * `replay_links` somebody made a second earlier. Turning on something already on, and
 * off something already off, both land as no-ops rather than as a duplicate key.
 *
 * The key is checked against types.Features by the handler before it gets here — the
 * column has no CHECK to lean on, so that check is the whole of the validation.
 */
func (s *Store) SetFeature(ctx context.Context, userID, feature string, enabled bool) (User, error) {
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET features = CASE WHEN $3
		            THEN array_remove(features, $2) || ARRAY[$2]::text[]
		            ELSE array_remove(features, $2)
		       END
		 WHERE id = $1
		RETURNING `+userColumns, userID, feature, enabled))
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
		SELECT u.id::text, u.email, u.name, u.title, u.org, u.phone, u.initials, u.hue,
		       u.can_host, u.is_admin, u.created_at,
		       (SELECT count(*) FROM webinars w WHERE w.host_id = u.id),
		       u.max_duration_min, u.can_cdn_broadcast, u.features
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
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Title, &u.Org, &u.Phone, &u.Initials,
			&u.Hue, &u.CanHost, &u.IsAdmin, &createdAt, &u.WebinarCount, &u.MaxDurationMin, &u.CanCdnBroadcast,
			&u.Features); err != nil {
			return nil, err
		}
		u.CreatedAt = createdAt.Format(time.RFC3339)
		if u.Features == nil {
			u.Features = []string{}
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

/* How far back the dashboard's start-day chart looks, and how many rows a
 * glance list renders. Both are the server's decision: a client that asked
 * for "the last 400 days" or "every live session in full" would be rebuilding
 * the list this endpoint exists to avoid, and the chart has one width. */
const (
	adminStatsWindowDays = 28
	adminGlanceLimit     = 5
)

/* AdminStats is the dashboard's aggregates.
 *
 * One round trip for the scalars, then the series, then three short lists.
 * Splitting them from AdminUsers and AdminWebinars is the point: those two
 * are shaped for management (a cap on accounts, a full webinar per row) and
 * a total computed from either is either truncated or enormous.
 *
 * The daily buckets are UTC days, including today, with a zero where nothing
 * starts. Filling the gaps here means the chart cannot invent a bar for a
 * day the query never returned, and cannot drop a quiet day and make the
 * previous week look busier than it was.
 *
 * Registrants exclude declined, the same cut as the count on a webinar.
 * Attendees are att_ identities only — a host in their own room is not an
 * attendee of it, which is the distinction SessionReport already draws.
 */
func (s *Store) AdminStats(ctx context.Context) (types.AdminStats, error) {
	var out types.AdminStats
	// Empty, not nil: encoding/json renders a nil slice as null, and the
	// dashboard maps these.
	out.Daily = []types.AdminDayCount{}
	out.LiveNow = []types.AdminWebinarGlance{}
	out.Upcoming = []types.AdminWebinarGlance{}
	out.Recent = []types.AdminWebinarGlance{}

	err := s.pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM users),
		  (SELECT count(*) FILTER (WHERE can_host) FROM users),
		  (SELECT count(*) FILTER (WHERE is_admin) FROM users),
		  (SELECT count(*) FILTER (WHERE can_cdn_broadcast) FROM users),
		  (SELECT count(*) FILTER (WHERE created_at >= now() - interval '7 days') FROM users),
		  (SELECT count(*) FROM webinars),
		  (SELECT count(*) FILTER (WHERE status = 'live') FROM webinars),
		  (SELECT count(*) FILTER (WHERE status = 'scheduled') FROM webinars),
		  (SELECT count(*) FILTER (WHERE status = 'ended') FROM webinars),
		  (SELECT count(*) FILTER (WHERE status = 'draft') FROM webinars),
		  (SELECT count(*) FILTER (WHERE kind = 'live') FROM webinars),
		  (SELECT count(*) FILTER (WHERE kind = 'simulive') FROM webinars),
		  (SELECT count(*) FILTER (WHERE kind = 'recurring') FROM webinars),
		  (SELECT count(*) FROM registrations WHERE state <> 'declined'),
		  (SELECT count(*) FROM attendance WHERE starts_with(identity, 'att_'))
	`).Scan(
		&out.Accounts, &out.Hosts, &out.Admins, &out.CdnBroadcast, &out.NewAccounts7d,
		&out.Webinars, &out.Live, &out.Scheduled, &out.Ended, &out.Drafts,
		&out.KindLive, &out.KindSimulive, &out.KindRecurring,
		&out.Registrants, &out.Attendees,
	)
	if err != nil {
		return types.AdminStats{}, err
	}

	now := time.Now().UTC()
	end := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	start := end.AddDate(0, 0, -(adminStatsWindowDays - 1))

	/* Date strings, not timestamps.
	 *
	 * A timestamptz cast to date uses the session TimeZone, which would slide
	 * the window a day for a connection that isn't UTC and disagree with the
	 * UTC bucketing of starts_at below. A date literal does not have that
	 * problem, and AT TIME ZONE 'UTC' then means midnight UTC. */
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(gs::date, 'YYYY-MM-DD'), COALESCE(c.n, 0)::int
		  FROM generate_series($1::date, $2::date, interval '1 day') AS gs
		  LEFT JOIN (
		    SELECT (w.starts_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
		      FROM webinars w
		     WHERE w.starts_at >= ($1::date AT TIME ZONE 'UTC')
		       AND w.starts_at <  (($2::date + 1) AT TIME ZONE 'UTC')
		     GROUP BY 1
		  ) c ON c.day = gs::date
		 ORDER BY gs`, start.Format("2006-01-02"), end.Format("2006-01-02"))
	if err != nil {
		return types.AdminStats{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var d types.AdminDayCount
		if err := rows.Scan(&d.Day, &d.Count); err != nil {
			return types.AdminStats{}, err
		}
		out.Daily = append(out.Daily, d)
	}
	if err := rows.Err(); err != nil {
		return types.AdminStats{}, err
	}

	out.LiveNow, err = s.adminGlances(ctx,
		"w.status = 'live'",
		"w.started_at DESC NULLS LAST, w.starts_at DESC")
	if err != nil {
		return types.AdminStats{}, err
	}
	out.Upcoming, err = s.adminGlances(ctx,
		"w.status = 'scheduled'",
		"w.starts_at ASC")
	if err != nil {
		return types.AdminStats{}, err
	}
	out.Recent, err = s.adminGlances(ctx,
		"w.status = 'ended'",
		"COALESCE(w.ended_at, w.starts_at) DESC")
	if err != nil {
		return types.AdminStats{}, err
	}
	return out, nil
}

/* adminGlances loads the rows a dashboard list actually paints.
 *
 * where and order are fixed clauses from AdminStats, not request input — a
 * filter an admin typed belongs on AdminWebinars, which already has one.
 * The limit is adminGlanceLimit for the same reason the window is fixed.
 */
func (s *Store) adminGlances(ctx context.Context, where, order string) ([]types.AdminWebinarGlance, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.topic, w.status, w.kind,
		       w.starts_at, w.duration_min, w.time_zone,
		       w.started_at, w.ended_at,
		       COALESCE(u.name, ''),
		       (SELECT count(*) FROM registrations r
		         WHERE r.webinar_id = w.id AND r.state <> 'declined')
		  FROM webinars w
		  JOIN users u ON u.id = w.host_id
		 WHERE `+where+`
		 ORDER BY `+order+`
		 LIMIT $1`, adminGlanceLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.AdminWebinarGlance{}
	for rows.Next() {
		var (
			g       types.AdminWebinarGlance
			starts  time.Time
			started *time.Time
			ended   *time.Time
		)
		if err := rows.Scan(&g.ID, &g.Topic, &g.Status, &g.Kind,
			&starts, &g.DurationMin, &g.TimeZone,
			&started, &ended, &g.HostName, &g.RegistrantCount); err != nil {
			return nil, err
		}
		g.StartsAt = starts.Format(time.RFC3339)
		if started != nil {
			g.StartedAt = started.Format(time.RFC3339)
		}
		if ended != nil {
			g.EndedAt = ended.Format(time.RFC3339)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
