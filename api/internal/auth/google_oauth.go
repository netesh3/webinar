package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
// short-lived access token for the optional People phone read.
func GoogleAuthCodeURL(clientID, redirect, state, nonce string) string {
	q := url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirect},
		"response_type": {"code"},
		"scope":         {GoogleOAuthScopes},
		"state":         {state},
		"nonce":         {nonce},
		"prompt":        {"select_account"},
	}
	return GoogleAuthURL + "?" + q.Encode()
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
