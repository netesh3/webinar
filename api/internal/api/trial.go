package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The 7-day free trial on monthly plans, through Razorpay Subscriptions.
 *
 *   POST /api/billing/trial          session  checks, then creates the subscription
 *   POST /api/billing/trial/verify   session  Checkout's signed callback → trial starts
 *   POST /api/me/billing/cancel      session  stops the subscription, plan dropped
 *   POST /api/webhooks/razorpay      signed   subscription.* → plan follows Razorpay
 *
 * Once per person, not per account. Before a trial starts, the account's phone and
 * email (Gmail dots and +tags folded) are hashed and compared with every earlier
 * trial's; a match is refused. After Checkout, the payment method — a UPI id, or a
 * card's last four, network and issuer — is compared too, and a match is FLAGGED
 * for an admin rather than refused: a card or UPI id is often shared in a family or
 * a team. The hashes outlive the account (migrations/0106).
 */

// errTrialUsedLate is a trial whose phone or email was claimed by another account
// between starting and authorising. It is cancelled before any charge.
var errTrialUsedLate = errors.New("trial already used")

func (s *Server) handleStartTrial(w http.ResponseWriter, r *http.Request) {
	if s.billing == nil || !s.cfg.TrialEnabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "trial_off",
			"Free trials aren't available right now. You can pick a plan and pay now.")
		return
	}
	var req types.StartTrialRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	// Plans on sale online only: no trial of a contact-only plan or the grandfathered Starter.
	quote, err := billing.NewQuote(req.Plan, billing.Monthly, billing.TrialCurrency, s.cfg.BillingGSTPercent)
	if errors.Is(err, billing.ErrRetired) {
		httpx.Error(w, http.StatusUnprocessableEntity, "plan_retired",
			"That plan is no longer offered. Pick one of the plans on the pricing page.")
		return
	}
	if errors.Is(err, billing.ErrContactOnly) {
		httpx.Error(w, http.StatusUnprocessableEntity, "contact_sales",
			"This plan is set up with our team. Write to us and we'll get you started.")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "unknown_plan", "That plan isn't available.")
		return
	}
	user := userFromContext(r.Context())
	if store.NormalisePhone(user.Phone) == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "phone_required",
			"Add your mobile number to your account to start a free trial.")
		return
	}
	/* An admin's exemption (handleGrantTrialExemption) waives both history checks
	 * for one trial; it is spent when that trial is authorised (applySubscription). */
	exempt, err := s.store.HasTrialExemption(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "trial: exemption", err)
		return
	}
	if exempt {
		s.log.Info("trial start under an admin exemption", "user", user.ID)
	} else {
		paid, err := s.store.HasPaidBefore(r.Context(), user.ID)
		if err != nil {
			s.fail(w, r, "trial: history", err)
			return
		}
		if paid {
			httpx.Error(w, http.StatusConflict, "trial_used",
				"You've already used a free trial on this account. You can start a paid plan instead.")
			return
		}
		kind, err := s.store.TrialClaimed(r.Context(), s.identityClaims(user))
		if err != nil {
			s.fail(w, r, "trial: claims", err)
			return
		}
		if kind != "" {
			s.log.Info("trial refused: already used", "user", user.ID, "by", kind)
			httpx.Error(w, http.StatusConflict, "trial_used",
				"You've already used a free trial. You can start a paid plan instead.")
			return
		}
	}

	planID, err := s.razorpayPlanFor(r.Context(), quote)
	if err != nil {
		s.log.Error("trial: razorpay plan", "plan", quote.Plan.ID, "err", err)
		httpx.Error(w, http.StatusBadGateway, "razorpay",
			"We couldn't start the trial just now. Please try again in a minute.")
		return
	}
	trialEnds := time.Now().Add(billing.TrialDays * 24 * time.Hour).Truncate(time.Second)
	sub, err := s.billing.CreateSubscription(r.Context(), billing.SubscriptionRequest{
		PlanID:         planID,
		TotalCount:     billing.TrialTotalCount,
		StartAt:        trialEnds.Unix(),
		CustomerNotify: true,
		Notes: map[string]string{
			"user_id": user.ID,
			"email":   user.Email,
			"plan":    string(quote.Plan.ID),
		},
	})
	if err != nil {
		s.log.Error("trial: create razorpay subscription", "user", user.ID, "plan", quote.Plan.ID, "err", err)
		httpx.Error(w, http.StatusBadGateway, "razorpay",
			"We couldn't start the trial just now. Please try again in a minute.")
		return
	}
	if err := s.store.CreateBillingSubscription(r.Context(), store.BillingSubscription{
		RazorpaySubscriptionID: sub.ID, UserID: user.ID, Plan: string(quote.Plan.ID),
		Currency: quote.Currency, Amount: quote.Total, TrialEndsAt: trialEnds,
	}); err != nil {
		s.fail(w, r, "trial: record subscription", err)
		return
	}
	// Starting a trial is choosing the product: an audience account is a customer now.
	if err := s.store.PromoteToCustomer(r.Context(), user.ID); err != nil {
		s.log.Warn("trial: promote to customer", "user", user.ID, "error", err)
	}
	httpx.JSON(w, http.StatusCreated, types.TrialCheckout{
		SubscriptionID: sub.ID,
		KeyID:          s.cfg.RazorpayKeyID,
		Plan:           string(quote.Plan.ID),
		PlanName:       quote.Plan.Name,
		Currency:       quote.Currency,
		Amount:         quote.Total,
		TrialEndsAt:    trialEnds.UTC().Format(time.RFC3339),
		Description:    fmt.Sprintf("%s plan · %d-day free trial, then monthly", quote.Plan.Name, billing.TrialDays),
		PrefillName:    user.Name,
		PrefillEmail:   user.Email,
		PrefillPhone:   user.Phone,
	})
}

