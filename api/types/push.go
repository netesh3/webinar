package types

/* Web Push: the wire contract between the API, the settings page, the opt-in prompts and the
 * service worker (web/public/sw.js). See api/internal/api/push.go. */

// PushKind is why a browser is being woken up. Each is one toggle in Settings → Notifications.
type PushKind string

const (
	// An attendee's webinar went live (host pressed Go live, or a simulive started).
	PushWebinarLive PushKind = "webinar_live"
	// Fifteen minutes before a webinar an attendee registered for.
	PushWebinarReminder PushKind = "webinar_reminder"
	// The replay of a webinar an attendee registered for was published to registrants.
	PushReplayReady PushKind = "replay_ready"
	// A meeting somebody registered for (or was invited to) started.
	PushMeetingStarted PushKind = "meeting_started"
	// Host and co-hosts: somebody knocked at a meeting's lobby while the host is not in it.
	PushLobbyKnock PushKind = "lobby_knock"
	// Host: the AI recap of a session is ready.
	PushRecapReady PushKind = "recap_ready"
	// Host: recordings are about to be deleted (the 7-day and 1-day reminders).
	PushRecordingExpiring PushKind = "recording_expiring"
	// Host: a registration is waiting for approval.
	PushApprovalRequested PushKind = "approval_requested"
	// Admins: an operator alert (the on-demand video server could not start).
	PushOpsAlert PushKind = "ops_alert"
	// "Send test notification" in Settings. Not a preference: it always goes.
	PushTest PushKind = "test"
)

// PushPublicKeyResponse is GET /api/push/public-key. Enabled is false, and PublicKey empty,
// when the deployment has no VAPID keys: the UI then offers nothing push-shaped.
type PushPublicKeyResponse struct {
	Enabled   bool   `json:"enabled"`
	PublicKey string `json:"publicKey"`
}

// PushKeys are a PushSubscription's keys, as PushSubscription.toJSON() gives them.
type PushKeys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

/* PushSubscribeRequest is POST /api/push/subscribe.
 *
 * Signed in, the browser is the account's. With JoinKey, it is (also) scoped to that
 * registration: a guest who registered without an account is told when THAT webinar starts.
 * One of the two is required. */
type PushSubscribeRequest struct {
	Endpoint string   `json:"endpoint"`
	Keys     PushKeys `json:"keys"`
	UA       string   `json:"ua,omitempty"`
	JoinKey  string   `json:"joinKey,omitempty"`
	/* OldEndpoint is set by the service worker's pushsubscriptionchange: the browser's push
	 * service replaced OldEndpoint with Endpoint. Knowing the old one is the credential (only
	 * that browser had it), and the account or registrations it was bound to carry over. */
	OldEndpoint string `json:"oldEndpoint,omitempty"`
}

/* PushUnsubscribeRequest is DELETE /api/push/subscribe. With JoinKey only that registration's
 * link goes; without, the browser stops hearing from this account (signed in) or at all. */
type PushUnsubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	JoinKey  string `json:"joinKey,omitempty"`
}

// PushSubscribeResponse says what the browser is now subscribed as.
type PushSubscribeResponse struct {
	// "account" when bound to the signed-in account, "registration" for a guest, "renewed"
	// when an old endpoint was replaced.
	Scope string `json:"scope"`
}

// PushPreference is one toggle. Host is true for the kinds only a host receives, so an
// attendee's settings can leave them out.
type PushPreference struct {
	Kind    PushKind `json:"kind"`
	Enabled bool     `json:"enabled"`
	Host    bool     `json:"host"`
}

// PushPreferencesResponse is GET /api/push/preferences.
type PushPreferencesResponse struct {
	// Enabled is whether this deployment sends push at all.
	Enabled     bool             `json:"enabled"`
	Preferences []PushPreference `json:"preferences"`
	// Devices is how many browsers this account is subscribed on.
	Devices int `json:"devices"`
}

// PushPreferencesUpdate is PUT /api/push/preferences: the kinds to change.
type PushPreferencesUpdate struct {
	Preferences []PushPreference `json:"preferences"`
}

// PushTestResponse is POST /api/push/test: how many browsers it was queued for.
type PushTestResponse struct {
	Queued int `json:"queued"`
}

/* PushPayload is the JSON a push message carries, decrypted by the browser and read by the
 * service worker's `push` handler. URL is a path on this site; the worker opens it, or focuses
 * a tab already on it, when the notification is clicked. */
type PushPayload struct {
	Kind     PushKind `json:"kind"`
	Title    string   `json:"title"`
	Body     string   `json:"body"`
	URL      string   `json:"url"`
	Tag      string   `json:"tag,omitempty"`
	Renotify bool     `json:"renotify,omitempty"`
	Icon     string   `json:"icon,omitempty"`
	Badge    string   `json:"badge,omitempty"`
}

/* NativePushRegisterRequest is POST /api/push/native (29 Oct 2026): the Android or iOS app
 * hands over its FCM registration token for the signed-in account. Sent after the app gets a
 * token, again on sign-in, and whenever Firebase rotates the token. */
type NativePushRegisterRequest struct {
	// Platform is "ios" or "android".
	Platform string `json:"platform"`
	// Token is the FCM registration token (on iOS too: Firebase maps it to the APNs token).
	Token string `json:"token"`
	// AppVersion is the app's version string, for support. Optional.
	AppVersion string `json:"appVersion,omitempty"`
}

// NativePushUnregisterRequest is DELETE /api/push/native: this install stops hearing from the
// signed-in account. The app sends it just before it signs out.
type NativePushUnregisterRequest struct {
	Token string `json:"token"`
}

// NativePushRegisterResponse says whether this deployment will actually send to the token.
// Sending is off until FCM_SERVICE_ACCOUNT_JSON is set; the token is stored either way.
type NativePushRegisterResponse struct {
	Status  string `json:"status"`
	Sending bool   `json:"sending"`
}
