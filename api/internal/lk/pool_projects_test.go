package lk

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/netkumar/webcast/api/internal/config"
)

/* A webhook from any configured project verifies — including a second one and a disabled
 * one — because each project's server signs with its own key and all of them post to the
 * same /api/webhooks/livekit. */
func TestWebhooksFromEveryProjectVerify(t *testing.T) {
	pool := NewPool([]config.LiveKitProject{
		{ID: "default", URL: "wss://a.example.com", HTTPURL: "https://a.example.com", Key: "APIdefault", Secret: "secret-default-0123456789abcdef", Disabled: true},
		{ID: "second", URL: "wss://b.example.com", HTTPURL: "https://b.example.com", Key: "APIsecond", Secret: "secret-second-0123456789abcdef"},
	}, time.Hour)

	for _, signer := range []struct{ key, secret string }{
		{"APIdefault", "secret-default-0123456789abcdef"},
		{"APIsecond", "secret-second-0123456789abcdef"},
	} {
		body, err := protojson.Marshal(&livekit.WebhookEvent{Event: "room_finished", Room: &livekit.Room{Name: "webinar_x"}})
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		token, err := auth.NewAccessToken(signer.key, signer.secret).
			SetValidFor(time.Minute).
			SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
			ToJWT()
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/api/webhooks/livekit", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/webhook+json")
		req.Header.Set("Authorization", token)
		if _, err := webhook.ReceiveWebhookEvent(req, pool); err != nil {
			t.Errorf("webhook signed by %s did not verify: %v", signer.key, err)
		}
	}

	// And a key no project has is refused.
	body := []byte(`{"event":"room_finished"}`)
	sum := sha256.Sum256(body)
	token, _ := auth.NewAccessToken("APIstranger", "secret-stranger-0123456789abcd").
		SetValidFor(time.Minute).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	req := httptest.NewRequest("POST", "/api/webhooks/livekit", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/webhook+json")
	req.Header.Set("Authorization", token)
	if _, err := webhook.ReceiveWebhookEvent(req, pool); err == nil {
		t.Error("a webhook signed by an unknown key verified")
	}
}
