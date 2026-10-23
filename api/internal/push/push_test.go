package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestValidEndpoint(t *testing.T) {
	ok := []string{
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/abc",
		"https://web.push.apple.com/QH0abc",
		"https://wns2-par02p.notify.windows.com/w/?token=abc",
	}
	for _, e := range ok {
		if err := ValidEndpoint(e); err != nil {
			t.Errorf("%s refused: %v", e, err)
		}
	}
	bad := []string{
		"",
		"http://fcm.googleapis.com/fcm/send/abc",       // not https
		"https://fcm.googleapis.com.evil.test/x",       // suffix trick
		"https://evilfcm.googleapis.com.test/x",        // not a subdomain
		"https://169.254.169.254/latest/meta-data",     // metadata server
		"https://localhost/x",                          // loopback
		"https://user:pw@fcm.googleapis.com/fcm/send/", // credentials
		"https://fcm.googleapis.com:8443/fcm/send/abc", // odd port
		"https://notapple.com/x",
	}
	for _, e := range bad {
		if err := ValidEndpoint(e); err == nil {
			t.Errorf("%s accepted", e)
		}
	}
}

func browserKeys(t *testing.T) (string, string) {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	return base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(auth)
}

func TestValidKeys(t *testing.T) {
	p, a := browserKeys(t)
	if err := ValidKeys(p, a); err != nil {
		t.Fatalf("real keys refused: %v", err)
	}
	if ValidKeys("AAAA", a) == nil {
		t.Error("short p256dh accepted")
	}
	if ValidKeys(p, "AAAA") == nil {
		t.Error("short auth accepted")
	}
}

func TestConfigValidate(t *testing.T) {
	if err := (Config{}).Validate(); err != nil {
		t.Fatalf("empty config is off, not invalid: %v", err)
	}
	if (Config{}).Enabled() {
		t.Fatal("empty config enabled")
	}
	pub, priv, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	good := Config{PublicKey: pub, PrivateKey: priv, Subject: "mailto:ops@example.com"}
	if err := good.Validate(); err != nil || !good.Enabled() {
		t.Fatalf("good config: %v", err)
	}
	if err := (Config{PublicKey: pub}).Validate(); err == nil {
		t.Error("partial config accepted")
	}
	pub2, _, _ := GenerateKeys()
	if err := (Config{PublicKey: pub2, PrivateKey: priv, Subject: "mailto:a@b"}).Validate(); err == nil {
		t.Error("mismatched pair accepted")
	}
	if err := (Config{PublicKey: pub, PrivateKey: priv, Subject: "ops@example.com"}).Validate(); err == nil {
		t.Error("subject without scheme accepted")
	}
}

func TestClassifyAndBackoff(t *testing.T) {
	cases := map[int]Outcome{201: Sent, 200: Sent, 404: Gone, 410: Gone, 429: Retry, 500: Retry, 503: Retry, 400: Drop, 413: Drop, 403: Drop}
	for status, want := range cases {
		if got := Classify(status, "", nil).Outcome; got != want {
			t.Errorf("%d: got %v want %v", status, got, want)
		}
	}
	if r := Classify(429, "120", nil); r.RetryAfter != 2*time.Minute {
		t.Errorf("retry-after: %v", r.RetryAfter)
	}
	if Backoff(1, 0) != 30*time.Second || Backoff(2, 0) != time.Minute || Backoff(30, 0) != time.Hour {
		t.Errorf("backoff curve: %v %v %v", Backoff(1, 0), Backoff(2, 0), Backoff(30, 0))
	}
	if Backoff(1, 10*time.Minute) != 10*time.Minute {
		t.Error("retry-after not honoured")
	}
}

// The request a push service receives: encrypted body, VAPID auth, TTL and Urgency headers.
func TestSendHeaders(t *testing.T) {
	var got *http.Request
	var n int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		n = r.ContentLength
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	pub, priv, _ := GenerateKeys()
	s := NewSender(Config{PublicKey: pub, PrivateKey: priv, Subject: "mailto:ops@example.com"}, srv.Client())
	p, a := browserKeys(t)
	res := s.Send(context.Background(), Target{Endpoint: srv.URL + "/push/1", P256dh: p, Auth: a},
		Message{Payload: []byte(`{"title":"hi"}`), TTL: 90 * time.Second, Urgency: "high"})
	if res.Outcome != Sent || res.Err != nil {
		t.Fatalf("send: %+v", res)
	}
	if got.Header.Get("Content-Encoding") != "aes128gcm" || got.Header.Get("TTL") != "90" || got.Header.Get("Urgency") != "high" {
		t.Errorf("headers: %v", got.Header)
	}
	if !strings.HasPrefix(got.Header.Get("Authorization"), "vapid t=") || !strings.Contains(got.Header.Get("Authorization"), "k="+pub) {
		t.Errorf("authorization: %q", got.Header.Get("Authorization"))
	}
	if n <= 0 {
		t.Error("empty body")
	}
}
