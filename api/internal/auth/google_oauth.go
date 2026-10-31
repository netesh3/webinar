package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
)

// GoogleAuthURL is the browser consent page. Tests may point it at a stub.
var GoogleAuthURL = "https://accounts.google.com/o/oauth2/v2/auth"

// GoogleTokenURL exchanges an authorization code for tokens.
var GoogleTokenURL = "https://oauth2.googleapis.com/token" // #nosec G101 -- a public endpoint URL, not a credential

// ErrGoogleOAuth is a failed code exchange (bad code, redirect mismatch, Google down).
var ErrGoogleOAuth = errors.New("google oauth")

// GoogleOAuthScopes is what Continue with Google asks for: sign-in only, which
// Google shows without checkboxes. The phone is asked for in the app instead
// (see the phone prompt), so no People scope. YouTube Connect uses a different
// grant and must not be added here.
const GoogleOAuthScopes = "openid email profile"

// GoogleAuthCodeURL is the consent page for first-party login. Unlike Connect
// YouTube it does not ask for offline access: only the ID token is used.
//
// Without a login_hint, prompt=select_account makes the chooser explicit. With
// a login_hint no prompt is sent: Google otherwise shows a blank picker and
// ignores the address they already typed.
func GoogleAuthCodeURL(clientID, redirect, state, nonce, loginHint, challenge string) string {
	hint := GoogleLoginHint(loginHint)
	q := url.Values{
		"client_id":              {clientID},
		"redirect_uri":           {redirect},
		"response_type":          {"code"},
		"scope":                  {GoogleOAuthScopes},
		"state":                  {state},
		"nonce":                  {nonce},
		"include_granted_scopes": {"true"},
	}
	if hint != "" {
		q.Set("login_hint", hint)
	} else {
		q.Set("prompt", "select_account")
	}
	if c := strings.TrimSpace(challenge); c != "" {
		q.Set("code_challenge", c)
		q.Set("code_challenge_method", "S256")
	}
	return GoogleAuthURL + "?" + q.Encode()
}

// GooglePKCE is the S256 pair for an authorization-code start. The verifier
// is stored in signed state and sent on the token request; the challenge goes
// on the authorize URL.
type GooglePKCE struct {
	Verifier  string
	Challenge string
}

// NewGooglePKCE returns a fresh S256 pair. Empty on RNG failure.
func NewGooglePKCE() (GooglePKCE, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return GooglePKCE{}, err
	}
	verifier := base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(verifier))
	return GooglePKCE{
		Verifier:  verifier,
		Challenge: base64.RawURLEncoding.EncodeToString(sum[:]),
	}, nil
}

// GoogleLoginHint is a typed email for Google's login_hint. Empty, a display
// name, a URL, or anything that is not a single mailbox is dropped so the
// authorize URL cannot carry open-redirect junk.
func GoogleLoginHint(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 254 {
		return ""
	}
	if strings.ContainsAny(raw, "\r\n\x00<>\"'\\") {
		return ""
	}
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return ""
	}
	email := strings.TrimSpace(addr.Address)
	if email == "" || strings.ContainsAny(email, " \t") {
		return ""
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return ""
	}
	if strings.Contains(email[:at], "@") || !strings.Contains(email[at+1:], ".") {
		return ""
	}
	return email
}

// GoogleTokenResponse is the token endpoint body we actually use.
type GoogleTokenResponse struct {
	IDToken     string
	AccessToken string
}

type googleTokenJSON struct {
	IDToken     string `json:"id_token"`
	AccessToken string `json:"access_token"`
	Error       string `json:"error"`
	ErrorDesc   string `json:"error_description"`
}

// ExchangeGoogleCode turns an authorization code into an ID token and access token.
// verifier is the PKCE code_verifier from /start; empty only for in-flight grants
// that predate PKCE.
func ExchangeGoogleCode(ctx context.Context, clientID, secret, redirect, code, verifier string) (GoogleTokenResponse, error) {
	clientID = strings.TrimSpace(clientID)
	secret = strings.TrimSpace(secret)
	code = strings.TrimSpace(code)
	redirect = strings.TrimSpace(redirect)
	if clientID == "" || secret == "" {
		return GoogleTokenResponse{}, fmt.Errorf("%w: not configured", ErrGoogleOAuth)
	}
	if code == "" {
		return GoogleTokenResponse{}, fmt.Errorf("%w: missing code", ErrGoogleOAuth)
	}

	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {clientID},
		"client_secret": {secret},
		"redirect_uri":  {redirect},
	}
	if v := strings.TrimSpace(verifier); v != "" {
		form.Set("code_verifier", v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, GoogleTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return GoogleTokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	res, err := GoogleHTTP.Do(req)
	if err != nil {
		return GoogleTokenResponse{}, fmt.Errorf("%w: %v", ErrGoogleOAuth, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return GoogleTokenResponse{}, fmt.Errorf("%w: %v", ErrGoogleOAuth, err)
	}

	var parsed googleTokenJSON
	if err := json.Unmarshal(body, &parsed); err != nil {
		return GoogleTokenResponse{}, fmt.Errorf("%w: bad token response", ErrGoogleOAuth)
	}
	if parsed.Error != "" || res.StatusCode != http.StatusOK {
		detail := strings.TrimSpace(parsed.Error)
		desc := strings.TrimSpace(parsed.ErrorDesc)
		switch {
		case detail != "" && desc != "":
			detail = detail + ": " + desc
		case desc != "":
			detail = desc
		case detail == "":
			detail = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return GoogleTokenResponse{}, fmt.Errorf("%w: %s", ErrGoogleOAuth, detail)
	}
	if strings.TrimSpace(parsed.IDToken) == "" {
		return GoogleTokenResponse{}, fmt.Errorf("%w: missing id_token", ErrGoogleOAuth)
	}
	return GoogleTokenResponse{
		IDToken:     parsed.IDToken,
		AccessToken: parsed.AccessToken,
	}, nil
}
