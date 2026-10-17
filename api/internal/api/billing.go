package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Self-serve plans: buy one, and hosting turns on.
 *
 *   GET  /api/billing/plans      public   the price list the pricing page renders
 *   POST /api/billing/orders     session  price a plan, create a Razorpay order
 *   POST /api/billing/verify     session  Checkout's signed callback → fulfil
 *   GET  /api/me/billing         session  this account's current plan
 *   POST /api/webhooks/razorpay  signed   payment.captured / order.paid → fulfil
 *
 * Two roads to fulfilment on purpose. The browser callback is what makes the
 * upgrade instant; the webhook is what makes it certain, for the buyer whose tab
 * closed between paying and the callback. store.FulfilBillingOrder makes the two
 * one: whichever lands first grants, the other is a no-op.
 *
 * Fulfilment does two things to the account: can_host = true, and the plan that
 * was bought goes into subscriptions (see store.FulfilBillingOrder), which is what
 * sets its attendee ceiling. Nothing here ever sets can_host back to false — an
 * admin's toggle is still the only way hosting is taken away.
 */

var gstinPattern = regexp.MustCompile(`^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`)

func (s *Server) billingCatalogue() types.BillingCatalogue {
	plans := make([]types.BillingPlan, 0, len(billing.Plans))
	for _, p := range billing.Plans {
		bp := types.BillingPlan{
			ID: string(p.ID), Name: p.Name, Who: p.Who, Attendees: p.Attendees(),
			Features: p.AllFeatures(), Popular: p.Popular,
		}
		for _, cur := range []string{billing.INR, billing.USD} {
			for _, per := range []string{billing.Monthly, billing.Yearly} {
				if amt, ok := p.Price(cur, per); ok {
					bp.Prices = append(bp.Prices, types.BillingPrice{Currency: cur, Period: per, Amount: amt})
				}
			}
		}
		plans = append(plans, bp)
	}
	return types.BillingCatalogue{
		Enabled:    s.billing != nil,
		GSTPercent: s.cfg.BillingGSTPercent,
		Plans:      plans,
	}
}

func (s *Server) handleBillingPlans(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, s.billingCatalogue())
}

/* handleCreateBillingOrder is POST /api/billing/orders.
 *
 * Prices the plan HERE, from billing.Plans, and asks Razorpay for an order of
 * exactly that amount. The row recorded alongside is what fulfilment later trusts
 * for which plan and period were bought — not anything the browser says then.
 */
func (s *Server) handleCreateBillingOrder(w http.ResponseWriter, r *http.Request) {
	if s.billing == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "billing_off",
			"Online payment isn't set up yet. Write to us and we'll enable your plan.")
		return
	}
	var req types.CreateBillingOrderRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if req.Currency == "" {
		req.Currency = billing.INR
	}
	quote, err := billing.NewQuote(req.Plan, req.Period, strings.ToUpper(req.Currency), s.cfg.BillingGSTPercent)
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "unknown_plan", "That plan isn't available.")
		return
	}
	gstin := strings.ToUpper(strings.TrimSpace(req.GSTIN))
	if gstin != "" && !gstinPattern.MatchString(gstin) {
		httpx.Fields(w, map[string]string{"gstin": "That doesn't look like a GSTIN (15 characters, e.g. 22AAAAA0000A1Z5)."})
		return
	}

	user := userFromContext(r.Context())
	order, err := s.billing.CreateOrder(r.Context(), billing.OrderRequest{
		Amount:   quote.Total,
		Currency: quote.Currency,
		// Razorpay caps a receipt at 40 characters.
		Receipt: fmt.Sprintf("wl-%.8s-%d", user.ID, time.Now().Unix()),
		Notes: map[string]string{
			"user_id": user.ID,
			"email":   user.Email,
			"plan":    string(quote.Plan.ID),
			"period":  quote.Period,
		},
	})
	if err != nil {
		s.log.Error("billing: create razorpay order", "user", user.ID, "plan", quote.Plan.ID, "err", err)
		httpx.Error(w, http.StatusBadGateway, "razorpay",
			"We couldn't start the payment just now. Please try again in a minute.")
		return
	}
	if _, err := s.store.CreateBillingOrder(r.Context(), store.BillingOrder{
		UserID: user.ID, Plan: string(quote.Plan.ID), Period: quote.Period, Currency: quote.Currency,
		Amount: quote.Total, Tax: quote.Tax, RazorpayOrderID: order.ID, GSTIN: gstin,
	}); err != nil {
		s.fail(w, r, "billing: record order", err)
		return
	}

	period := "1 month"
	if quote.Period == billing.Yearly {
		period = "1 year"
	}
	httpx.JSON(w, http.StatusCreated, types.BillingCheckout{
		OrderID:      order.ID,
		KeyID:        s.cfg.RazorpayKeyID,
		Plan:         string(quote.Plan.ID),
		PlanName:     quote.Plan.Name,
		Period:       quote.Period,
		Currency:     quote.Currency,
		Subtotal:     quote.Subtotal,
		Tax:          quote.Tax,
		Amount:       quote.Total,
		Description:  fmt.Sprintf("%s plan · %s", quote.Plan.Name, period),
		PrefillName:  user.Name,
		PrefillEmail: user.Email,
		PrefillPhone: user.Phone,
	})
}

/* handleVerifyBillingPayment is POST /api/billing/verify.
 *
 * The body is exactly what Razorpay Checkout hands its success handler. The
 * signature is checked against the key secret before anything is read from the
 * database, so a forged callback costs one HMAC and learns nothing.
 */
