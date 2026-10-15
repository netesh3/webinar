package auth

import (
	"context"
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
var GoogleTokenURL = "https://oauth2.googleapis.com/token"

// ErrGoogleOAuth is a failed code exchange (bad code, redirect mismatch, Google down).
var ErrGoogleOAuth = errors.New("google oauth")

// GoogleAuthCodeURL is the consent page for first-party login. Unlike Connect
// YouTube it does not ask for offline access: we only need an ID token and a
// short-lived access token to read People phone numbers.
//
// prompt is consent every time so a user who left the People phone box empty
// sees that scope again. Without a login_hint, select_account is added so the
// chooser is explicit. With a login_hint, select_account is omitted: Google
// otherwise shows a blank picker and ignores the address they already typed.
// Google still draws extra scopes as unchecked boxes; there is no authorize
// query that pre-checks them. Do not set enable_granular_consent=false —
// Google ignores it once granular permissions are on for the client.
func GoogleAuthCodeURL(clientID, redirect, state, nonce, loginHint string) string {
	hint := GoogleLoginHint(loginHint)
	prompt := "select_account consent"
	if hint != "" {
		prompt = "consent"
	}
	q := url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirect},
		"response_type": {"code"},
		"scope":         {GoogleOAuthScopes},
		"state":         {state},
		"nonce":         {nonce},
		"prompt":        {prompt},
	}
	if hint != "" {
		q.Set("login_hint", hint)
	}
	return GoogleAuthURL + "?" + q.Encode()
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
func ExchangeGoogleCode(ctx context.Context, clientID, secret, redirect, code string) (GoogleTokenResponse, error) {
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
		detail := parsed.Error
		if parsed.ErrorDesc != "" {
			detail = parsed.ErrorDesc
		}
		if detail == "" {
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
