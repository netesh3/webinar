package billing

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

/* Razorpay Subscriptions: the monthly free trial.
 *
 * A trial is a subscription whose start_at is TrialDays out. Checkout opens it
 * against the subscription id, the buyer authorises a mandate (card, UPI AutoPay
 * or eMandate) with Razorpay's small refunded authentication charge, and the
 * first real charge is Razorpay's, on start_at.
 * https://razorpay.com/docs/payments/subscriptions/workflow/
 *
 * Trials are INR only. Plans accept "any supported currency", but nothing in
 * Razorpay's Subscriptions docs confirms recurring USD/international mandates,
 * so a USD buyer pays up front through the one-time order flow instead.
 */

// TrialDays is how long the free trial runs before the first charge.
const TrialDays = 7

// TrialCurrency is the one currency trials are offered in.
const TrialCurrency = INR

/* TrialTotalCount is the subscription's billing cycles. Razorpay needs a count
 * or an end date; ten years of months is "until cancelled" in practice. */
const TrialTotalCount = 120

// PlanRequest is POST /v1/plans. https://razorpay.com/docs/api/payments/subscriptions/create-plan/
type PlanRequest struct {
	Period   string            `json:"period"`
	Interval int               `json:"interval"`
	Item     PlanItem          `json:"item"`
	Notes    map[string]string `json:"notes,omitempty"`
}

type PlanItem struct {
	Name        string `json:"name"`
	Amount      int64  `json:"amount"`
	Currency    string `json:"currency"`
	Description string `json:"description,omitempty"`
}

type RazorpayPlan struct {
	ID string `json:"id"`
}

// CreatePlan creates a Razorpay plan: the price a subscription charges each cycle.
func (c *Client) CreatePlan(ctx context.Context, req PlanRequest) (RazorpayPlan, error) {
	var p RazorpayPlan
	if err := c.do(ctx, http.MethodPost, "/v1/plans", req, &p, "create plan"); err != nil {
		return RazorpayPlan{}, err
	}
	if p.ID == "" {
		return RazorpayPlan{}, errors.New("razorpay create plan: no plan id in response")
	}
	return p, nil
}

/* SubscriptionRequest is POST /v1/subscriptions.
 * https://razorpay.com/docs/api/payments/subscriptions/create-subscription/ */
type SubscriptionRequest struct {
	PlanID         string            `json:"plan_id"`
	TotalCount     int               `json:"total_count"`
	StartAt        int64             `json:"start_at,omitempty"`
	CustomerNotify bool              `json:"customer_notify"`
	Notes          map[string]string `json:"notes,omitempty"`
}

/* Subscription is the part of Razorpay's subscription entity this app reads.
 * Times are unix seconds, 0 when Razorpay sends null (current_start/current_end
 * stay null until the first charge). Notes is raw: Razorpay sends [] when empty. */
type Subscription struct {
	ID           string          `json:"id"`
	PlanID       string          `json:"plan_id"`
	CustomerID   string          `json:"customer_id"`
	Status       string          `json:"status"`
	CurrentStart int64           `json:"current_start"`
	CurrentEnd   int64           `json:"current_end"`
	ChargeAt     int64           `json:"charge_at"`
	StartAt      int64           `json:"start_at"`
	ShortURL     string          `json:"short_url"`
	Notes        json.RawMessage `json:"notes"`
}

func (c *Client) CreateSubscription(ctx context.Context, req SubscriptionRequest) (Subscription, error) {
	var sub Subscription
	if err := c.do(ctx, http.MethodPost, "/v1/subscriptions", req, &sub, "create subscription"); err != nil {
		return Subscription{}, err
	}
	if sub.ID == "" {
		return Subscription{}, errors.New("razorpay create subscription: no subscription id in response")
	}
	return sub, nil
}

func (c *Client) FetchSubscription(ctx context.Context, id string) (Subscription, error) {
	var sub Subscription
	err := c.do(ctx, http.MethodGet, "/v1/subscriptions/"+url.PathEscape(id), nil, &sub, "fetch subscription")
	return sub, err
}

/* CancelSubscription cancels now. cancel_at_cycle_end is refused on a subscription
 * still in its trial (no active billing cycle yet), and cancelling a trial is meant
 * to stop the first charge, so it is always immediate.
 * https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/ */
func (c *Client) CancelSubscription(ctx context.Context, id string) (Subscription, error) {
	var sub Subscription
	err := c.do(ctx, http.MethodPost, "/v1/subscriptions/"+url.PathEscape(id)+"/cancel",
		map[string]bool{"cancel_at_cycle_end": false}, &sub, "cancel subscription")
	return sub, err
}

// PaymentCard is the card object on a card payment.
type PaymentCard struct {
	Last4   string `json:"last4"`
	Network string `json:"network"`
	Issuer  string `json:"issuer"`
}

/* Payment is the part of Razorpay's payment entity used to recognise a payment
 * method seen on an earlier trial: vpa for UPI, card for cards.
 * https://razorpay.com/docs/api/payments/fetch-with-id/ */
type Payment struct {
	ID       string       `json:"id"`
	Amount   int64        `json:"amount"`
	Currency string       `json:"currency"`
	Status   string       `json:"status"`
	Method   string       `json:"method"`
	VPA      string       `json:"vpa"`
	CardID   string       `json:"card_id"`
	Email    string       `json:"email"`
	Contact  string       `json:"contact"`
	Card     *PaymentCard `json:"card"`
}

// FetchPayment reads one payment with its card details expanded.
func (c *Client) FetchPayment(ctx context.Context, id string) (Payment, error) {
	var p Payment
	err := c.do(ctx, http.MethodGet, "/v1/payments/"+url.PathEscape(id)+"?expand[]=card", nil, &p, "fetch payment")
	return p, err
}

/* VerifySubscriptionPayment checks Checkout's signature for a subscription:
 * HMAC-SHA256 of "payment_id|subscription_id" with the key secret. The order is
 * the reverse of an order's "order_id|payment_id".
 * https://razorpay.com/docs/payments/subscriptions/integration-guide/ */
func VerifySubscriptionPayment(keySecret, paymentID, subscriptionID, signature string) bool {
	if keySecret == "" || paymentID == "" || subscriptionID == "" || signature == "" {
		return false
	}
	return equalHex(sign(keySecret, []byte(paymentID+"|"+subscriptionID)), signature)
}

/* SubscriptionEvent is a subscription.* webhook: the subscription, and the
 * payment when the event carries one (charged and completed do; authenticated
 * does not). https://razorpay.com/docs/webhooks/subscriptions/ */
type SubscriptionEvent struct {
	Event        string
	Subscription Subscription
	Payment      *Payment
}

func ParseSubscriptionWebhook(body []byte) (SubscriptionEvent, bool) {
	var env struct {
		Event   string `json:"event"`
		Payload struct {
			Subscription struct {
				Entity Subscription `json:"entity"`
			} `json:"subscription"`
			Payment *struct {
				Entity Payment `json:"entity"`
			} `json:"payment"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(body, &env); err != nil || !strings.HasPrefix(env.Event, "subscription.") {
		return SubscriptionEvent{}, false
	}
	if env.Payload.Subscription.Entity.ID == "" {
		return SubscriptionEvent{}, false
	}
	ev := SubscriptionEvent{Event: env.Event, Subscription: env.Payload.Subscription.Entity}
	if env.Payload.Payment != nil && env.Payload.Payment.Entity.ID != "" {
		p := env.Payload.Payment.Entity
		ev.Payment = &p
	}
	return ev, true
}
