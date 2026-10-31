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

// Periods a plan can be bought for. A yearly charge is about ten months (see yearly); it is
// shown as YearlyOffPercent off a list price (YearlyList), not as months free (31 Oct 2026).
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
 * The plan ids and what each plan allows are types.Plan, types.PlanAttendeeCap and
 * types.PlanStageCap, which is what the API enforces (see api.attendeeCeiling and
 * api.stageCapForHost). This table only adds what a plan costs and how the pricing page
 * describes it, so the numbers on the page are the enforced ones by construction.
 *
 * Prices are minor units (paise, cents) BEFORE tax. Tax is added at checkout
 * (see Quote) so a change of GST rate is a config change, not a price change.
 */
type Plan struct {
	ID   types.Plan
	Name string
	Who  string
	// Features after the attendee and stage lines, which AllFeatures supplies.
	Features []string
	Popular  bool
	// Monthly price per currency, minor units. Yearly is about ten times this; see yearly.
	Monthly map[string]int64
	/* ListMonthly is the monthly list price the real one is shown against, struck through,
	 * with its saving as a badge ("60% OFF"). Display only — every charge uses Monthly. A
	 * yearly price's list is YearlyList, whatever this says. */
	ListMonthly map[string]int64
	/* ContactOnly is a plan sold by conversation, not online: the pricing page says
	 * "Contact us", and orders and trials for it are refused. An admin assigns it. */
	ContactOnly bool
	/* Retired is a grandfathered plan: kept so its subscribers keep their limits, their
	 * price and its name on their billing card, but not on the pricing page and never sold
	 * to anyone new. Only an account already on it may buy it again (NewQuoteFor). */
	Retired bool
}

/* YearlyOffPercent is how a yearly price is presented: this much off its list price, which
 * is YearlyList. The charge itself is still yearly's ten-months rule (31 Oct 2026). */
const YearlyOffPercent = 80

/* YearlyList is the struck-through list price a yearly charge is shown against: the charge
 * over (1 − YearlyOffPercent), rounded to the nearest minor unit, so the badge reads exactly
 * "80% OFF". The one place this rule lives on the server; web/lib/plans.ts yearlyListPrice is
 * the same, and a test holds them to each other. */
func YearlyList(charge int64) int64 {
	keep := int64(100 - YearlyOffPercent)
	return (charge*100 + keep/2) / keep
}

// DiscountPercent is how much below the list price amount is, rounded down; 0 with no list price.
func DiscountPercent(amount, list int64) int {
	if list <= 0 || amount >= list {
		return 0
	}
	return int((list - amount) * 100 / list)
}

// OffLabel is the badge a discounted price carries: "60% OFF".
func OffLabel(percent int) string {
	if percent <= 0 {
		return ""
	}
	return fmt.Sprintf("%d%% OFF", percent)
}

// Attendees is the plan's enforced attendee cap.
func (p Plan) Attendees() int { return types.PlanAttendeeCap(p.ID) }

// StageSeats is the plan's enforced cap on people on stage at once, the host included.
func (p Plan) StageSeats() int { return types.PlanStageCap(p.ID) }

// AllFeatures is the pricing page's list: the attendee and stage caps first, then the rest.
// A contact-only plan's attendee cap is where it starts ("1,000+ attendees").
func (p Plan) AllFeatures() []string {
	attendees := fmt.Sprintf("Up to %s attendees", thousands(p.Attendees()))
	if p.ContactOnly {
		attendees = fmt.Sprintf("%s+ attendees", thousands(p.Attendees()))
	}
	return append([]string{
		attendees,
		fmt.Sprintf("Up to %s people on stage", thousands(p.StageSeats())),
	}, p.Features...)
}

// thousands writes 1000 as "1,000".
func thousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

/* Plans is the price list, in display order, the grandfathered Starter last.
 *
 * Edit here to change prices: the pricing page, the order summary and the amount
 * Razorpay charges all read from this one table. web/lib/plans.ts repeats the plans for
 * the static pages (the comparison table, /features), and a test here reads it back and
 * fails if the two disagree (web_plans_test.go).
 *
 * (31 Oct 2026) The owner's lineup: Basic, Professional, Business, Enterprise. Basic's USD
 * price ($39 against a $99 list) is our proposal, not the owner's figure.
 */
