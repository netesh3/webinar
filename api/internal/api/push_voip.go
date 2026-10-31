package api

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/push"
)

/* iOS VoIP push: ringing the iOS app for an incoming call (31 Oct 2026).
 *
 * The iOS app registers a PushKit token beside its FCM token: POST /api/push/native with
 * platform "ios_voip" (apps/mobile/ios/App/App/CallRingingPlugin.swift hands it to the page,
 * web/lib/native-bridge.ts posts it). A call to an account sends every one of its VoIP tokens
 * the call's JSON straight through APNs (push/apns_voip.go), and the app reports it to CallKit,
 * which rings like a phone call even when the app was killed. Android rings from an FCM data
 * message instead (apps/mobile/android/.../CallMessagingService.java); that is the FCM path.
 *
 * The hook is pushVoIP (call_voip.go), which the calls API (calls.go) calls once per ring with
 * the types.IncomingCallEvent JSON and once per end with the types.CallEndedEvent JSON; it hands
 * both to sendVoIPCall. The FCM message for the same events (call_push.go) skips an iPhone
 * account that has a VoIP token (store.PushMessage.SkipIOSWithVoIP), so CallKit's ring is not
 * doubled by an "is calling" banner.
 *
 * Off without APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID: s.voip is nil, the boot log says so
 * once, ios_voip tokens are still stored, and sendVoIPCall does nothing. A token APNs reports
 * as Unregistered, BadDeviceToken or DeviceTokenNotForTopic is deleted. Nothing is queued or
 * retried: a call that does not ring within a few seconds has been given up on by the caller. */

// voipPlatform is native_push_tokens.platform for an iOS PushKit token (migrations/0177).
const voipPlatform = "ios_voip"

// voipSendBudget bounds one call's sends to all of an account's iPhones.
const voipSendBudget = 15 * time.Second

func newVoIPSender(s *Server) {
	v, err := push.NewVoIPSenderFromConfig(s.cfg.APNsVoIP(), nil)
	switch {
	case err != nil:
		s.log.Error("voip push off: the APNS_* key is not usable", "error", err)
	case v == nil:
		s.log.Info("voip push off: APNS_KEY_P8, APNS_KEY_ID and APNS_TEAM_ID are not set; iOS calls will not ring")
	default:
		s.voip = v
		s.log.Info("voip push enabled", "apns_env", v.Env(), "key_id", v.KeyID(), "topic", push.APNsVoIPTopic)
	}
}

var voipTokenHex = regexp.MustCompile(`^[0-9a-f]{32,200}$`)

// normalizeVoIPToken is a PushKit token as stored: lowercase hex, or "" when it is not one.
func normalizeVoIPToken(token string) string {
	token = strings.ToLower(strings.TrimSpace(token))
	if !voipTokenHex.MatchString(token) {
		return ""
	}
	return token
}

/* sendVoIPCall rings (or, for call_ended, stops ringing) the account's iPhones. The tokens are
 * read with ctx; the sends run after it returns (inBackground), so the caller is never held up
 * by APNs, and nothing fails it: errors are logged. No-op when VoIP is off or the account has
 * no iPhone. */
func (s *Server) sendVoIPCall(ctx context.Context, userID string, payload json.RawMessage) {
	if s.voip == nil || userID == "" {
		return
	}
	body, callID, err := push.VoIPPayload(payload)
	if err != nil {
		s.log.Error("voip push: payload", "error", err)
		return
	}
	tokens, err := s.store.NativeVoIPTokens(ctx, userID)
	if err != nil {
		s.log.Error("voip push: tokens", "error", err)
		return
	}
	if len(tokens) == 0 {
		return
	}
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(payload, &head)
	s.inBackground(func(bg context.Context) {
		bg, cancel := context.WithTimeout(bg, voipSendBudget)
		defer cancel()
		var wg sync.WaitGroup
		for _, t := range tokens {
			wg.Add(1)
			go func() {
				defer wg.Done()
				res := s.voip.Send(bg, t.Token, body, callID)
				switch res.Outcome {
				case push.Sent:
					if err := s.store.NativeVoIPSent(bg, t.ID); err != nil {
						s.log.Error("voip push: record sent", "error", err)
					}
				case push.Gone:
					s.log.Info("voip push: token gone, removing", "status", res.Status, "error", res.Err)
					if err := s.store.NativePushGone(bg, t.ID); err != nil {
						s.log.Error("voip push: remove gone", "error", err)
					}
				default:
					s.log.Warn("voip push: not delivered", "type", head.Type, "call", callID,
						"status", res.Status, "error", res.Err)
				}
			}()
		}
		wg.Wait()
	})
}
