/* The 7-day free trial on monthly plans. See internal/billing/subscriptions.go.
 *
 * razorpay_plans caches the Razorpay plan created for one (plan, currency, amount).
 * The amount is tax included and part of the key, so a price or GST change makes a
 * new Razorpay plan rather than silently re-pricing one buyers already agreed to.
 *
 * billing_subscriptions is the ledger of Razorpay subscriptions this server created,
 * like billing_orders is for one-time payments: which account and plan each one is,
 * whatever its webhooks later say. user_id is SET NULL so the row outlives a deleted
 * account, the same as billing_orders (0104).
 *
 * trial_claims is what makes the trial once per person, across accounts. One row per
 * identifier a trial was started with — phone, email, UPI id, card signature — as a
 * salted SHA-256 (store.TrialDigest), never the identifier itself. No link to users
 * on purpose: deleting the account must not give its owner a second trial, and the
 * hash alone identifies nobody. Kept for fraud prevention (privacy policy).
 *
 * trial_flags is for a trial that matched an earlier one only on its payment method.
 * Phone and email matches are refused outright; a shared card or UPI id can be a
 * family or a team, so those are shown to an admin instead of blocked.
 *
 * subscriptions.provider_subscription_id is now looked up by every subscription
 * webhook, hence the index.
 */
CREATE TABLE razorpay_plans (
    plan             text        NOT NULL,
    currency         text        NOT NULL,
    amount           bigint      NOT NULL,
    razorpay_plan_id text        NOT NULL UNIQUE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plan, currency, amount)
);

CREATE TABLE billing_subscriptions (
    razorpay_subscription_id text        PRIMARY KEY,
    user_id                  uuid        REFERENCES users (id) ON DELETE SET NULL,
    plan                     text        NOT NULL,
    currency                 text        NOT NULL,
    amount                   bigint      NOT NULL,
    status                   text        NOT NULL DEFAULT 'created',
    trial_ends_at            timestamptz NOT NULL,
    -- The payment method is compared with earlier trials once, on the first payment
    -- seen for this subscription; after that its own claim would match itself.
    method_checked           boolean     NOT NULL DEFAULT false,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_subscriptions_user ON billing_subscriptions (user_id, created_at DESC);

CREATE TABLE trial_claims (
    kind       text        NOT NULL CHECK (kind IN ('phone', 'email', 'vpa', 'card')),
    digest     text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, digest)
);

CREATE TABLE trial_flags (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reason     text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trial_flags_user ON trial_flags (user_id);

/* trial_exemptions is an admin letting one account take one more trial, past the
 * once-per-person check (support's call, e.g. a trial that broke). Consumed when
 * that trial is authorised; granted_by is who allowed it, for the record. */
CREATE TABLE trial_exemptions (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    granted_by uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz
);

CREATE UNIQUE INDEX trial_exemptions_one_open ON trial_exemptions (user_id) WHERE used_at IS NULL;

CREATE INDEX subscriptions_provider_subscription
    ON subscriptions (provider_subscription_id) WHERE provider_subscription_id <> '';
