/* Plans, before payments.
 *
 * One row per account that is on a paid plan. No row is the launch default
 * (types.PlanLaunchAttendees attendees), which is what every beta host has today;
 * nothing is taken away from them.
 *
 * plan sets the attendee ceiling now (see api.attendeeCeiling). status, the trial
 * and period dates and the provider ids are here for checkout, which is not built
 * yet: until then an admin assigns plans (PATCH /api/admin/users/{id}/plan) and the
 * status is 'active'. Nothing enforces status yet.
 */
CREATE TABLE subscriptions (
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
