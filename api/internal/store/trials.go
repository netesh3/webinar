package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

/* The monthly free trial. See migrations/0106_trials.sql.
 *
 * billing_subscriptions is the ledger of Razorpay subscriptions, and
 * ApplySubscriptionStatus is the one place a subscription's state reaches the
 * account's plan (the subscriptions table) — from the browser's verified callback
 * and from every subscription webhook, in whatever order they arrive.
 */

// ErrTrialUnavailable is an account that has paid before; trials are for new customers.
var ErrTrialUnavailable = errors.New("account has paid before")

type BillingSubscription struct {
	RazorpaySubscriptionID string
	UserID                 string
	Plan                   string
	Currency               string
	Amount                 int64
	Status                 string
	TrialEndsAt            time.Time
	MethodChecked          bool
	CreatedAt              time.Time
}

const billingSubscriptionColumns = `razorpay_subscription_id, coalesce(user_id::text, ''), plan, currency,
	amount, status, trial_ends_at, method_checked, created_at`

func scanBillingSubscription(row scanner) (BillingSubscription, error) {
	var b BillingSubscription
	err := row.Scan(&b.RazorpaySubscriptionID, &b.UserID, &b.Plan, &b.Currency, &b.Amount,
		&b.Status, &b.TrialEndsAt, &b.MethodChecked, &b.CreatedAt)
	return b, err
}

// ---------------------------------------------------------------- plan ids

// RazorpayPlanID is the cached Razorpay plan for this price, or "".
func (s *Store) RazorpayPlanID(ctx context.Context, plan, currency string, amount int64) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		SELECT razorpay_plan_id FROM razorpay_plans
		 WHERE plan = $1 AND currency = $2 AND amount = $3`, plan, currency, amount).Scan(&id)
	if noRows(err) {
		return "", nil
	}
	return id, err
}

/* SaveRazorpayPlanID caches a plan Razorpay just created. If another request saved
 * one for the same price first, that one is returned and this one goes unused. */
func (s *Store) SaveRazorpayPlanID(ctx context.Context, plan, currency string, amount int64, id string) (string, error) {
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO razorpay_plans (plan, currency, amount, razorpay_plan_id)
		VALUES ($1, $2, $3, $4) ON CONFLICT (plan, currency, amount) DO NOTHING`,
		plan, currency, amount, id); err != nil {
		return "", err
	}
	return s.RazorpayPlanID(ctx, plan, currency, amount)
}

// ---------------------------------------------------------------- ledger

func (s *Store) CreateBillingSubscription(ctx context.Context, b BillingSubscription) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO billing_subscriptions
		    (razorpay_subscription_id, user_id, plan, currency, amount, trial_ends_at)
		VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
		b.RazorpaySubscriptionID, b.UserID, b.Plan, b.Currency, b.Amount, b.TrialEndsAt)
	return err
}

func (s *Store) BillingSubscriptionByID(ctx context.Context, id string) (BillingSubscription, error) {
	b, err := scanBillingSubscription(s.pool.QueryRow(ctx,
		`SELECT `+billingSubscriptionColumns+` FROM billing_subscriptions WHERE razorpay_subscription_id = $1`, id))
	if noRows(err) {
		return BillingSubscription{}, ErrNotFound
	}
	return b, err
}

/* CurrentBillingSubscription is the account's subscription that is still running
 * (in trial, active, or retrying a charge), or ErrNotFound. */
func (s *Store) CurrentBillingSubscription(ctx context.Context, userID string) (BillingSubscription, error) {
	b, err := scanBillingSubscription(s.pool.QueryRow(ctx, `
		SELECT `+billingSubscriptionColumns+` FROM billing_subscriptions
		 WHERE user_id = $1::uuid AND status IN ('authenticated', 'active', 'pending')
		 ORDER BY created_at DESC LIMIT 1`, userID))
	if noRows(err) {
		return BillingSubscription{}, ErrNotFound
	}
	return b, err
}

