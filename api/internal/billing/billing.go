/* Package billing is self-serve plans: the price list, Razorpay orders, and the
 * two signatures that prove a payment happened.
 *
 * The price list lives here, on the server, and nowhere else. The browser asks
 * for a plan, a period and a currency; it never sends an amount. Whatever the
 * pricing page shows is read from GET /api/billing/plans, so the page and the
 * charge cannot disagree.
 *
 * Razorpay is reached over its REST API with the key id and secret as Basic
 * auth. There is no SDK: one endpoint is used (create order), and the two
 * signatures are an HMAC each.
 */
package billing

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// Periods a plan can be bought for. A yearly price is ten months: two free.
const (
	Monthly = "monthly"
	Yearly  = "yearly"
)

// Currencies Razorpay is asked to charge in. USD needs international payments
// switched on for the Razorpay account.
const (
	INR = "INR"
	USD = "USD"
)

/* Plan is one row of the price list.
 *
 * The plan ids and what each plan allows are types.Plan and types.PlanAttendeeCap,
 * which is what the API enforces (see api.attendeeCeiling). This table only adds
 * what a plan costs and how the pricing page describes it, so the attendee number
 * on the page is the enforced one by construction.
 *
 * Prices are minor units (paise, cents) BEFORE tax. Tax is added at checkout
 * (see Quote) so a change of GST rate is a config change, not a price change.
 */
type Plan struct {
	ID   types.Plan
	Name string
	Who  string
	// Features after the attendee line, which Attendees() supplies.
	Features []string
	Popular  bool
	// Monthly price per currency, minor units. Yearly is ten times this.
	Monthly map[string]int64
	/* ListMonthly is the regular price the early-bird price is shown against,
	 * struck through. Display only — every charge uses Monthly. */
	ListMonthly map[string]int64
	/* ContactOnly is a plan sold by conversation, not online: the pricing page says
	 * "Contact us", and orders and trials for it are refused. An admin assigns it. */
	ContactOnly bool
}

/* PromoLabel names the offer a list price is shown against. The saving is
 * computed per price (DiscountPercent), never written into the label. */
func PromoLabel(currency string) string {
	if currency == INR {
		return "Early bird · India special offer"
	}
	return "Early bird"
}

// DiscountPercent is how much below the list price amount is, rounded down; 0 with no list price.
func DiscountPercent(amount, list int64) int {
	if list <= 0 || amount >= list {
		return 0
	}
	return int((list - amount) * 100 / list)
}

// Attendees is the plan's enforced attendee cap.
func (p Plan) Attendees() int { return types.PlanAttendeeCap(p.ID) }

// AllFeatures is the pricing page's list: the attendee cap first, then the rest.
func (p Plan) AllFeatures() []string {
	return append([]string{fmt.Sprintf("Up to %d attendees", p.Attendees())}, p.Features...)
}

/* Plans is the price list, in display order.
 *
 * Edit here to change prices: the pricing page, the order summary and the amount
 * Razorpay charges all read from this one table.
 */
var Plans = []Plan{
	{
		ID:   types.PlanProfessional,
		Name: "Professional",
		Who:  "For coaches and consultants",
		Features: []string{
			"Registration pages & email reminders",
			"Polls, quizzes, Q&A and recording",
			"Engagement Score",
		},
		Monthly:     map[string]int64{INR: 3_999_00, USD: 49_00},
		ListMonthly: map[string]int64{INR: 9_999_00, USD: 99_00},
	},
	{
		ID:      types.PlanBusiness,
		Name:    "Business",
		Who:     "For coaches selling programs",
		Popular: true,
		Features: []string{
			"WhatsApp reminders & broadcasts",
			"Follow-up by engagement group",
			"Drips, chatbot & shared inbox",
		},
		Monthly:     map[string]int64{INR: 14_999_00, USD: 199_00},
		ListMonthly: map[string]int64{INR: 37_499_00, USD: 399_00},
	},
	{
		ID:   types.PlanEnterprise,
		Name: "Enterprise",
		Who:  "For academies and teams",
		Features: []string{
			"Everything in Business",
			"Priority support on WhatsApp",
			"Personal onboarding session",
		},
		// Kept for an admin-assigned plan's records; never charged online.
		Monthly:     map[string]int64{INR: 39_999_00, USD: 499_00},
		ContactOnly: true,
	},
}

// FindPlan returns the plan with this id.
func FindPlan(id string) (Plan, bool) {
	for _, p := range Plans {
		if string(p.ID) == id {
			return p, true
		}
	}
	return Plan{}, false
}

// Price is the pre-tax price of a plan for one period, in minor units.
func (p Plan) Price(currency, period string) (int64, bool) {
	monthly, ok := p.Monthly[currency]
	if !ok {
		return 0, false
	}
	switch period {
	case Monthly:
		return monthly, true
	case Yearly:
		return monthly * 10, true
	}
	return 0, false
}

// List is the struck-through regular price for one period, or 0 when there is none.
func (p Plan) List(currency, period string) int64 {
	monthly := p.ListMonthly[currency]
	if period == Yearly {
		return monthly * 10
	}
	return monthly
}

// Quote is what one checkout will charge.
type Quote struct {
	Plan     Plan
	Period   string
	Currency string
	Subtotal int64
	Tax      int64
	Total    int64
}

var ErrUnknownPlan = errors.New("unknown plan, period or currency")

// ErrContactOnly is a plan that is not sold online (see Plan.ContactOnly).
var ErrContactOnly = errors.New("plan is sold by contacting us")

/* NewQuote prices a plan.
 *
 * GST applies to INR only: a USD buyer is paying from outside India, which is an
 * export of services. gstPercent of 0 turns tax off entirely, for an operator who
 * is not GST-registered or quotes tax-inclusive prices. Rounded to the nearest
 * paisa, half up.
 */
