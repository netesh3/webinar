-- Self-serve plans: pay with Razorpay, and hosting turns on.
--
-- One row per checkout attempt. A Razorpay order is created first and recorded
-- here with the amount the SERVER priced it at, so nothing the browser sends can
-- change what is charged or what is granted. The row is then fulfilled exactly
-- once — by the browser's signed callback or by the webhook, whichever arrives
-- first — and fulfilment is what sets users.can_host.
--
-- paid_until is the end of the period this payment bought. A renewal bought
-- before the current period ends starts where that one stops rather than today,
-- so paying early never loses days.

CREATE TABLE billing_orders (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan                text        NOT NULL,
    period              text        NOT NULL CHECK (period IN ('monthly', 'yearly')),
    currency            text        NOT NULL CHECK (currency IN ('INR', 'USD')),
    -- Minor units (paise, cents), tax included: exactly what Razorpay was asked for.
    amount              bigint      NOT NULL CHECK (amount > 0),
    tax                 bigint      NOT NULL DEFAULT 0 CHECK (tax >= 0),
    razorpay_order_id   text        NOT NULL UNIQUE,
    razorpay_payment_id text        UNIQUE,
    status              text        NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
    gstin               text        NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    paid_at             timestamptz,
    paid_until          timestamptz
);

-- "What is this account's current plan" reads the newest paid row.
CREATE INDEX billing_orders_user_paid_idx
    ON billing_orders (user_id, paid_until DESC)
    WHERE status = 'paid';
