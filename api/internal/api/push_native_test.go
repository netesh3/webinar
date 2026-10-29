package api_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/push"
	"github.com/netkumar/webcast/api/types"
)

/* Native push for the mobile apps (29 Oct 2026): the token endpoints, and delivery through a
 * fake FCM (Google's token endpoint and the v1 send endpoint). */

type fakeFCMService struct {
	srv    *httptest.Server
	mu     sync.Mutex
	sends  []map[string]any
	gone   map[string]bool
	tokens int
}

func newFakeFCMService(t *testing.T) (*fakeFCMService, string) {
	t.Helper()
	f := &fakeFCMService{gone: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.tokens++
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fake-access", "expires_in": 3600})
	})
	mux.HandleFunc("/v1/projects/webinarliv-test/messages:send", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fake-access" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var msg map[string]any
		_ = json.Unmarshal(body, &msg)
		token, _ := msg["message"].(map[string]any)["token"].(string)
		f.mu.Lock()
		f.sends = append(f.sends, msg)
		gone := f.gone[token]
		f.mu.Unlock()
		if gone {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}`)
			return
		}
		_, _ = io.WriteString(w, `{"name":"projects/webinarliv-test/messages/1"}`)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	prev := push.FCMBaseURL
	push.FCMBaseURL = f.srv.URL
	t.Cleanup(func() { push.FCMBaseURL = prev })

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	sa, _ := json.Marshal(map[string]string{
		"type": "service_account", "project_id": "webinarliv-test",
		"private_key":  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})),
		"client_email": "fcm@webinarliv-test.iam.gserviceaccount.com",
		"token_uri":    f.srv.URL + "/token",
	})
	return f, string(sa)
}

func (f *fakeFCMService) sentTo() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.sends {
		out = append(out, m["message"].(map[string]any)["token"].(string))
	}
	return out
}

func fcmToken(name string) string { return "fcm-token-" + name + "-" + strings.Repeat("x", 40) }

func TestNativePushTokenEndpoints(t *testing.T) {
	h := newHarness(t)

	reg := types.NativePushRegisterRequest{Platform: "ios", Token: fcmToken("a"), AppVersion: "1.0 (7)"}
	res, raw := h.do(http.MethodPost, "/api/push/native", reg)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out register: %d %s", res.StatusCode, raw)
	}

	pat := h.signup("Pat", "pat-native@example.com", false)
	res, raw = h.do(http.MethodPost, "/api/push/native", reg)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("register: %d %s", res.StatusCode, raw)
	}
	var out types.NativePushRegisterResponse
	h.decode(raw, &out)
	if out.Sending {
		t.Fatal("sending without FCM_SERVICE_ACCOUNT_JSON")
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE token = $1 AND user_id = $2 AND platform = 'ios' AND app_version = '1.0 (7)'`,
		reg.Token, pat.ID); n != 1 {
		t.Fatal("token not stored for the account")
	}
	// Registering again is the same row.
	h.do(http.MethodPost, "/api/push/native", reg)
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens`); n != 1 {
		t.Fatalf("rows after re-register: %d", n)
	}
	for _, bad := range []types.NativePushRegisterRequest{
		{Platform: "windows", Token: fcmToken("b")},
		{Platform: "android", Token: "short"},
		{Platform: "android", Token: fcmToken("c") + " with spaces"},
	} {
		if res, raw := h.do(http.MethodPost, "/api/push/native", bad); res.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("register %+v: %d %s", bad, res.StatusCode, raw)
		}
	}
	res, raw = h.do(http.MethodGet, "/api/push/preferences", nil)
	var prefs types.PushPreferencesResponse
	h.decode(raw, &prefs)
	if res.StatusCode != http.StatusOK || prefs.Devices != 1 {
		t.Fatalf("preferences: %d %+v", res.StatusCode, prefs)
	}

	// The same install signed in as somebody else moves to them.
	h.logout()
	sam := h.signup("Sam", "sam-native@example.com", false)
	h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "ios", Token: reg.Token})
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE token = $1 AND user_id = $2`, reg.Token, sam.ID); n != 1 {
		t.Fatal("token did not move to the account that registered it last")
	}

	// Only the owner removes it; for anybody else it is a no-op that still says ok.
	h.logout()
	h.signup("Lee", "lee-native@example.com", false)
	if res, raw := h.do(http.MethodDelete, "/api/push/native", types.NativePushUnregisterRequest{Token: reg.Token}); res.StatusCode != http.StatusOK {
		t.Fatalf("unregister by another account: %d %s", res.StatusCode, raw)
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens`); n != 1 {
		t.Fatal("another account removed the token")
	}
	h.logout()
	h.login("sam-native@example.com")
	if res, raw := h.do(http.MethodDelete, "/api/push/native", types.NativePushUnregisterRequest{Token: reg.Token}); res.StatusCode != http.StatusOK {
		t.Fatalf("unregister: %d %s", res.StatusCode, raw)
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens`); n != 0 {
		t.Fatal("unregister left the token")
	}
	h.logout()
	if res, _ := h.do(http.MethodDelete, "/api/push/native", types.NativePushUnregisterRequest{Token: reg.Token}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out unregister: %d", res.StatusCode)
	}
}

