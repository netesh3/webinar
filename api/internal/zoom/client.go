/* Package zoom talks to a host's own Zoom account.
 *
 * User-level OAuth. The access token stays in memory. The refresh token is
 * stored only as ciphertext by the caller. Nothing in this package logs the
 * authorization code, either token, or a join or start URL.
 */
package zoom

import (
	"bytes"
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
	VenueApp     = "app"
	VenueMeeting = "zoom_meeting"
	VenueWebinar = "zoom_webinar"

	defaultAPI   = "https://api.zoom.us/v2"
	defaultOAuth = "https://zoom.us"
)

func IsVenue(v string) bool {
	return v == VenueMeeting || v == VenueWebinar
}

var (
	ErrNotConfigured = errors.New("zoom is not configured")
	ErrNotConnected  = errors.New("zoom is not connected")
	ErrNoJoinURL     = errors.New("zoom join link is missing")
	ErrSwitch        = errors.New("zoom session kind cannot change after someone registered")
)

type Client struct {
	ID, Secret string
	API        string
	OAuth      string
	HTTP       *http.Client
}

func New(id, secret string) *Client {
	return &Client{
		ID:     strings.TrimSpace(id),
		Secret: strings.TrimSpace(secret),
		API:    defaultAPI,
		OAuth:  defaultOAuth,
		HTTP:   &http.Client{Timeout: 20 * time.Second},
	}
}

func (c *Client) Enabled() bool {
	return c != nil && c.ID != "" && c.Secret != ""
}

func (c *Client) AuthCodeURL(redirect, state string) string {
	q := url.Values{
		"response_type": {"code"},
		"client_id":     {c.ID},
		"redirect_uri":  {redirect},
		"state":         {state},
	}
	return strings.TrimRight(c.OAuth, "/") + "/oauth/authorize?" + q.Encode()
}

type Token struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int
}

type Account struct {
	ID        string
	AccountID string
	Email     string
}

type Spec struct {
	Venue       string
	Topic       string
	StartsAt    time.Time
	DurationMin int
	TimeZone    string
}

type Created struct {
	ID       string
	StartURL string
}

type Person struct {
	Email     string
	FirstName string
	LastName  string
}

type Registrant struct {
	ID      string
	JoinURL string
}

type APIError struct {
	Status  int
	Code    int
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("zoom error %d", e.Status)
}

/* Public is a sentence safe to show a host. Zoom's own message, trimmed,
 * unless it is long enough to be carrying something we should not repeat. */
func (e *APIError) Public() string {
	msg := strings.TrimSpace(e.Message)
	if msg == "" || len(msg) > 240 || strings.Contains(strings.ToLower(msg), "bearer") {
		return "Zoom refused that request."
	}
	return msg
}

func (c *Client) Exchange(ctx context.Context, redirect, code string) (Token, error) {
	if !c.Enabled() {
		return Token{}, ErrNotConfigured
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return Token{}, errors.New("zoom did not send an authorization code")
	}
	return c.token(ctx, url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {code},
		"redirect_uri": {redirect},
	})
}

func (c *Client) Refresh(ctx context.Context, refresh string) (Token, error) {
	if !c.Enabled() {
		return Token{}, ErrNotConfigured
	}
	if strings.TrimSpace(refresh) == "" {
		return Token{}, ErrNotConnected
	}
	return c.token(ctx, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
	})
}

