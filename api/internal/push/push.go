/* Package push sends Web Push messages (RFC 8030) with VAPID (RFC 8292) and the aes128gcm
 * payload encryption of RFC 8291.
 *
 * The encryption and the VAPID JWT are github.com/SherClockHolmes/webpush-go; this package is
 * the part that is ours: which endpoints we are willing to POST to, how a push service's answer
 * is read (sent, gone for good, try again later, give up), and the configuration that turns the
 * whole feature off when the three VAPID variables are not set.
 *
 * Nothing here knows about the database. The outbox, the fan-out and the per-endpoint backoff
 * are in api/internal/api/push.go and api/internal/store/push.go.
 */
package push

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Config is the deployment's VAPID identity. All three empty means push is off.
type Config struct {
	// PublicKey and PrivateKey are the base64url P-256 key pair from
	// `npx web-push generate-vapid-keys`.
	PublicKey  string
	PrivateKey string
	// Subject is a mailto: or https: contact the push services can reach (RFC 8292 §2.1).
	Subject string
}

// Enabled reports whether push is configured. Validate has already refused a partial one.
func (c Config) Enabled() bool {
	return c.PublicKey != "" && c.PrivateKey != "" && c.Subject != ""
}

// Validate refuses a half-configured or malformed identity. An empty one is valid: off.
func (c Config) Validate() error {
	if c.PublicKey == "" && c.PrivateKey == "" && c.Subject == "" {
		return nil
	}
	if !c.Enabled() {
		return errors.New("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together")
	}
	pub, err := decodeB64(c.PublicKey)
	if err != nil || len(pub) != 65 || pub[0] != 4 {
		return errors.New("VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key (65 bytes)")
	}
	priv, err := decodeB64(c.PrivateKey)
	if err != nil || len(priv) != 32 {
		return errors.New("VAPID_PRIVATE_KEY must be a base64url P-256 private key (32 bytes)")
	}
	// The two halves must be one pair, or every push service answers 401/403 and the
	// failure looks like a broken browser rather than a typo in a secret.
	key, err := ecdh.P256().NewPrivateKey(priv)
	if err != nil || !bytes.Equal(key.PublicKey().Bytes(), pub) {
		return errors.New("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a key pair")
	}
	if !strings.HasPrefix(c.Subject, "mailto:") && !strings.HasPrefix(c.Subject, "https://") {
		return errors.New("VAPID_SUBJECT must start with mailto: or https://")
	}
	return nil
}

/* GenerateKeys makes a VAPID key pair, for tests and for an operator without Node at hand.
 * (`npx web-push generate-vapid-keys` prints the same two strings.) */
func GenerateKeys() (publicKey, privateKey string, err error) {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	return pub, priv, err
}

func decodeB64(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	return base64.RawURLEncoding.DecodeString(s)
}

// ------------------------------------------------------------------ what we accept

/* pushHosts are the push services the browsers that can install this app use. An endpoint is
 * a URL the browser hands us and we later POST to from the server, so accepting any URL would
 * make subscribe a way to have this server send requests wherever somebody likes. Suffix
 * match: Mozilla, Apple and Microsoft shard by subdomain. */
var pushHosts = []string{
	"fcm.googleapis.com",                // Chrome, Edge on Android, Samsung Internet, Opera, Brave
	"android.googleapis.com",            // older Chrome endpoints, still delivered by FCM
	"push.services.mozilla.com",         // Firefox (updates.push.services.mozilla.com)
	"push.apple.com",                    // Safari 16+ and iOS 16.4+ home-screen apps (web.push.apple.com)
	"notify.windows.com",                // Edge on Windows (*.notify.windows.com)
	"push.api.chrome.google.com",        // reserved by Chrome for non-FCM delivery
	"webpush.push.services.mozilla.com", // explicit, covered by the suffix as well
}

// ErrEndpoint is a subscription whose endpoint is not one of the push services above.
var ErrEndpoint = errors.New("push: endpoint is not a known push service")