/* HasPaidBefore is an account that has bought a plan or started a trial already.
 * A trial is for somebody who has not. */
func (s *Store) HasPaidBefore(ctx context.Context, userID string) (bool, error) {
	var paid bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM billing_orders WHERE user_id = $1::uuid AND status = 'paid')
		    OR EXISTS (SELECT 1 FROM billing_subscriptions WHERE user_id = $1::uuid AND status <> 'created')`,
		userID).Scan(&paid)
	return paid, err
}

// MarkMethodChecked records that this subscription's payment method was compared.
func (s *Store) MarkMethodChecked(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE billing_subscriptions SET method_checked = true, updated_at = now() WHERE razorpay_subscription_id = $1`, id)
	return err
}

// subscriptionTerminal are Razorpay states a subscription does not come back from.
var subscriptionTerminal = map[string]bool{"halted": true, "cancelled": true, "completed": true, "expired": true}

/* ApplySubscriptionStatus moves one subscription to a Razorpay status and the
 * account's plan with it. Returns the account as it now is.
 *
 *   authenticated  trial started: plan 'trialing' until trialEndsAt, hosting on
 *   active         first charge or later: plan 'active' until periodEnd, hosting on
 *   pending        a charge failed and Razorpay is retrying: 'past_due', plan kept
 *   halted/cancelled/completed/expired: the plan row is deleted (launch default).
 *                  can_host is left as it is, as for a lapsed one-time payment.
 *
 * Webhooks retry and can arrive out of order, so: a terminal status is final; a
 * late 'authenticated' does not take an active plan back to trialing; and the plan
 * row is only touched while it still belongs to this subscription, so an older
 * subscription halting never deletes a plan bought since.
 *
 * firstActivation reports the move from 'created', which is when the trial's
 * claims are recorded. ErrAccountGone is a subscription whose account was deleted.
 */
