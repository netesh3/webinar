// Package wa talks to Meta's Graph API for WhatsApp Cloud.
//
// A host connects their own WhatsApp Business Account once, through Meta's
// Embedded Signup dialog. The browser completes that dialog and hands back a
// short-lived code plus the ids of the WABA and phone number it just granted;
// Exchange turns the code into the long-lived token every later send carries.
//
// The token belongs to the HOST's business, which is the point of the whole
// arrangement rather than an implementation detail: Meta bills each conversation
// to the WABA that sent it, so a host pays for their own messages and this
// server never fronts anybody else's fees. A host without a payment method on
// their WABA is connected and still cannot send — that is Meta's decision to
// report, not ours to pre-empt.
//
// Inbound deliveries are parsed in webhook.go and sending lives in send.go. See
// docs/WHATSAPP-CRM-PLAN.md for what lands in which phase.
package wa

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	/* DefaultGraph is pinned to a version rather than tracking whatever Meta
	 * calls latest. A Graph version is supported for roughly two years, and a
	 * silently-moving one is how a working integration breaks on somebody else's
	 * release schedule — during a webinar, for messages a host has paid for.
	 * WHATSAPP_GRAPH_URL overrides it, which is also how the tests point this at
	 * an httptest.Server. */
	DefaultGraph = "https://graph.facebook.com/v23.0"

	// SignatureHeader carries the HMAC Meta signs every webhook body with.
	SignatureHeader = "X-Hub-Signature-256"
)

var (
	ErrNotConfigured = errors.New("WhatsApp is not set up on this instance")
	ErrNeedCode      = errors.New("Meta did not send an authorization code")
	ErrNotConnected  = errors.New("connect WhatsApp in Account settings first")
	/* ErrTokenRejected is Meta refusing the stored token — the host removed our
	 * app from their business, or the WABA was deleted. Distinct from
	 * ErrNotConnected because the two need different words in the UI: one asks
	 * somebody to connect for the first time, the other tells them a connection
	 * they believe they have is gone. */
	ErrTokenRejected = errors.New("Meta rejected this WhatsApp connection. Reconnect WhatsApp in Account settings")
)

// Client is a Meta app that can complete Embedded Signup for a host's WABA.
type Client struct {
	AppID     string
	AppSecret string
	/* ConfigID is the Embedded Signup configuration the browser opens. Public by
	 * design — it names which signup flow to show, not who may use it — so it is
	 * served to the frontend the way GoogleClientID is. */
	ConfigID string
	Graph    string
	HTTP     *http.Client
}

func New(appID, appSecret, configID string) *Client {
	return &Client{
		AppID:     strings.TrimSpace(appID),
		AppSecret: strings.TrimSpace(appSecret),
		ConfigID:  strings.TrimSpace(configID),
		Graph:     strings.TrimRight(DefaultGraph, "/"),
		HTTP:      &http.Client{Timeout: 15 * time.Second},
	}
}

/* Enabled requires the config id as well as the credentials.
 *
 * The exchange itself would work without it, but nothing can ever reach the
 * exchange: without a config id the browser cannot open the dialog that produces
 * a code. Treating a partial setup as enabled would mean offering a Connect
 * button that dead-ends, so all three or none.
 */
func (c *Client) Enabled() bool {
	return c != nil && c.AppID != "" && c.AppSecret != "" && c.ConfigID != ""
}

/* Token is the business integration system user token Embedded Signup produces.
 *
 * ExpiresAt is usually the zero time, and that is an answer rather than a
 * missing value: the token Meta issues for a business integration does not
 * expire, so there is deliberately no refresh path in this package. A non-zero
 * one comes from the short-lived tokens test apps and the Graph explorer hand
 * out; callers store it so a stale connection can be SHOWN as stale instead of
 * being discovered when a reminder fails to send.
 */
type Token struct {
	AccessToken string
	ExpiresAt   time.Time
}

// Number is a WhatsApp business phone number as Meta describes it.
type Number struct {
	ID string
	// DisplayPhone is Meta's formatted version ("+27 82 000 0000"), not E.164.
	// It is for showing a host which of their numbers is connected; nothing
	// matches contacts against it.
	DisplayPhone string
	// VerifiedName is the business name recipients see as the sender.
	VerifiedName string
}

/* Exchange turns the Embedded Signup code into the host's token.
 *
 * No redirect_uri, unlike the YouTube authorization-code grant in the yt
 * package. The code comes from Meta's JS SDK dialog rather than from a browser
 * redirect we own, so there is no URI to prove and sending one makes Meta reject
 * the exchange.
 */
