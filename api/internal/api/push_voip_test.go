package api_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/push"
	"github.com/netkumar/webcast/api/types"
)

/* iOS VoIP push for incoming calls (31 Oct 2026): ios_voip tokens on POST /api/push/native,
 * kept out of the ordinary fan-outs, and a call rung through a fake APNs over HTTP/2. */

func voipToken(c string) string { return strings.Repeat(c, 64) }

func apnsKeyPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func TestVoIPTokenEndpoint(t *testing.T) {
	h := newHarness(t)
	pat := h.signup("Pat", "pat-voip@example.com", false)

	// Uppercase hex is stored lowercase; sending is off without the APNS_* key.
	res, raw := h.do(http.MethodPost, "/api/push/native",
		types.NativePushRegisterRequest{Platform: "ios_voip", Token: strings.ToUpper(voipToken("a")), AppVersion: "1.1 (9)"})
	var out types.NativePushRegisterResponse
	h.decode(raw, &out)
	if res.StatusCode != http.StatusOK || out.Sending {
		t.Fatalf("register: %d %s", res.StatusCode, raw)
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE token = $1 AND user_id = $2 AND platform = 'ios_voip'`,
		voipToken("a"), pat.ID); n != 1 {
		t.Fatal("voip token not stored, lowercase, for the account")
	}
	// A VoIP token is hex; an FCM token sent as one is refused.
	for _, bad := range []string{fcmToken("x"), "abcd", voipToken("g")} {
		if res, raw := h.do(http.MethodPost, "/api/push/native",
			types.NativePushRegisterRequest{Platform: "ios_voip", Token: bad}); res.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("register %q: %d %s", bad, res.StatusCode, raw)
		}
	}
	// The same phone's FCM token: one device, not two.
	h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "ios", Token: fcmToken("phone")})
	res, raw = h.do(http.MethodGet, "/api/push/preferences", nil)
	var prefs types.PushPreferencesResponse
	h.decode(raw, &prefs)
	if res.StatusCode != http.StatusOK || prefs.Devices != 1 {
		t.Fatalf("preferences: %d %+v", res.StatusCode, prefs)
	}
	// Sign-out removes it like any token.
	if res, raw := h.do(http.MethodDelete, "/api/push/native", types.NativePushUnregisterRequest{Token: voipToken("a")}); res.StatusCode != http.StatusOK {
		t.Fatalf("unregister: %d %s", res.StatusCode, raw)
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE platform = 'ios_voip'`); n != 0 {
		t.Fatal("unregister left the voip token")
	}
}

// The outbox never sends a webinar notification to a VoIP token: PushKit would have to ring it.
func TestVoIPTokensAreLeftOutOfTheFanOut(t *testing.T) {
	f, sa := newFakeFCMService(t)
	h := newHarness(t, func(c *config.Config) { c.FCMServiceAccountJSON = sa })
	h.signup("Ios", "ios-voip-fanout@example.com", false)
	h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "ios", Token: fcmToken("ios")})
	h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "ios_voip", Token: voipToken("b")})

	res, raw := h.do(http.MethodPost, "/api/push/test", nil)
	var queued types.PushTestResponse
	h.decode(raw, &queued)
	if res.StatusCode != http.StatusOK || queued.Queued != 1 {
		t.Fatalf("test push: %d %s", res.StatusCode, raw)
	}
	h.flushPush()
	if sent := f.sentTo(); len(sent) != 1 || sent[0] != fcmToken("ios") {
		t.Fatalf("FCM sends %v", sent)
	}
}

type fakeVoIPAPNs struct {
	srv    *httptest.Server
	mu     sync.Mutex
	paths  []string
	heads  []http.Header
	bodies []map[string]any
	gone   map[string]string // token -> reason
}