// ValidEndpoint accepts an https URL on a known push service.
func ValidEndpoint(raw string) error {
	if len(raw) == 0 || len(raw) > 2048 {
		return ErrEndpoint
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return ErrEndpoint
	}
	if p := u.Port(); p != "" && p != "443" {
		return ErrEndpoint
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range pushHosts {
		if host == h || strings.HasSuffix(host, "."+h) {
			return nil
		}
	}
	return ErrEndpoint
}

// ValidKeys checks a subscription's keys decode to what RFC 8291 needs: a P-256 point and a
// 16-byte auth secret. A subscription that fails here would fail every send.
func ValidKeys(p256dh, auth string) error {
	pub, err := decodeB64(p256dh)
	if err != nil || len(pub) != 65 {
		return errors.New("push: p256dh must be a base64url P-256 public key")
	}
	if _, err := ecdh.P256().NewPublicKey(pub); err != nil {
		return errors.New("push: p256dh is not a point on P-256")
	}
	a, err := decodeB64(auth)
	if err != nil || len(a) != 16 {
		return errors.New("push: auth must be a base64url 16-byte secret")
	}
	return nil
}

// ------------------------------------------------------------------ sending

// Target is one browser.
type Target struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// Message is one push. Payload is the JSON the service worker reads (types.PushPayload).
type Message struct {
	Payload []byte
	// TTL is how long the push service may hold it for an offline browser. Zero means
	// deliver now or never, which is right for "somebody is at the door".
	TTL time.Duration
	// Urgency is very-low, low, normal or high (RFC 8030 §5.3). High wakes a sleeping phone.
	Urgency string
}

// Outcome is what to do after a send.
type Outcome int

const (
	// Sent: the push service accepted it.
	Sent Outcome = iota
	// Gone: the subscription no longer exists (404/410). Delete it.
	Gone
	// Retry: a transient failure (network, 429, 5xx). Back this endpoint off.
	Retry
	// Drop: the push service refused this message for good (other 4xx). Do not retry it.
	Drop
)

// Result is a send's outcome, with the push service's Retry-After when it gave one.
type Result struct {
	Outcome    Outcome
	Status     int
	RetryAfter time.Duration
	Err        error
}

// Sender posts messages to push services.
type Sender struct {
	cfg    Config
	client *http.Client
}

// NewSender makes a sender. client may be nil (a 15-second-timeout default).
func NewSender(cfg Config, client *http.Client) *Sender {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &Sender{cfg: cfg, client: client}
}

// PublicKey is the application server key the browser subscribes with.
func (s *Sender) PublicKey() string { return s.cfg.PublicKey }

// Send encrypts and posts one message.
func (s *Sender) Send(ctx context.Context, t Target, m Message) Result {
	urgency := webpush.Urgency(m.Urgency)
	switch urgency {
	case webpush.UrgencyVeryLow, webpush.UrgencyLow, webpush.UrgencyNormal, webpush.UrgencyHigh:
	default:
		urgency = webpush.UrgencyNormal
	}
	res, err := webpush.SendNotificationWithContext(ctx, m.Payload, &webpush.Subscription{
		Endpoint: t.Endpoint,
		Keys:     webpush.Keys{P256dh: t.P256dh, Auth: t.Auth},
	}, &webpush.Options{
		HTTPClient: s.client,
		// The library prefixes "mailto:" to anything that is not https:, so a subject
		// written the RFC's way ("mailto:ops@…") is passed without its scheme.
		Subscriber:      strings.TrimPrefix(s.cfg.Subject, "mailto:"),
		VAPIDPublicKey:  s.cfg.PublicKey,
		VAPIDPrivateKey: s.cfg.PrivateKey,
		TTL:             int(m.TTL / time.Second),
		Urgency:         urgency,
	})
	if err != nil {
		if ctx.Err() != nil {
			return Result{Outcome: Retry, Err: ctx.Err()}
		}
		// The network, or (rarely) a key that encrypts badly. Either way the endpoint backs
		// off, and a message that keeps failing runs out of attempts (store.MaxPushAttempts).
		return Result{Outcome: Retry, Err: err}
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
	return Classify(res.StatusCode, res.Header.Get("Retry-After"), body)
}

// Classify reads a push service's status code.
func Classify(status int, retryAfter string, body []byte) Result {
	r := Result{Status: status}
	switch {
	case status >= 200 && status < 300:
		r.Outcome = Sent
	case status == http.StatusNotFound || status == http.StatusGone:
		r.Outcome = Gone
	case status == http.StatusTooManyRequests || status >= 500:
		r.Outcome = Retry
		r.RetryAfter = parseRetryAfter(retryAfter)
	default:
		r.Outcome = Drop
	}
	if r.Outcome != Sent {
		r.Err = fmt.Errorf("push service answered %d: %s", status, strings.TrimSpace(string(body)))
	}
	return r
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

/* Backoff is how long an endpoint rests after its n-th consecutive failure: 30 s doubling,
 * capped at an hour, and never less than what the push service asked for. */
func Backoff(failures int, retryAfter time.Duration) time.Duration {
	if failures < 1 {
		failures = 1
	}
	d := 30 * time.Second
	for i := 1; i < failures && d < time.Hour; i++ {
		d *= 2
	}
	if d > time.Hour {
		d = time.Hour
	}
	if retryAfter > d {
		d = retryAfter
	}
	return d
}
