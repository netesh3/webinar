package store

import (
	"context"
	"errors"
	"time"
)

/* Billing orders. See migrations/0100_billing.sql.
 *
 * billing_orders is the payment ledger: every checkout, what it cost, and the
 * Razorpay ids. subscriptions (migrations/0101) is the account's CURRENT plan,
 * which is what the API enforces. Fulfilment writes both.
 *
 * Fulfilment is the only path in the product, besides an admin's toggle and
 * PromoteAdmins, that sets can_host. It runs inside one transaction with the
 * order row locked, so the browser callback and the webhook arriving together
 * fulfil the order once and grant once.
 */

type BillingOrder struct {
	ID                string
	UserID            string
	Plan              string
	Period            string
	Currency          string
	Amount            int64
	Tax               int64
	RazorpayOrderID   string
	RazorpayPaymentID string
	Status            string
	GSTIN             string
	CreatedAt         time.Time
	PaidAt            *time.Time
	PaidUntil         *time.Time
}

var (
	// ErrPaymentMismatch means an order that is already paid was reported paid
	// again by a DIFFERENT payment. The first one stands; the second is logged
	// for a refund rather than silently extending the plan.
	ErrPaymentMismatch = errors.New("order already paid by another payment")
)

const billingColumns = `id::text, user_id::text, plan, period, currency, amount, tax,
	razorpay_order_id, coalesce(razorpay_payment_id, ''), status, gstin,
	created_at, paid_at, paid_until`

func scanBillingOrder(row scanner) (BillingOrder, error) {
	var o BillingOrder
	err := row.Scan(&o.ID, &o.UserID, &o.Plan, &o.Period, &o.Currency, &o.Amount, &o.Tax,
		&o.RazorpayOrderID, &o.RazorpayPaymentID, &o.Status, &o.GSTIN,
		&o.CreatedAt, &o.PaidAt, &o.PaidUntil)
	return o, err
}

// CreateBillingOrder records an order Razorpay has just created, before Checkout opens.
func (s *Store) CreateBillingOrder(ctx context.Context, o BillingOrder) (BillingOrder, error) {
	return scanBillingOrder(s.pool.QueryRow(ctx, `
		INSERT INTO billing_orders (user_id, plan, period, currency, amount, tax, razorpay_order_id, gstin)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING `+billingColumns,
		o.UserID, o.Plan, o.Period, o.Currency, o.Amount, o.Tax, o.RazorpayOrderID, o.GSTIN))
}

// BillingOrderByRazorpayID is the order Razorpay knows by this id.
func (s *Store) BillingOrderByRazorpayID(ctx context.Context, razorpayOrderID string) (BillingOrder, error) {
	o, err := scanBillingOrder(s.pool.QueryRow(ctx,
		`SELECT `+billingColumns+` FROM billing_orders WHERE razorpay_order_id = $1`, razorpayOrderID))
	if noRows(err) {
		return BillingOrder{}, ErrNotFound
	}
	return o, err
}

/* FulfilBillingOrder marks an order paid and turns hosting on for its account.
 *
 * Idempotent: the browser and the webhook both call it, in either order, possibly
 * at the same moment. The row lock serialises them; the second sees status 'paid'
 * with the same payment id and returns the stored result without extending
 * anything.
 *
 * userID, when not empty, must own the order — that is the browser path, where the
 * caller is a signed-in account. The webhook passes "" because Razorpay is not
 * anybody's session.
 *
 * The new period starts at the later of now and the end of this account's latest
 * paid period, so renewing early adds a full period rather than overlapping one.
 */
func (s *Store) FulfilBillingOrder(ctx context.Context, razorpayOrderID, paymentID, userID string) (BillingOrder, User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillingOrder{}, User{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	o, err := scanBillingOrder(tx.QueryRow(ctx,
		`SELECT `+billingColumns+` FROM billing_orders WHERE razorpay_order_id = $1 FOR UPDATE`, razorpayOrderID))
	if noRows(err) {
		return BillingOrder{}, User{}, ErrNotFound
	}
	if err != nil {
		return BillingOrder{}, User{}, err
	}
	if userID != "" && o.UserID != userID {
		// Somebody else's order. Not-found rather than forbidden: an order id
		// is not something this account should learn exists.
		return BillingOrder{}, User{}, ErrNotFound
	}

	if o.Status == "paid" {
		if o.RazorpayPaymentID != paymentID {
			return o, User{}, ErrPaymentMismatch
		}
		u, err := scanUser(tx.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, o.UserID))
		if err != nil {
			return BillingOrder{}, User{}, err
		}
		return o, u, tx.Commit(ctx)
	}

	o, err = scanBillingOrder(tx.QueryRow(ctx, `
		UPDATE billing_orders
		   SET status = 'paid',
		       razorpay_payment_id = $2,
		       paid_at = now(),
		       paid_until = greatest(
		           now(),
		           coalesce((SELECT max(paid_until) FROM billing_orders
		                      WHERE user_id = $3 AND status = 'paid'), now())
		       ) + CASE period WHEN 'yearly' THEN interval '1 year' ELSE interval '1 month' END
		 WHERE id = $1
		RETURNING `+billingColumns, o.ID, paymentID, o.UserID))
	if err != nil {
		return BillingOrder{}, User{}, err
	}

	/* The plan bought becomes the account's plan, active until the end of the period
	 * this payment covers. A purchase replaces whatever plan was there, including
	 * one an admin assigned: what somebody paid for is what they get. */
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscriptions (user_id, plan, status, current_period_end, provider)
		VALUES ($1::uuid, $2, 'active', $3, 'razorpay')
		ON CONFLICT (user_id) DO UPDATE
		   SET plan = EXCLUDED.plan,
		       status = 'active',
		       current_period_end = EXCLUDED.current_period_end,
		       provider = 'razorpay',
		       updated_at = now()`, o.UserID, o.Plan, o.PaidUntil); err != nil {
		return BillingOrder{}, User{}, err
	}

	// RETURNING reads the subscription just written: same transaction, later statement.
	u, err := scanUser(tx.QueryRow(ctx,
		`UPDATE users SET can_host = true WHERE id = $1 RETURNING `+userColumns, o.UserID))
	if err != nil {
		return BillingOrder{}, User{}, err
	}
	return o, u, tx.Commit(ctx)
}

// CurrentBillingOrder is this account's paid order that runs latest, or ErrNotFound.
func (s *Store) CurrentBillingOrder(ctx context.Context, userID string) (BillingOrder, error) {
	o, err := scanBillingOrder(s.pool.QueryRow(ctx, `
		SELECT `+billingColumns+` FROM billing_orders
		 WHERE user_id = $1 AND status = 'paid'
		 ORDER BY paid_until DESC LIMIT 1`, userID))
	if noRows(err) {
		return BillingOrder{}, ErrNotFound
	}
	return o, err
}
