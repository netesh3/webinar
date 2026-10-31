package types

/* Calling (31 Oct 2026): a host rings another Webinar Liv account into a meeting. The wire
 * contract between the API (api/internal/api/calls.go), the web app's incoming-call card and
 * service worker, and the mobile apps' native ringing. docs/calling.md is the reference. */

// CallState is where a call is. Every call starts ringing and ends in exactly one of the
// other four; a transition is only ever out of ringing.
type CallState string

const (
	CallRinging   CallState = "ringing"
	CallAccepted  CallState = "accepted"
	CallDeclined  CallState = "declined"
	CallCancelled CallState = "cancelled"
	// CallMissed is a call nobody answered within CallRingSeconds.
	CallMissed CallState = "missed"
)

// CallRingSeconds is how long a call rings before it is missed.
const CallRingSeconds = 45

// The "type" of a call event: the realtime event, the web push data and the FCM data.
const (
	CallEventIncoming = "incoming_call"
	CallEventEnded    = "call_ended"
)

/* StartCallRequest is POST /api/calls. Without MeetingSlug the API creates an instant meeting
 * for the call; with one, the caller must host (or co-host) that meeting. */
type StartCallRequest struct {
	CalleeUserID string `json:"calleeUserId"`
	MeetingSlug  string `json:"meetingSlug,omitempty"`
}

// StartCallResponse is the call just placed, ringing until ExpiresAt.
type StartCallResponse struct {
	CallID      string `json:"callId"`
	MeetingSlug string `json:"meetingSlug"`
	// JoinURL is the callee's way in (a path on the site), the same one the ring carries.
	JoinURL string `json:"joinUrl"`
	// ExpiresAt is RFC3339: when the call stops ringing and is missed.
	ExpiresAt string `json:"expiresAt"`
	// MeetingCreated is true when the API made an instant meeting for this call. The caller
	// starts it (POST /api/host/webinars/{slug}/start) and opens its room.
	MeetingCreated bool `json:"meetingCreated"`
}

// Call is GET /api/calls/{id}, and the answer to accept, decline and cancel.
type Call struct {
	CallID      string    `json:"callId"`
	State       CallState `json:"state"`
	MeetingSlug string    `json:"meetingSlug"`
	Topic       string    `json:"topic"`
	// JoinURL is the callee's personal way into the meeting (a path on the site).
	JoinURL   string `json:"joinUrl"`
	ExpiresAt string `json:"expiresAt"`
	// CallerName and CalleeName are display names, never addresses.
	CallerName string `json:"callerName"`
	CalleeName string `json:"calleeName"`
	// Role is the asker's side of the call: "caller" or "callee".
	Role string `json:"role"`
}

/* CallConflict is the 409 of accept, decline or cancel on a call that already ended another
 * way: an APIError ("call_ended") with the call as it now stands. */
type CallConflict struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Call    Call   `json:"call"`
}

/* IncomingCallEvent rings the callee: the realtime event on GET /api/me/events, the web push's
 * data and the FCM data message, the same fields everywhere. Type is CallEventIncoming. */
type IncomingCallEvent struct {
	Type       string `json:"type"`
	CallID     string `json:"callId"`
	CallerName string `json:"callerName"`
	// CallerAvatarURL is the caller's photo when it is a public URL, else null.
	CallerAvatarURL *string `json:"callerAvatarUrl" tstype:"string | null,required"`
	MeetingSlug     string  `json:"meetingSlug"`
	Topic           string  `json:"topic"`
	// JoinURL is a path on the site ("/host/<slug>/room").
	JoinURL string `json:"joinUrl"`
	// ExpiresAt is RFC3339.
	ExpiresAt string `json:"expiresAt"`
}

/* CallEndedEvent stops the ringing on the callee's other devices and tells the caller how it
 * went. Type is CallEventEnded; State is accepted, declined, cancelled or missed. */
type CallEndedEvent struct {
	Type   string    `json:"type"`
	CallID string    `json:"callId"`
	State  CallState `json:"state"`
}

/* Contact is somebody the host may call (GET /api/contacts?q=): never an address, except the
 * one the host typed in full, which is echoed back so the row can say what matched. */
type Contact struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Initials  string `json:"initials"`
	Hue       string `json:"hue"`
	// Email is set only on an exact address match, and is the address the host typed.
	Email string `json:"email,omitempty"`
}

// ContactsResponse is GET /api/contacts.
type ContactsResponse struct {
	Contacts []Contact `json:"contacts"`
}
