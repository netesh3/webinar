/* Connect Zoom, Connect YouTube and the Drive picker from the desktop and mobile apps
 * (29 Oct 2026).
 *
 * Their OAuth has to run in the SYSTEM browser (Google refuses embedded webviews, and the
 * phones send off-site navigation out of the WebView anyway), but the account they connect is
 * the one signed in to the APP's webview. One row per attempt carries the account across:
 *
 *   ticket_hash  the app's webview (signed in) mints a ticket; the system browser opens the
 *                provider's start route with it. Two minutes, one use (started_at). Only the
 *                SHA-256 is kept, as for app_auth_codes (0173).
 *   code_hash    Zoom and YouTube: the OAuth callback, back in the system browser, does NOT
 *                connect anything there. It parks the provider's authorization code here
 *                (payload, sealed) and hands the app a completion code through webinarliv://.
 *                The app's webview redeems it, and the API connects the provider only if that
 *                webview's session is the ticket's account. So a ticket link sent to somebody
 *                else cannot connect their Zoom to the sender's account: the completion code
 *                lands in the victim's app (or nowhere), never with the sender.
 *   payload      sealed with a key derived from SESSION_SECRET (api/app_connect.go): the
 *                provider's authorization code, or for Drive the picked file and the short-lived
 *                read token the picker page got. Cleared the moment it is used.
 *   finished_at  set by the one redemption (or the one Drive collection), right user or not.
 *
 * Rows live for minutes; the issuer deletes those dead a day.
 */
CREATE TABLE app_connect_handoffs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_hash        text NOT NULL UNIQUE,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider           text NOT NULL CHECK (provider IN ('zoom', 'youtube', 'drive')),
    app                text NOT NULL CHECK (app IN ('desktop', 'ios', 'android')),
    return_path        text NOT NULL DEFAULT '/settings',
    expires_at         timestamptz NOT NULL,
    started_at         timestamptz,
    code_hash          text UNIQUE,
    payload            bytea,
    payload_expires_at timestamptz,
    finished_at        timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_connect_handoffs_user_idx ON app_connect_handoffs (user_id, created_at);
CREATE INDEX app_connect_handoffs_expires_idx ON app_connect_handoffs (expires_at);
ALTER TABLE app_connect_handoffs ENABLE ROW LEVEL SECURITY;