var Plans = []Plan{
	{
		ID:   types.PlanBasic,
		Name: "Basic",
		Who:  "For coaches running their first webinars",
		Features: []string{
			"Webinars with registration pages",
			"Email reminders before and follow-ups after",
			"Engagement for every attendee",
			"Webinar Engagement Score",
		},
		Monthly:     map[string]int64{INR: 2_999_00, USD: 39_00},
		ListMonthly: map[string]int64{INR: 7_499_00, USD: 99_00},
	},
	{
		ID:      types.PlanProfessional,
		Name:    "Professional",
		Who:     "For coaches selling programs every week",
		Popular: true,
		Features: []string{
			"Everything in Basic",
			"WhatsApp automations and campaigns",
			"WhatsApp follow-ups and scheduling",
		},
		Monthly: map[string]int64{INR: 9_999_00, USD: 149_00},
	},
	{
		ID:   types.PlanBusiness,
		Name: "Business",
		Who:  "For academies and teams with big launches",
		Features: []string{
			"Everything in Professional",
			"Simulive: recordings played as live",
			"AI recaps, knowledge base and follow-ups",
			"Zoom and every advanced feature",
		},
		Monthly: map[string]int64{INR: 24_999_00, USD: 349_00},
	},
	{
		ID:   types.PlanEnterprise,
		Name: "Enterprise",
		Who:  "For institutions and very large audiences",
		Features: []string{
			"Everything in Business",
			"Customised for your organisation",
			"Priority support and onboarding",
		},
		// Kept for an admin-assigned plan's records; never charged online.
		Monthly:     map[string]int64{INR: 39_999_00, USD: 499_00},
		ContactOnly: true,
	},
	{
		// Grandfathered (31 Oct 2026): the first subscribers' "Professional", renamed by
		// migrations/0179. Their Razorpay subscriptions keep charging what they agreed to.
		ID:   types.PlanStarter,
		Name: "Starter",
		Who:  "For coaches and consultants",
		Features: []string{
			"Registration pages & email reminders",
			"Polls, quizzes, Q&A and recording",
			"Engagement Score",
		},
		Monthly: map[string]int64{INR: 3_999_00, USD: 49_00},
		Retired: true,
	},
}

// OnSale is the plans the pricing page lists: every plan but the grandfathered ones.
func OnSale() []Plan {
	out := make([]Plan, 0, len(Plans))
	for _, p := range Plans {
		if !p.Retired {
			out = append(out, p)
		}
	}
	return out
}

// FindPlan returns the plan with this id, a grandfathered one included.
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
		return yearly(currency, monthly), true
	}
	return 0, false
}

/* yearly is the yearly charge: ten months for the price of twelve. Shown as
 * YearlyOffPercent off YearlyList since 31 Oct 2026; what a buyer pays is unchanged.
 *
 * The pricing page shows a yearly plan per month, and ten months over twelve is
 * a fraction of a rupee (₹39,990 / 12 = ₹3,332.50). So INR is priced as twelve
 * months at a whole per-month figure ending in 9, rounded down from that — the
 * buyer never pays more than ten months. USD stays ten times monthly. */
func yearly(currency string, monthly int64) int64 {
	if currency != INR {
		return monthly * 10
	}
	rupees := monthly * 10 / 12 / 100
	rupees -= ((rupees-9)%10 + 10) % 10
	return rupees * 12 * 100
}

/* List is the struck-through list price for one period, or 0 when there is none: a yearly
 * price's is always YearlyList, a monthly one's is ListMonthly where the plan has one. */
func (p Plan) List(currency, period string) int64 {
	if period == Yearly {
		if charge, ok := p.Price(currency, Yearly); ok {
			return YearlyList(charge)
		}
		return 0
	}
	return p.ListMonthly[currency]
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

// ErrRetired is a grandfathered plan asked for by an account not already on it (Plan.Retired).
var ErrRetired = errors.New("plan is no longer sold")

/* NewQuote prices a plan.
 *
 * GST applies to INR only: a USD buyer is paying from outside India, which is an
 * export of services. gstPercent of 0 turns tax off entirely, for an operator who
 * is not GST-registered or quotes tax-inclusive prices. Rounded to the nearest
 * paisa, half up.
 */
func NewQuote(planID, period, currency string, gstPercent int) (Quote, error) {
	return NewQuoteFor(planID, period, currency, gstPercent, false)
}

/* NewQuoteFor is NewQuote that can price a grandfathered plan: keepRetired is true only for
 * an account already on that plan, renewing it at the price it has (handleCreateBillingOrder).
 * Everyone else is refused it with ErrRetired. */
func NewQuoteFor(planID, period, currency string, gstPercent int, keepRetired bool) (Quote, error) {
	plan, ok := FindPlan(planID)
	if !ok {
		return Quote{}, ErrUnknownPlan
	}
	if plan.ContactOnly {
		return Quote{}, ErrContactOnly
	}
	if plan.Retired && !keepRetired {
		return Quote{}, ErrRetired
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
