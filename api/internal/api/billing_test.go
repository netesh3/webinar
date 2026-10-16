package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Self-serve plans, against a fake Razorpay.
 *
 * What is under test is the part that is ours: the server prices the plan, the
 * payment is only believed when Razorpay's signature says so, and a believed
 * payment turns hosting on exactly once whichever of the browser and the webhook
 * reports it first. Razorpay itself is an httptest.Server that checks the Basic
 * auth and records the amount it was asked to charge.
 */

const (
	rzpKeyID     = "rzp_test_harness"
	rzpSecret    = "key-secret-for-tests"
	rzpWebhookSK = "webhook-secret-for-tests"
)

type fakeRazorpay struct {
	mu     sync.Mutex
	n      int
	orders map[string]billing.OrderRequest
}

func newFakeRazorpay(t *testing.T) (*fakeRazorpay, *httptest.Server) {
	f := &fakeRazorpay{orders: map[string]billing.OrderRequest{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, secret, ok := r.BasicAuth()
		if !ok || id != rzpKeyID || secret != rzpSecret {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"description":"Authentication failed"}}`))
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/orders" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var req billing.OrderRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.n++
		oid := fmt.Sprintf("order_fake%d", f.n)
		f.orders[oid] = req
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(billing.Order{ID: oid, Amount: req.Amount, Currency: req.Currency, Status: "created"})
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeRazorpay) order(id string) billing.OrderRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.orders[id]
}

func billingHarness(t *testing.T) (*harness, *fakeRazorpay) {
	t.Helper()
	fake, srv := newFakeRazorpay(t)
	h := newHarness(t, func(c *config.Config) {
		c.RazorpayKeyID = rzpKeyID
		c.RazorpayKeySecret = rzpSecret
		c.RazorpayWebhookSecret = rzpWebhookSK
		c.RazorpayAPIURL = srv.URL
		c.BillingGSTPercent = 18
	})
	return h, fake
}

func (h *harness) buy(plan, period, currency string) types.BillingCheckout {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/billing/orders", types.CreateBillingOrderRequest{
		Plan: plan, Period: period, Currency: currency,
	})
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("create order: status %d body %s", res.StatusCode, raw)
	}
	var co types.BillingCheckout
	h.decode(raw, &co)
	return co
}

func (h *harness) webhook(event, orderID, paymentID string, amount int64, currency string) *http.Response {
	h.t.Helper()
	body := []byte(fmt.Sprintf(
		`{"event":%q,"payload":{"payment":{"entity":{"id":%q,"order_id":%q,"amount":%d,"currency":%q,"status":"captured"}}}}`,
		event, paymentID, orderID, amount, currency))
	res, _ := h.doRaw(http.MethodPost, "/api/webhooks/razorpay", "application/json", body,
		map[string]string{"X-Razorpay-Signature": billing.Sign(rzpWebhookSK, body)})
	return res
}

func (h *harness) me() types.Account {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("me: %d %s", res.StatusCode, raw)
	}
	var a types.Account
	h.decode(raw, &a)
	return a
}

func TestBuyingAPlanTurnsHostingOn(t *testing.T) {
	h, fake := billingHarness(t)
	h.signup("Coach Buyer", "buyer@example.com", false)

	// Before paying: not a host, and the host API says so.
	if h.me().CanHost {
		t.Fatal("fresh account can host")
	}
	if res, _ := h.do(http.MethodGet, "/api/host/webinars", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("host API before paying: %d, want 403", res.StatusCode)
	}

	co := h.buy("business", billing.Monthly, billing.INR)
	// The SERVER priced it: ₹14,999 + 18% GST, and that is what Razorpay was asked for.
	if co.Subtotal != 14_999_00 || co.Tax != 2_699_82 || co.Amount != 17_698_82 || co.KeyID != rzpKeyID {
		t.Fatalf("checkout: %+v", co)
	}
	if got := fake.order(co.OrderID); got.Amount != co.Amount || got.Currency != "INR" || got.Notes["plan"] != "business" {
		t.Fatalf("razorpay was asked for %+v", got)
	}

	// Checkout's success handler, with Razorpay's signature.
	res, raw := h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
		OrderID: co.OrderID, PaymentID: "pay_ok1",
		Signature: billing.Sign(rzpSecret, []byte(co.OrderID+"|pay_ok1")),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("verify: %d %s", res.StatusCode, raw)
	}
	var vr types.VerifyBillingPaymentResponse
	h.decode(raw, &vr)
	if !vr.Account.CanHost || vr.Billing.Plan != "business" || !vr.Billing.Active || vr.Billing.Attendees != 300 {
		t.Fatalf("verify response: %+v", vr)
	}
	until, _ := time.Parse(time.RFC3339, vr.Billing.PaidUntil)
	if d := time.Until(until); d < 27*24*time.Hour || d > 32*24*time.Hour {
		t.Fatalf("a month should be paid for, got until %s", vr.Billing.PaidUntil)
	}

	// The very next request can host.
	if !h.me().CanHost {
		t.Fatal("account cannot host after paying")
	}
	if res, raw := h.do(http.MethodGet, "/api/host/webinars", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("host API after paying: %d %s", res.StatusCode, raw)
	}

	// The webhook for the same payment arriving afterwards changes nothing.
	if res := h.webhook("payment.captured", co.OrderID, "pay_ok1", co.Amount, "INR"); res.StatusCode != http.StatusOK {
		t.Fatalf("duplicate webhook: %d", res.StatusCode)
	}
	res, raw = h.do(http.MethodGet, "/api/me/billing", nil)
	var st types.BillingStatus
	h.decode(raw, &st)
	if st.PaidUntil != vr.Billing.PaidUntil {
		t.Fatalf("duplicate report extended the plan: %s → %s", vr.Billing.PaidUntil, st.PaidUntil)
	}
}

func TestForgedPaymentIsRefused(t *testing.T) {
	h, _ := billingHarness(t)
	h.signup("Forger", "forger@example.com", false)
	co := h.buy("enterprise", billing.Yearly, billing.INR)

	for name, sig := range map[string]string{
		"no signature":     "",
		"wrong secret":     billing.Sign("guess", []byte(co.OrderID+"|pay_x")),
		"another payment":  billing.Sign(rzpSecret, []byte(co.OrderID+"|pay_other")),
		"signed elsewhere": "deadbeef",
	} {
		res, _ := h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
			OrderID: co.OrderID, PaymentID: "pay_x", Signature: sig,
		})
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", name, res.StatusCode)
		}
	}
	if h.me().CanHost {
		t.Fatal("forged payment granted hosting")
	}

	// A webhook signed with anything but the webhook secret is refused too.
	body := []byte(fmt.Sprintf(`{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_x","order_id":%q,"amount":%d,"currency":"INR","status":"captured"}}}}`, co.OrderID, co.Amount))
	res, _ := h.doRaw(http.MethodPost, "/api/webhooks/razorpay", "application/json", body,
		map[string]string{"X-Razorpay-Signature": billing.Sign(rzpSecret, body)})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("webhook signed with the key secret: %d, want 401", res.StatusCode)
	}
	if h.me().CanHost {
		t.Fatal("unsigned webhook granted hosting")
	}
}

func TestWebhookAloneTurnsHostingOn(t *testing.T) {
	// The buyer paid and closed the tab before Checkout's callback ran.
	h, _ := billingHarness(t)
	h.signup("Tab Closer", "closer@example.com", false)
	co := h.buy("professional", billing.Monthly, billing.USD)
	if co.Tax != 0 || co.Amount != 49_00 {
		t.Fatalf("USD has no GST: %+v", co)
	}

	// A capture for a different amount is not this order being paid.
	if res := h.webhook("payment.captured", co.OrderID, "pay_cheap", 1_00, "USD"); res.StatusCode != http.StatusOK {
		t.Fatalf("mismatched webhook should be acknowledged: %d", res.StatusCode)
	}
	if h.me().CanHost {
		t.Fatal("underpayment granted hosting")
	}

	if res := h.webhook("order.paid", co.OrderID, "pay_wh1", co.Amount, "USD"); res.StatusCode != http.StatusOK {
		t.Fatalf("webhook: %d", res.StatusCode)
	}
	if !h.me().CanHost {
		t.Fatal("webhook did not turn hosting on")
	}

	// The browser's callback arriving late is a no-op success, not an error.
	res, raw := h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
		OrderID: co.OrderID, PaymentID: "pay_wh1",
		Signature: billing.Sign(rzpSecret, []byte(co.OrderID+"|pay_wh1")),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("late callback: %d %s", res.StatusCode, raw)
	}
}

