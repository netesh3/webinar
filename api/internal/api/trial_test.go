package api_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The 7-day free trial, against the fake Razorpay in billing_test.go.
 *
 * Under test: a trial is a subscription that starts charging in seven days; its
 * webhooks move the account's plan; it is once per person (same phone or the same
 * Gmail mailbox on another account is refused, a shared payment method is only
 * flagged), and that survives deleting the account. Plus the lapse fix: a one-time
 * payment's plan ends when its period does.
 */

func (h *harness) setPhone(phone string) {
	h.t.Helper()
	res, raw := h.do(http.MethodPatch, "/api/auth/me", types.ProfilePatch{Phone: &phone})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("set phone: %d %s", res.StatusCode, raw)
	}
}

func (h *harness) startTrial(plan string) (int, types.TrialCheckout, string) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/billing/trial", types.StartTrialRequest{Plan: plan})
	var co types.TrialCheckout
	if res.StatusCode == http.StatusCreated {
		h.decode(raw, &co)
	}
	return res.StatusCode, co, string(raw)
}

func (h *harness) verifyTrial(subID, paymentID string) (int, types.VerifyTrialResponse, string) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/billing/trial/verify", types.VerifyTrialRequest{
		PaymentID: paymentID, SubscriptionID: subID,
		Signature: billing.Sign(rzpSecret, []byte(paymentID+"|"+subID)),
	})
	var vr types.VerifyTrialResponse
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &vr)
	}
	return res.StatusCode, vr, string(raw)
}

func (h *harness) subWebhook(event, subID, status string, currentEnd int64, payment string) {
	h.t.Helper()
	end := "null"
	if currentEnd > 0 {
		end = fmt.Sprint(currentEnd)
	}
	pay := ""
	if payment != "" {
		pay = `,"payment":{"entity":` + payment + `}`
	}
	body := []byte(fmt.Sprintf(`{"entity":"event","event":%q,"payload":{"subscription":{"entity":{"id":%q,"status":%q,"customer_id":"cust_fake","current_start":null,"current_end":%s,"notes":[]}}%s}}`,
		event, subID, status, end, pay))
	res, raw := h.doRaw(http.MethodPost, "/api/webhooks/razorpay", "application/json", body,
		map[string]string{"X-Razorpay-Signature": billing.Sign(rzpWebhookSK, body)})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("%s webhook: %d %s", event, res.StatusCode, raw)
	}
}

func (f *fakeRazorpay) holdPayment(p billing.Payment) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.payments[p.ID] = p
}

func (f *fakeRazorpay) wasCancelled(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.cancelled {
		if s == sub {
			return true
		}
	}
	return false
}