func NewQuote(planID, period, currency string, gstPercent int) (Quote, error) {
	plan, ok := FindPlan(planID)
	if !ok {
		return Quote{}, ErrUnknownPlan
	}
	if plan.ContactOnly {
		return Quote{}, ErrContactOnly
	}
	sub, ok := plan.Price(currency, period)
	if !ok {
		return Quote{}, ErrUnknownPlan
	}
	var tax int64
	if currency == INR && gstPercent > 0 {
		tax = (sub*int64(gstPercent) + 50) / 100
	}
	return Quote{Plan: plan, Period: period, Currency: currency, Subtotal: sub, Tax: tax, Total: sub + tax}, nil
}

// ------------------------------------------------------------------ signatures

/* VerifyPayment checks the signature Razorpay Checkout hands the browser after a
 * successful payment: HMAC-SHA256 of "order_id|payment_id" with the key secret.
 *
 * This is what ties a payment id the browser reports to the order the server
 * created, so a browser cannot claim a payment that was made for something else.
 */
func VerifyPayment(keySecret, orderID, paymentID, signature string) bool {
	if keySecret == "" || orderID == "" || paymentID == "" || signature == "" {
		return false
	}
	return equalHex(sign(keySecret, []byte(orderID+"|"+paymentID)), signature)
}

// VerifyWebhook checks X-Razorpay-Signature: HMAC-SHA256 of the raw body with
// the webhook secret set in the Razorpay dashboard.
func VerifyWebhook(webhookSecret string, body []byte, signature string) bool {
	if webhookSecret == "" || signature == "" {
		return false
	}
	return equalHex(sign(webhookSecret, body), signature)
}

// Sign is exported for tests that play the part of Razorpay.
func Sign(secret string, msg []byte) string { return sign(secret, msg) }

func sign(secret string, msg []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(msg)
	return hex.EncodeToString(m.Sum(nil))
}

func equalHex(want, got string) bool {
	return hmac.Equal([]byte(want), []byte(strings.ToLower(strings.TrimSpace(got))))
}

// ------------------------------------------------------------------ API client

// DefaultAPI is Razorpay's API host. Tests point Client.API at httptest.Server.
const DefaultAPI = "https://api.razorpay.com"

type Client struct {
	KeyID     string
	KeySecret string
	API       string
	HTTP      *http.Client
}

func New(keyID, keySecret string) *Client {
	return &Client{
		KeyID:     keyID,
		KeySecret: keySecret,
		API:       DefaultAPI,
		HTTP:      &http.Client{Timeout: 15 * time.Second},
	}
}

// OrderRequest is POST /v1/orders. Amount is minor units.
type OrderRequest struct {
	Amount   int64             `json:"amount"`
	Currency string            `json:"currency"`
	Receipt  string            `json:"receipt,omitempty"`
	Notes    map[string]string `json:"notes,omitempty"`
}

type Order struct {
	ID       string `json:"id"`
	Amount   int64  `json:"amount"`
	Currency string `json:"currency"`
	Status   string `json:"status"`
}

// CreateOrder asks Razorpay for an order. Checkout can only be opened against one.
func (c *Client) CreateOrder(ctx context.Context, req OrderRequest) (Order, error) {
	var o Order
	if err := c.do(ctx, http.MethodPost, "/v1/orders", req, &o, "create order"); err != nil {
		return Order{}, err
	}
	if o.ID == "" {
		return Order{}, errors.New("razorpay create order: no order id in response")
	}
	return o, nil
}

/* do is one authenticated Razorpay request. body nil sends none; out nil
 * discards the response. Razorpay's error body names the problem ("Authentication
 * failed", "The amount must be at least INR 1.00") and never echoes the secret. */
func (c *Client) do(ctx context.Context, method, path string, body, out any, what string) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(raw)
	}
	hr, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.API, "/")+path, rd)
	if err != nil {
		return err
	}
	hr.SetBasicAuth(c.KeyID, c.KeySecret)
	if body != nil {
		hr.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(hr)
	if err != nil {
		return fmt.Errorf("razorpay %s: %w", what, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		var e struct {
			Error struct {
				Description string `json:"description"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		return fmt.Errorf("razorpay %s: status %d: %s", what, res.StatusCode, e.Error.Description)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("razorpay %s: %w", what, err)
	}
	return nil
}

// ------------------------------------------------------------------ webhooks

/* WebhookPayment pulls the payment out of a payment.captured or order.paid event.
 *
 * Both carry payload.payment.entity with the order it paid. Any other event, or a
 * payment that is not captured, returns ok=false and is acknowledged without
 * doing anything.
 */
type WebhookPayment struct {
	Event     string
	PaymentID string
	OrderID   string
	Amount    int64
	Currency  string
}

func ParseWebhook(body []byte) (WebhookPayment, bool) {
	var env struct {
		Event   string `json:"event"`
		Payload struct {
			Payment struct {
				Entity struct {
					ID       string `json:"id"`
					OrderID  string `json:"order_id"`
					Amount   int64  `json:"amount"`
					Currency string `json:"currency"`
					Status   string `json:"status"`
				} `json:"entity"`
			} `json:"payment"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return WebhookPayment{}, false
	}
	if env.Event != "payment.captured" && env.Event != "order.paid" {
		return WebhookPayment{}, false
	}
	p := env.Payload.Payment.Entity
	if p.ID == "" || p.OrderID == "" || p.Status != "captured" {
		return WebhookPayment{}, false
	}
	return WebhookPayment{Event: env.Event, PaymentID: p.ID, OrderID: p.OrderID, Amount: p.Amount, Currency: p.Currency}, true
}