/* handleVerifyTrial is POST /api/billing/trial/verify. The signature is checked
 * before anything is read. The subscription and its authorisation payment are then
 * fetched from Razorpay rather than taken from the browser. */
func (s *Server) handleVerifyTrial(w http.ResponseWriter, r *http.Request) {
	if s.billing == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "billing_off", "Online payment isn't set up.")
		return
	}
	var req types.VerifyTrialRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	user := userFromContext(r.Context())
	if !billing.VerifySubscriptionPayment(s.cfg.RazorpayKeySecret, req.PaymentID, req.SubscriptionID, req.Signature) {
		s.log.Warn("trial: signature rejected", "user", user.ID, "subscription", req.SubscriptionID)
		httpx.Error(w, http.StatusBadRequest, "bad_signature",
			"We couldn't confirm that authorisation. If money left your account, write to us and we'll sort it out.")
		return
	}
	ledger, err := s.store.BillingSubscriptionByID(r.Context(), req.SubscriptionID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && ledger.UserID != user.ID) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such subscription.")
		return
	}
	if err != nil {
		s.fail(w, r, "trial: lookup", err)
		return
	}

	// The signature proves the mandate was authorised; Razorpay's own record is
	// read for the customer and for a subscription already past its first charge.
	status, customerID, periodEnd := "authenticated", "", (*time.Time)(nil)
	if sub, err := s.billing.FetchSubscription(r.Context(), req.SubscriptionID); err != nil {
		s.log.Warn("trial: fetch subscription", "subscription", req.SubscriptionID, "err", err)
	} else {
		customerID = sub.CustomerID
		if st := subscriptionStatus(sub.Status); st == "active" {
			status, periodEnd = st, unixTime(sub.CurrentEnd)
		}
	}
	var payment *billing.Payment
	if p, err := s.billing.FetchPayment(r.Context(), req.PaymentID); err != nil {
		s.log.Warn("trial: fetch authorisation payment", "payment", req.PaymentID, "err", err)
	} else {
		payment = &p
	}

	u, err := s.applySubscription(r.Context(), req.SubscriptionID, status, customerID, periodEnd, payment)
	switch {
	case errors.Is(err, errTrialUsedLate):
		httpx.Error(w, http.StatusConflict, "trial_used",
			"This mobile number or email has already had a free trial, so this one was cancelled before any charge. You can pick a plan and pay now.")
		return
	case err != nil:
		s.fail(w, r, "trial: start", err)
		return
	}
	s.log.Info("trial started", "user", u.ID, "plan", ledger.Plan, "subscription", req.SubscriptionID)
	httpx.JSON(w, http.StatusOK, types.VerifyTrialResponse{
		Account: u.Public(),
		Billing: s.billingStatusFor(r.Context(), u.ID),
	})
}

