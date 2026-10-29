package push

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

/* Native push for the Android and iOS apps, through Firebase Cloud Messaging's HTTP v1 API
 * (29 Oct 2026).
 *
 * One sender for both platforms. The apps register with Firebase (@capacitor-firebase/messaging)
 * and hand the API an FCM registration token on iOS as well as Android; FCM delivers to iOS
 * through APNs with the APNs auth key uploaded into the Firebase project, so this server holds
 * one credential, not two, and never speaks APNs itself.
 *
 * The credential is a Firebase service account's JSON key (FCM_SERVICE_ACCOUNT_JSON). It signs
 * a short JWT, exchanged at Google's token endpoint for an hour's OAuth access token with the
 * firebase.messaging scope; the token is cached and refreshed a minute early. No Google SDK:
 * the whole protocol is two POSTs.
 *
 * Outcomes reuse Web Push's (Classify above): Sent, Gone (FCM says the token is UNREGISTERED,
 * or belongs to another Firebase project: delete it), Retry (429, 5xx, network) and Drop. */

// FCMScope is the OAuth scope for sending.
const FCMScope = "https://www.googleapis.com/auth/firebase.messaging"

// FCMBaseURL is FCM's API root. A variable so tests can point it at a fake.
var FCMBaseURL = "https://fcm.googleapis.com"

// ServiceAccount is the part of a service account JSON key that sending needs.
type ServiceAccount struct {
	Type        string `json:"type"`
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"`
	ClientEmail string `json:"client_email"`
	TokenURI    string `json:"token_uri"`
}

/* ParseServiceAccount reads FCM_SERVICE_ACCOUNT_JSON: the key file's JSON as is, or the same
 * base64-encoded (easier to paste into some secret stores). */
func ParseServiceAccount(raw string) (ServiceAccount, *rsa.PrivateKey, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ServiceAccount{}, nil, errors.New("empty")
	}
	if !strings.HasPrefix(raw, "{") {
		dec, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return ServiceAccount{}, nil, errors.New("FCM_SERVICE_ACCOUNT_JSON is neither JSON nor base64 JSON")
		}
		raw = string(dec)
	}
	var sa ServiceAccount
	if err := json.Unmarshal([]byte(raw), &sa); err != nil {
		return ServiceAccount{}, nil, fmt.Errorf("FCM_SERVICE_ACCOUNT_JSON: %w", err)
	}
	if sa.Type != "service_account" || sa.ProjectID == "" || sa.ClientEmail == "" || sa.PrivateKey == "" {
		return ServiceAccount{}, nil, errors.New("FCM_SERVICE_ACCOUNT_JSON must be a service account key (type, project_id, client_email, private_key)")
	}
	if sa.TokenURI == "" {
		sa.TokenURI = "https://oauth2.googleapis.com/token"
	}
	if u, err := url.Parse(sa.TokenURI); err != nil || (u.Scheme != "https" && u.Hostname() != "127.0.0.1") {
		return ServiceAccount{}, nil, errors.New("FCM_SERVICE_ACCOUNT_JSON: token_uri must be https")
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(sa.PrivateKey))
	if err != nil {
		return ServiceAccount{}, nil, fmt.Errorf("FCM_SERVICE_ACCOUNT_JSON: private_key: %w", err)
	}
	return sa, key, nil
}

// NativeTarget is one install of the app.
type NativeTarget struct {
	Token    string
	Platform string // "ios" or "android"
}

// NativeMessage is one notification. URL is where a tap takes the app (an absolute site URL).
type NativeMessage struct {
	Kind    string
	Title   string
	Body    string
	URL     string
	Tag     string
	TTL     time.Duration
	Urgency string
}

// FCMSender posts to FCM's v1 send endpoint.
type FCMSender struct {
	sa     ServiceAccount
	key    *rsa.PrivateKey
	client *http.Client

	mu      sync.Mutex
	access  string
	expires time.Time
}

// NewFCMSender makes a sender from the service account JSON. client may be nil.
func NewFCMSender(serviceAccountJSON string, client *http.Client) (*FCMSender, error) {
	sa, key, err := ParseServiceAccount(serviceAccountJSON)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &FCMSender{sa: sa, key: key, client: client}, nil
}

// ProjectID is the Firebase project messages are sent through.
func (f *FCMSender) ProjectID() string { return f.sa.ProjectID }

// accessToken is a cached OAuth token, refreshed a minute before it runs out.
func (f *FCMSender) accessToken(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.access != "" && time.Now().Before(f.expires) {
		return f.access, nil
	}
	now := time.Now()
	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":   f.sa.ClientEmail,
		"scope": FCMScope,
		"aud":   f.sa.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}).SignedString(f.key)
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.sa.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := f.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fcm token endpoint answered %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.AccessToken == "" {
		return "", errors.New("fcm token endpoint gave no access_token")
	}
	if tok.ExpiresIn <= 0 {
		tok.ExpiresIn = 3600
	}
	f.access = tok.AccessToken
	f.expires = now.Add(time.Duration(tok.ExpiresIn)*time.Second - time.Minute)
	return f.access, nil
}

