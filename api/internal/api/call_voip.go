package api

import (
	"context"
	"encoding/json"
)

/* pushVoIP is the iOS VoIP (PushKit / CallKit) half of a call's ring (31 Oct 2026, calls.go).
 *
 * It sends the event straight to APNs as a VoIP push to each of the callee's iPhones
 * (sendVoIPCall in push_voip.go, push/apns_voip.go; 31 Oct 2026), and the app hands it to
 * CallKit (apps/mobile/ios/App/App/CallRingingPlugin.swift). Off without the APNS_* key. The
 * contract:
 *
 *   - called once for every ring, right after the call is placed, with payload the
 *     types.IncomingCallEvent JSON ({"type":"incoming_call","callId":…,"callerName":…,
 *     "callerAvatarUrl":…|null,"meetingSlug":…,"topic":…,"joinUrl":"/host/<slug>/room",
 *     "expiresAt":"RFC3339"});
 *   - called once for every end, with the types.CallEndedEvent JSON ({"type":"call_ended",
 *     "callId":…,"state":"accepted|declined|cancelled|missed"}), so CallKit can end a call
 *     that is still ringing on the phone (reportCall(with:endedAt:reason:));
 *   - payload is exactly what GET /api/me/events sends the callee's open tabs;
 *   - ctx is the request's (or the sweep's): send in the background if it may be slow, and
 *     never fail the caller — errors are logged, not returned.
 *
 * The FCM data message for the same events is queued separately through the push outbox
 * (call_push.go, store.PushMessage.DataOnly), so Android and the iOS alert fallback do not
 * depend on this. */
func (s *Server) pushVoIP(ctx context.Context, calleeUserID string, payload json.RawMessage) {
	s.sendVoIPCall(ctx, calleeUserID, payload)
}