func TestOnlyTheBuyerCanClaimAnOrder(t *testing.T) {
	h, _ := billingHarness(t)
	h.signup("Buyer", "owner@example.com", false)
	co := h.buy("business", billing.Monthly, billing.INR)
	h.logout()

	h.signup("Somebody Else", "other@example.com", false)
	res, _ := h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
		OrderID: co.OrderID, PaymentID: "pay_ok",
		Signature: billing.Sign(rzpSecret, []byte(co.OrderID+"|pay_ok")),
	})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("claiming another account's order: %d, want 404", res.StatusCode)
	}
	if h.me().CanHost {
		t.Fatal("another account's payment granted hosting")
	}
}

func TestRenewingEarlyAddsAFullPeriod(t *testing.T) {
	h, _ := billingHarness(t)
	h.signup("Renewer", "renew@example.com", false)
	pay := func(period, payment string) types.BillingStatus {
		co := h.buy("professional", period, billing.INR)
		res, raw := h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
			OrderID: co.OrderID, PaymentID: payment,
			Signature: billing.Sign(rzpSecret, []byte(co.OrderID+"|"+payment)),
		})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("verify %s: %d %s", payment, res.StatusCode, raw)
		}
		var vr types.VerifyBillingPaymentResponse
		h.decode(raw, &vr)
		return vr.Billing
	}
	first := pay(billing.Monthly, "pay_m1")
	second := pay(billing.Yearly, "pay_y1")
	a, _ := time.Parse(time.RFC3339, first.PaidUntil)
	b, _ := time.Parse(time.RFC3339, second.PaidUntil)
	if d := b.Sub(a); d < 364*24*time.Hour || d > 367*24*time.Hour {
		t.Fatalf("a year bought during a paid month should start when the month ends: %s → %s", a, b)
	}
}

