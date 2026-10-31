package push

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

/* iOS VoIP push for incoming calls, straight to APNs (31 Oct 2026).
 *
 * Everything else reaches the iOS app through FCM (fcm.go). A call cannot: iOS only rings an
 * app that was killed when the push is a PushKit VoIP push, and the app must hand it to
 * CallKit at once (apps/mobile/ios/App/App/CallRingingPlugin.swift). FCM does not send VoIP
 * pushes, so this sender speaks APNs' HTTP/2 API itself.
 *
 * Token authentication: a provider JWT (ES256) signed with the team's APNs auth key (.p8), the
 * same key already uploaded into Firebase. One key works for every topic of the team's apps,
 * VoIP included, so no VoIP certificate is needed. Apple wants the token reused for between
 * 20 and 60 minutes; it is cached for 50.
 *
 * The request: POST /3/device/<voip token> on api.push.apple.com (api.sandbox.push.apple.com
 * for a development-signed build), apns-push-type: voip, apns-topic: the bundle ID + ".voip"
 * (Apple requires exactly that for PushKit), apns-priority: 10, and an apns-expiration about
 * 45 seconds out: a call nobody hears ringing within that is over anyway.
 *
 * Outcomes reuse Web Push's: Sent; Gone for Unregistered (410), BadDeviceToken and
 * DeviceTokenNotForTopic (the token is not, or no longer, this app's: delete it); Retry for
 * 429, 5xx and an expired or refused provider token (which is forgotten); Drop for the rest. */

// APNsVoIPTopic is the PushKit topic: the app's bundle ID plus ".voip".
const APNsVoIPTopic = "com.webinarliv.app.voip"

// APNs hosts. Variables so tests can point them at a fake.
var (
	APNsProductionURL = "https://api.push.apple.com"
	APNsSandboxURL    = "https://api.sandbox.push.apple.com"
)

// APNsVoIPExpiry is how long APNs may hold a call push for a phone that is out of reach.
const APNsVoIPExpiry = 45 * time.Second

// apnsTokenLife is how long one provider JWT is reused (Apple: refresh between 20 and 60 min).
const apnsTokenLife = 50 * time.Minute

// APNsConfig is the APNs auth key. All of KeyP8, KeyID and TeamID empty means VoIP is off.
type APNsConfig struct {
	// KeyP8 is the .p8 file's PEM, or the same base64-encoded (APNS_KEY_P8).
	KeyP8 string
	// KeyID is the key's 10-character ID (APNS_KEY_ID).
	KeyID string
	// TeamID is the Apple developer team (APNS_TEAM_ID).
	TeamID string
	// Env is "production" (the default) or "sandbox" (APNS_ENV).
	Env string
}

// Configured reports whether any of the key's parts is set.
func (c APNsConfig) Configured() bool {
	return strings.TrimSpace(c.KeyP8) != "" || strings.TrimSpace(c.KeyID) != "" || strings.TrimSpace(c.TeamID) != ""
}

var apnsIDPattern = regexp.MustCompile(`^[A-Z0-9]{10}$`)

// ParseAPNsKey reads an APNs auth key: the .p8 PEM, base64 of the PEM, or base64 of its DER.
func ParseAPNsKey(raw string) (*ecdsa.PrivateKey, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("APNS_KEY_P8 is empty")
	}
	// A secret store may have turned the PEM's newlines into "\n".
	raw = strings.ReplaceAll(raw, `\n`, "\n")
	var der []byte
	if block, _ := pem.Decode([]byte(raw)); block != nil {
		der = block.Bytes
	} else {
		dec, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(raw), ""))
		if err != nil {
			return nil, errors.New("APNS_KEY_P8 is neither a PEM key nor base64")
		}
		if block, _ := pem.Decode(dec); block != nil {
			der = block.Bytes
		} else {
			der = dec
		}
	}
	key, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, fmt.Errorf("APNS_KEY_P8: %w", err)
	}
	ec, ok := key.(*ecdsa.PrivateKey)
	if !ok || ec.Curve.Params().Name != "P-256" {
		return nil, errors.New("APNS_KEY_P8 must be a P-256 (ES256) key, as Apple's .p8 keys are")
	}
	return ec, nil
}

// VoIPSender posts VoIP pushes to APNs.
type VoIPSender struct {
	key    *ecdsa.PrivateKey
	keyID  string
	teamID string
	env    string
	client *http.Client
	now    func() time.Time

	mu       sync.Mutex
	bearer   string
	bearerAt time.Time
}

/* NewVoIPSenderFromConfig makes the sender (31 Oct 2026): nil and no error when nothing is set
 * (VoIP is off), an error when the key is partial or does not parse, so the boot log says
 * which. client may be nil: a 10-second-timeout client on the default transport, which speaks
 * HTTP/2 to APNs (APNs accepts nothing else). */
