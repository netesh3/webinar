package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

/* The APNs VoIP sender (31 Oct 2026): the key's formats, the config's refusals, the provider
 * JWT, the request against a fake APNs speaking HTTP/2 over TLS, and the answers' outcomes. */

func newP8(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

const (
	testKeyID  = "ABC123DEFG"
	testTeamID = "GF5C6XT5S4"
	testVoIP   = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
)

func TestParseAPNsKeyFormats(t *testing.T) {
	key, p8 := newP8(t)
	block, _ := pem.Decode([]byte(p8))
	for name, raw := range map[string]string{
		"pem":             p8,
		"escaped pem":     strings.ReplaceAll(p8, "\n", `\n`),
		"base64 pem":      base64.StdEncoding.EncodeToString([]byte(p8)),
		"base64 der":      base64.StdEncoding.EncodeToString(block.Bytes),
		"wrapped base64":  "  " + base64.StdEncoding.EncodeToString([]byte(p8)) + "\n",
		"pem with spaces": "\n" + p8 + "\n\n",
	} {
		got, err := ParseAPNsKey(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !got.Equal(key) {
			t.Fatalf("%s: a different key", name)
		}
	}
	if _, err := ParseAPNsKey("not a key"); err == nil {
		t.Fatal("garbage parsed")
	}
	// An RSA key (a Firebase service account's, pasted into the wrong secret) is refused.
	_, rsaPEM := newServiceAccountKey(t)
	if _, err := ParseAPNsKey(rsaPEM); err == nil {
		t.Fatal("an RSA key parsed as an APNs key")
	}
}

func newServiceAccountKey(t *testing.T) (any, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func TestVoIPSenderConfig(t *testing.T) {
	_, p8 := newP8(t)
	if v, err := NewVoIPSenderFromConfig(APNsConfig{}, nil); v != nil || err != nil {
		t.Fatalf("unset: %v %v", v, err)
	}
	for name, cfg := range map[string]APNsConfig{
		"no key":      {KeyID: testKeyID, TeamID: testTeamID},
		"no key id":   {KeyP8: p8, TeamID: testTeamID},
		"no team":     {KeyP8: p8, KeyID: testKeyID},
		"bad key id":  {KeyP8: p8, KeyID: "abc", TeamID: testTeamID},
		"bad team":    {KeyP8: p8, KeyID: testKeyID, TeamID: "team"},
		"bad env":     {KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID, Env: "staging"},
		"bad key":     {KeyP8: "nope", KeyID: testKeyID, TeamID: testTeamID},
		"only env":    {KeyP8: " ", KeyID: testKeyID, TeamID: testTeamID, Env: "sandbox"},
		"only team":   {TeamID: testTeamID},
		"blank parts": {KeyP8: p8, KeyID: "  ", TeamID: testTeamID},
	} {
		if v, err := NewVoIPSenderFromConfig(cfg, nil); err == nil || v != nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	v, err := NewVoIPSenderFromConfig(APNsConfig{KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID}, nil)
	if err != nil || v.Env() != "production" || v.baseURL() != "https://api.push.apple.com" {
		t.Fatalf("default env: %v %+v", err, v)
	}
	v, err = NewVoIPSenderFromConfig(APNsConfig{KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID, Env: "Sandbox"}, nil)
	if err != nil || v.Env() != "sandbox" || v.baseURL() != "https://api.sandbox.push.apple.com" {
		t.Fatalf("sandbox: %v %+v", err, v)
	}
}

func TestVoIPProviderToken(t *testing.T) {
	key, p8 := newP8(t)
	v, err := NewVoIPSenderFromConfig(APNsConfig{KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1_790_000_000, 0)
	v.now = func() time.Time { return clock }
	first, err := v.providerToken()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := jwt.Parse(first, func(tok *jwt.Token) (any, error) {
		if tok.Method != jwt.SigningMethodES256 {
			t.Fatalf("alg %v", tok.Header["alg"])
		}
		return &key.PublicKey, nil
	}, jwt.WithTimeFunc(func() time.Time { return clock }))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if parsed.Header["kid"] != testKeyID {
		t.Fatalf("kid %v", parsed.Header["kid"])
	}
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["iss"] != testTeamID || claims["iat"].(float64) != float64(clock.Unix()) || len(claims) != 2 {
		t.Fatalf("claims %v", claims)
	}
	// The raw R||S signature JOSE wants, not ASN.1: 64 bytes.
	sig, _ := base64.RawURLEncoding.DecodeString(strings.Split(first, ".")[2])
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes", len(sig))
	}
	clock = clock.Add(49 * time.Minute)
	if again, _ := v.providerToken(); again != first {
		t.Fatal("token not reused within 50 minutes")
	}
	clock = clock.Add(2 * time.Minute)
	if again, _ := v.providerToken(); again == first {
		t.Fatal("token reused after 50 minutes")
	}
}

type fakeAPNs struct {
	srv  *httptest.Server
	mu   sync.Mutex
	reqs []*http.Request
	body [][]byte
	// answer by device token: status and reason. Missing is 200.
	answer map[string][2]string
}

func newFakeAPNs(t *testing.T) *fakeAPNs {
	t.Helper()
	f := &fakeAPNs{answer: map[string][2]string{}}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.reqs = append(f.reqs, r)
		f.body = append(f.body, b)
		a, ok := f.answer[strings.TrimPrefix(r.URL.Path, "/3/device/")]
		f.mu.Unlock()
		if r.ProtoMajor != 2 {
			w.WriteHeader(http.StatusHTTPVersionNotSupported)
			return
		}
		w.Header().Set("apns-id", "11111111-2222-3333-4444-555555555555")
		if !ok {
			w.WriteHeader(http.StatusOK)
			return
		}
		status, _ := strconv.Atoi(a[0])
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"reason": a[1]})
	}))
	f.srv.EnableHTTP2 = true
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	prev := APNsProductionURL
	APNsProductionURL = f.srv.URL
	t.Cleanup(func() { APNsProductionURL = prev })
	return f
}