// handleCancelSubscription is POST /api/me/billing/cancel: the running subscription stops now.
func (s *Server) handleCancelSubscription(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if s.billing == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "billing_off", "Online payment isn't set up.")
		return
	}
	cur, err := s.store.CurrentBillingSubscription(r.Context(), user.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "no_subscription", "There's no running subscription to cancel.")
		return
	}
	if err != nil {
		s.fail(w, r, "billing: cancel lookup", err)
		return
	}
	if _, err := s.billing.CancelSubscription(r.Context(), cur.RazorpaySubscriptionID); err != nil {
		s.log.Error("billing: cancel razorpay subscription", "user", user.ID,
			"subscription", cur.RazorpaySubscriptionID, "err", err)
		httpx.Error(w, http.StatusBadGateway, "razorpay",
			"We couldn't cancel just now. Please try again in a minute.")
		return
	}
	u, err := s.applySubscription(r.Context(), cur.RazorpaySubscriptionID, "cancelled", "", nil, nil)
	if err != nil {
		s.fail(w, r, "billing: cancel", err)
		return
	}
	s.log.Info("subscription cancelled by its owner", "user", user.ID, "subscription", cur.RazorpaySubscriptionID)
	httpx.JSON(w, http.StatusOK, types.VerifyTrialResponse{
		Account: u.Public(),
		Billing: s.billingStatusFor(r.Context(), u.ID),
	})
}

/* handleSubscriptionWebhook is the subscription.* half of POST /api/webhooks/razorpay.
 * A subscription this server did not create is acknowledged and left alone. */
func (s *Server) handleSubscriptionWebhook(w http.ResponseWriter, r *http.Request, ev billing.SubscriptionEvent) {
	status := subscriptionEventStatus(ev.Event)
	if status == "" {
		w.WriteHeader(http.StatusOK)
		return
	}
	id := ev.Subscription.ID
	_, err := s.applySubscription(r.Context(), id, status, ev.Subscription.CustomerID, unixTime(ev.Subscription.CurrentEnd), ev.Payment)
	switch {
	case err == nil, errors.Is(err, store.ErrNotFound), errors.Is(err, errTrialUsedLate):
		w.WriteHeader(http.StatusOK)
	case errors.Is(err, store.ErrAccountGone):
		/* The account was deleted and its subscription is still running. Stop it, so
		 * nobody is charged for an account that no longer exists. */
		if status != "cancelled" && status != "halted" && status != "completed" {
			if _, cerr := s.billing.CancelSubscription(r.Context(), id); cerr != nil {
				s.log.Error("billing: cancel subscription of a deleted account", "subscription", id, "err", cerr)
			}
		}
		if ev.Payment != nil {
			s.log.Error("billing: charge for a deleted account, refund it", "subscription", id, "payment", ev.Payment.ID)
		}
		w.WriteHeader(http.StatusOK)
	default:
		s.fail(w, r, "razorpay webhook: subscription", err)
	}
}

/* applySubscription moves a subscription and the account's plan, then does the
 * once-per-person bookkeeping: on the trial's first activation its phone and email
 * are claimed (or, if another account claimed them in the meantime, the trial is
 * cancelled), and on the first payment seen its payment method is compared with
 * earlier trials and claimed. */