func NewVoIPSenderFromConfig(cfg APNsConfig, client *http.Client) (*VoIPSender, error) {
	if !cfg.Configured() {
		return nil, nil
	}
	keyID, teamID := strings.TrimSpace(cfg.KeyID), strings.TrimSpace(cfg.TeamID)
	if strings.TrimSpace(cfg.KeyP8) == "" || keyID == "" || teamID == "" {
		return nil, errors.New("APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID must be set together")
	}
	if !apnsIDPattern.MatchString(keyID) {
		return nil, errors.New("APNS_KEY_ID must be the key's 10-character ID")
	}
	if !apnsIDPattern.MatchString(teamID) {
		return nil, errors.New("APNS_TEAM_ID must be the 10-character team ID")
	}
	env := strings.ToLower(strings.TrimSpace(cfg.Env))
	switch env {
	case "", "production", "prod":
		env = "production"
	case "sandbox", "development", "dev":
		env = "sandbox"
	default:
		return nil, errors.New("APNS_ENV must be production or sandbox")
	}
	key, err := ParseAPNsKey(cfg.KeyP8)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &VoIPSender{key: key, keyID: keyID, teamID: teamID, env: env, client: client, now: time.Now}, nil
}

// Env is "production" or "sandbox", for the boot log.
func (v *VoIPSender) Env() string { return v.env }

// KeyID is the auth key's ID, for the boot log.
func (v *VoIPSender) KeyID() string { return v.keyID }

func (v *VoIPSender) baseURL() string {
	if v.env == "sandbox" {
		return strings.TrimRight(APNsSandboxURL, "/")
	}
	return strings.TrimRight(APNsProductionURL, "/")
}

// providerToken is the cached provider JWT: {alg: ES256, kid} . {iss: team, iat}.
func (v *VoIPSender) providerToken() (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	if v.bearer != "" && now.Sub(v.bearerAt) < apnsTokenLife {
		return v.bearer, nil
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": v.teamID, "iat": now.Unix()})
	tok.Header["kid"] = v.keyID
	signed, err := tok.SignedString(v.key)
	if err != nil {
		return "", err
	}
	v.bearer, v.bearerAt = signed, now
	return signed, nil
}

func (v *VoIPSender) forgetToken() {
	v.mu.Lock()
	v.bearer = ""
	v.mu.Unlock()
}

// VoIPPayload is the push body: the call's fields at the top level, beside an empty aps.
func VoIPPayload(fields map[string]string) ([]byte, error) {
	body := map[string]any{"aps": map[string]any{}}
	for k, val := range fields {
		if k == "aps" {
			continue
		}
		body[k] = val
	}
	return json.Marshal(body)
}

/* NewVoIPRequest builds one APNs request. collapseID (the call's ID) makes a call_ended
 * replace a still-queued incoming_call for the same call rather than queue behind it. */
func (v *VoIPSender) NewVoIPRequest(ctx context.Context, deviceToken string, payload []byte, collapseID string) (*http.Request, error) {
	bearer, err := v.providerToken()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		v.baseURL()+"/3/device/"+deviceToken, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "bearer "+bearer)
	req.Header.Set("apns-push-type", "voip")
	req.Header.Set("apns-topic", APNsVoIPTopic)
	req.Header.Set("apns-priority", "10")
	req.Header.Set("apns-expiration", strconv.FormatInt(v.now().Add(APNsVoIPExpiry).Unix(), 10))
	if collapseID != "" {
		if len(collapseID) > 64 {
			collapseID = collapseID[:64]
		}
		req.Header.Set("apns-collapse-id", collapseID)
	}
	req.Header.Set("content-type", "application/json")
	return req, nil
}

var hexToken = regexp.MustCompile(`^[0-9a-fA-F]{32,200}$`)

// Send posts one VoIP push to one device.
func (v *VoIPSender) Send(ctx context.Context, deviceToken string, payload []byte, collapseID string) Result {
	if !hexToken.MatchString(deviceToken) {
		// PushKit tokens are hex. Anything else could never be delivered.
		return Result{Outcome: Gone, Status: http.StatusBadRequest, Err: errors.New("apns: not a hex device token")}
	}
	req, err := v.NewVoIPRequest(ctx, deviceToken, payload, collapseID)
	if err != nil {
		return Result{Outcome: Drop, Err: err}
	}
	res, err := v.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Result{Outcome: Retry, Err: ctx.Err()}
		}
		return Result{Outcome: Retry, Err: err}
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))
	r := ClassifyAPNs(res.StatusCode, res.Header.Get("Retry-After"), body)
	if r.Status == http.StatusForbidden {
		// The provider token: expired, or refused. Sign a new one next time.
		v.forgetToken()
	}
	return r
}

/* ClassifyAPNs reads APNs' answer: 200 with an empty body, or a status and {"reason": "..."}
 * (Apple's "Handling notification responses from APNs"). */
func ClassifyAPNs(status int, retryAfter string, body []byte) Result {
	r := Result{Status: status}
	if status == http.StatusOK {
		r.Outcome = Sent
		return r
	}
	var e struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(body, &e)
	switch {
	case status == http.StatusGone || e.Reason == "Unregistered" ||
		e.Reason == "BadDeviceToken" || e.Reason == "DeviceTokenNotForTopic":
		r.Outcome = Gone
	case status == http.StatusForbidden && (e.Reason == "ExpiredProviderToken" || e.Reason == "InvalidProviderToken"):
		r.Outcome = Retry
	case status == http.StatusTooManyRequests || status >= 500:
		r.Outcome = Retry
		r.RetryAfter = parseRetryAfter(retryAfter)
	default:
		r.Outcome = Drop
	}
	r.Err = fmt.Errorf("apns answered %d %s", status, e.Reason)
	return r
}
