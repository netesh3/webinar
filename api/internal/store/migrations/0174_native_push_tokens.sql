/* Native push for the mobile apps (29 Oct 2026).
 *
 * The Android and iOS apps cannot use Web Push (neither WebView has the Push API), so they
 * register with Firebase Cloud Messaging and hand the API the FCM registration token. One row
 * per token: a token is one install of the app, so a second register from the same install
 * updates the row (and moves it to whoever is signed in now) rather than adding one. Tokens are
 * always an account's. There is no guest scope as there is for a browser's "tell me when THIS
 * webinar starts", and signing out removes the install's token.
 *
 * Messages reuse the Web Push outbox (0150): a push_messages row points at either a browser
 * (subscription_id) or an install (native_token_id), never both, so a fan-out, its dedupe key,
 * its time to live and its retries work the same for both. Backoff is per token, as it is per
 * endpoint. FCM answering UNREGISTERED deletes the token and, by cascade, what was queued for it.
 */
CREATE TABLE native_push_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform        text NOT NULL CHECK (platform IN ('ios', 'android')),
    token           text NOT NULL UNIQUE CHECK (length(token) BETWEEN 1 AND 4096),
    app_version     text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_ok_at      timestamptz,
    failures        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz
);
CREATE INDEX native_push_tokens_user_idx ON native_push_tokens (user_id);
ALTER TABLE native_push_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE push_messages
    ALTER COLUMN subscription_id DROP NOT NULL,
    ADD COLUMN native_token_id uuid REFERENCES native_push_tokens(id) ON DELETE CASCADE,
    ADD CONSTRAINT push_messages_one_target CHECK (num_nonnulls(subscription_id, native_token_id) = 1);
CREATE UNIQUE INDEX push_messages_native_dedupe_idx ON push_messages (native_token_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL AND native_token_id IS NOT NULL;
CREATE INDEX push_messages_native_token_idx ON push_messages (native_token_id)
    WHERE native_token_id IS NOT NULL;
