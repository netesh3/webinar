package push

import (
	"context"
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

// testServiceAccount is a service account key whose token_uri is tokenURI.
func testServiceAccount(t *testing.T, tokenURI string) (string, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]string{
		"type":         "service_account",
		"project_id":   "webinarliv-test",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "fcm@webinarliv-test.iam.gserviceaccount.com",
		"token_uri":    tokenURI,
	})
	return string(raw), key
}

// fakeFCM is Google's token endpoint and FCM's send endpoint.
type fakeFCM struct {
	srv       *httptest.Server
	mu        sync.Mutex
	tokenHits int
	sends     []map[string]any
	auth      []string
	answer    func(token string) (int, string)
	key       *rsa.PrivateKey
	assertion jwt.MapClaims
}

func newFakeFCM(t *testing.T) *fakeFCM {
	t.Helper()
	f := &fakeFCM{answer: func(string) (int, string) { return 200, `{"name":"projects/webinarliv-test/messages/1"}` }}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		defer f.mu.Unlock()
		f.tokenHits++
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			http.Error(w, "grant_type", http.StatusBadRequest)
			return
		}
		claims := jwt.MapClaims{}
		if _, err := jwt.ParseWithClaims(r.Form.Get("assertion"), claims, func(*jwt.Token) (any, error) {
			return &f.key.PublicKey, nil
		}, jwt.WithValidMethods([]string{"RS256"})); err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		f.assertion = claims
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fake-access", "expires_in": 3600})
	})
	mux.HandleFunc("/v1/projects/webinarliv-test/messages:send", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var msg map[string]any
		_ = json.Unmarshal(body, &msg)
		f.mu.Lock()
		f.sends = append(f.sends, msg)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		answer := f.answer
		f.mu.Unlock()
		token, _ := msg["message"].(map[string]any)["token"].(string)
		code, out := answer(token)
		w.WriteHeader(code)
		_, _ = io.WriteString(w, out)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	prev := FCMBaseURL
	FCMBaseURL = f.srv.URL
	t.Cleanup(func() { FCMBaseURL = prev })
	return f
}

