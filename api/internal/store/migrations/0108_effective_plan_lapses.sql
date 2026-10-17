/* A plan that has run out is no plan. effective_plan (0107) is the one place an
 * account's plan is decided, so the rule lives here and plan and features lapse
 * together.
 *
 * Trialing, active and past_due count (past_due is Razorpay still retrying a
 * charge). Then one of: no period end (an admin assigned it); a period that has not
 * ended (a one-time payment, which lapses on its own); or a Razorpay subscription,
 * whose webhooks move the status and delete the row when it halts or is cancelled
 * (store.ApplySubscriptionStatus), so its stored period end is informational.
 */
CREATE OR REPLACE FUNCTION effective_plan(uid uuid) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce((
        SELECT s.plan FROM subscriptions s
         WHERE s.user_id = uid
           AND s.status IN ('trialing', 'active', 'past_due')
           AND (s.current_period_end IS NULL OR s.current_period_end > now()
                OR s.provider_subscription_id <> '')), '')
$$;
