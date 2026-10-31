/* Google sign-in callbacks that arrive twice (31 Oct 2026).
 *
 * Chrome can send one navigation to /api/auth/google/callback twice, a few hundred ms apart
 * (an extension, link capturing, a prefetch, a restarted load). Both carry the same state and
 * the same authorization code. Google
 * redeems a code once, so the second got invalid_grant, and because the second is the one the
 * browser shows, the desktop app was handed "Could not finish Google sign-in" right after the
 * first had succeeded (desktop 0.1.5, 31 Oct 2026, 17:04 UTC).
 *
 * One row per (state, code), keyed by the SHA-256 of the pair, records how the first callback
 * ended so a repeat inside two minutes is answered the same way without calling Google:
 *
 *   done_at   null while the first is still exchanging with Google; a repeat waits for it.
 *   user_id   who signed in. A web repeat sets the session cookie again only when it carries
 *             the matching state cookie (the same browser); otherwise it is only redirected.
 *   app       an app sign-in. app_nonce derives the SAME one-time hand-off code again
 *             (HMAC under SESSION_SECRET, api/auth_google_replay.go), so a repeat hands the app
 *             the code the first minted; app_auth_codes still allows it to be redeemed once.
 *             The code itself is not stored here, as it is not in app_auth_codes.
 *   landing   a web sign-in's landing path.
 *   failure   how the first failed ("signup", "unverified", ...), so a repeat says the same.
 *
 * Swept by the token-retention job once dead a day.
 */
CREATE TABLE google_callback_replays (
    key_hash   text PRIMARY KEY,
    user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
    app        text NOT NULL DEFAULT '',
    app_nonce  text NOT NULL,
    landing    text NOT NULL DEFAULT '',
    failure    text NOT NULL DEFAULT '',
    done_at    timestamptz,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_callback_replays_expires_idx ON google_callback_replays (expires_at);
ALTER TABLE google_callback_replays ENABLE ROW LEVEL SECURITY;