func (c *Client) Exchange(ctx context.Context, code string) (Token, error) {
	if !c.Enabled() {
		return Token{}, ErrNotConfigured
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return Token{}, ErrNeedCode
	}

	q := url.Values{
		"client_id":     {c.AppID},
		"client_secret": {c.AppSecret},
		"code":          {code},
	}
	var out struct {
		AccessToken string `json:"access_token"`
		// Seconds, and absent for a token that does not expire — which is the
		// normal case here. See Token.ExpiresAt.
		ExpiresIn int64 `json:"expires_in"`
	}
	if err := c.get(ctx, "", "/oauth/access_token?"+q.Encode(), &out); err != nil {
		return Token{}, err
	}
	if out.AccessToken == "" {
		return Token{}, errors.New("meta returned no access token for that code")
	}
	tok := Token{AccessToken: out.AccessToken}
	if out.ExpiresIn > 0 {
		tok.ExpiresAt = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	}
	return tok, nil
}

// Number reads the display phone and verified business name for one phone
// number id, which is what Account settings shows a connected host.
func (c *Client) Number(ctx context.Context, token, phoneNumberID string) (Number, error) {
	if strings.TrimSpace(token) == "" {
		return Number{}, ErrNotConnected
	}
	id := strings.TrimSpace(phoneNumberID)
	if id == "" {
		return Number{}, errors.New("meta sent no phone number id")
	}
	var out struct {
		ID           string `json:"id"`
		DisplayPhone string `json:"display_phone_number"`
		VerifiedName string `json:"verified_name"`
	}
	path := "/" + url.PathEscape(id) + "?fields=display_phone_number,verified_name"
	if err := c.get(ctx, token, path, &out); err != nil {
		return Number{}, err
	}
	if out.ID == "" {
		out.ID = id
	}
	return Number{ID: out.ID, DisplayPhone: out.DisplayPhone, VerifiedName: out.VerifiedName}, nil
}

/* SubscribeApp points the host's WABA at our webhook.
 *
 * Without it the grant is real and completely silent: sends would work, and no
 * delivery status or inbound reply would ever arrive, so the CRM inbox would sit
 * empty with nothing visibly wrong. Part of connecting, therefore, not of
 * ingest.
 */
func (c *Client) SubscribeApp(ctx context.Context, token, wabaID string) error {
	if strings.TrimSpace(token) == "" {
		return ErrNotConnected
	}
	id := strings.TrimSpace(wabaID)
	if id == "" {
		return errors.New("meta sent no WhatsApp Business Account id")
	}
	return c.post(ctx, token, "/"+url.PathEscape(id)+"/subscribed_apps", nil, nil)
}

/* Register enables Cloud API sending on a phone number, with the host's two-step PIN.
 *
 * Meta's own step, and the one that is easy to miss: a number created inside Embedded
 * Signup exists, is verified, belongs to the host's WABA — and cannot send anything
 * until it has been registered against Cloud API. Every send until then fails with a
 * message about the number not being registered, which reads like a problem with this
 * application and is not one.
 *
 * The PIN is the host's two-step verification code for that number, chosen by them.
 * It is a parameter and nothing else here: not generated, not defaulted, not kept.
 * See the handler in whatsapp.go for why it is never stored and never logged.
 *
 * Idempotent at Meta's end for a number already registered with the same PIN, which is
 * what makes it safe to offer as a button a host can press twice.
 */
func (c *Client) Register(ctx context.Context, token, phoneNumberID, pin string) error {
	if strings.TrimSpace(token) == "" {
		return ErrNotConnected
	}
	id := strings.TrimSpace(phoneNumberID)
	if id == "" {
		return errors.New("meta sent no phone number id")
	}
	if strings.TrimSpace(pin) == "" {
		return errors.New("a two-step PIN is required to register a number")
	}
	return c.post(ctx, token, "/"+url.PathEscape(id)+"/register", map[string]any{
		"messaging_product": "whatsapp",
		"pin":               pin,
	}, nil)
}

/* UnsubscribeApp is the other half of SubscribeApp, for disconnecting.
 *
 * Dropping our copy of the token is not enough on its own: the subscription
 * lives on the host's WABA, so without this Meta would keep posting their
 * customers' messages to our webhook after the host has told us to stop. The
 * bodies would be signed and would look entirely genuine, which is precisely why
 * they must not keep arriving.
 *
 * Best-effort at the call site — a host revoking our app from their business
 * side first makes this fail with a rejected token, and the disconnect they asked
 * for must still happen.
 */