func TestParseServiceAccount(t *testing.T) {
	raw, _ := testServiceAccount(t, "https://oauth2.googleapis.com/token")
	sa, key, err := ParseServiceAccount(raw)
	if err != nil || key == nil || sa.ProjectID != "webinarliv-test" {
		t.Fatalf("plain JSON: %+v %v", sa, err)
	}
	// The same, base64 (some secret stores mangle newlines).
	if _, _, err := ParseServiceAccount(base64.StdEncoding.EncodeToString([]byte(raw))); err != nil {
		t.Fatalf("base64 JSON: %v", err)
	}
	for name, bad := range map[string]string{
		"empty":      "",
		"not json":   "%%%",
		"wrong type": `{"type":"authorized_user","project_id":"p","client_email":"e","private_key":"k"}`,
		"bad key":    `{"type":"service_account","project_id":"p","client_email":"e","private_key":"nope"}`,
		"http token": strings.Replace(raw, "https://oauth2.googleapis.com/token", "http://evil.example/token", 1),
	} {
		if _, _, err := ParseServiceAccount(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestClassifyFCM(t *testing.T) {
	fcmErr := func(code int, status, errorCode, msg string) []byte {
		b, _ := json.Marshal(map[string]any{"error": map[string]any{
			"code": code, "status": status, "message": msg,
			"details": []map[string]string{{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": errorCode}},
		}})
		return b
	}
	cases := []struct {
		name   string
		status int
		body   []byte
		want   Outcome
	}{
		{"ok", 200, []byte(`{"name":"x"}`), Sent},
		{"unregistered", 404, fcmErr(404, "NOT_FOUND", "UNREGISTERED", "Requested entity was not found."), Gone},
		{"other project", 403, fcmErr(403, "PERMISSION_DENIED", "SENDER_ID_MISMATCH", "SenderId mismatch"), Gone},
		{"malformed token", 400, fcmErr(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token"), Gone},
		{"bad payload", 400, fcmErr(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", "Invalid value at 'message.android.ttl'"), Drop},
		{"apns key", 401, fcmErr(401, "UNAUTHENTICATED", "THIRD_PARTY_AUTH_ERROR", "Auth error from APNS"), Drop},
		{"our token", 401, []byte(`{"error":{"code":401,"status":"UNAUTHENTICATED"}}`), Retry},
		{"quota", 429, fcmErr(429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "quota"), Retry},
		{"down", 503, fcmErr(503, "UNAVAILABLE", "UNAVAILABLE", "try later"), Retry},
	}
	for _, c := range cases {
		if got := ClassifyFCM(c.status, "", c.body).Outcome; got != c.want {
			t.Errorf("%s: outcome %v, want %v", c.name, got, c.want)
		}
	}
	if r := ClassifyFCM(429, "120", nil); r.RetryAfter != 2*time.Minute {
		t.Errorf("Retry-After: %v", r.RetryAfter)
	}
}

func TestFCMSenderSends(t *testing.T) {
	f := newFakeFCM(t)
	raw, key := testServiceAccount(t, f.srv.URL+"/token")
	f.key = key
	s, err := NewFCMSender(raw, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	msg := NativeMessage{Kind: "webinar_live", Title: "Starting now", Body: "Tap to join.",
		URL: "https://webinarliv.com/webinars/x/room?k=AB", Tag: "webinar-x", TTL: 30 * time.Minute, Urgency: "high"}
	if r := s.Send(ctx, NativeTarget{Token: "tok-1", Platform: "android"}, msg); r.Outcome != Sent {
		t.Fatalf("send: %+v", r)
	}
	if r := s.Send(ctx, NativeTarget{Token: "tok-2", Platform: "ios"}, msg); r.Outcome != Sent {
		t.Fatalf("second send: %+v", r)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tokenHits != 1 {
		t.Fatalf("token endpoint hit %d times, want 1 (cached)", f.tokenHits)
	}
	if f.assertion["iss"] != "fcm@webinarliv-test.iam.gserviceaccount.com" || f.assertion["scope"] != FCMScope ||
		f.assertion["aud"] != f.srv.URL+"/token" {
		t.Fatalf("assertion %v", f.assertion)
	}
	if f.auth[0] != "Bearer fake-access" {
		t.Fatalf("authorization %q", f.auth[0])
	}
	m := f.sends[0]["message"].(map[string]any)
	if m["token"] != "tok-1" {
		t.Fatalf("token %v", m["token"])
	}
	if n := m["notification"].(map[string]any); n["title"] != "Starting now" || n["body"] != "Tap to join." {
		t.Fatalf("notification %v", n)
	}
	if d := m["data"].(map[string]any); d["url"] != msg.URL || d["kind"] != "webinar_live" || d["tag"] != "webinar-x" {
		t.Fatalf("data %v", d)
	}
	if a := m["android"].(map[string]any); a["priority"] != "HIGH" || a["ttl"] != "1800s" {
		t.Fatalf("android %v", a)
	}
	h := m["apns"].(map[string]any)["headers"].(map[string]any)
	if h["apns-priority"] != "10" || h["apns-collapse-id"] != "webinar-x" || h["apns-expiration"] == "0" {
		t.Fatalf("apns headers %v", h)
	}
}

func TestFCMSenderOutcomes(t *testing.T) {
	f := newFakeFCM(t)
	raw, key := testServiceAccount(t, f.srv.URL+"/token")
	f.key = key
	f.answer = func(token string) (int, string) {
		switch token {
		case "gone":
			return 404, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`
		case "expired-access":
			return 401, `{"error":{"code":401,"status":"UNAUTHENTICATED"}}`
		}
		return 200, `{}`
	}
	s, err := NewFCMSender(raw, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	zero := NativeMessage{Title: "t", URL: "https://webinarliv.com/"}
	if r := s.Send(ctx, NativeTarget{Token: "gone"}, zero); r.Outcome != Gone {
		t.Fatalf("unregistered: %+v", r)
	}
	// A 401 is our access token: it is dropped, and the next send fetches a new one.
	if r := s.Send(ctx, NativeTarget{Token: "expired-access"}, zero); r.Outcome != Retry {
		t.Fatalf("401: %+v", r)
	}
	if r := s.Send(ctx, NativeTarget{Token: "fine"}, zero); r.Outcome != Sent {
		t.Fatalf("after 401: %+v", r)
	}
	f.mu.Lock()
	hits := f.tokenHits
	last := f.sends[len(f.sends)-1]["message"].(map[string]any)
	f.mu.Unlock()
	if hits != 2 {
		t.Fatalf("token endpoint hit %d times, want 2 (refetched after the 401)", hits)
	}
	// Zero TTL: deliver now or never, on both platforms.
	if last["android"].(map[string]any)["ttl"] != "0s" ||
		last["apns"].(map[string]any)["headers"].(map[string]any)["apns-expiration"] != "0" {
		t.Fatalf("zero ttl payload %v", last)
	}
}

/* fakeMetadata is the GCE / Cloud Run metadata server's token endpoint (29 Oct 2026). It
 * hands out meta-access-1, meta-access-2, ... and refuses a request without
 * Metadata-Flavor: Google, as the real one does. */
type fakeMetadata struct {
	srv    *httptest.Server
	mu     sync.Mutex
	hits   int
	scopes []string
}

func newFakeMetadata(t *testing.T) *fakeMetadata {
	t.Helper()
	m := &fakeMetadata{}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/computeMetadata/v1/instance/service-accounts/default/token" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Metadata-Flavor") != "Google" {
			http.Error(w, "Missing Metadata-Flavor:Google header.", http.StatusForbidden)
			return
		}
		m.mu.Lock()
		m.hits++
		n := m.hits
		m.scopes = append(m.scopes, r.URL.Query().Get("scopes"))
		m.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "meta-access-" + strconv.Itoa(n), "expires_in": 3599, "token_type": "Bearer"})
	}))
	t.Cleanup(m.srv.Close)
	prev := MetadataBaseURL
	MetadataBaseURL = m.srv.URL
	t.Cleanup(func() { MetadataBaseURL = prev })
	return m
}

func TestFCMMetadataSenderFetchesAndCaches(t *testing.T) {
	f := newFakeFCM(t)
	m := newFakeMetadata(t)
	s, err := NewFCMSenderFromConfig("", "webinarliv-test", nil)
	if err != nil || s == nil {
		t.Fatalf("sender: %v %v", s, err)
	}
	if s.Source() != FCMSourceMetadata || s.ProjectID() != "webinarliv-test" {
		t.Fatalf("source %q project %q", s.Source(), s.ProjectID())
	}
	ctx := context.Background()
	msg := NativeMessage{Title: "t", URL: "https://webinarliv.com/"}
	for _, tok := range []string{"tok-1", "tok-2"} {
		if r := s.Send(ctx, NativeTarget{Token: tok, Platform: "android"}, msg); r.Outcome != Sent {
			t.Fatalf("send %s: %+v", tok, r)
		}
	}
	m.mu.Lock()
	hits, scopes := m.hits, m.scopes
	m.mu.Unlock()
	if hits != 1 {
		t.Fatalf("metadata server hit %d times, want 1 (cached)", hits)
	}
	if scopes[0] != FCMScope {
		t.Fatalf("scopes %q", scopes[0])
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tokenHits != 0 {
		t.Fatal("the JWT token endpoint was used")
	}
	if f.auth[0] != "Bearer meta-access-1" || f.auth[1] != "Bearer meta-access-1" {
		t.Fatalf("authorization %v", f.auth)
	}
}

func TestFCMMetadataSenderSendsTheFlavorHeader(t *testing.T) {
	m := newFakeMetadata(t)
	// The fake refuses a request without the header, so a token back means the sender sent it.
	res, err := http.Get(m.srv.URL + "/computeMetadata/v1/instance/service-accounts/default/token")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("headerless request answered %d", res.StatusCode)
	}
	s, _ := NewFCMMetadataSender("webinarliv-test", nil)
	if tok, err := s.accessToken(context.Background()); err != nil || tok != "meta-access-1" {
		t.Fatalf("token %q %v", tok, err)
	}
}

func TestFCMMetadataSenderRefreshesAnExpiredToken(t *testing.T) {
	m := newFakeMetadata(t)
	s, err := NewFCMMetadataSender("webinarliv-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, err := s.accessToken(ctx)
	if err != nil || first != "meta-access-1" {
		t.Fatalf("first %q %v", first, err)
	}
	// Cached until a minute before expires_in.
	if until := time.Until(s.expires); until < 3530*time.Second || until > 3540*time.Second {
		t.Fatalf("cached for %v, want about 3539s", until)
	}
	if again, _ := s.accessToken(ctx); again != first {
		t.Fatalf("not cached: %q", again)
	}
	s.mu.Lock()
	s.expires = time.Now().Add(-time.Second)
	s.mu.Unlock()
	second, err := s.accessToken(ctx)
	if err != nil || second != "meta-access-2" {
		t.Fatalf("after expiry %q %v", second, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.hits != 2 {
		t.Fatalf("metadata server hit %d times, want 2", m.hits)
	}
}

func TestFCMSenderFromConfigPrefersTheJSON(t *testing.T) {
	f := newFakeFCM(t)
	m := newFakeMetadata(t)
	raw, key := testServiceAccount(t, f.srv.URL+"/token")
	f.key = key
	s, err := NewFCMSenderFromConfig(raw, "some-other-project", f.srv.Client())
	if err != nil || s == nil {
		t.Fatalf("sender: %v %v", s, err)
	}
	if s.Source() != FCMSourceServiceAccount || s.ProjectID() != "webinarliv-test" {
		t.Fatalf("source %q project %q", s.Source(), s.ProjectID())
	}
	if r := s.Send(context.Background(), NativeTarget{Token: "tok-1"}, NativeMessage{Title: "t", URL: "https://webinarliv.com/"}); r.Outcome != Sent {
		t.Fatalf("send: %+v", r)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.hits != 0 {
		t.Fatal("the metadata server was used although the JSON is set")
	}
	// A JSON that does not parse is an error, not a quiet switch to the metadata server.
	if s, err := NewFCMSenderFromConfig("%%%", "webinarliv-test", nil); err == nil || s != nil {
		t.Fatalf("bad JSON: %v %v", s, err)
	}
}

func TestFCMSenderFromConfigOff(t *testing.T) {
	for _, c := range [][2]string{{"", ""}, {"  ", " \n"}} {
		if s, err := NewFCMSenderFromConfig(c[0], c[1], nil); s != nil || err != nil {
			t.Fatalf("%q: %v %v, want off", c, s, err)
		}
	}
}
