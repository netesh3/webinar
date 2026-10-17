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
	created := false
	switch {
	case err == nil:
		created = true
	case errors.Is(err, ErrConflict):
		// Already there. The whole point.
	default:
		return false, err
	}
	// The operator account has to be able to sign in. Password signup leaves a row
	// unverified; this bootstrap path does not. Idempotent, so a retry after a
	// failed mark still ends verified, and an account that already was is left at
	// its original time.
	if err := s.MarkEmailVerifiedByEmail(ctx, email); err != nil {
		return false, err
	}
	return created, nil
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
		UPDATE users
		   SET can_host = $2,
		       -- Somebody who can host is a customer (see PromoteToCustomer).
		       account_kind = CASE WHEN $2 THEN 'customer' ELSE account_kind END,
		       account_kind_set_at = CASE WHEN $2 AND account_kind = 'audience' THEN now()
		                                  ELSE account_kind_set_at END
		 WHERE id = $1
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

/* SetUserMediaQuota sets an account's media library limit in bytes; nil puts it back
 * on the deployment default (MEDIA_QUOTA_DEFAULT_MB). Lowering it below what the
 * library already holds deletes nothing — further uploads are refused until it fits. */
func (s *Store) SetUserMediaQuota(ctx context.Context, userID string, quotaBytes *int64) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET media_quota_bytes = $2 WHERE id = $1`, userID, quotaBytes)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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

/* SetFeature forces one feature on or off for this account, whatever its plan says.
 * See SetFeatureOverride. */
func (s *Store) SetFeature(ctx context.Context, userID, feature string, enabled bool) (User, error) {
	return s.SetFeatureOverride(ctx, userID, feature, &enabled)
}

/* SetFeatureOverride sets this account's override for one feature: true forces it
 * on (users.features), false forces it off (users.features_off), nil clears both so
 * the account inherits its plan's value (migrations/0107).
 *
 * Set arithmetic in SQL rather than read-modify-write in Go, which is what makes it
 * safe for two admins on two screens: array_remove then append touches only the key
 * being changed, so a request about `whatsapp_crm` cannot undo a decision about
 * `cloud_recording` somebody made a second earlier. A key is never in both lists.
 *
 * The key is checked against types.Features by the handler before it gets here — the
 * columns have no CHECK to lean on, so that check is the whole of the validation.
 */
func (s *Store) SetFeatureOverride(ctx context.Context, userID, feature string, state *bool) (User, error) {
	on := state != nil && *state
	off := state != nil && !*state
	u, err := scanUser(s.pool.QueryRow(ctx, `
		UPDATE users
		   SET features = CASE WHEN $3 THEN array_remove(features, $2) || ARRAY[$2]::text[]
		                       ELSE array_remove(features, $2) END,
		       features_off = CASE WHEN $4 THEN array_remove(features_off, $2) || ARRAY[$2]::text[]
		                           ELSE array_remove(features_off, $2) END
		 WHERE id = $1
		RETURNING `+userColumns, userID, feature, on, off))
	if noRows(err) {
		return User{}, ErrNotFound
	}
	return u, err
}

/* FeatureOverrideConversionSQL moves accounts from "every switch on the account" to
 * "plan, then overrides" without changing what anyone has. Every tier starts with
 * whiteboard, so it leaves users.features (now the tier's), and an account that had it
 * turned off gets a forced-off override. Every other key stays as a forced-on override.
 *
 * One shot: migrations/0107 runs it, and a store test checks this text still matches.
 * Tests apply it to rows written in the old shape to prove the guarantee. */
const FeatureOverrideConversionSQL = `UPDATE users SET features_off = ARRAY['whiteboard']
 WHERE NOT ('whiteboard' = ANY (features));
UPDATE users SET features = array_remove(features, 'whiteboard')
 WHERE 'whiteboard' = ANY (features);`

// ConvertFeatureOverrides applies FeatureOverrideConversionSQL. Tests only.
func (s *Store) ConvertFeatureOverrides(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, FeatureOverrideConversionSQL)
	return err
}

// PlanTiers is every tier an admin configures, "" being no plan.
var PlanTiers = []types.Plan{"", types.PlanProfessional, types.PlanBusiness, types.PlanEnterprise}

// PlanFeatures is the tier matrix: which features each plan includes, in PlanTiers order.
func (s *Store) PlanFeatures(ctx context.Context) ([]types.PlanFeatures, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT plan, feature FROM plan_features WHERE enabled ORDER BY plan, feature`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byPlan := map[types.Plan][]string{}
	for rows.Next() {
		var plan, feature string
		if err := rows.Scan(&plan, &feature); err != nil {
			return nil, err
		}
		byPlan[types.Plan(plan)] = append(byPlan[types.Plan(plan)], feature)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]types.PlanFeatures, 0, len(PlanTiers))
	for _, p := range PlanTiers {
		f := byPlan[p]
		if f == nil {
			f = []string{}
		}
		out = append(out, types.PlanFeatures{Plan: p, Features: f})
	}
	return out, nil
}

