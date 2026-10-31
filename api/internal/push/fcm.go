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
 * Or no key at all (29 Oct 2026): when FCM_SERVICE_ACCOUNT_JSON is unset and FCM_PROJECT_ID
 * is set, the token comes from the GCE / Cloud Run metadata server for the runtime service
 * account, which holds roles/firebasecloudmessaging.admin on that project. Nothing to download
 * or rotate. The JSON key wins when both are set.
 *
 * Outcomes reuse Web Push's (Classify above): Sent, Gone (FCM says the token is UNREGISTERED,
 * or belongs to another Firebase project: delete it), Retry (429, 5xx, network) and Drop. */

// FCMScope is the OAuth scope for sending.
const FCMScope = "https://www.googleapis.com/auth/firebase.messaging"

// FCMBaseURL is FCM's API root. A variable so tests can point it at a fake.
var FCMBaseURL = "https://fcm.googleapis.com"

// MetadataBaseURL is the GCE / Cloud Run metadata server. A variable so tests can point it at a fake.
var MetadataBaseURL = "http://metadata.google.internal"

// The credential an FCMSender uses, for the boot log.
const (
	FCMSourceServiceAccount = "service_account_json"
	FCMSourceMetadata       = "metadata_server"
)

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
	// Data is more FCM data next to url, kind and tag (31 Oct 2026, calling): string values only,
	// as FCM requires. It never overrides those three.
	Data map[string]string
	/* DataOnly sends a data message (31 Oct 2026, calling): no notification block, so Android
	 * wakes the app (priority HIGH) to draw its own UI, an incoming-call screen, rather than
	 * the system drawing a banner. iOS does not wake a killed app for a data message, so with
	 * a Title it still gets an APNs alert (apns-push-type alert, priority 10) as the fallback,
	 * and with no Title a silent background push (content-available). */
	DataOnly bool
}

// FCMSender posts to FCM's v1 send endpoint.
type FCMSender struct {
	projectID string
	source    string
	// mint fetches a fresh access token and its lifetime in seconds (0: the default hour).
	mint   func(ctx context.Context) (string, int, error)
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
	f := &FCMSender{projectID: sa.ProjectID, source: FCMSourceServiceAccount, client: client}
	f.mint = func(ctx context.Context) (string, int, error) { return f.jwtToken(ctx, sa, key) }
	return f, nil
}

/* NewFCMMetadataSender makes a sender that sends through Firebase project projectID with the
 * runtime service account's token from the metadata server (29 Oct 2026). Nothing is fetched
 * until the first send. client may be nil. */
func NewFCMMetadataSender(projectID string, client *http.Client) (*FCMSender, error) {
	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return nil, errors.New("FCM_PROJECT_ID is empty")
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	f := &FCMSender{projectID: projectID, source: FCMSourceMetadata, client: client}
	f.mint = f.metadataToken
	return f, nil
}

/* NewFCMSenderFromConfig picks the credential (29 Oct 2026): the service account JSON when it
 * is set (an unusable one is an error, not a quiet fall back to the metadata server, so a bad
 * paste is noticed), else the metadata server when projectID is set, else nil and no error:
 * native sending is off. */
func NewFCMSenderFromConfig(serviceAccountJSON, projectID string, client *http.Client) (*FCMSender, error) {
	if strings.TrimSpace(serviceAccountJSON) != "" {
		return NewFCMSender(serviceAccountJSON, client)
	}
	if strings.TrimSpace(projectID) != "" {
		return NewFCMMetadataSender(projectID, client)
	}
	return nil, nil
}

// ProjectID is the Firebase project messages are sent through.
func (f *FCMSender) ProjectID() string { return f.projectID }

// Source is where the access token comes from: FCMSourceServiceAccount or FCMSourceMetadata.
func (f *FCMSender) Source() string { return f.source }

// accessToken is a cached OAuth token, refreshed a minute before it runs out.
func (f *FCMSender) accessToken(ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.access != "" && time.Now().Before(f.expires) {
		return f.access, nil
	}
	now := time.Now()
	access, expiresIn, err := f.mint(ctx)
	if err != nil {
		return "", err
	}
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	f.access = access
	f.expires = now.Add(time.Duration(expiresIn)*time.Second - time.Minute)
	return f.access, nil
}

// jwtToken exchanges a JWT signed with the service account's key for an access token.
func (f *FCMSender) jwtToken(ctx context.Context, sa ServiceAccount, key *rsa.PrivateKey) (string, int, error) {
	now := time.Now()
	assertion, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":   sa.ClientEmail,
		"scope": FCMScope,
		"aud":   sa.TokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	}).SignedString(key)
	if err != nil {
		return "", 0, err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sa.TokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return f.readToken(req, "fcm token endpoint")
}

/* metadataToken asks the metadata server for the runtime service account's token with the
 * firebase.messaging scope (29 Oct 2026). The server refuses a request without
 * Metadata-Flavor: Google. */
func (f *FCMSender) metadataToken(ctx context.Context) (string, int, error) {
	endpoint := strings.TrimRight(MetadataBaseURL, "/") +
		"/computeMetadata/v1/instance/service-accounts/default/token?scopes=" + url.QueryEscape(FCMScope)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Metadata-Flavor", "Google")
	return f.readToken(req, "metadata server")
}

// readToken does req and reads an OAuth token answer: {"access_token", "expires_in"}.
func (f *FCMSender) readToken(req *http.Request, what string) (string, int, error) {
	res, err := f.client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("%s answered %d: %s", what, res.StatusCode, strings.TrimSpace(string(body)))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.AccessToken == "" {
		return "", 0, fmt.Errorf("%s gave no access_token", what)
	}
	return tok.AccessToken, tok.ExpiresIn, nil
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
	data := map[string]string{}
	for k, v := range m.Data {
		data[k] = v
	}
	data["url"], data["kind"] = m.URL, m.Kind
	if m.Tag != "" {
		data["tag"] = m.Tag
	}
	if m.DataOnly {
		return fcmDataPayload(t, m, data, ttl, expiration)
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

/* fcmDataPayload is the v1 body of a DataOnly message: Android high priority and no
 * notification anywhere; iOS the alert fallback, or a background push without a title. */
func fcmDataPayload(t NativeTarget, m NativeMessage, data map[string]string, ttl int64, expiration string) ([]byte, error) {
	apnsHeaders := map[string]string{"apns-expiration": expiration}
	aps := map[string]any{}
	if m.Title != "" {
		apnsHeaders["apns-push-type"], apnsHeaders["apns-priority"] = "alert", "10"
		aps["alert"] = map[string]string{"title": m.Title, "body": m.Body}
		aps["sound"] = "default"
	} else {
		apnsHeaders["apns-push-type"], apnsHeaders["apns-priority"] = "background", "5"
		aps["content-available"] = 1
	}
	if m.Tag != "" {
		collapse := m.Tag
		if len(collapse) > 64 {
			collapse = collapse[:64]
		}
		apnsHeaders["apns-collapse-id"] = collapse
	}
	msg := map[string]any{
		"token": t.Token,
		"data":  data,
		"android": map[string]any{
			"priority": "HIGH",
			"ttl":      strconv.FormatInt(ttl, 10) + "s",
		},
		"apns": map[string]any{
			"headers": apnsHeaders,
			"payload": map[string]any{"aps": aps},
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
	endpoint := strings.TrimRight(FCMBaseURL, "/") + "/v1/projects/" + url.PathEscape(f.projectID) + "/messages:send"
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