func (f *FCMSender) forgetToken() {
	f.mu.Lock()
	f.access = ""
	f.mu.Unlock()
}

// fcmPayload is the v1 send body.
func fcmPayload(t NativeTarget, m NativeMessage) ([]byte, error) {
	high := m.Urgency == "high"
	androidPriority, apnsPriority := "NORMAL", "5"
	if high {
		androidPriority, apnsPriority = "HIGH", "10"
	}
	ttl := int64(m.TTL / time.Second)
	if ttl < 0 {
		ttl = 0
	}
	// APNs: 0 means "deliver now or never", which is what a zero TTL means here too.
	expiration := "0"
	if ttl > 0 {
		expiration = strconv.FormatInt(time.Now().Add(time.Duration(ttl)*time.Second).Unix(), 10)
	}
	data := map[string]string{"url": m.URL, "kind": m.Kind}
	if m.Tag != "" {
		data["tag"] = m.Tag
	}
	android := map[string]any{
		"priority": androidPriority,
		"ttl":      strconv.FormatInt(ttl, 10) + "s",
	}
	apnsHeaders := map[string]string{"apns-priority": apnsPriority, "apns-expiration": expiration}
	if m.Tag != "" {
		// One notification per tag on the lock screen, as the browser's tag does.
		android["notification"] = map[string]string{"tag": m.Tag}
		collapse := m.Tag
		if len(collapse) > 64 {
			collapse = collapse[:64]
		}
		apnsHeaders["apns-collapse-id"] = collapse
	}
	msg := map[string]any{
		"token":        t.Token,
		"notification": map[string]string{"title": m.Title, "body": m.Body},
		"data":         data,
		"android":      android,
		"apns": map[string]any{
			"headers": apnsHeaders,
			"payload": map[string]any{"aps": map[string]any{"sound": "default"}},
		},
	}
	return json.Marshal(map[string]any{"message": msg})
}

// Send posts one message to one install.
func (f *FCMSender) Send(ctx context.Context, t NativeTarget, m NativeMessage) Result {
	payload, err := fcmPayload(t, m)
	if err != nil {
		return Result{Outcome: Drop, Err: err}
	}
	access, err := f.accessToken(ctx)
	if err != nil {
		// Our credential, not the install: the message waits and the token backs off.
		return Result{Outcome: Retry, Err: err}
	}
	endpoint := strings.TrimRight(FCMBaseURL, "/") + "/v1/projects/" + url.PathEscape(f.sa.ProjectID) + "/messages:send"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Result{Outcome: Drop, Err: err}
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	res, err := f.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Result{Outcome: Retry, Err: ctx.Err()}
		}
		return Result{Outcome: Retry, Err: err}
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 8<<10))
	if res.StatusCode == http.StatusUnauthorized {
		// The access token was revoked or expired early: get a new one next time.
		f.forgetToken()
	}
	return ClassifyFCM(res.StatusCode, res.Header.Get("Retry-After"), body)
}

/* ClassifyFCM reads FCM v1's answer. The error body is
 *
 *	{"error": {"code": 404, "status": "NOT_FOUND", "message": "...",
 *	           "details": [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
 *	                        "errorCode": "UNREGISTERED"}]}}
 *
 * UNREGISTERED (the app was uninstalled, or the token rotated) and SENDER_ID_MISMATCH (a token
 * from another Firebase project) can never be delivered: Gone. An INVALID_ARGUMENT about the
 * registration token is a malformed token: Gone too. Any other 400, and THIRD_PARTY_AUTH_ERROR
 * (the APNs key in Firebase is missing or wrong), refuse this message: Drop. 401, 429 and 5xx
 * pass: Retry. */
func ClassifyFCM(status int, retryAfter string, body []byte) Result {
	r := Result{Status: status}
	if status >= 200 && status < 300 {
		r.Outcome = Sent
		return r
	}
	var e struct {
		Error struct {
			Status  string `json:"status"`
			Message string `json:"message"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	code := e.Error.Status
	for _, d := range e.Error.Details {
		if d.ErrorCode != "" {
			code = d.ErrorCode
		}
	}
	switch {
	case code == "UNREGISTERED" || code == "SENDER_ID_MISMATCH":
		r.Outcome = Gone
	case status == http.StatusNotFound && code == "":
		r.Outcome = Gone
	case code == "INVALID_ARGUMENT" && strings.Contains(strings.ToLower(e.Error.Message), "registration token"):
		r.Outcome = Gone
	case code == "THIRD_PARTY_AUTH_ERROR":
		// APNs (or Web Push) refused Firebase's credential: a setup problem, not this message.
		r.Outcome = Drop
	case status == http.StatusUnauthorized || status == http.StatusTooManyRequests || status >= 500 ||
		code == "QUOTA_EXCEEDED" || code == "UNAVAILABLE" || code == "INTERNAL":
		r.Outcome = Retry
		r.RetryAfter = parseRetryAfter(retryAfter)
	default:
		r.Outcome = Drop
	}
	msg := strings.TrimSpace(e.Error.Message)
	if msg == "" {
		msg = strings.TrimSpace(string(body))
	}
	r.Err = fmt.Errorf("fcm answered %d %s: %s", status, code, msg)
	return r
}