func TestTrialStartsChargesAndHalts(t *testing.T) {
	h, fake := billingHarness(t)
	coach := h.signup("Trial Coach", "trial-coach@example.com", false)
	// Signup asks for a phone now; an older account may still have none.
	if _, err := h.store.Pool().Exec(t.Context(), `UPDATE users SET phone = '' WHERE id = $1::uuid`, coach.ID); err != nil {
		t.Fatal(err)
	}

	if code, _, raw := h.startTrial("business"); code != http.StatusUnprocessableEntity || errorCode(t, []byte(raw)) != "phone_required" {
		t.Fatalf("trial without a phone: %d %s, want 422 phone_required", code, raw)
	}
	h.setPhone("+91 98111 00001")
	// A Razorpay plan cached at an old price (₹14,999 + GST) must not be reused: the
	// cache is keyed by amount, so the new price gets a plan of its own.
	if _, err := h.store.SaveRazorpayPlanID(t.Context(), "business", "INR", 17_698_82, "plan_stale"); err != nil {
		t.Fatal(err)
	}

	// Business is ₹24,999 since 31 Oct 2026.
	code, co, raw := h.startTrial("business")
	if code != http.StatusCreated {
		t.Fatalf("start trial: %d %s", code, raw)
	}
	fake.mu.Lock()
	req := fake.subs[co.SubscriptionID]
	plan := fake.plans[req.PlanID]
	fake.mu.Unlock()
	// Monthly, ₹24,999 + 18% GST, first charge seven days out, notifying the buyer.
	if plan.Period != "monthly" || plan.Interval != 1 || plan.Item.Amount != 29_498_82 || plan.Item.Currency != "INR" {
		t.Fatalf("razorpay plan = %+v", plan)
	}
	if d := time.Until(time.Unix(req.StartAt, 0)); d < 7*24*time.Hour-time.Minute || d > 7*24*time.Hour+time.Minute {
		t.Fatalf("start_at %v away, want 7 days", d)
	}
	if req.PlanID == "plan_stale" {
		t.Fatal("the trial reused a Razorpay plan created for the old price")
	}
	if req.TotalCount != billing.TrialTotalCount || !req.CustomerNotify || req.Notes["plan"] != "business" || req.Notes["user_id"] == "" {
		t.Fatalf("subscription request = %+v", req)
	}
	if co.Amount != 29_498_82 || co.KeyID != rzpKeyID || co.TrialEndsAt == "" {
		t.Fatalf("trial checkout = %+v", co)
	}

	// Signed with anything else, the callback starts nothing.
	res, _ := h.do(http.MethodPost, "/api/billing/trial/verify", types.VerifyTrialRequest{
		PaymentID: "pay_auth1", SubscriptionID: co.SubscriptionID,
		Signature: billing.Sign("guess", []byte("pay_auth1|"+co.SubscriptionID)),
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("forged trial callback: %d, want 400", res.StatusCode)
	}

	fake.holdPayment(billing.Payment{ID: "pay_auth1", Amount: 500, Currency: "INR", Method: "upi", VPA: "coach@okaxis"})
	code, vr, raw := h.verifyTrial(co.SubscriptionID, "pay_auth1")
	if code != http.StatusOK {
		t.Fatalf("verify trial: %d %s", code, raw)
	}
	if !vr.Account.CanHost || vr.Account.Plan != types.PlanBusiness || vr.Billing.Status != "trialing" ||
		vr.Billing.TrialEndsAt == "" || !vr.Billing.Renews {
		t.Fatalf("after authorising: %+v", vr)
	}
	// The webhook for the same authorisation changes nothing, and a second trial is refused.
	h.subWebhook("subscription.authenticated", co.SubscriptionID, "authenticated", 0, "")
	if code, _, raw := h.startTrial("professional"); code != http.StatusConflict || errorCode(t, []byte(raw)) != "trial_used" {
		t.Fatalf("second trial on the same account: %d %s, want 409 trial_used", code, raw)
	}

	// Day 8: Razorpay charges, and the plan is active for the month it paid for.
	periodEnd := time.Now().Add(37 * 24 * time.Hour).Unix()
	h.subWebhook("subscription.charged", co.SubscriptionID, "active", periodEnd,
		`{"id":"pay_first","amount":1179882,"currency":"INR","status":"captured","method":"upi","vpa":"coach@okaxis"}`)
	res, raw2 := h.do(http.MethodGet, "/api/me/billing", nil)
	var st types.BillingStatus
	h.decode(raw2, &st)
	if res.StatusCode != http.StatusOK || st.Status != "active" || st.TrialEndsAt != "" || st.PaidUntil == "" || st.Plan != "business" {
		t.Fatalf("after first charge: %+v", st)
	}
	if h.me().Plan != types.PlanBusiness {
		t.Fatal("plan lost after the first charge")
	}

	// Retries exhausted: back to no plan; hosting stays as it was.
	h.subWebhook("subscription.halted", co.SubscriptionID, "halted", periodEnd, "")
	if a := h.me(); a.Plan != "" || a.AttendeeCap != types.PlanLaunchAttendees || !a.CanHost {
		t.Fatalf("after halt: plan %q cap %d canHost %v, want none, launch cap, still a host", a.Plan, a.AttendeeCap, a.CanHost)
	}
	// A late charged event for a halted subscription does not bring the plan back.
	h.subWebhook("subscription.charged", co.SubscriptionID, "active", periodEnd, "")
	if h.me().Plan != "" {
		t.Fatal("a late event revived a halted subscription")
	}
}

func TestTrialCancelDropsThePlan(t *testing.T) {
	h, fake := billingHarness(t)
	h.signup("Cancel Coach", "cancel-coach@example.com", false)
	h.setPhone("+91 98111 00002")
	code, co, raw := h.startTrial("professional")
	if code != http.StatusCreated {
		t.Fatalf("start: %d %s", code, raw)
	}
	if code, _, raw := h.verifyTrial(co.SubscriptionID, "pay_auth_c"); code != http.StatusOK {
		t.Fatalf("verify: %d %s", code, raw)
	}
	res, cancelRaw := h.do(http.MethodPost, "/api/me/billing/cancel", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("cancel: %d %s", res.StatusCode, cancelRaw)
	}
	if !fake.wasCancelled(co.SubscriptionID) {
		t.Fatal("razorpay subscription was not cancelled")
	}
	if a := h.me(); a.Plan != "" {
		t.Fatalf("plan after cancelling the trial = %q, want none", a.Plan)
	}
	if res, _ := h.do(http.MethodPost, "/api/me/billing/cancel", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("second cancel: %d, want 404", res.StatusCode)
	}
}

func TestTrialIsOncePerPerson(t *testing.T) {
	h, fake := billingHarness(t)

	// A takes the trial, paying with a UPI id.
	h.signup("Coach One", "coach.one@gmail.com", false)
	h.setPhone("+91 98111 00010")
	_, co, _ := h.startTrial("business")
	fake.holdPayment(billing.Payment{ID: "pay_a", Method: "upi", VPA: "family@okhdfc"})
	if code, _, raw := h.verifyTrial(co.SubscriptionID, "pay_a"); code != http.StatusOK {
		t.Fatalf("A verify: %d %s", code, raw)
	}

	// B: same Gmail mailbox written differently, new phone.
	h.logout()
	h.signup("Coach One Again", "coachone+again@gmail.com", false)
	h.setPhone("+91 98111 00011")
	if code, _, raw := h.startTrial("business"); code != http.StatusConflict || errorCode(t, []byte(raw)) != "trial_used" {
		t.Fatalf("same gmail mailbox: %d %s, want 409 trial_used", code, raw)
	}

	// C: same phone, different email.
	h.logout()
	h.signup("Coach Phone", "coach-phone@example.com", false)
	h.setPhone("+919811100010")
	if code, _, raw := h.startTrial("professional"); code != http.StatusConflict || errorCode(t, []byte(raw)) != "trial_used" {
		t.Fatalf("same phone: %d %s, want 409 trial_used", code, raw)
	}

	// D: new phone and email, but A's UPI id: the trial starts and is flagged.
	h.logout()
	d := h.signup("Coach Family", "coach-family@example.com", false)
	h.setPhone("+91 98111 00013")
	_, coD, raw := h.startTrial("professional")
	if coD.SubscriptionID == "" {
		t.Fatalf("D start: %s", raw)
	}
	fake.holdPayment(billing.Payment{ID: "pay_d", Method: "upi", VPA: "Family@OKHDFC"})
	if code, vr, raw := h.verifyTrial(coD.SubscriptionID, "pay_d"); code != http.StatusOK || vr.Account.Plan != types.PlanProfessional {
		t.Fatalf("D verify: %d %s, want the trial to start", code, raw)
	}
	// The first charge's payment is the same method: not flagged twice.
	h.subWebhook("subscription.charged", coD.SubscriptionID, "active", time.Now().Add(37*24*time.Hour).Unix(),
		`{"id":"pay_d2","method":"upi","vpa":"family@okhdfc","status":"captured"}`)
	var flags int
	if err := h.store.Pool().QueryRow(t.Context(), `SELECT count(*) FROM trial_flags WHERE user_id = $1::uuid`, d.ID).Scan(&flags); err != nil || flags != 1 {
		t.Fatalf("D flags = %d (%v), want 1", flags, err)
	}
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.logout()
	h.login("neeraj@acme.dev")
	res, raw2 := h.do(http.MethodGet, "/api/admin/users?q=coach-family@example.com", nil)
	var users []types.AdminUser
	h.decode(raw2, &users)
	if res.StatusCode != http.StatusOK || len(users) != 1 || users[0].TrialFlag == "" {
		t.Fatalf("admin row for D = %s", raw2)
	}

	// A deletes their account; the trial is stopped, and their phone still can't have another.
	h.logout()
	h.login("coach.one@gmail.com")
	res, raw2 = h.do(http.MethodDelete, "/api/auth/account", types.DeleteAccountRequest{Password: "webcast-dev"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete A: %d %s", res.StatusCode, raw2)
	}
	if !fake.wasCancelled(co.SubscriptionID) {
		t.Fatal("deleting the account left its subscription running")
	}
	h.signup("Coach One Returns", "coach-one-returns@example.com", false)
	h.setPhone("+91 98111 00010")
	if code, _, raw := h.startTrial("business"); code != http.StatusConflict || errorCode(t, []byte(raw)) != "trial_used" {
		t.Fatalf("deleted account's phone: %d %s, want 409 trial_used", code, raw)
	}
}

// Billing on but no TRIAL_HASH_SALT: no trials, and the catalogue says so.
func TestTrialOffWithoutSalt(t *testing.T) {
	_, srv := newFakeRazorpay(t)
	h := newHarness(t, func(c *config.Config) {
		c.RazorpayKeyID = rzpKeyID
		c.RazorpayKeySecret = rzpSecret
		c.RazorpayWebhookSecret = rzpWebhookSK
		c.RazorpayAPIURL = srv.URL
	})
	_, raw := h.do(http.MethodGet, "/api/billing/plans", nil)
	var cat types.BillingCatalogue
	h.decode(raw, &cat)
	if !cat.Enabled || cat.TrialDays != 0 {
		t.Fatalf("catalogue without a salt: enabled %v trialDays %d, want pay-now only", cat.Enabled, cat.TrialDays)
	}
	h.signup("No Salt", "no-salt@example.com", false)
	h.setPhone("+91 98111 00040")
	if code, _, body := h.startTrial("business"); code != http.StatusServiceUnavailable || errorCode(t, []byte(body)) != "trial_off" {
		t.Fatalf("trial without a salt: %d %s, want 503 trial_off", code, body)
	}
	var claims int
	if err := h.store.Pool().QueryRow(t.Context(), `SELECT count(*) FROM trial_claims`).Scan(&claims); err != nil || claims != 0 {
		t.Fatalf("claims recorded without a salt: %d (%v)", claims, err)
	}
}

/* If Razorpay's webhooks stop, a subscription's plan still ends: three days past
 * its period (or its trial, before a first charge). A later charged webhook brings
 * it back. An admin-assigned plan never lapses. */
func TestRazorpayPlanGraceAndRestore(t *testing.T) {
	h, _ := billingHarness(t)
	acct := h.signup("Grace Coach", "grace-coach@example.com", false)
	h.setPhone("+91 98111 00030")
	_, co, _ := h.startTrial("business")
	if code, _, raw := h.verifyTrial(co.SubscriptionID, "pay_grace"); code != http.StatusOK {
		t.Fatalf("verify: %d %s", code, raw)
	}
	ctx := t.Context()
	set := func(sql string) {
		t.Helper()
		if _, err := h.store.Pool().Exec(ctx, sql+` WHERE user_id = $1::uuid`, acct.ID); err != nil {
			t.Fatal(err)
		}
	}
	plan := func() types.Plan {
		t.Helper()
		p, err := h.store.PlanForUser(ctx, acct.ID)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}

	// (d) Trialing, before any charge: the trial end is what counts.
	set(`UPDATE subscriptions SET current_period_end = NULL, trial_ends_at = now() - interval '2 days'`)
	if plan() != types.PlanBusiness {
		t.Fatal("trial 2 days past its end lost the plan inside the grace")
	}
	set(`UPDATE subscriptions SET trial_ends_at = now() - interval '4 days'`)
	if plan() != "" {
		t.Fatal("trial 4 days past its end, no charge: still on the plan")
	}

	// Charged: active until Razorpay's current_end.
	h.subWebhook("subscription.charged", co.SubscriptionID, "active", time.Now().Add(30*24*time.Hour).Unix(), "")
	if plan() != types.PlanBusiness {
		t.Fatal("charge did not put the plan back")
	}

	// (a) 2 days past the period: still inside the grace.
	set(`UPDATE subscriptions SET current_period_end = now() - interval '2 days'`)
	if plan() != types.PlanBusiness {
		t.Fatal("active subscription 2 days past its period lost the plan")
	}

	// (b) 4 days past: no plan, and features are the no-plan defaults.
	set(`UPDATE subscriptions SET current_period_end = now() - interval '4 days'`)
	if plan() != "" {
		t.Fatal("active subscription 4 days past its period still has the plan")
	}
	var defaults []string
	if err := h.store.Pool().QueryRow(ctx, `SELECT effective_features('', '{}', '{}')`).Scan(&defaults); err != nil {
		t.Fatal(err)
	}
	if a := h.me(); a.Plan != "" || fmt.Sprint(a.Features) != fmt.Sprint(types.EffectiveFeatures(defaults)) {
		t.Fatalf("after lapse: plan %q features %v, want none and %v", a.Plan, a.Features, defaults)
	}

	// (c) The renewal's webhook arrives late: access comes back by itself.
	h.subWebhook("subscription.charged", co.SubscriptionID, "active", time.Now().Add(30*24*time.Hour).Unix(), "")
	if plan() != types.PlanBusiness {
		t.Fatal("a late charged webhook did not restore the plan")
	}
	// A late, older event never pulls the period back into the grace.
	h.subWebhook("subscription.charged", co.SubscriptionID, "active", time.Now().Add(-10*24*time.Hour).Unix(), "")
	if plan() != types.PlanBusiness {
		t.Fatal("an older charged event moved the period backwards")
	}

	// A Razorpay row with no dates at all fails closed, unless it is a fresh trial.
	set(`UPDATE subscriptions SET current_period_end = NULL, trial_ends_at = NULL, status = 'active'`)
	if plan() != "" {
		t.Fatal("a Razorpay row with no dates kept its plan")
	}
	set(`UPDATE subscriptions SET status = 'trialing', created_at = now()`)
	if plan() != types.PlanBusiness {
		t.Fatal("a fresh trial with no dates yet lost its plan")
	}

	// (e) Admin-assigned: no provider id, no end, never lapses.
	if _, err := h.store.SetUserPlan(ctx, acct.ID, types.PlanEnterprise); err != nil {
		t.Fatal(err)
	}
	set(`UPDATE subscriptions SET created_at = now() - interval '400 days', updated_at = now() - interval '400 days'`)
	if plan() != types.PlanEnterprise {
		t.Fatal("an admin-assigned plan lapsed")
	}
}

// A one-time payment's plan ends with its period; an admin-assigned plan has none.
func TestOneTimePlanLapses(t *testing.T) {
	h, _ := billingHarness(t)
	acct := h.signup("Lapse Coach", "lapse-coach@example.com", false)
	co := h.buy("business", billing.Monthly, billing.INR)
	res, raw := h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
		OrderID: co.OrderID, PaymentID: "pay_lapse",
		Signature: billing.Sign(rzpSecret, []byte(co.OrderID+"|pay_lapse")),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("verify: %d %s", res.StatusCode, raw)
	}
	if h.me().Plan != types.PlanBusiness {
		t.Fatal("plan not set by paying")
	}
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE subscriptions SET current_period_end = now() - interval '1 hour' WHERE user_id = $1::uuid`, acct.ID); err != nil {
		t.Fatal(err)
	}
	if a := h.me(); a.Plan != "" || a.AttendeeCap != types.PlanLaunchAttendees {
		t.Fatalf("after the paid month: plan %q cap %d, want it lapsed", a.Plan, a.AttendeeCap)
	}
	plan, err := h.store.PlanForUser(t.Context(), acct.ID)
	if err != nil || plan != "" {
		t.Fatalf("PlanForUser after lapse = %q, %v", plan, err)
	}
	if _, err := h.store.SetUserPlan(t.Context(), acct.ID, types.PlanEnterprise); err != nil {
		t.Fatal(err)
	}
	if h.me().Plan != types.PlanEnterprise {
		t.Fatal("an admin-assigned plan (no period end) does not count")
	}
}

/* Support's two tools. "Allow another trial" lets exactly one more trial through
 * the once-per-person check, and is admin-only; "Clear flag" ends a payment-method
 * review. */
func TestAdminTrialExemptionAndFlags(t *testing.T) {
	h, fake := billingHarness(t)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}

	h.signup("First Trial", "first-trial@example.com", false)
	h.setPhone("+91 98111 00020")
	_, co, _ := h.startTrial("business")
	fake.holdPayment(billing.Payment{ID: "pay_first", Method: "upi", VPA: "shared@okicici"})
	if code, _, raw := h.verifyTrial(co.SubscriptionID, "pay_first"); code != http.StatusOK {
		t.Fatalf("first verify: %d %s", code, raw)
	}

	h.logout()
	again := h.signup("Same Phone", "same-phone@example.com", false)
	h.setPhone("+91 98111 00020")
	code, _, raw := h.startTrial("business")
	if code != http.StatusConflict || errorCode(t, []byte(raw)) != "trial_used" {
		t.Fatalf("same phone: %d %s, want 409 trial_used", code, raw)
	}
	// Not an admin: refused.
	if res, _ := h.do(http.MethodPost, "/api/admin/users/"+again.ID+"/trial-exemption", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin exemption: %d, want 403", res.StatusCode)
	}

	h.logout()
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPost, "/api/admin/users/"+again.ID+"/trial-exemption", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("grant exemption: %d %s", res.StatusCode, raw)
	}

	h.logout()
	h.login("same-phone@example.com")
	code, coAgain, raw := h.startTrial("business")
	if code != http.StatusCreated {
		t.Fatalf("exempt trial start: %d %s", code, raw)
	}
	if code, vr, raw := h.verifyTrial(coAgain.SubscriptionID, "pay_again"); code != http.StatusOK || vr.Billing.Status != "trialing" {
		t.Fatalf("exempt trial verify: %d %s", code, raw)
	}
	// Spent: this account's next trial is refused again.
	h.subWebhook("subscription.cancelled", coAgain.SubscriptionID, "cancelled", 0, "")
	if code, _, raw := h.startTrial("business"); code != http.StatusConflict || errorCode(t, []byte(raw)) != "trial_used" {
		t.Fatalf("after the exemption is spent: %d %s, want 409 trial_used", code, raw)
	}

	// A third account pays with the first one's UPI id: flagged, then cleared.
	h.logout()
	flagged := h.signup("Shared UPI", "shared-upi@example.com", false)
	h.setPhone("+91 98111 00022")
	_, coF, _ := h.startTrial("professional")
	fake.holdPayment(billing.Payment{ID: "pay_shared", Method: "upi", VPA: "shared@okicici"})
	if code, _, raw := h.verifyTrial(coF.SubscriptionID, "pay_shared"); code != http.StatusOK {
		t.Fatalf("flagged verify: %d %s", code, raw)
	}
	if res, _ := h.do(http.MethodDelete, "/api/admin/users/"+flagged.ID+"/trial-flags", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin clear flag: %d, want 403", res.StatusCode)
	}
	h.logout()
	h.login("neeraj@acme.dev")
	adminRow := func(email string) types.AdminUser {
		t.Helper()
		_, raw := h.do(http.MethodGet, "/api/admin/users?q="+email, nil)
		var users []types.AdminUser
		h.decode(raw, &users)
		if len(users) != 1 {
			t.Fatalf("admin search %s: %s", email, raw)
		}
		return users[0]
	}
	if row := adminRow("shared-upi@example.com"); row.TrialFlag == "" {
		t.Fatal("shared UPI id was not flagged")
	}
	if row := adminRow("same-phone@example.com"); row.TrialExemption {
		t.Fatal("the spent exemption still shows as open")
	}
	if res, raw := h.do(http.MethodDelete, "/api/admin/users/"+flagged.ID+"/trial-flags", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("clear flag: %d %s", res.StatusCode, raw)
	}
	if row := adminRow("shared-upi@example.com"); row.TrialFlag != "" {
		t.Fatalf("flag after clearing = %q", row.TrialFlag)
	}
}