func (s *Store) ApplySubscriptionStatus(ctx context.Context, id, status, customerID string, periodEnd *time.Time) (sub BillingSubscription, u User, firstActivation bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillingSubscription{}, User{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	sub, err = scanBillingSubscription(tx.QueryRow(ctx,
		`SELECT `+billingSubscriptionColumns+` FROM billing_subscriptions WHERE razorpay_subscription_id = $1 FOR UPDATE`, id))
	if noRows(err) {
		return BillingSubscription{}, User{}, false, ErrNotFound
	}
	if err != nil {
		return BillingSubscription{}, User{}, false, err
	}
	if subscriptionTerminal[sub.Status] {
		// Final already. Nothing a later event says changes that.
		if sub.UserID == "" {
			return sub, User{}, false, ErrAccountGone
		}
		u, err = scanUser(tx.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, sub.UserID))
		return sub, u, false, err
	}
	if status == "authenticated" && sub.Status != "created" {
		status = sub.Status // a retry, or a late arrival after the first charge
	}
	firstActivation = sub.Status == "created" && status != "created" && !subscriptionTerminal[status]
	if _, err := tx.Exec(ctx, `
		UPDATE billing_subscriptions SET status = $2, updated_at = now() WHERE razorpay_subscription_id = $1`,
		id, status); err != nil {
		return BillingSubscription{}, User{}, false, err
	}
	sub.Status = status
	if sub.UserID == "" {
		if err := tx.Commit(ctx); err != nil {
			return BillingSubscription{}, User{}, false, err
		}
		return sub, User{}, false, ErrAccountGone
	}

	switch {
	case status == "authenticated":
		_, err = tx.Exec(ctx, `
			INSERT INTO subscriptions (user_id, plan, status, trial_ends_at, current_period_end,
			                           provider, provider_customer_id, provider_subscription_id)
			VALUES ($1::uuid, $2, 'trialing', $3, $3, 'razorpay', $4, $5)
			ON CONFLICT (user_id) DO UPDATE
			   SET plan = EXCLUDED.plan, status = 'trialing', trial_ends_at = EXCLUDED.trial_ends_at,
			       current_period_end = EXCLUDED.current_period_end, provider = 'razorpay',
			       provider_customer_id = EXCLUDED.provider_customer_id,
			       provider_subscription_id = EXCLUDED.provider_subscription_id, updated_at = now()`,
			sub.UserID, sub.Plan, sub.TrialEndsAt, customerID, id)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE users SET can_host = true WHERE id = $1`, sub.UserID)
		}
	case status == "active":
		_, err = tx.Exec(ctx, `
			INSERT INTO subscriptions (user_id, plan, status, trial_ends_at, current_period_end,
			                           provider, provider_customer_id, provider_subscription_id)
			VALUES ($1::uuid, $2, 'active', $3, coalesce($4::timestamptz, $3), 'razorpay', $5, $6)
			ON CONFLICT (user_id) DO UPDATE
			   SET plan = EXCLUDED.plan, status = 'active',
			       -- Forward only: a late, older event never pulls the period back,
			       -- so a healthy subscription stays ahead of effective_plan's grace (0108).
			       current_period_end = CASE WHEN $4::timestamptz IS NULL THEN subscriptions.current_period_end
			                                 ELSE greatest(coalesce(subscriptions.current_period_end, $4::timestamptz), $4::timestamptz) END,
			       provider = 'razorpay',
			       provider_customer_id = CASE WHEN EXCLUDED.provider_customer_id <> ''
			                                   THEN EXCLUDED.provider_customer_id
			                                   ELSE subscriptions.provider_customer_id END,
			       provider_subscription_id = EXCLUDED.provider_subscription_id, updated_at = now()`,
			sub.UserID, sub.Plan, sub.TrialEndsAt, periodEnd, customerID, id)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE users SET can_host = true WHERE id = $1`, sub.UserID)
		}
	case status == "pending":
		_, err = tx.Exec(ctx, `
			UPDATE subscriptions SET status = 'past_due', updated_at = now()
			 WHERE user_id = $1::uuid AND provider_subscription_id = $2`, sub.UserID, id)
	case subscriptionTerminal[status]:
		_, err = tx.Exec(ctx, `
			DELETE FROM subscriptions WHERE user_id = $1::uuid AND provider_subscription_id = $2`, sub.UserID, id)
	}
	if err != nil {
		return BillingSubscription{}, User{}, false, err
	}
	u, err = scanUser(tx.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, sub.UserID))
	if err != nil {
		return BillingSubscription{}, User{}, false, err
	}
	return sub, u, firstActivation, tx.Commit(ctx)
}

// SubscriptionPlanRow is the account's plan row as the billing screen shows it.
type SubscriptionPlanRow struct {
	Plan             string
	Status           string
	TrialEndsAt      *time.Time
	CurrentPeriodEnd *time.Time
}

// SubscriptionPlan is the account's subscriptions row, or ErrNotFound.
func (s *Store) SubscriptionPlan(ctx context.Context, userID string) (SubscriptionPlanRow, error) {
	var r SubscriptionPlanRow
	err := s.pool.QueryRow(ctx, `
		SELECT plan, status, trial_ends_at, current_period_end FROM subscriptions WHERE user_id = $1::uuid`,
		userID).Scan(&r.Plan, &r.Status, &r.TrialEndsAt, &r.CurrentPeriodEnd)
	if noRows(err) {
		return SubscriptionPlanRow{}, ErrNotFound
	}
	return r, err
}

// ---------------------------------------------------------------- claims

// Trial claim kinds.
const (
	ClaimPhone = "phone"
	ClaimEmail = "email"
	ClaimVPA   = "vpa"
	ClaimCard  = "card"
)

// TrialClaim is one identifier a trial was started with, hashed.
type TrialClaim struct {
	Kind   string
	Digest string
}

/* TrialDigest is the salted SHA-256 of a normalised identifier. The salt keeps a
 * leaked table from being reversed with a list of phone numbers. Empty value,
 * empty digest: there is nothing to claim. */
func TrialDigest(salt, kind, value string) string {
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(salt + "\x00" + kind + "\x00" + value))
	return hex.EncodeToString(sum[:])
}