func (c *Client) UnsubscribeApp(ctx context.Context, token, wabaID string) error {
	if strings.TrimSpace(token) == "" {
		return ErrNotConnected
	}
	id := strings.TrimSpace(wabaID)
	if id == "" {
		return errors.New("meta sent no WhatsApp Business Account id")
	}
	return c.do(ctx, token, http.MethodDelete, "/"+url.PathEscape(id)+"/subscribed_apps", nil, nil)
}

/* Version is the Graph version segment, for the browser's JS SDK.
 *
 * Embedded Signup runs in Meta's own dialog, initialised with a version string
 * of its own — and the host's browser must be on the same version this server
 * talks to, or the sessionInfo message it sends back can carry a different shape
 * than the exchange below expects. Read off the pinned base URL rather than
 * written out twice.
 */
/* TokenHealth is Meta's own verdict on a stored token, from /debug_token. */
type TokenHealth struct {
	Valid bool
	// ExpiresAt is zero for a token that never expires.
	ExpiresAt time.Time
	// Reason is Meta's words when Valid is false, for the log.
	Reason string
}

/* CheckToken asks Meta whether a host's token still works, without sending
 * anything. Authenticated as the app (app id | secret), which is what
 * /debug_token requires — so it answers even for a token that is already dead,
 * where a call made WITH that token would only return 190.
 */
func (c *Client) CheckToken(ctx context.Context, token string) (TokenHealth, error) {
	if !c.Enabled() {
		return TokenHealth{}, ErrNotConfigured
	}
	q := url.Values{
		"input_token":  {token},
		"access_token": {c.AppID + "|" + c.AppSecret},
	}
	var out struct {
		Data struct {
			IsValid   bool  `json:"is_valid"`
			ExpiresAt int64 `json:"expires_at"`
			Error     struct {
				Message string `json:"message"`
				Code    int    `json:"code"`
				Sub     int    `json:"subcode"`
			} `json:"error"`
		} `json:"data"`
	}
	if err := c.get(ctx, "", "/debug_token?"+q.Encode(), &out); err != nil {
		return TokenHealth{}, err
	}
	h := TokenHealth{Valid: out.Data.IsValid}
	if out.Data.ExpiresAt > 0 {
		h.ExpiresAt = time.Unix(out.Data.ExpiresAt, 0).UTC()
	}
	if !h.Valid {
		h.Reason = fmt.Sprintf("%s (code %d, subcode %d)",
			strings.TrimSpace(out.Data.Error.Message), out.Data.Error.Code, out.Data.Error.Sub)
	}
	return h, nil
}

func (c *Client) Version() string {
	segments := strings.Split(strings.TrimRight(c.base(), "/"), "/")
	last := segments[len(segments)-1]
	// A WHATSAPP_GRAPH_URL override with no version segment (an httptest server,
	// a local proxy) falls back to the pinned default: the SDK needs a real
	// version, and "127.0.0.1:53019" is not one.
	if strings.HasPrefix(last, "v") && len(last) > 1 && last[1] >= '0' && last[1] <= '9' {
		return last
	}
	parts := strings.Split(DefaultGraph, "/")
	return parts[len(parts)-1]
}

/* VerifySignature is whether this webhook body really came from Meta.
 *
 * The body must be the EXACT bytes received — the HMAC is over the raw payload,
 * so a handler that decodes JSON first and re-encodes it to check the signature
 * will reject every genuine delivery.
 *
 * False for an empty header rather than true, which matters because the
 * signature is the only thing standing between a public endpoint and anybody
 * able to write messages into a host's inbox.
 */
func (c *Client) VerifySignature(body []byte, header string) bool {
	if c == nil || c.AppSecret == "" {
		return false
	}
	want := strings.TrimSpace(header)
	// Meta sends "sha256=<hex>". Accept the bare hex too: it costs a line and
	// removes a whole class of confusing local-testing failure.
	want = strings.TrimPrefix(want, "sha256=")
	if want == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(c.AppSecret))
	mac.Write(body)
	sum := hex.EncodeToString(mac.Sum(nil))
	// Constant time, so a wrong signature does not leak how much of it was right.
	return hmac.Equal([]byte(sum), []byte(strings.ToLower(want)))
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func (c *Client) base() string {
	if strings.TrimSpace(c.Graph) == "" {
		return strings.TrimRight(DefaultGraph, "/")
	}
	return strings.TrimRight(c.Graph, "/")
}

func (c *Client) get(ctx context.Context, token, path string, dest any) error {
	return c.do(ctx, token, http.MethodGet, path, nil, dest)
}

// mediaIDPattern is Meta's media id: a long decimal string. Anything else is
// refused before it is placed in a URL.
var mediaIDPattern = regexp.MustCompile(`^[0-9]{1,128}$`)

// MediaDownload is the bytes behind a stored media id. The caller closes Body.
type MediaDownload struct {
	Body     io.ReadCloser
	MimeType string
}