func (s *Server) applySubscription(ctx context.Context, id, status, customerID string, periodEnd *time.Time, payment *billing.Payment) (store.User, error) {
	sub, u, first, err := s.store.ApplySubscriptionStatus(ctx, id, status, customerID, periodEnd)
	if err != nil {
		return u, err
	}
	if first {
		claims := s.identityClaims(u)
		exempt, err := s.store.UseTrialExemption(ctx, u.ID)
		if err != nil {
			return u, err
		}
		kind := ""
		if exempt {
			s.log.Info("trial exemption used", "user", u.ID, "subscription", id)
		} else if kind, err = s.store.TrialClaimed(ctx, claims); err != nil {
			return u, err
		}
		if kind != "" {
			s.log.Warn("trial cancelled: claimed by another account meanwhile", "user", u.ID, "by", kind, "subscription", id)
			if _, err := s.billing.CancelSubscription(ctx, id); err != nil {
				s.log.Error("billing: cancel duplicate trial", "subscription", id, "err", err)
			}
			if _, u, _, err = s.store.ApplySubscriptionStatus(ctx, id, "cancelled", "", nil); err != nil {
				return u, err
			}
			return u, errTrialUsedLate
		}
		if err := s.store.RecordTrialClaims(ctx, claims); err != nil {
			return u, err
		}
	}
	if payment != nil && !sub.MethodChecked {
		claims := s.methodClaims(*payment)
		if len(claims) > 0 {
			kind, err := s.store.TrialClaimed(ctx, claims)
			if err != nil {
				return u, err
			}
			if kind != "" {
				reason := "Trial paid with a UPI id used on an earlier trial"
				if kind == store.ClaimCard {
					reason = "Trial paid with a card that matches an earlier trial's"
				}
				s.log.Warn("trial flagged: payment method seen before", "user", u.ID, "by", kind, "subscription", id)
				if err := s.store.AddTrialFlag(ctx, u.ID, reason); err != nil {
					return u, err
				}
			}
			if err := s.store.RecordTrialClaims(ctx, claims); err != nil {
				return u, err
			}
		}
		if err := s.store.MarkMethodChecked(ctx, id); err != nil {
			return u, err
		}
	}
	return u, nil
}

/* identityClaims and methodClaims never hash with an empty salt: without
 * TRIAL_HASH_SALT trials are off (handleStartTrial says trial_off), and a webhook
 * for an older trial arriving after the salt was removed records nothing rather
 * than unsalted hashes. */
func (s *Server) identityClaims(u store.User) []store.TrialClaim {
	salt := s.cfg.TrialHashSalt
	if salt == "" {
		return nil
	}
	return []store.TrialClaim{
		{Kind: store.ClaimPhone, Digest: store.TrialDigest(salt, store.ClaimPhone, store.NormalisePhone(u.Phone))},
		{Kind: store.ClaimEmail, Digest: store.TrialDigest(salt, store.ClaimEmail, store.NormaliseTrialEmail(u.Email))},
	}
}

func (s *Server) methodClaims(p billing.Payment) []store.TrialClaim {
	salt := s.cfg.TrialHashSalt
	if salt == "" {
		return nil
	}
	var out []store.TrialClaim
	if vpa := store.NormaliseTrialVPA(p.VPA); vpa != "" {
		out = append(out, store.TrialClaim{Kind: store.ClaimVPA, Digest: store.TrialDigest(salt, store.ClaimVPA, vpa)})
	}
	if p.Card != nil {
		if sig := store.NormaliseTrialCard(p.Card.Last4, p.Card.Network, p.Card.Issuer); sig != "" {
			out = append(out, store.TrialClaim{Kind: store.ClaimCard, Digest: store.TrialDigest(salt, store.ClaimCard, sig)})
		}
	}
	return out
}

/* razorpayPlanFor is the Razorpay plan for this monthly price, created the first
 * time it is needed. A price or tax change is a new amount and so a new plan. */
func (s *Server) razorpayPlanFor(ctx context.Context, q billing.Quote) (string, error) {
	id, err := s.store.RazorpayPlanID(ctx, string(q.Plan.ID), q.Currency, q.Total)
	if err != nil || id != "" {
		return id, err
	}
	p, err := s.billing.CreatePlan(ctx, billing.PlanRequest{
		Period:   "monthly",
		Interval: 1,
		Item: billing.PlanItem{
			Name:     q.Plan.Name + " (monthly)",
			Amount:   q.Total,
			Currency: q.Currency,
		},
		Notes: map[string]string{"plan": string(q.Plan.ID)},
	})
	if err != nil {
		return "", err
	}
	return s.store.SaveRazorpayPlanID(ctx, string(q.Plan.ID), q.Currency, q.Total, p.ID)
}