func newFakeVoIPAPNs(t *testing.T) *fakeVoIPAPNs {
	t.Helper()
	f := &fakeVoIPAPNs{gone: map[string]string{}}
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 {
			w.WriteHeader(http.StatusHTTPVersionNotSupported)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		tok := strings.TrimPrefix(r.URL.Path, "/3/device/")
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.heads = append(f.heads, r.Header.Clone())
		f.bodies = append(f.bodies, body)
		reason, gone := f.gone[tok]
		f.mu.Unlock()
		if gone {
			status := http.StatusBadRequest
			if reason == "Unregistered" {
				status = http.StatusGone
			}
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"reason": reason})
		}
	}))
	f.srv.EnableHTTP2 = true
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	prev := push.APNsProductionURL
	push.APNsProductionURL = f.srv.URL
	t.Cleanup(func() { push.APNsProductionURL = prev })
	return f
}

func TestVoIPCallRingsThroughAPNs(t *testing.T) {
	f := newFakeVoIPAPNs(t)
	cfg := push.APNsConfig{KeyP8: apnsKeyPEM(t), KeyID: "ABC123DEFG", TeamID: "GF5C6XT5S4", Env: "production"}
	h := newHarness(t, func(c *config.Config) {
		c.APNsKeyP8, c.APNsKeyID, c.APNsTeamID, c.APNsEnv = cfg.KeyP8, cfg.KeyID, cfg.TeamID, cfg.Env
	})
	if !api.VoIPEnabled(h.server) {
		t.Fatal("the APNS_* key did not turn VoIP on")
	}
	v, err := push.NewVoIPSenderFromConfig(cfg, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	api.UseVoIPSender(h.server, v)

	callee := h.signup("Callee", "callee-voip@example.com", false)
	for _, tok := range []string{voipToken("c"), voipToken("d"), voipToken("e")} {
		res, raw := h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "ios_voip", Token: tok})
		var out types.NativePushRegisterResponse
		h.decode(raw, &out)
		if res.StatusCode != http.StatusOK || !out.Sending {
			t.Fatalf("register: %d %s", res.StatusCode, raw)
		}
	}
	// An Android token is not rung through APNs.
	h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "android", Token: fcmToken("droid")})
	f.gone[voipToken("d")] = "Unregistered"
	f.gone[voipToken("e")] = "BadDeviceToken"

	payload := map[string]any{
		"type": "incoming_call", "callId": "4b7e0f57-61d7-4a77-9c1e-0a8f0d8d0c11", "callerName": "Host Person",
		"callerAvatarUrl": nil, "meetingSlug": "abc-defg-hij", "topic": "Quick sync",
		"joinUrl": "/host/abc-defg-hij/room", "expiresAt": "2026-10-31T12:00:45Z",
	}
	raw, _ := json.Marshal(payload)
	api.PushVoIP(h.server, context.Background(), callee.ID, raw)
	h.server.WaitBackground()

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.paths) != 3 {
		t.Fatalf("APNs got %d pushes, want 3: %v", len(f.paths), f.paths)
	}
	for i, hd := range f.heads {
		if hd.Get("apns-push-type") != "voip" || hd.Get("apns-topic") != "com.webinarliv.app.voip" ||
			hd.Get("apns-priority") != "10" || hd.Get("apns-collapse-id") != payload["callId"].(string) ||
			!strings.HasPrefix(hd.Get("authorization"), "bearer ey") {
			t.Fatalf("push %d headers %v", i, hd)
		}
		for k, want := range payload {
			if f.bodies[i][k] != want {
				t.Fatalf("push %d body[%s] = %v, want %v", i, k, f.bodies[i][k], want)
			}
		}
	}
	// Unregistered and BadDeviceToken were deleted; the live one is marked healthy.
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE user_id = $1 AND platform = 'ios_voip'`, callee.ID); n != 1 {
		t.Fatalf("voip tokens left: %d, want 1", n)
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE token = $1 AND last_ok_at IS NOT NULL`, voipToken("c")); n != 1 {
		t.Fatal("the delivered token is not marked ok")
	}
	if n := h.pushCount(`SELECT count(*) FROM native_push_tokens WHERE platform = 'android'`); n != 1 {
		t.Fatal("the android token was touched")
	}
}

