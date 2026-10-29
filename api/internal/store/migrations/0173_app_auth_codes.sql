/* Sign-in hand-off for the desktop and mobile apps (29 Oct 2026).
 *
 * Google refuses OAuth inside embedded webviews, so an app opens Continue with Google in the
 * system browser instead. That browser is not the app: a session cookie set there would sign
 * in Safari or Chrome, not the app's own webview. So when the sign-in started inside an app,
 * the callback sets no cookie and writes one of these rows instead: a single-use code, bound
 * to the account, that the app redeems from its own webview for the normal session cookie
 * (api/internal/api/auth_app.go).
 *
 * Only the code's SHA-256 is stored, as for the reset and verification links. challenge is the
 * base64url SHA-256 of a verifier the app made and kept to itself (the PKCE idea, RFC 7636 S256):
 * the code travels through the system browser and a webinarliv:// link, the verifier does not,
 * so a code that leaks on the way cannot be redeemed alone. used_at is set on the first
 * redemption attempt, right or wrong, so a code is good for one try. Rows live for minutes; the
 * issuer deletes the long-dead ones.
 */
CREATE TABLE app_auth_codes (
    code_hash  text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    challenge  text NOT NULL CHECK (length(challenge) = 43),
    app        text NOT NULL CHECK (app IN ('desktop', 'ios', 'android')),
    next_path  text NOT NULL DEFAULT '/',
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_auth_codes_expires_idx ON app_auth_codes (expires_at);
ALTER TABLE app_auth_codes ENABLE ROW LEVEL SECURITY;