func TestCatalogueAndRefusals(t *testing.T) {
	h, _ := billingHarness(t)
	res, raw := h.do(http.MethodGet, "/api/billing/plans", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("plans: %d", res.StatusCode)
	}
	var cat types.BillingCatalogue
	h.decode(raw, &cat)
	if !cat.Enabled || cat.GSTPercent != 18 || len(cat.Plans) != 3 || len(cat.Plans[0].Prices) != 4 {
		t.Fatalf("catalogue: %+v", cat)
	}
	if strings.Contains(string(raw), rzpSecret) {
		t.Fatal("catalogue leaks the key secret")
	}

	// No session, no order.
	if res, _ := h.do(http.MethodPost, "/api/billing/orders", types.CreateBillingOrderRequest{Plan: "business", Period: "monthly"}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous order: %d, want 401", res.StatusCode)
	}
	h.signup("Picky", "picky@example.com", false)
	if res, _ := h.do(http.MethodPost, "/api/billing/orders", types.CreateBillingOrderRequest{Plan: "platinum", Period: "monthly"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unknown plan: %d, want 422", res.StatusCode)
	}
	if res, _ := h.do(http.MethodPost, "/api/billing/orders", types.CreateBillingOrderRequest{Plan: "business", Period: "monthly", GSTIN: "nope"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("bad GSTIN: %d, want 422", res.StatusCode)
	}
}

func TestBillingOffWithoutKeys(t *testing.T) {
	h := newHarness(t)
	_, raw := h.do(http.MethodGet, "/api/billing/plans", nil)
	var cat types.BillingCatalogue
	h.decode(raw, &cat)
	if cat.Enabled {
		t.Fatal("billing enabled with no keys")
	}
	h.signup("Early", "early@example.com", false)
	if res, _ := h.do(http.MethodPost, "/api/billing/orders", types.CreateBillingOrderRequest{Plan: "business", Period: "monthly"}); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("order with billing off: %d, want 503", res.StatusCode)
	}
	// And the webhook refuses everything rather than trusting an empty secret.
	body := []byte(`{"event":"payment.captured"}`)
	res, _ := h.doRaw(http.MethodPost, "/api/webhooks/razorpay", "application/json", body,
		map[string]string{"X-Razorpay-Signature": billing.Sign("", body)})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("webhook with no secret configured: %d, want 401", res.StatusCode)
	}
}
