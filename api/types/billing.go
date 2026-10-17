package types

/* Self-serve plans, paid through Razorpay. See internal/billing.
 *
 * Every amount on the wire is minor units (paise, cents) so the browser never
 * does money arithmetic in floating point; it only formats.
 */

// BillingPrice is one plan's pre-tax price for a currency and period.
type BillingPrice struct {
	Currency string `json:"currency"`
	Period   string `json:"period"`
	// Amount is what is charged, before tax.
	Amount int64 `json:"amount"`
	// List is the regular price shown struck through beside Amount; display only.
	List int64 `json:"list,omitempty"`
	// DiscountPercent is Amount below List, rounded down; 0 with no List.
	DiscountPercent int `json:"discountPercent,omitempty"`
	// Promo names the offer List is shown against, e.g. "Early bird"; empty with no List.
	Promo string `json:"promo,omitempty"`
}

type BillingPlan struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Who       string         `json:"who"`
	Attendees int            `json:"attendees"`
	Features  []string       `json:"features"`
	Popular   bool           `json:"popular,omitempty"`
	Prices    []BillingPrice `json:"prices"`
	// ContactOnly is a plan sold by talking to us: no prices, no buy or trial.
	ContactOnly bool `json:"contactOnly,omitempty"`
}

/* BillingCatalogue is GET /api/billing/plans, public.
 *
 * Enabled is false when Razorpay keys are not configured: the page still shows
 * prices, and the buy button says checkout is unavailable rather than failing on
 * click. GSTPercent is applied to INR only.
 */
type BillingCatalogue struct {
	Enabled    bool          `json:"enabled"`
	GSTPercent int           `json:"gstPercent"`
	Plans      []BillingPlan `json:"plans"`
	// TrialDays is the free trial on monthly plans in TrialCurrency; 0 when trials
	// are off, and then every plan is pay-now.
	TrialDays     int    `json:"trialDays"`
	TrialCurrency string `json:"trialCurrency,omitempty"`
}

// StartTrialRequest is POST /api/billing/trial. Monthly, in TrialCurrency, always.
type StartTrialRequest struct {
	Plan string `json:"plan"`
}

/* TrialCheckout is what the browser opens Razorpay Checkout with for a trial: a
 * subscription, not an order. Amount is the monthly charge from TrialEndsAt, tax
 * included; today's payment is only Razorpay's small refunded authorisation. */
type TrialCheckout struct {
	SubscriptionID string `json:"subscriptionId"`
	KeyID          string `json:"keyId"`
	Plan           string `json:"plan"`
	PlanName       string `json:"planName"`
	Currency       string `json:"currency"`
	Amount         int64  `json:"amount"`
	TrialEndsAt    string `json:"trialEndsAt"`
	Description    string `json:"description"`
	PrefillName    string `json:"prefillName"`
	PrefillEmail   string `json:"prefillEmail"`
	PrefillPhone   string `json:"prefillPhone,omitempty"`
}

// VerifyTrialRequest is POST /api/billing/trial/verify: Checkout's handler response for a subscription.
type VerifyTrialRequest struct {
	PaymentID      string `json:"razorpay_payment_id"`
	SubscriptionID string `json:"razorpay_subscription_id"`
	Signature      string `json:"razorpay_signature"`
}

// CreateBillingOrderRequest is POST /api/billing/orders. No amount: the server prices it.
type CreateBillingOrderRequest struct {
	Plan     string `json:"plan"`
	Period   string `json:"period"`
	Currency string `json:"currency"`
	GSTIN    string `json:"gstin,omitempty"`
}

/* BillingCheckout is what the browser opens Razorpay Checkout with.
 *
 * KeyID is the PUBLIC key id; the secret never leaves the server. Prefill is the
 * signed-in account, so the buyer does not type their email twice.
 */
type BillingCheckout struct {
	OrderID      string `json:"orderId"`
	KeyID        string `json:"keyId"`
	Plan         string `json:"plan"`
	PlanName     string `json:"planName"`
	Period       string `json:"period"`
	Currency     string `json:"currency"`
	Subtotal     int64  `json:"subtotal"`
	Tax          int64  `json:"tax"`
	Amount       int64  `json:"amount"`
	Description  string `json:"description"`
	PrefillName  string `json:"prefillName"`
	PrefillEmail string `json:"prefillEmail"`
	PrefillPhone string `json:"prefillPhone,omitempty"`
}

// VerifyBillingPaymentRequest is POST /api/billing/verify: Razorpay Checkout's handler response.
type VerifyBillingPaymentRequest struct {
	OrderID   string `json:"razorpay_order_id"`
	PaymentID string `json:"razorpay_payment_id"`
	Signature string `json:"razorpay_signature"`
}

// BillingStatus is the account's current plan. Empty Plan means it has never paid.
type BillingStatus struct {
	Plan      string `json:"plan,omitempty"`
	PlanName  string `json:"planName,omitempty"`
	Period    string `json:"period,omitempty"`
	Attendees int    `json:"attendees,omitempty"`
	// PaidUntil is RFC3339: the end of the latest period paid for.
	PaidUntil string `json:"paidUntil,omitempty"`
	Active    bool   `json:"active"`
	// Status is the subscription's: trialing, active or past_due. Empty for a
	// one-time payment.
	Status string `json:"status,omitempty"`
	// TrialEndsAt is RFC3339, set while trialing: the day of the first charge.
	TrialEndsAt string `json:"trialEndsAt,omitempty"`
	// Renews is a Razorpay subscription that charges monthly until cancelled.
	Renews bool `json:"renews,omitempty"`
}

// VerifyTrialResponse is the account once its trial has started.
type VerifyTrialResponse struct {
	Account Account       `json:"account"`
	Billing BillingStatus `json:"billing"`
}

// VerifyBillingPaymentResponse is the upgraded account and the plan it now has.
type VerifyBillingPaymentResponse struct {
	Account   Account       `json:"account"`
	Billing   BillingStatus `json:"billing"`
	PaymentID string        `json:"paymentId"`
}
