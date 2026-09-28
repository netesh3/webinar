/* Interest in an integration that is not connected yet.
 *
 * Telegram (and anything else marked "notify me") has no credentials to store.
 * A row here is the host asking to be emailed when it ships. One row per
 * account and provider; asking again does nothing.
 */
CREATE TABLE integration_interest (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);
