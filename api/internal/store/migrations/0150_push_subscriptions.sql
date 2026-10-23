/* Web Push: browsers that asked to be told, and what is owed to each.
 *
 * Subscriptions. One row per browser push endpoint — the endpoint is the browser's address
 * at its push service and is unique per browser profile per origin, so a second subscribe
 * from the same browser updates the row rather than adding one. A row is owned by an account
 * (user_id), or by nobody when a guest registrant subscribed from the confirmation page. A
 * guest's scope is the registrations in push_subscription_registrations: "tell me when THIS
 * webinar starts", proven by the join key. The same browser can be linked to several
 * registrations and be signed in too; the endpoint is still one row.
 *
 * Backoff is per endpoint, not per message: a push service that is failing fails for every
 * message to that browser, so failures and next_attempt_at live here, and a 404/410 from the
 * push service deletes the row (and, by cascade, everything queued for it).
 *
 * Messages. An outbox like notifications (0010): rows are written next to the change they
 * announce and the tick (api.flushPush) sends what is due. dedupe_key makes a fan-out
 * idempotent — the 15-minute reminder sweep runs every pass and "starting now" can be
 * reached from three code paths, and each browser still hears it once.
 *
 * Preferences. Opt-out per account per kind: no row means on.
 */

CREATE TABLE push_subscriptions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint        text NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 1 AND 2048),
    p256dh          text NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 256),
    auth            text NOT NULL CHECK (length(auth) BETWEEN 1 AND 64),
    user_agent      text NOT NULL DEFAULT '',
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_ok_at      timestamptz,
    failures        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE user_id IS NOT NULL;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE TABLE push_subscription_registrations (
    subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subscription_id, registration_id)
);
CREATE INDEX push_subscription_registrations_reg_idx ON push_subscription_registrations (registration_id);
ALTER TABLE push_subscription_registrations ENABLE ROW LEVEL SECURITY;

CREATE TABLE push_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    kind            text NOT NULL,
    title           text NOT NULL,
    body            text NOT NULL DEFAULT '',
    url             text NOT NULL DEFAULT '/',
    tag             text NOT NULL DEFAULT '',
    urgency         text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('very-low', 'low', 'normal', 'high')),
    ttl_sec         integer NOT NULL DEFAULT 3600 CHECK (ttl_sec >= 0),
    dedupe_key      text,
    due_at          timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'expired')),
    attempts        integer NOT NULL DEFAULT 0,
    claimed_until   timestamptz,
    sent_at         timestamptz,
    last_error      text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX push_messages_dedupe_idx ON push_messages (subscription_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL;
CREATE INDEX push_messages_due_idx ON push_messages (due_at) WHERE state = 'pending';
ALTER TABLE push_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE push_preferences (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind    text NOT NULL,
    enabled boolean NOT NULL,
    PRIMARY KEY (user_id, kind)
);
ALTER TABLE push_preferences ENABLE ROW LEVEL SECURITY;