func TestVoIPCallIsANoOpWhenOffOrWithoutAnIPhone(t *testing.T) {
	f := newFakeVoIPAPNs(t)
	h := newHarness(t)
	if api.VoIPEnabled(h.server) {
		t.Fatal("VoIP on with no APNS_* key")
	}
	u := h.signup("Off", "off-voip@example.com", false)
	h.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "ios_voip", Token: voipToken("f")})
	api.PushVoIP(h.server, context.Background(), u.ID, json.RawMessage(`{"type":"call_ended","callId":"x","state":"missed"}`))
	h.server.WaitBackground()

	// On, but the account has no iPhone.
	v, err := push.NewVoIPSenderFromConfig(push.APNsConfig{KeyP8: apnsKeyPEM(t), KeyID: "ABC123DEFG", TeamID: "GF5C6XT5S4"}, f.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	api.UseVoIPSender(h.server, v)
	h.logout()
	other := h.signup("NoPhone", "nophone-voip@example.com", false)
	api.PushVoIP(h.server, context.Background(), other.ID, json.RawMessage(`{"type":"incoming_call","callId":"y"}`))
	h.server.WaitBackground()

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.paths) != 0 {
		t.Fatalf("APNs got %v", f.paths)
	}
}

/* A real call, end to end: the iPhone rings through APNs VoIP (the calls API's pushVoIP hook),
 * and its FCM token is left out of the ring so CallKit is not doubled by a banner; Android
 * still gets its data message. The end reaches both. */
func TestACallRingsAnIPhoneThroughVoIPAndNotFCM(t *testing.T) {
	apns := newFakeVoIPAPNs(t)
	fcm, sa := newFakeFCMService(t)
	cfg := push.APNsConfig{KeyP8: apnsKeyPEM(t), KeyID: "ABC123DEFG", TeamID: "GF5C6XT5S4"}
	h := newHarness(t, func(c *config.Config) {
		c.FCMServiceAccountJSON = sa
		c.APNsKeyP8, c.APNsKeyID, c.APNsTeamID = cfg.KeyP8, cfg.KeyID, cfg.TeamID
	})
	v, err := push.NewVoIPSenderFromConfig(cfg, apns.srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	api.UseVoIPSender(h.server, v)

	_, callee, calleeAcct := callPair(t, h)
	for _, r := range []types.NativePushRegisterRequest{
		{Platform: "ios", Token: fcmToken("iphone")},
		{Platform: "ios_voip", Token: voipToken("9")},
		{Platform: "android", Token: fcmToken("pixel")},
	} {
		if res, raw := callee.do(http.MethodPost, "/api/push/native", r); res.StatusCode != http.StatusOK {
			t.Fatalf("register %s: %d %s", r.Platform, res.StatusCode, raw)
		}
	}

	c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusCreated)
	h.flushPush()
	h.server.WaitBackground()

	apns.mu.Lock()
	if len(apns.bodies) != 1 || apns.bodies[0]["type"] != "incoming_call" || apns.bodies[0]["callId"] != c.CallID ||
		apns.paths[0] != "/3/device/"+voipToken("9") || apns.heads[0].Get("apns-collapse-id") != c.CallID {
		t.Fatalf("APNs ring %v %v", apns.paths, apns.bodies)
	}
	apns.mu.Unlock()
	if sent := fcm.sentTo(); len(sent) != 1 || sent[0] != fcmToken("pixel") {
		t.Fatalf("FCM ring went to %v, want only the Android phone", sent)
	}

	callee.callAction(c.CallID, "decline")
	h.flushPush()
	h.server.WaitBackground()
	apns.mu.Lock()
	if len(apns.bodies) != 2 || apns.bodies[1]["type"] != "call_ended" || apns.bodies[1]["state"] != "declined" {
		t.Fatalf("APNs end %v", apns.bodies)
	}
	apns.mu.Unlock()
	if sent := fcm.sentTo(); len(sent) != 3 {
		t.Fatalf("FCM after the end: %v", sent)
	}
}