func TestNativePushDeliveryThroughFCM(t *testing.T) {
	f, sa := newFakeFCMService(t)
	// FCM only, no VAPID: native push works on its own.
	h := newHarness(t, func(c *config.Config) { c.FCMServiceAccountJSON = sa })

	acct := h.signup("Nat", "nat-native@example.com", false)
	for _, r := range []types.NativePushRegisterRequest{
		{Platform: "android", Token: fcmToken("phone")},
		{Platform: "ios", Token: fcmToken("uninstalled")},
	} {
		res, raw := h.do(http.MethodPost, "/api/push/native", r)
		var out types.NativePushRegisterResponse
		h.decode(raw, &out)
		if res.StatusCode != http.StatusOK || !out.Sending {
			t.Fatalf("register: %d %s", res.StatusCode, raw)
		}
	}
	f.mu.Lock()
	f.gone[fcmToken("uninstalled")] = true
	f.mu.Unlock()

	res, raw := h.do(http.MethodPost, "/api/push/test", nil)
	var queued types.PushTestResponse
	h.decode(raw, &queued)
	if res.StatusCode != http.StatusOK || queued.Queued != 2 {
		t.Fatalf("test push: %d %s", res.StatusCode, raw)
	}
	h.flushPush()

	sent := f.sentTo()
	if len(sent) != 2 {
		t.Fatalf("FCM got %d sends, want 2: %v", len(sent), sent)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_messages m JOIN native_push_tokens t ON t.id = m.native_token_id
		WHERE t.token = $1 AND m.state = 'sent'`, fcmToken("phone")); n != 1 {
		t.Fatal("the live install's message is not marked sent")
	}
	// UNREGISTERED removed the install, and what was queued for it went with it.
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE user_id = $1`, acct.ID); n != 1 {
		t.Fatalf("installs left: %d, want 1", n)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_messages`); n != 1 {
		t.Fatalf("messages left: %d, want 1", n)
	}

	// The tap target is an absolute site URL the app will open.
	f.mu.Lock()
	data := f.sends[0]["message"].(map[string]any)["data"].(map[string]any)
	f.mu.Unlock()
	if data["url"] != "http://localhost:3000/settings#notifications" || data["kind"] != string(types.PushTest) {
		t.Fatalf("data %v", data)
	}

	// Sent once: a second flush sends nothing more.
	h.flushPush()
	if n := len(f.sentTo()); n != 2 {
		t.Fatalf("second flush sent again: %d", n)
	}
}

/* With FCM_PROJECT_ID and no key file (29 Oct 2026), the API sends with the Cloud Run
 * identity's token from the metadata server, which it asks with Metadata-Flavor: Google. */
func TestNativePushDeliveryThroughFCMWithTheMetadataServer(t *testing.T) {
	f, _ := newFakeFCMService(t)
	var mu sync.Mutex
	metaHits := 0
	meta := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Metadata-Flavor") != "Google" ||
			r.URL.Path != "/computeMetadata/v1/instance/service-accounts/default/token" ||
			r.URL.Query().Get("scopes") != push.FCMScope {
			http.Error(w, "bad metadata request", http.StatusForbidden)
			return
		}
		mu.Lock()
		metaHits++
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fake-access", "expires_in": 3599, "token_type": "Bearer"})
	}))
	t.Cleanup(meta.Close)
	prev := push.MetadataBaseURL
	push.MetadataBaseURL = meta.URL
	t.Cleanup(func() { push.MetadataBaseURL = prev })

	h := newHarness(t, func(c *config.Config) { c.FCMProjectID = "webinarliv-test" })
	h.signup("Meta", "meta-native@example.com", false)
	res, raw := h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "android", Token: fcmToken("meta")})
	var out types.NativePushRegisterResponse
	h.decode(raw, &out)
	if res.StatusCode != http.StatusOK || !out.Sending {
		t.Fatalf("register: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/push/test", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("test push: %d %s", res.StatusCode, raw)
	}
	h.flushPush()
	if sent := f.sentTo(); len(sent) != 1 || sent[0] != fcmToken("meta") {
		t.Fatalf("FCM sends %v", sent)
	}
	f.mu.Lock()
	jwtHits := f.tokens
	f.mu.Unlock()
	mu.Lock()
	defer mu.Unlock()
	if metaHits != 1 || jwtHits != 0 {
		t.Fatalf("metadata hits %d, JWT token hits %d", metaHits, jwtHits)
	}
}

// "Starting now" reaches a signed-in registrant's phone through the same fan-out as their
// browsers, with their own join link, once, and not when the account turned the kind off.
func TestNativePushWentLiveFollowsPreferences(t *testing.T) {
	ctx := context.Background()
	f, sa := newFakeFCMService(t)
	h := newHarness(t, func(c *config.Config) { c.FCMServiceAccountJSON = sa })

	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Native live", nil)
	h.logout()

	register := func(name string, optOut bool) string {
		acct := h.signup(name, name+"@example.com", false)
		reg := h.registerAs(wb.ID, name+"@example.com")
		if _, err := h.store.Pool().Exec(ctx, `UPDATE registrations SET user_id = $1 WHERE join_key = $2`, acct.ID, reg.JoinKey); err != nil {
			t.Fatal(err)
		}
		h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "android", Token: fcmToken(name)})
		if optOut {
			h.do(http.MethodPut, "/api/push/preferences", types.PushPreferencesUpdate{
				Preferences: []types.PushPreference{{Kind: types.PushWebinarLive, Enabled: false}},
			})
		}
		h.logout()
		return reg.JoinKey
	}
	key := register("nativeyes", false)
	register("nativeno", true)

	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: %d %s", res.StatusCode, raw)
	}
	h.flushPush()
	sent := f.sentTo()
	if len(sent) != 1 || sent[0] != fcmToken("nativeyes") {
		t.Fatalf("sent to %v, want only the registrant who kept starting-now on", sent)
	}
	f.mu.Lock()
	msg := f.sends[0]["message"].(map[string]any)
	f.mu.Unlock()
	if url := msg["data"].(map[string]any)["url"]; url != "http://localhost:3000/webinars/"+wb.ID+"/room?k="+key {
		t.Fatalf("tap target %v", url)
	}
	if p := msg["android"].(map[string]any)["priority"]; p != "HIGH" {
		t.Fatalf("starting-now priority %v", p)
	}
	// Go live again: deduplicated per install, as per browser.
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	h.flushPush()
	if n := len(f.sentTo()); n != 1 {
		t.Fatalf("starting-now sent %d times", n)
	}
}