func (c *Client) Revoke(ctx context.Context, token string) error {
	if !c.Enabled() || strings.TrimSpace(token) == "" {
		return nil
	}
	form := url.Values{"token": {token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(c.OAuth, "/")+"/oauth/revoke", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(c.ID, c.Secret)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 300 && res.StatusCode != http.StatusBadRequest {
		return &APIError{Status: res.StatusCode, Message: "Zoom could not revoke the connection."}
	}
	return nil
}

func (c *Client) Me(ctx context.Context, access string) (Account, error) {
	var out struct {
		ID        string `json:"id"`
		AccountID string `json:"account_id"`
		Email     string `json:"email"`
	}
	if err := c.do(ctx, http.MethodGet, "/users/me", access, nil, &out); err != nil {
		return Account{}, err
	}
	if out.ID == "" {
		return Account{}, &APIError{Status: http.StatusBadGateway, Message: "Zoom did not say which account connected."}
	}
	return Account{ID: out.ID, AccountID: out.AccountID, Email: out.Email}, nil
}

func (c *Client) Create(ctx context.Context, access, venue string, spec Spec) (Created, error) {
	kind, err := resource(venue)
	if err != nil {
		return Created{}, err
	}
	var out struct {
		ID       zoomID `json:"id"`
		StartURL string `json:"start_url"`
	}
	if err := c.do(ctx, http.MethodPost, "/users/me/"+kind, access, specBody(venue, spec), &out); err != nil {
		return Created{}, err
	}
	if out.ID.String() == "" {
		return Created{}, &APIError{Status: http.StatusBadGateway, Message: "Zoom did not return a meeting id."}
	}
	return Created{ID: out.ID.String(), StartURL: out.StartURL}, nil
}

func (c *Client) Update(ctx context.Context, access, venue, id string, spec Spec) error {
	kind, err := resource(venue)
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPatch, "/"+kind+"/"+url.PathEscape(id), access, specBody(venue, spec), nil)
}

func (c *Client) Delete(ctx context.Context, access, venue, id string) error {
	kind, err := resource(venue)
	if err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	err = c.do(ctx, http.MethodDelete, "/"+kind+"/"+url.PathEscape(id), access, nil, nil)
	var api *APIError
	if errors.As(err, &api) && (api.Status == http.StatusNotFound || api.Code == 3001) {
		return nil
	}
	return err
}

func (c *Client) StartURL(ctx context.Context, access, venue, id string) (string, error) {
	kind, err := resource(venue)
	if err != nil {
		return "", err
	}
	var out struct {
		StartURL string `json:"start_url"`
	}
	if err := c.do(ctx, http.MethodGet, "/"+kind+"/"+url.PathEscape(id), access, nil, &out); err != nil {
		return "", err
	}
	if out.StartURL == "" {
		return "", &APIError{Status: http.StatusBadGateway, Message: "Zoom did not return a host link."}
	}
	return out.StartURL, nil
}

func (c *Client) AddRegistrant(ctx context.Context, access, venue, id string, person Person) (Registrant, error) {
	kind, err := resource(venue)
	if err != nil {
		return Registrant{}, err
	}
	first := strings.TrimSpace(person.FirstName)
	last := strings.TrimSpace(person.LastName)
	if first == "" {
		first = "Attendee"
	}
	if last == "" {
		last = "-"
	}
	var out struct {
		ID      string `json:"registrant_id"`
		JoinURL string `json:"join_url"`
	}
	body := map[string]string{
		"email":      strings.TrimSpace(person.Email),
		"first_name": first,
		"last_name":  last,
	}
	if err := c.do(ctx, http.MethodPost, "/"+kind+"/"+url.PathEscape(id)+"/registrants", access, body, &out); err != nil {
		return Registrant{}, err
	}
	if out.JoinURL == "" || out.ID == "" {
		return Registrant{}, &APIError{Status: http.StatusBadGateway, Message: "Zoom did not return a personal join link."}
	}
	return Registrant{ID: out.ID, JoinURL: out.JoinURL}, nil
}

func resource(venue string) (string, error) {
	switch venue {
	case VenueMeeting:
		return "meetings", nil
	case VenueWebinar:
		return "webinars", nil
	default:
		return "", fmt.Errorf("not a zoom venue %q", venue)
	}
}

/* mailOff is every confirmation, reminder, and follow-up Zoom would send.
 * Our email and WhatsApp are the send path. Bools are present even when
 * false — omitempty would drop them and Zoom would keep its defaults.
 */
type mailOff struct {
	ApprovalType                 int        `json:"approval_type"`
	RegistrationType             int        `json:"registration_type"`
	RegistrantsConfirmationEmail bool       `json:"registrants_confirmation_email"`
	RegistrantsEmailNotification bool       `json:"registrants_email_notification"`
	Reminder                     enableFlag `json:"attendees_and_panelists_reminder_email_notification"`
	FollowUpAttendees            enableFlag `json:"follow_up_attendees_email_notification"`
	FollowUpAbsentees            enableFlag `json:"follow_up_absentees_email_notification"`
	PanelistsInvitation          bool       `json:"panelists_invitation_email_notification"`
}

type enableFlag struct {
	Enable bool `json:"enable"`
}

func emailsOff() mailOff {
	return mailOff{
		ApprovalType:     0, // automatic, so the registrant response includes join_url
		RegistrationType: 1,
	}
}

func specBody(venue string, spec Spec) map[string]any {
	kind := 2
	if venue == VenueWebinar {
		kind = 5
	}
	return map[string]any{
		"topic":      spec.Topic,
		"type":       kind,
		"start_time": spec.StartsAt.UTC().Format("2006-01-02T15:04:05Z"),
		"duration":   spec.DurationMin,
		"timezone":   spec.TimeZone,
		"settings":   emailsOff(),
	}
}

func (c *Client) token(ctx context.Context, form url.Values) (Token, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(c.OAuth, "/")+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(c.ID, c.Secret)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return Token{}, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return Token{}, parseAPIError(res.StatusCode, raw)
	}
	var out struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return Token{}, &APIError{Status: http.StatusBadGateway, Message: "Zoom did not return an access token."}
	}
	return Token{AccessToken: out.AccessToken, RefreshToken: out.RefreshToken, ExpiresIn: out.ExpiresIn}, nil
}