// billingStatusFor is GET /api/me/billing's answer: a running subscription first,
// else the latest one-time payment, else nothing.
func (s *Server) billingStatusFor(ctx context.Context, userID string) types.BillingStatus {
	if cur, err := s.store.CurrentBillingSubscription(ctx, userID); err == nil {
		st := types.BillingStatus{Plan: cur.Plan, Period: billing.Monthly, Renews: true}
		if p, ok := billing.FindPlan(cur.Plan); ok {
			st.PlanName = p.Name
			st.Attendees = p.Attendees()
		}
		if row, err := s.store.SubscriptionPlan(ctx, userID); err == nil {
			st.Status = row.Status
			st.Active = true
			if row.Status == "trialing" && row.TrialEndsAt != nil {
				st.TrialEndsAt = row.TrialEndsAt.UTC().Format(time.RFC3339)
			}
			if row.CurrentPeriodEnd != nil {
				st.PaidUntil = row.CurrentPeriodEnd.UTC().Format(time.RFC3339)
			}
		}
		return st
	}
	order, err := s.store.CurrentBillingOrder(ctx, userID)
	if err != nil {
		return types.BillingStatus{}
	}
	return billingStatus(order)
}

/* cancelRunningSubscription stops an account's Razorpay subscription, before the
 * account is deleted. An error means it may still charge, so deletion waits. */
func (s *Server) cancelRunningSubscription(ctx context.Context, userID string) error {
	cur, err := s.store.CurrentBillingSubscription(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if s.billing == nil {
		return errors.New("a Razorpay subscription is running but billing is not configured")
	}
	if _, err := s.billing.CancelSubscription(ctx, cur.RazorpaySubscriptionID); err != nil {
		return err
	}
	_, err = s.applySubscription(ctx, cur.RazorpaySubscriptionID, "cancelled", "", nil, nil)
	return err
}

/* handleGrantTrialExemption is POST /api/admin/users/{id}/trial-exemption: the
 * account may take one more free trial, past the once-per-person check. Logged
 * with the admin, and recorded with them (trial_exemptions.granted_by). */
func (s *Server) handleGrantTrialExemption(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	target := chi.URLParam(r, "id")
	if err := s.store.GrantTrialExemption(r.Context(), target, admin.ID); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	} else if err != nil {
		s.fail(w, r, "admin: trial exemption", err)
		return
	}
	s.log.Info("trial exemption granted", "admin", admin.ID, "target", target)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "granted"})
}

// handleClearTrialFlags is DELETE /api/admin/users/{id}/trial-flags: the review is done.
func (s *Server) handleClearTrialFlags(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	target := chi.URLParam(r, "id")
	n, err := s.store.ClearTrialFlags(r.Context(), target)
	if err != nil {
		s.fail(w, r, "admin: clear trial flags", err)
		return
	}
	s.log.Info("trial flags cleared", "admin", admin.ID, "target", target, "flags", n)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "cleared"})
}

// subscriptionEventStatus maps a webhook event to the status it moves to, "" to ignore.
func subscriptionEventStatus(event string) string {
	switch event {
	case "subscription.authenticated":
		return "authenticated"
	case "subscription.activated", "subscription.charged":
		return "active"
	case "subscription.pending":
		return "pending"
	case "subscription.halted":
		return "halted"
	case "subscription.cancelled":
		return "cancelled"
	case "subscription.completed":
		return "completed"
	}
	return ""
}

// subscriptionStatus maps a fetched subscription's status the same way.
func subscriptionStatus(status string) string {
	switch status {
	case "authenticated", "active", "pending", "halted", "cancelled", "completed", "expired":
		return status
	}
	return ""
}

func unixTime(sec int64) *time.Time {
	if sec <= 0 {
		return nil
	}
	t := time.Unix(sec, 0).UTC()
	return &t
}