/* OpenMedia downloads one WhatsApp attachment.
 *
 * Two requests, both authenticated with the host's token and neither of them
 * visible to the browser. The first asks Graph for a short-lived URL; the second
 * fetches that URL. The URL is only followed when it is https on Meta's media
 * hosts, or on the configured Graph host (so a test server can stand in). The
 * token is never written into the URL.
 */
func (c *Client) OpenMedia(ctx context.Context, token, mediaID string) (*MediaDownload, error) {
	if c == nil {
		return nil, ErrNotConfigured
	}
	if strings.TrimSpace(token) == "" {
		return nil, ErrNotConnected
	}
	id := strings.TrimSpace(mediaID)
	if !mediaIDPattern.MatchString(id) {
		return nil, errors.New("invalid whatsapp media id")
	}
	var meta struct {
		URL      string `json:"url"`
		MimeType string `json:"mime_type"`
	}
	if err := c.get(ctx, token, "/"+url.PathEscape(id), &meta); err != nil {
		return nil, err
	}
	if !c.mediaURLAllowed(meta.URL) {
		return nil, errors.New("whatsapp media url was not on Meta's hosts")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, meta.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	base := c.http()
	client := &http.Client{
		Timeout:   base.Timeout,
		Transport: base.Transport,
		CheckRedirect: func(r *http.Request, _ []*http.Request) error {
			if !c.mediaURLAllowed(r.URL.String()) {
				return errors.New("whatsapp media redirect left Meta's hosts")
			}
			return nil
		},
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		raw, readErr := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		return nil, graphError(raw, res.StatusCode)
	}
	return &MediaDownload{Body: res.Body, MimeType: strings.TrimSpace(meta.MimeType)}, nil
}

func (c *Client) mediaURLAllowed(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme == "https" && metaMediaHost(host) {
		return true
	}
	base, err := url.Parse(c.base())
	if err != nil || base.Host == "" {
		return false
	}
	/* The configured Graph origin, including an httptest server. Host includes
	 * the port, so a second local server on the same machine is not the Graph
	 * host and does not receive the token. Production media bytes live on
	 * lookaside.fbsbx.com, which metaMediaHost already allows. */
	if strings.EqualFold(u.Host, base.Host) && (u.Scheme == "https" || u.Scheme == "http") {
		return true
	}
	return false
}

func metaMediaHost(host string) bool {
	switch host {
	case "lookaside.fbsbx.com", "graph.facebook.com", "facebook.com", "www.facebook.com":
		return true
	}
	return strings.HasSuffix(host, ".fbsbx.com") || strings.HasSuffix(host, ".fbcdn.net") ||
		strings.HasSuffix(host, ".facebook.com")
}

func (c *Client) post(ctx context.Context, token, path string, body, dest any) error {
	return c.do(ctx, token, http.MethodPost, path, body, dest)
}

func (c *Client) do(ctx context.Context, token, method, path string, body, dest any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, rdr)
	if err != nil {
		return err
	}
	// The code exchange authenticates with the app secret in the query string
	// and carries no token, so this is conditional.
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
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
		return graphError(raw, res.StatusCode)
	}
	if dest == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dest)
}

/* graphError turns Meta's error envelope into something a host can act on.
 *
 * Meta's own message is usually the most accurate thing available, so it is
 * preferred over anything invented here — except for code 190, where the
 * message ("Error validating access token") describes the mechanism and not the
 * remedy.
 */
func graphError(raw []byte, status int) error {
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    int    `json:"code"`
			Sub     int    `json:"error_subcode"`
			Trace   string `json:"fbtrace_id"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if parsed.Error.Code == 190 {
		/* Meta's reason is kept, for the log: the subcode says WHY — 458 app removed
		 * from the business, 460 password changed, 463 expired, 467 invalid. The
		 * host is shown only ErrTokenRejected's own sentence (see whatsappAPIError). */
		return fmt.Errorf("%w (meta: %s; subcode %d; fbtrace %s)",
			ErrTokenRejected, strings.TrimSpace(parsed.Error.Message), parsed.Error.Sub, parsed.Error.Trace)
	}
	msg := strings.TrimSpace(parsed.Error.Message)
	if msg == "" {
		return fmt.Errorf("meta graph HTTP %d", status)
	}
	// The trace id is what Meta support asks for first, and it is only ever in
	// this response — worth carrying into the log line.
	if parsed.Error.Trace != "" {
		return fmt.Errorf("meta graph: %s (fbtrace %s)", msg, parsed.Error.Trace)
	}
	return fmt.Errorf("meta graph: %s", msg)
}