func (c *Client) do(ctx context.Context, method, path, access string, in, out any) error {
	if !c.Enabled() {
		return ErrNotConfigured
	}
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.API, "/")+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return parseAPIError(res.StatusCode, raw)
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &APIError{Status: http.StatusBadGateway, Message: "Zoom sent a response that could not be read."}
	}
	return nil
}

func parseAPIError(status int, raw []byte) *APIError {
	var body struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Reason  string `json:"reason"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	msg := strings.TrimSpace(body.Message)
	if msg == "" {
		msg = strings.TrimSpace(body.Reason)
	}
	if msg == "" {
		msg = strings.TrimSpace(body.Error)
	}
	if msg == "" {
		msg = "Zoom refused that request."
	}
	return &APIError{Status: status, Code: body.Code, Message: msg}
}

/* IsPlan reports a license or add-on refusal. Those leave the webinar on
 * this app. Other failures are shown to the host and not retried. */
func IsPlan(venue string, err error) bool {
	var api *APIError
	if !errors.As(err, &api) {
		return false
	}
	msg := strings.ToLower(api.Message)
	if strings.Contains(msg, "paid") || strings.Contains(msg, "licen") ||
		strings.Contains(msg, "add-on") || strings.Contains(msg, "add on") ||
		strings.Contains(msg, "not subscribed") || strings.Contains(msg, "webinar plan") {
		return true
	}
	if venue == VenueWebinar && (api.Code == 200 || api.Code == 3000 || strings.Contains(msg, "webinar")) {
		return true
	}
	return false
}

func PlanNotice(venue string) string {
	if venue == VenueWebinar {
		return "Zoom Webinars need the Webinar add-on. This webinar stays in this app."
	}
	return "Meetings with registration need a paid Zoom license. This webinar stays in this app."
}

type zoomID string

func (z *zoomID) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*z = ""
		return nil
	}
	*z = zoomID(strings.Trim(string(b), `"`))
	return nil
}

func (z zoomID) String() string { return string(z) }