func TestVoIPSendRequest(t *testing.T) {
	f := newFakeAPNs(t)
	key, p8 := newP8(t)
	v, err := NewVoIPSenderFromConfig(APNsConfig{KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID}, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	payload, err := VoIPPayload(map[string]string{
		"type": "incoming_call", "callId": "c1", "callerName": "Pat", "joinUrl": "https://webinarliv.com/m/x",
		"aps": "ignored",
	})
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	res := v.Send(context.Background(), testVoIP, payload, "c1")
	if res.Outcome != Sent || res.Err != nil {
		t.Fatalf("send: %+v", res)
	}
	if len(f.reqs) != 1 {
		t.Fatalf("%d requests", len(f.reqs))
	}
	r := f.reqs[0]
	if r.ProtoMajor != 2 || r.Method != http.MethodPost || r.URL.Path != "/3/device/"+testVoIP {
		t.Fatalf("request %s %s %s", r.Proto, r.Method, r.URL.Path)
	}
	for h, want := range map[string]string{
		"apns-push-type": "voip", "apns-topic": "com.webinarliv.app.voip", "apns-priority": "10",
		"apns-collapse-id": "c1", "content-type": "application/json",
	} {
		if got := r.Header.Get(h); got != want {
			t.Fatalf("%s = %q, want %q", h, got, want)
		}
	}
	exp, _ := strconv.ParseInt(r.Header.Get("apns-expiration"), 10, 64)
	if d := time.Unix(exp, 0).Sub(before); d < 40*time.Second || d > 50*time.Second {
		t.Fatalf("expiration %v from now", d)
	}
	bearer := strings.TrimPrefix(r.Header.Get("authorization"), "bearer ")
	if _, err := jwt.Parse(bearer, func(*jwt.Token) (any, error) { return &key.PublicKey, nil },
		jwt.WithValidMethods([]string{"ES256"})); err != nil {
		t.Fatalf("bearer: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal(f.body[0], &body); err != nil {
		t.Fatal(err)
	}
	if body["type"] != "incoming_call" || body["callId"] != "c1" || body["callerName"] != "Pat" {
		t.Fatalf("body %v", body)
	}
	if aps, ok := body["aps"].(map[string]any); !ok || len(aps) != 0 {
		t.Fatalf("aps %v", body["aps"])
	}
}

func TestVoIPSendOutcomes(t *testing.T) {
	f := newFakeAPNs(t)
	_, p8 := newP8(t)
	v, _ := NewVoIPSenderFromConfig(APNsConfig{KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID}, f.srv.Client())
	tok := func(c string) string { return strings.Repeat(c, 64) }
	f.answer[tok("1")] = [2]string{"410", "Unregistered"}
	f.answer[tok("2")] = [2]string{"400", "BadDeviceToken"}
	f.answer[tok("3")] = [2]string{"400", "DeviceTokenNotForTopic"}
	f.answer[tok("4")] = [2]string{"403", "ExpiredProviderToken"}
	f.answer[tok("5")] = [2]string{"429", "TooManyRequests"}
	f.answer[tok("6")] = [2]string{"503", "ServiceUnavailable"}
	f.answer[tok("7")] = [2]string{"400", "PayloadTooLarge"}
	f.answer[tok("8")] = [2]string{"403", "TopicDisallowed"}
	for c, want := range map[string]Outcome{
		"1": Gone, "2": Gone, "3": Gone, "4": Retry, "5": Retry, "6": Retry, "7": Drop, "8": Drop, "9": Sent,
	} {
		if got := v.Send(context.Background(), tok(c), []byte(`{}`), ""); got.Outcome != want {
			t.Fatalf("token %s: %+v, want %v", c, got, want)
		}
	}
	// A token that is not hex never leaves the server.
	n := len(f.reqs)
	if got := v.Send(context.Background(), "fcm:not-a-voip-token", []byte(`{}`), ""); got.Outcome != Gone {
		t.Fatalf("non-hex: %+v", got)
	}
	if len(f.reqs) != n {
		t.Fatal("a non-hex token was posted")
	}
}

func TestVoIPForgetsRefusedProviderToken(t *testing.T) {
	f := newFakeAPNs(t)
	_, p8 := newP8(t)
	v, _ := NewVoIPSenderFromConfig(APNsConfig{KeyP8: p8, KeyID: testKeyID, TeamID: testTeamID}, f.srv.Client())
	clock := time.Now()
	v.now = func() time.Time { return clock }
	f.answer[testVoIP] = [2]string{"403", "ExpiredProviderToken"}
	v.Send(context.Background(), testVoIP, []byte(`{}`), "")
	first := f.reqs[0].Header.Get("authorization")
	clock = clock.Add(time.Second) // a new iat, so a new signature is a new token
	v.Send(context.Background(), testVoIP, []byte(`{}`), "")
	if f.reqs[1].Header.Get("authorization") == first {
		t.Fatal("the refused provider token was reused")
	}
}

func TestClassifyAPNs(t *testing.T) {
	if r := ClassifyAPNs(200, "", nil); r.Outcome != Sent || r.Err != nil {
		t.Fatalf("200: %+v", r)
	}
	if r := ClassifyAPNs(410, "", []byte(`{"reason":"Unregistered","timestamp":1}`)); r.Outcome != Gone {
		t.Fatalf("410: %+v", r)
	}
	if r := ClassifyAPNs(429, "7", []byte(`{"reason":"TooManyRequests"}`)); r.Outcome != Retry || r.RetryAfter != 7*time.Second {
		t.Fatalf("429: %+v", r)
	}
	if r := ClassifyAPNs(500, "", []byte(`not json`)); r.Outcome != Retry || r.Err == nil {
		t.Fatalf("500: %+v", r)
	}
	if r := ClassifyAPNs(413, "", []byte(`{"reason":"PayloadTooLarge"}`)); r.Outcome != Drop {
		t.Fatalf("413: %+v", r)
	}
}