/* SetPlanFeatures replaces the whole matrix in one transaction, so a reader never sees
 * half of an admin's save. The handler has checked every plan and feature key. */
func (s *Store) SetPlanFeatures(ctx context.Context, tiers []types.PlanFeatures) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM plan_features`); err != nil {
		return err
	}
	for _, t := range tiers {
		for _, f := range t.Features {
			if _, err := tx.Exec(ctx, `
				INSERT INTO plan_features (plan, feature, enabled) VALUES ($1, $2, true)
				ON CONFLICT (plan, feature) DO NOTHING`, string(t.Plan), f); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

/* OperatorInstantWebinarSQL turns Instant webinar on for the existing operator
 * admin, and for nobody else.
 *
 * The email local-part is how that account is recognised: webinarliv@…, admin,
 * and not a second admin whose address is something else. is_admin is required
 * so a host who happens to use the same local-part does not receive it.
 *
 * One shot. migrations/0087 runs this when the account already exists. Do not
 * call it on every boot: an administrator who later turns the switch off must
 * stay off. A store test checks this text still matches that migration.
 */
const OperatorInstantWebinarSQL = `UPDATE users
   SET features = array_append(features, 'instant_webinar')
 WHERE is_admin
   AND NOT ('instant_webinar' = ANY (features))
   AND lower(split_part(email, '@', 1)) = 'webinarliv'`

/* KeepOperatorInstantWebinar applies OperatorInstantWebinarSQL.
 *
 * Tests insert the operator after migrations have already run, so they call
 * this to apply the same statement. Production relies on the migration.
 */
func (s *Store) KeepOperatorInstantWebinar(ctx context.Context) (int, error) {
	tag, err := s.pool.Exec(ctx, OperatorInstantWebinarSQL)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

/* AdminUsers lists every account for the admin panel.
 *
 * Includes the count of webinars each account owns, because that is the fact an admin needs
 * before revoking: taking hosting from somebody who owns scheduled sessions leaves those
 * sessions with registrants attached and nobody able to start them. The UI warns on it rather
 * than refusing — an operator removing a departed colleague genuinely does want that — but it
 * cannot warn about a number it was not given.
 */
func (s *Store) AdminUsers(ctx context.Context, search string, kind types.AccountKind, limit int) ([]types.AdminUser, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// Empty search matches everything: ILIKE '%%' rather than a second query.
	like := "%" + strings.ToLower(strings.TrimSpace(search)) + "%"

	// kind "" lists both; the admin screen always asks for one list or the other.
	rows, err := s.pool.Query(ctx, `
		SELECT u.id::text, u.email, u.name, u.title, u.org, u.phone, u.initials, u.hue,
		       u.can_host, u.is_admin, u.created_at,
		       (SELECT count(*) FROM webinars w WHERE w.host_id = u.id),
		       u.max_duration_min, u.can_cdn_broadcast,
		       effective_features(effective_plan(u.id), u.features, u.features_off),
		       (u.email_verified_at IS NOT NULL),
		       effective_plan(u.id), u.features, u.features_off,
		       coalesce((SELECT f.reason FROM trial_flags f WHERE f.user_id = u.id
		                  ORDER BY f.created_at DESC LIMIT 1), ''),
		       EXISTS (SELECT 1 FROM trial_exemptions e WHERE e.user_id = u.id AND e.used_at IS NULL),
		       u.account_kind, coalesce(u.sfu_project, ''),
		       (SELECT count(*) FROM registrations r WHERE r.user_id = u.id),
		       coalesce((SELECT w.topic FROM registrations r JOIN webinars w ON w.id = r.webinar_id
		                  WHERE r.user_id = u.id ORDER BY r.created_at DESC LIMIT 1), ''),
		       u.media_quota_bytes,
		       coalesce((SELECT sum(m.bytes) FROM crm_media_files m WHERE m.host_id = u.id), 0)::bigint
		  FROM users u
		 WHERE (lower(u.email) LIKE $1 OR lower(u.name) LIKE $1)
		   AND ($3 = '' OR u.account_kind = $3)
		 ORDER BY u.is_admin DESC, u.can_host DESC, u.created_at DESC
		 LIMIT $2`, like, limit, string(kind))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.AdminUser{}
	for rows.Next() {
		var (
			u                   types.AdminUser
			createdAt           time.Time
			forcedOn, forcedOff []string
		)
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Title, &u.Org, &u.Phone, &u.Initials,
			&u.Hue, &u.CanHost, &u.IsAdmin, &createdAt, &u.WebinarCount, &u.MaxDurationMin, &u.CanCdnBroadcast,
			&u.Features, &u.EmailVerified, &u.Plan, &forcedOn, &forcedOff,
			&u.TrialFlag, &u.TrialExemption,
			&u.AccountKind, &u.SFUProject, &u.RegistrationCount, &u.LastWebinarTopic,
			&u.MediaQuotaBytes, &u.MediaUsedBytes); err != nil {
			return nil, err
		}
		u.CreatedAt = createdAt.Format(time.RFC3339)
		if u.Features == nil {
			u.Features = []string{}
		}
		u.FeatureOverrides = map[string]bool{}
		for _, f := range forcedOn {
			u.FeatureOverrides[f] = true
		}
		for _, f := range forcedOff {
			u.FeatureOverrides[f] = false
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
		  (SELECT count(*) FILTER (WHERE status = 'scheduled' AND NOT `+LapsedScheduledCond("")+`) FROM webinars),
		  (SELECT count(*) FILTER (WHERE status = 'ended' OR `+LapsedScheduledCond("")+`) FROM webinars),
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
	kinds, err := s.AdminAccountCounts(ctx)
	if err != nil {
		return types.AdminStats{}, err
	}
	out.Customers, out.Audience = kinds.Customers, kinds.Audience

	now := time.Now().UTC()
	end := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	start := end.AddDate(0, 0, -(adminStatsWindowDays - 1))

	/* Date strings, not timestamps.
	 *
	 * A timestamptz cast to date uses the session TimeZone, which would slide
	 * the window a day for a connection that isn't UTC and disagree with the
	 * UTC bucketing of starts_at below. The bounds go through timestamp first:
	 * date AT TIME ZONE converts via the session zone, timestamp AT TIME ZONE
	 * 'UTC' is midnight UTC whatever the session says. */
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(gs::date, 'YYYY-MM-DD'), COALESCE(c.n, 0)::int
		  FROM generate_series($1::date, $2::date, interval '1 day') AS gs
		  LEFT JOIN (
		    SELECT (w.starts_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
		      FROM webinars w
		     WHERE w.starts_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
		       AND w.starts_at <  (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
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
		"w.status = 'scheduled' AND NOT "+LapsedScheduledCond("w"),
		"w.starts_at ASC")
	if err != nil {
		return types.AdminStats{}, err
	}
	out.Recent, err = s.adminGlances(ctx,
		"(w.status = 'ended' OR "+LapsedScheduledCond("w")+")",
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
		/* Same read-time rule as the host list. The badge would otherwise still
		 * say scheduled on a row the Completed count already includes. */
		if g.Status == string(types.StatusScheduled) && g.StartedAt == "" &&
			!starts.Add(time.Duration(g.DurationMin)*time.Minute).After(time.Now()) {
			g.Status = string(types.StatusEnded)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

/* SetUserPlan puts an account on a paid plan, or with an empty plan removes its
 * subscription (back to the launch default). Admin-assigned, so status is active;
 * checkout will own the other states. */
func (s *Store) SetUserPlan(ctx context.Context, userID string, plan types.Plan) (User, error) {
	var err error
	if plan == "" {
		_, err = s.pool.Exec(ctx, `DELETE FROM subscriptions WHERE user_id = $1::uuid`, userID)
	} else {
		_, err = s.pool.Exec(ctx, `
			INSERT INTO subscriptions (user_id, plan) VALUES ($1::uuid, $2)
			ON CONFLICT (user_id) DO UPDATE
			   SET plan = EXCLUDED.plan, status = 'active', updated_at = now(),
			       -- An admin's plan has no end and no payment behind it.
			       trial_ends_at = NULL, current_period_end = NULL, provider = '',
			       provider_customer_id = '', provider_subscription_id = ''`, userID, string(plan))
	}
	if isForeignKeyViolation(err) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	if plan != "" {
		if err := s.PromoteToCustomer(ctx, userID); err != nil {
			return User{}, err
		}
	}
	return s.UserByID(ctx, userID)
}

// PlanForUser is an account's plan, empty with no subscription.
func (s *Store) PlanForUser(ctx context.Context, userID string) (types.Plan, error) {
	var plan string
	err := s.pool.QueryRow(ctx, `SELECT effective_plan($1::uuid)`, userID).Scan(&plan)
	return types.Plan(plan), err
}

// HostSFUProject is the LiveKit project an admin assigned to this host, empty for the
// default order.
func (s *Store) HostSFUProject(ctx context.Context, userID string) (string, error) {
	if userID == "" {
		return "", nil
	}
	var project string
	err := s.pool.QueryRow(ctx,
		`SELECT coalesce(sfu_project, '') FROM users WHERE id = $1::uuid`, userID).Scan(&project)
	if noRows(err) {
		return "", ErrNotFound
	}
	return project, err
}

// SetUserSFUProject assigns a host's new webinars to a LiveKit project; "" restores the
// default order.
func (s *Store) SetUserSFUProject(ctx context.Context, userID, project string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET sfu_project = NULLIF($2, '') WHERE id = $1::uuid`, userID, project)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
