/* A plan that has run out is no plan. effective_plan (0107) is the one place an
 * account's plan is decided, so the rule lives here and plan and features lapse
 * together.
 *
 * Trialing, active and past_due count (past_due is Razorpay still retrying a
 * charge). Then, by where the plan came from:
 *
 *   No provider subscription (an admin assigned it, or a one-time payment): no
 *   period end never lapses; otherwise it lapses when the period ends.
 *
 *   A Razorpay subscription: its webhooks move the status and delete the row when
 *   it halts or is cancelled, and every charged/activated event advances
 *   current_period_end to Razorpay's current_end (store.ApplySubscriptionStatus).
 *   So a healthy subscription is always ahead of now. If webhooks stop arriving,
 *   the plan still ends: it is kept for RAZORPAY_GRACE = 3 days past
 *   current_period_end (or trial_ends_at while there is no charge yet), the slack
 *   for a late renewal charge and its webhook, and lapses after that. A later
 *   charged/activated webhook restores it on its own, because the plan is computed
 *   per request, not stored.
 *
 *   A Razorpay row with neither date is treated as lapsed (fail closed), except a
 *   trial created in the last 10 days, the window in which it can legitimately
 *   have no dates yet.
 */
CREATE OR REPLACE FUNCTION effective_plan(uid uuid) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce((
        SELECT s.plan FROM subscriptions s
         WHERE s.user_id = uid
           AND s.status IN ('trialing', 'active', 'past_due')
           AND (
                (s.provider_subscription_id = ''
                 AND (s.current_period_end IS NULL OR s.current_period_end > now()))
             OR (s.provider_subscription_id <> ''
                 AND (
                      -- RAZORPAY_GRACE
                      coalesce(s.current_period_end, s.trial_ends_at) > now() - interval '3 days'
                   OR (s.current_period_end IS NULL AND s.trial_ends_at IS NULL
                       AND s.status = 'trialing' AND s.created_at > now() - interval '10 days')))
           )), '')
$$;