/* NormaliseTrialEmail is the mailbox an address delivers to: lowercased, and for
 * Gmail without dots or a +suffix, since a.b+trial@gmail.com is ab@gmail.com. */
func NormaliseTrialEmail(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndexByte(email, '@')
	if at <= 0 {
		return email
	}
	local, domain := email[:at], email[at+1:]
	if domain == "gmail.com" || domain == "googlemail.com" {
		if plus := strings.IndexByte(local, '+'); plus >= 0 {
			local = local[:plus]
		}
		local = strings.ReplaceAll(local, ".", "")
		domain = "gmail.com"
	}
	return local + "@" + domain
}

// NormaliseTrialVPA is a UPI id, lowercased.
func NormaliseTrialVPA(vpa string) string { return strings.ToLower(strings.TrimSpace(vpa)) }

/* NormaliseTrialCard is the weak card signature: last four, network and issuer.
 * Not unique to one card, which is why a match only flags. Empty unless all three
 * are present. */
func NormaliseTrialCard(last4, network, issuer string) string {
	last4, network, issuer = strings.TrimSpace(last4), strings.ToLower(strings.TrimSpace(network)),
		strings.ToUpper(strings.TrimSpace(issuer))
	if last4 == "" || network == "" || issuer == "" {
		return ""
	}
	return last4 + "|" + network + "|" + issuer
}

// TrialClaimed is the kind of the first claim already on record, or "".
func (s *Store) TrialClaimed(ctx context.Context, claims []TrialClaim) (string, error) {
	for _, c := range claims {
		if c.Digest == "" {
			continue
		}
		var hit bool
		if err := s.pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM trial_claims WHERE kind = $1 AND digest = $2)`, c.Kind, c.Digest).Scan(&hit); err != nil {
			return "", err
		}
		if hit {
			return c.Kind, nil
		}
	}
	return "", nil
}

// RecordTrialClaims remembers identifiers a trial was started with.
func (s *Store) RecordTrialClaims(ctx context.Context, claims []TrialClaim) error {
	for _, c := range claims {
		if c.Digest == "" {
			continue
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO trial_claims (kind, digest) VALUES ($1, $2) ON CONFLICT DO NOTHING`, c.Kind, c.Digest); err != nil {
			return err
		}
	}
	return nil
}

// AddTrialFlag puts an account in front of an admin, with the reason.
func (s *Store) AddTrialFlag(ctx context.Context, userID, reason string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO trial_flags (user_id, reason) VALUES ($1::uuid, $2)`, userID, reason)
	return err
}

// ClearTrialFlags removes an account's review flags once an admin has looked. Returns how many.
func (s *Store) ClearTrialFlags(ctx context.Context, userID string) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM trial_flags WHERE user_id = $1::uuid`, userID)
	return tag.RowsAffected(), err
}

/* GrantTrialExemption lets an account take one more trial past the once-per-person
 * check. A second grant while one is open changes nothing. ErrNotFound is no such
 * account. */
func (s *Store) GrantTrialExemption(ctx context.Context, userID, adminID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO trial_exemptions (user_id, granted_by) VALUES ($1::uuid, $2::uuid)
		ON CONFLICT (user_id) WHERE used_at IS NULL DO NOTHING`, userID, adminID)
	if isForeignKeyViolation(err) {
		return ErrNotFound
	}
	return err
}

// HasTrialExemption is an open (unused) exemption for this account.
func (s *Store) HasTrialExemption(ctx context.Context, userID string) (bool, error) {
	var open bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM trial_exemptions WHERE user_id = $1::uuid AND used_at IS NULL)`, userID).Scan(&open)
	return open, err
}

// UseTrialExemption spends the open exemption, reporting whether there was one.
func (s *Store) UseTrialExemption(ctx context.Context, userID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE trial_exemptions SET used_at = now() WHERE user_id = $1::uuid AND used_at IS NULL`, userID)
	return tag.RowsAffected() > 0, err
}
