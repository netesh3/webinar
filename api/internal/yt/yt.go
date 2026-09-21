// Package yt talks to Google OAuth and the YouTube Live Streaming API.
//
// A host connects their channel once (authorization code + offline access). We
// keep the refresh token and, when they go live, create an Unlisted broadcast
// bound to a reusable encoder stream, then hand the RTMP ingest URL to the
// compositor already encoding the attendee mix.
package yt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	DefaultTokenURL = "https://oauth2.googleapis.com/token"
	DefaultRevoke   = "https://oauth2.googleapis.com/revoke"
	DefaultAPI      = "https://www.googleapis.com/youtube/v3"
	Scope           = "https://www.googleapis.com/auth/youtube"
)

var (
	ErrNeedCode      = errors.New("Google did not send an authorization code")
	ErrNotConfigured = errors.New("YouTube linking is not set up on this instance")
	ErrNoChannel     = errors.New("that Google account has no YouTube channel")
	ErrLiveDisabled  = errors.New("this YouTube channel cannot go live yet. Enable live streaming in YouTube Studio, wait until YouTube says it's ready, then try again")
	ErrNeedRefresh   = errors.New("connect your YouTube channel in Account settings first")
)

// Client is a Google OAuth client that can create YouTube lives.
type Client struct {
	ID, Secret string
	AuthURL    string
	TokenURL   string
	RevokeURL  string
	API        string
	HTTP       *http.Client
}

func New(id, secret string) *Client {
	return &Client{
		ID:        strings.TrimSpace(id),
		Secret:    strings.TrimSpace(secret),
		AuthURL:   DefaultAuthURL,
		TokenURL:  DefaultTokenURL,
		RevokeURL: DefaultRevoke,
		API:       strings.TrimRight(DefaultAPI, "/"),
		HTTP:      &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *Client) Enabled() bool {
	return c != nil && c.ID != "" && c.Secret != ""
}

// AuthCodeURL is the Google consent page. access_type=offline + prompt=consent
// is what actually produces a refresh token on every connect; without consent
// Google only returns an access token the second time.
func (c *Client) AuthCodeURL(redirect, state string) string {
	q := url.Values{
		"client_id":     {c.ID},
		"redirect_uri":  {redirect},
		"response_type": {"code"},
		"scope":         {Scope},
		"access_type":   {"offline"},
		"prompt":        {"consent"},
		"state":         {state},
	}
	return c.AuthURL + "?" + q.Encode()
}

type Token struct {
	AccessToken  string
	RefreshToken string
}

type Channel struct {
	ID    string
	Title string
}

// Exchange turns an authorization code into tokens and the channel they belong to.
func (c *Client) Exchange(ctx context.Context, redirect, code string) (Token, Channel, error) {
	if !c.Enabled() {
		return Token{}, Channel{}, ErrNotConfigured
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return Token{}, Channel{}, ErrNeedCode
	}
	tok, err := c.token(ctx, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {c.ID},
		"client_secret": {c.Secret},
		"redirect_uri":  {redirect},
	})
	if err != nil {
		return Token{}, Channel{}, err
	}
	ch, err := c.mineChannel(ctx, tok.AccessToken)
	if err != nil {
		return Token{}, Channel{}, err
	}
	return tok, ch, nil
}

func (c *Client) Refresh(ctx context.Context, refresh string) (Token, error) {
	refresh = strings.TrimSpace(refresh)
	if refresh == "" {
		return Token{}, ErrNeedRefresh
	}
	return c.token(ctx, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {c.ID},
		"client_secret": {c.Secret},
	})
}

func (c *Client) Revoke(ctx context.Context, refresh string) error {
	refresh = strings.TrimSpace(refresh)
	if refresh == "" || c.RevokeURL == "" {
		return nil
	}
	form := url.Values{"token": {refresh}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.RevokeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.http().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	// Invalid tokens are already gone; treat that as success so Disconnect
	// still clears our copy.
	if res.StatusCode >= 500 {
		return fmt.Errorf("google revoke: HTTP %d", res.StatusCode)
	}
	return nil
}

func (c *Client) token(ctx context.Context, form url.Values) (Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.http().Do(req)
	if err != nil {
		return Token{}, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return Token{}, err
	}
	var parsed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Token{}, fmt.Errorf("google token: %w", err)
	}
	if res.StatusCode >= 300 || parsed.AccessToken == "" {
		msg := parsed.ErrorDesc
		if msg == "" {
			msg = parsed.Error
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", res.StatusCode)
		}
		return Token{}, fmt.Errorf("google token: %s", msg)
	}
	// A refresh grant does not always return a new refresh token; keep the one
	// we sent so callers can always write the same column.
	if parsed.RefreshToken == "" {
		parsed.RefreshToken = form.Get("refresh_token")
	}
	return Token{AccessToken: parsed.AccessToken, RefreshToken: parsed.RefreshToken}, nil
}

func (c *Client) mineChannel(ctx context.Context, access string) (Channel, error) {
	var out struct {
		Items []struct {
			ID      string `json:"id"`
			Snippet struct {
				Title string `json:"title"`
			} `json:"snippet"`
		} `json:"items"`
	}
	if err := c.api(ctx, access, http.MethodGet, "/channels?part=snippet&mine=true", nil, &out); err != nil {
		return Channel{}, err
	}
	if len(out.Items) == 0 || out.Items[0].ID == "" {
		return Channel{}, ErrNoChannel
	}
	return Channel{ID: out.Items[0].ID, Title: out.Items[0].Snippet.Title}, nil
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) api(ctx context.Context, access, method, path string, body any, dest any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.API+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return apiError(raw, res.StatusCode)
	}
	if dest == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dest)
}

func apiError(raw []byte, status int) error {
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &parsed)
	for _, e := range parsed.Error.Errors {
		switch e.Reason {
		case "liveStreamingNotEnabled", "livePermissionBlocked", "insufficientLivePermissions":
			return ErrLiveDisabled
		}
	}
	msg := strings.TrimSpace(parsed.Error.Message)
	if msg == "" {
		msg = fmt.Sprintf("YouTube API HTTP %d", status)
	}
	return errors.New(msg)
}