func (s *Server) handleVerifyBillingPayment(w http.ResponseWriter, r *http.Request) {
	if s.billing == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "billing_off", "Online payment isn't set up.")
		return
	}
	var req types.VerifyBillingPaymentRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	user := userFromContext(r.Context())
	if !billing.VerifyPayment(s.cfg.RazorpayKeySecret, req.OrderID, req.PaymentID, req.Signature) {
		s.log.Warn("billing: payment signature rejected", "user", user.ID, "order", req.OrderID)
		httpx.Error(w, http.StatusBadRequest, "bad_signature",
			"We couldn't confirm that payment. If money left your account, write to us and we'll sort it out.")
		return
	}

	order, updated, err := s.store.FulfilBillingOrder(r.Context(), req.OrderID, req.PaymentID, user.ID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such order.")
		return
	case errors.Is(err, store.ErrPaymentMismatch):
		s.log.Error("billing: order paid twice", "user", user.ID, "order", req.OrderID,
			"kept", order.RazorpayPaymentID, "extra", req.PaymentID)
		httpx.Error(w, http.StatusConflict, "already_paid",
			"This order was already paid. The second payment will be refunded.")
		return
	case err != nil:
		s.fail(w, r, "billing: fulfil", err)
		return
	}
	s.log.Info("billing: paid, hosting enabled", "via", "checkout", "user", updated.ID,
		"plan", order.Plan, "period", order.Period, "order", order.RazorpayOrderID, "payment", req.PaymentID)

	httpx.JSON(w, http.StatusOK, types.VerifyBillingPaymentResponse{
		Account:   updated.Public(),
		Billing:   billingStatus(order),
		PaymentID: req.PaymentID,
	})
}

// handleMyBilling is GET /api/me/billing.
func (s *Server) handleMyBilling(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	order, err := s.store.CurrentBillingOrder(r.Context(), user.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.JSON(w, http.StatusOK, types.BillingStatus{})
		return
	}
	if err != nil {
		s.fail(w, r, "billing: current", err)
		return
	}
	httpx.JSON(w, http.StatusOK, billingStatus(order))
}

/* handleRazorpayWebhook is POST /api/webhooks/razorpay.
 *
 * Signed with the webhook secret over the raw body. Answers 2xx for every event
 * it does not act on, because Razorpay retries anything else and eventually
 * disables the webhook. An order this server does not know is acknowledged too:
 * the same Razorpay account may take payments for something else.
 */
func (s *Server) handleRazorpayWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if !billing.VerifyWebhook(s.cfg.RazorpayWebhookSecret, body, r.Header.Get("X-Razorpay-Signature")) {
		s.log.Warn("razorpay webhook rejected")
		httpx.Error(w, http.StatusUnauthorized, "razorpay_signature", "Webhook signature was not accepted.")
		return
	}
	p, ok := billing.ParseWebhook(body)
	if !ok {
		w.WriteHeader(http.StatusOK)
		return
	}
	known, err := s.store.BillingOrderByRazorpayID(r.Context(), p.OrderID)
	if errors.Is(err, store.ErrNotFound) {
		w.WriteHeader(http.StatusOK)
		return
	}
	if err != nil {
		s.fail(w, r, "razorpay webhook: lookup", err)
		return
	}
	// The order was created for an amount; a capture for anything else is not
	// this order being paid, whatever the order id says.
	if p.Amount != known.Amount || !strings.EqualFold(p.Currency, known.Currency) {
		s.log.Error("razorpay webhook: amount mismatch", "order", p.OrderID,
			"want", known.Amount, "got", p.Amount, "currency", p.Currency)
		w.WriteHeader(http.StatusOK)
		return
	}
	order, updated, err := s.store.FulfilBillingOrder(r.Context(), p.OrderID, p.PaymentID, "")
	switch {
	case errors.Is(err, store.ErrPaymentMismatch):
		s.log.Error("billing: order paid twice", "order", p.OrderID,
			"kept", order.RazorpayPaymentID, "extra", p.PaymentID)
		w.WriteHeader(http.StatusOK)
		return
	case errors.Is(err, store.ErrAccountGone):
		s.log.Error("billing: payment for a deleted account, refund it", "order", p.OrderID,
			"payment", p.PaymentID)
		w.WriteHeader(http.StatusOK)
		return
	case err != nil:
		// 5xx: Razorpay retries, which is what a transient database error wants.
		s.fail(w, r, "razorpay webhook: fulfil", err)
		return
	}
	s.log.Info("billing: paid, hosting enabled", "via", p.Event, "user", updated.ID,
		"plan", order.Plan, "period", order.Period, "order", order.RazorpayOrderID, "payment", p.PaymentID)
	w.WriteHeader(http.StatusOK)
}

func billingStatus(o store.BillingOrder) types.BillingStatus {
	st := types.BillingStatus{Plan: o.Plan, Period: o.Period}
	if p, ok := billing.FindPlan(o.Plan); ok {
		st.PlanName = p.Name
		st.Attendees = p.Attendees()
	}
	if o.PaidUntil != nil {
		st.PaidUntil = o.PaidUntil.UTC().Format(time.RFC3339)
		st.Active = o.PaidUntil.After(time.Now())
	}
	return st
}

// razorpayMode is "test" or "live", from the key id's prefix, for the boot log.
func razorpayMode(keyID string) string {
	if strings.HasPrefix(keyID, "rzp_live_") {
		return "live"
	}
	return "test"
}
