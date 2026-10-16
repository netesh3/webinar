/* Plans: what each account may do.
 *
 * One row per account that is on a paid plan. No row is the launch default
 * (types.PlanLaunchAttendees attendees), which is what every beta host has today;
 * nothing is taken away from them.
 *
 * plan sets the attendee ceiling now (see api.attendeeCeiling). Two writers: an
 * admin (PATCH /api/admin/users/{id}/plan), and a Razorpay payment
 * (store.FulfilBillingOrder, migrations/0100_billing), which sets status 'active',
 * current_period_end to the end of the period paid for, and provider 'razorpay'.
 * Nothing enforces status or the period end yet.
 *
 * 0101 rather than 0100: this was written alongside 0100_billing.sql, which had
 * already been applied in production when the two were merged. IF NOT EXISTS
 * because a database that ran this branch before the rename has the table under
 * the old file name (0100_subscriptions.sql), and the shape is identical.
 */
CREATE TABLE IF NOT EXISTS subscriptions (
    user_id                  uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    plan                     text NOT NULL CHECK (plan IN ('professional', 'business', 'enterprise')),
    status                   text NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
    trial_ends_at            timestamptz,
    current_period_end       timestamptz,
    provider                 text NOT NULL DEFAULT '',
    provider_customer_id     text NOT NULL DEFAULT '',
    provider_subscription_id text NOT NULL DEFAULT '',
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);
