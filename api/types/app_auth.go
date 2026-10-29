package types

/* The desktop and mobile apps' sign-in hand-off (29 Oct 2026). See api/internal/api/auth_app.go.
 *
 * Continue with Google opens in the system browser with ?app=desktop|ios|android and a
 * PKCE-style challenge. The callback hands a one-time code back to the app through
 * webinarliv://, and the app's own webview redeems it here for the session cookie. */

// AppAuthExchangeRequest is POST /api/auth/app/exchange.
type AppAuthExchangeRequest struct {
	// Code is the one-time code from webinarliv://auth/complete.
	Code string `json:"code"`
	// Verifier is the random string the app hashed into the challenge it started with.
	Verifier string `json:"verifier"`
}

// AppAuthExchangeResponse is the account now signed in and where to take it.
type AppAuthExchangeResponse struct {
	Account Account `json:"account"`
	// Next is a same-site path: where the sign-in was headed.
	Next string `json:"next"`
}
