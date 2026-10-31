/* iOS VoIP tokens for incoming calls (31 Oct 2026).
 *
 * The iOS app registers with PushKit as well as with Firebase, and hands the API its VoIP token
 * with platform 'ios_voip' on the same POST /api/push/native. It lives beside the install's FCM
 * token, one row per token as before, and is deleted the same ways: on sign-out, and when APNs
 * answers Unregistered or BadDeviceToken (api/internal/api/push_voip.go).
 *
 * A VoIP token is only ever sent a call (api/internal/push/apns_voip.go, straight to APNs). The
 * outbox's fan-outs (store/push.go) leave 'ios_voip' rows out: PushKit requires every push it
 * delivers to ring as a call, and a "webinar starting" reported to CallKit would be wrong.
 */
ALTER TABLE native_push_tokens DROP CONSTRAINT IF EXISTS native_push_tokens_platform_check;
ALTER TABLE native_push_tokens ADD CONSTRAINT native_push_tokens_platform_check
    CHECK (platform IN ('ios', 'android', 'ios_voip'));
CREATE INDEX native_push_tokens_voip_idx ON native_push_tokens (user_id) WHERE platform = 'ios_voip';
