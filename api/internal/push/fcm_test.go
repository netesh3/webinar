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
