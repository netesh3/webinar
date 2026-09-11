// Package types holds the HTTP wire contract.
//
// This package is the single source of truth for the shapes the frontend sees.
// `make types` runs tygo over it to regenerate web/lib/api-types.ts, so a field
// rename here becomes a TypeScript compile error there instead of a runtime
// surprise during a live webinar.
//
// Keep these boring: scalars, slices, maps and other types from this package.
// No interfaces, no generics, no embedded structs from other packages.
package types

import "strings"

// Role decides what a participant may do inside a room. This is the entire
// difference between a webinar and a meeting.
type Role string

const (
	RoleHost     Role = "host"
	RolePanelist Role = "panelist"
	RoleAttendee Role = "attendee"
)

type WebinarStatus string

const (
	StatusScheduled WebinarStatus = "scheduled"
	StatusLive      WebinarStatus = "live"
	StatusEnded     WebinarStatus = "ended"
	StatusDraft     WebinarStatus = "draft"
)

type WebinarKind string

const (
	KindLive      WebinarKind = "live"
	KindSimulive  WebinarKind = "simulive"
	KindRecurring WebinarKind = "recurring"
)

type ApprovalMode string

const (
	ApprovalAutomatic ApprovalMode = "automatic"
	ApprovalManual    ApprovalMode = "manual"
)

type RegistrationState string

const (
	RegApproved RegistrationState = "approved"
	RegPending  RegistrationState = "pending"
	RegDeclined RegistrationState = "declined"
)

// Decidable reports whether a host may set a registration to this state.
//
// Approving and declining are host decisions; putting somebody BACK to pending is one too,
// because a host who declines by accident needs an undo that is not "approve them instead".
// Anything else is a client sending a state this server does not have.
func (s RegistrationState) Decidable() bool {
	switch s {
	case RegApproved, RegDeclined, RegPending:
		return true
	}
	return false
}

// NotificationKind is why somebody is being told something.
type NotificationKind string

const (
	// NotifyApprovalRequested goes to the HOST: somebody is waiting for a decision.
	NotifyApprovalRequested NotificationKind = "approval_requested"
	// NotifyRegistrationApproved goes to the REGISTRANT, with their join link.
	NotifyRegistrationApproved NotificationKind = "registration_approved"
	// NotifyRegistrationDeclined goes to the REGISTRANT. Sent rather than silently
	// dropped: somebody who registered and hears nothing assumes they are coming.
	NotifyRegistrationDeclined NotificationKind = "registration_declined"
)

/* HostAlert is one in-app notification as a host's browser sees it.
 *
 * Carries the webinar's slug and topic rather than only an id, so the panel can render a
 * sentence and a link without a second request per row — a host with twenty alerts would
 * otherwise make twenty calls to find out what they were about.
 */
type HostAlert struct {
	ID        string           `json:"id"`
	Kind      NotificationKind `json:"kind"`
	WebinarID string           `json:"webinarId"` // slug, empty if the webinar is gone
	Topic     string           `json:"topic"`
	Subject   string           `json:"subject"`
	Body      string           `json:"body"`
	Unread    bool             `json:"unread"`
	CreatedAt string           `json:"createdAt"`
}

// AlertsResponse is the notification panel's payload: the rows plus the badge count,
// so opening the panel does not need a second request to know what the bell said.
type AlertsResponse struct {
	Alerts []HostAlert `json:"alerts"`
	Unread int         `json:"unread"`
}

/* ApprovalsRequest is the batch decision: a set of registrations and one state for all of them.
 *
 * IDs rather than "everyone pending" because a host reviewing forty strangers approves some and
 * declines others, and an all-or-nothing endpoint makes them do it one request at a time. An
 * empty list is accepted and changes nothing, which is what a host who pressed the button with
 * no rows ticked meant.
 */
type ApprovalsRequest struct {
	IDs   []string          `json:"ids"`
	State RegistrationState `json:"state"`
}

// ApprovalsResponse reports what actually changed, not what was asked for. The two differ
// when a row was already in the target state, or belonged to another webinar.
type ApprovalsResponse struct {
	Changed  int             `json:"changed"`
	Notified int             `json:"notified"`
	Rows     []RegistrantRow `json:"rows"`
}

type Person struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Org      string `json:"org"`
	Initials string `json:"initials"`
	Hue      string `json:"hue"`
}

type AgendaItem struct {
	At     string `json:"at"`
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
}

type CustomQuestion struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Type     string   `json:"type"` // short | select | checkbox
	Required bool     `json:"required"`
	Options  []string `json:"options,omitempty"`
}

// WebinarOptions are the things a host decides while scheduling.
type WebinarOptions struct {
	PracticeSession bool `json:"practiceSession"`
	AutoRecord      bool `json:"autoRecord"`
	QAndA           bool `json:"qAndA"`
	// Polls used to be here, as a checkbox on the scheduling form. It is now
	// PollsEnabled in SessionControls: whether to poll the room is a decision made
	// during the session, next to chat and Q&A, and a host who ticked a box a week
	// earlier still had to be able to change their mind. Old rows keep a stray
	// "polls" key in their options JSON, which unmarshalling ignores.
	AttendeeChat      bool `json:"attendeeChat"`
	RaiseHand         bool `json:"raiseHand"`
	Captions          bool `json:"captions"`
	Multistream       bool `json:"multistream"`
	PostWebinarSurvey bool `json:"postWebinarSurvey"`
}

// SessionControls are the things a host flips *during* the session.
//
// These live in Postgres rather than in a server's memory: a control has to
// survive an API restart and it has to apply to someone who joins ten minutes
// after it was set. "Attendees are hidden" is a property of the session.
//
// They are also mirrored into LiveKit room metadata on every change, which is
// how 500 browsers learn about a toggle without polling.
type SessionControls struct {
	// HideAttendees is enforced at the SFU: attendee tokens are minted with
	// hidden=true, so an attendee is invisible to every other client rather
	// than merely filtered out of a list by our own JavaScript.
	HideAttendees    bool `json:"hideAttendees"`
	MuteOnEntry      bool `json:"muteOnEntry"`
	AllowUnmute      bool `json:"allowUnmute"`
	ChatEnabled      bool `json:"chatEnabled"`
	QAEnabled        bool `json:"qaEnabled"`
	RaiseHandEnabled bool `json:"raiseHandEnabled"`
	ReactionsEnabled bool `json:"reactionsEnabled"`
	// PollsEnabled decides whether the audience can be polled. Off hides the panel
	// for them entirely; the host still sees theirs, because writing the questions
	// is what you do before turning it on.
	PollsEnabled bool `json:"pollsEnabled"`
	Locked       bool `json:"locked"`

	// ChatDestination decides where an ATTENDEE's chat goes: to the whole room, or
	// to the stage only. The host owns it, which is the point — an attendee picking
	// their own audience is the thing this prevents.
	//
	// It is a control rather than a per-message field so that it is one
	// authoritative value: set by the host through PATCH /controls, stored, and
	// mirrored into SFU room metadata, which is how 500 browsers learn about the
	// change without polling. Messages still carry the destination they were sent
	// with, so switching the setting never rewrites history.
	ChatDestination ChatDestination `json:"chatDestination"`
}

// ChatDestination is the audience for a chat message.
type ChatDestination string

const (
	ChatToEveryone  ChatDestination = "everyone"
	ChatToPanelists ChatDestination = "panelists"
)

// Valid reports whether d is a destination this server recognises. Anything else
// is refused rather than coerced: silently turning a typo into "everyone" would
// widen an audience the host meant to narrow.
func (d ChatDestination) Valid() bool {
	return d == ChatToEveryone || d == ChatToPanelists
}

// OrDefault fills in the default for a destination that was never set.
//
// Only for whole-record writes, where an omitted field is the empty string and
// means "no opinion" — a schedule form from an older build, say. A PATCH that
// names the field explicitly is checked with Valid and refused, because there
// the difference between "absent" and "wrong" is the whole point.
func (d ChatDestination) OrDefault() ChatDestination {
	if d.Valid() {
		return d
	}
	return ChatToEveryone
}

// ControlsPatch updates a subset of the controls. Pointers so that "not
// mentioned" and "set to false" are different requests.
type ControlsPatch struct {
	HideAttendees    *bool `json:"hideAttendees,omitempty"`
	MuteOnEntry      *bool `json:"muteOnEntry,omitempty"`
	AllowUnmute      *bool `json:"allowUnmute,omitempty"`
	ChatEnabled      *bool `json:"chatEnabled,omitempty"`
	QAEnabled        *bool `json:"qaEnabled,omitempty"`
	RaiseHandEnabled *bool `json:"raiseHandEnabled,omitempty"`
	ReactionsEnabled *bool `json:"reactionsEnabled,omitempty"`
	PollsEnabled     *bool `json:"pollsEnabled,omitempty"`
	Locked           *bool `json:"locked,omitempty"`
	// A pointer for the same reason as the others: "not mentioned" and "set to
	// everyone" are different requests.
	ChatDestination *ChatDestination `json:"chatDestination,omitempty"`
}

// ------------------------------------------------------------------- polls

// PollKind separates a poll from a quiz.
//
// A quiz is a poll with a right answer. Same question, same options, same voting
// and same tally — the only differences are that a quiz records which option is
// correct and withholds it until voting closes.
type PollKind string

const (
	PollOpinion  PollKind = "poll"
	PollQuizKind PollKind = "quiz"
)

func (k PollKind) Valid() bool { return k == PollOpinion || k == PollQuizKind }

type PollState string

const (
	// PollDraft is written but never shown to the audience.
	PollDraft PollState = "draft"
	// PollOpen is accepting votes. Only one poll per webinar may be open.
	PollOpen PollState = "open"
	// PollClosed is final: the tally cannot change and a quiz answer is revealed.
	PollClosed PollState = "closed"
)

// Poll is one question, as the caller is allowed to see it.
//
// "As the caller is allowed to see it" is the important part, and it is the whole
// reason there are two endpoints rather than one:
//
//	the stage     the tally, the running total, and the correct answer to a quiz.
//	the audience  the question and the options. Nothing else.
//
// The audience gets no numbers at all — not a per-option count, not a percentage,
// not even how many people have answered. A live tally is a nudge: someone who has
// not voted yet can see which way the room is going, and the answers stop being
// independent. It is withheld by not being SENT, so there is nothing for a client to
// hide and nothing to read out of a network response.
type Poll struct {
	ID        string    `json:"id"`
	Question  string    `json:"question"`
	Kind      PollKind  `json:"kind"`
	Options   []string  `json:"options"`
	State     PollState `json:"state"`
	CreatedAt string    `json:"createdAt"`
	ClosedAt  string    `json:"closedAt,omitempty"`

	// CorrectOption is an index into Options, or -1 when there is no right answer
	// or the caller is not yet entitled to know it. Minus one rather than omitted so
	// a client never has to tell "absent" from "index zero".
	//
	// Revealed to the audience once voting closes, unlike the tally: a quiz exists
	// to tell people whether they were right, and by then there is no answer left to
	// influence.
	CorrectOption int `json:"correctOption"`

	// Votes is a count per option, index-aligned with Options. Empty for the
	// audience, always.
	Votes []int `json:"votes"`
	// TotalVotes is how many people have answered. Zero for the audience — the
	// presenter needs to know when to move on, and nobody else does.
	TotalVotes int `json:"totalVotes"`
	// MyChoice is this caller's own answer, or -1 if they have not voted.
	//
	// This is the one number the audience does get, and it is what makes one vote
	// per person visible rather than merely enforced: the inputs are disabled and
	// their answer is shown back to them, and it survives a reload because the vote
	// is keyed on the participant identity we minted rather than on anything the
	// browser is holding.
	MyChoice int `json:"myChoice"`
}

// PollInput creates a poll.
type PollInput struct {
	Question string   `json:"question"`
	Kind     PollKind `json:"kind"`
	Options  []string `json:"options"`
	// CorrectOption is required for a quiz and refused for a poll.
	CorrectOption *int `json:"correctOption,omitempty"`
}

// PollVoteRequest casts one vote.
type PollVoteRequest struct {
	// JoinKey authenticates an attendee with no account, as on the realtime relay.
	JoinKey string `json:"joinKey,omitempty"`
	// Choice is an index into the poll's options.
	Choice int `json:"choice"`
}

// -------------------------------------------------------------- chat history

// ChatMessageType separates a line of text from an image.
type ChatMessageType string

const (
	ChatText  ChatMessageType = "text"
	ChatImage ChatMessageType = "image"
)

// ChatMessage is one persisted line of a session's chat.
//
// The field names are the archival contract as much as the wire one: this is what a
// transcript export contains, and what any later reporting reads. Everything an
// analytics query needs is on the row — who, when, in which session, to whom, and
// whether it was words or a picture.
type ChatMessage struct {
	// ID is the sender's own message id. It is what makes redelivery idempotent: a
	// reconnecting client merges the backlog by id and cannot show a line twice.
	ID string `json:"id"`
	// Seq is the total order within the session, and the sync cursor. A client asks
	// for everything after the highest one it holds.
	Seq int64 `json:"seq"`

	SenderID   string `json:"senderId"`
	SenderName string `json:"senderName"`
	SenderRole Role   `json:"senderRole"`
	// UserID is set for a signed-in account and empty for an attendee holding only a
	// join key, which is most of an audience. Present so reporting can join a
	// transcript to accounts where there are accounts to join to.
	UserID string `json:"userId,omitempty"`

	Type        ChatMessageType `json:"messageType"`
	Destination ChatDestination `json:"destination"`
	// Message is the text. Empty for an image.
	Message string `json:"message"`

	// MediaURL points at this API, not at the storage backend. The handler checks the
	// caller is in this webinar before streaming the bytes; a bucket URL in the payload
	// would be a link that outlives the session and anybody who saw it.
	MediaURL    string `json:"mediaUrl,omitempty"`
	MediaMime   string `json:"mediaMime,omitempty"`
	MediaBytes  int64  `json:"mediaBytes,omitempty"`
	MediaWidth  int    `json:"mediaWidth,omitempty"`
	MediaHeight int    `json:"mediaHeight,omitempty"`

	Timestamp string `json:"timestamp"`
}

// ChatBacklog is the answer to "what have I missed".
//
// Returned on joining and on every reconnect. `cursor` is the highest seq in the
// batch, which the client sends back next time — so a reconnect after an hour costs
// one request and no duplicates.
type ChatBacklog struct {
	Messages []ChatMessage `json:"messages"`
	Cursor   int64         `json:"cursor"`
	// More reports that the batch was truncated and another read would return further
	// messages. A session with ten thousand lines must not arrive in one response.
	More bool `json:"more"`
}

// ChatImageResponse is returned after an upload. The message has already been created
// and broadcast by the time this comes back.
type ChatImageResponse struct {
	Message ChatMessage `json:"message"`
}

// ChatStats is the per-session summary, for reporting.
type ChatStats struct {
	WebinarID string `json:"webinarId"`
	Messages  int    `json:"messages"`
	Images    int    `json:"images"`
	// Senders is how many distinct people said something — the engagement number,
	// as opposed to how many were in the room.
	Senders     int    `json:"senders"`
	FirstAt     string `json:"firstAt,omitempty"`
	LastAt      string `json:"lastAt,omitempty"`
	MediaBytes  int64  `json:"mediaBytes"`
	ToPanelists int    `json:"toPanelists"`
}

// ------------------------------------------------------------ realtime relay

// RoomMessageKind names the realtime messages an attendee may ask the server to
// deliver for them.
//
// The stage-only messages — clearing a raised hand, marking a question answered,
// asking one person to unmute — are absent on purpose: the host and panelists
// publish those on the data channel themselves.
type RoomMessageKind string

const (
	MsgChat     RoomMessageKind = "chat"
	MsgQuestion RoomMessageKind = "question"
	MsgUpvote   RoomMessageKind = "upvote"
	MsgHand     RoomMessageKind = "hand"
	MsgReaction RoomMessageKind = "reaction"
)

// SendMessageRequest is one realtime message handed to the server for delivery.
//
// Attendee tokens carry canPublishData=false, so the SFU refuses a packet an
// attendee tries to publish and this endpoint is the only way their chat,
// questions, hands and reactions reach the room. That is what makes the host's
// chat destination a rule: the server picks the recipients and stamps the sender,
// leaving a patched client nothing to lie about.
//
// One flat shape rather than a struct per kind, because this contract is
// generated into TypeScript and four optional fields cost less there than a
// discriminated union.
type SendMessageRequest struct {
	// JoinKey authenticates an attendee who registered without an account — the
	// same credential the join endpoint accepts, for the same reason.
	JoinKey string          `json:"joinKey,omitempty"`
	Kind    RoomMessageKind `json:"kind"`
	// ID is the sender's id for this message, echoed in the delivered packet so
	// every client agrees on what to de-duplicate.
	ID string `json:"id,omitempty"`
	// Text is the chat message or the question.
	Text string `json:"text,omitempty"`
	// Anonymous drops the asker's name from a question.
	Anonymous bool `json:"anonymous,omitempty"`
	// QuestionID is the question being upvoted.
	QuestionID string `json:"questionId,omitempty"`
	// Raised is the new state of this person's hand.
	Raised bool `json:"raised,omitempty"`
	// Emoji is the reaction. Checked against a fixed list server-side, so one
	// patched client cannot push arbitrary strings into 500 people's UI.
	Emoji string `json:"emoji,omitempty"`
	// Destination is a request, not an instruction, and it is honoured only for the
	// host and the panelists. An attendee's chat goes where the host's setting says
	// regardless of what arrives here — that is the whole point of the endpoint —
	// and the field exists so a panelist who has fallen back to the relay can still
	// address the stage rather than accidentally broadcasting to the audience.
	Destination ChatDestination `json:"destination,omitempty"`
}

// SendMessageResponse reports what the server actually did, which is not always
// what was asked.
type SendMessageResponse struct {
	// Destination is where a chat message went. For an attendee this is the host's
	// setting rather than anything the client requested, and the composer reads it
	// back so its label can never disagree with what happened.
	Destination ChatDestination `json:"destination,omitempty"`
	// Recipients is how many identities the SFU was given. Zero means the whole
	// room, because a broadcast carries no list.
	Recipients int `json:"recipients"`
}

type WebinarReport struct {
	Attended    int `json:"attended"`
	AvgWatchMin int `json:"avgWatchMin"`
	Questions   int `json:"questions"`
}

type Webinar struct {
	ID        string        `json:"id"` // slug, used in URLs
	WebinarID string        `json:"webinarId"`
	Topic     string        `json:"topic"`
	Summary   string        `json:"summary"`
	Descript  string        `json:"description"`
	Track     string        `json:"track"`
	/* ImageURL is a path back to this API, never a bucket URL — same reasoning as
	 * MediaKey on a chat image, so the backend can move where the bytes live without
	 * breaking a link already on a registration page. Carries a `?v=` that changes
	 * every time the image is replaced, so a cache never serves stale bytes under a
	 * URL that looks unchanged. Empty when no image was uploaded; the frontend falls
	 * back to its own generated cover in that case. */
	ImageURL  string        `json:"imageUrl,omitempty"`
	StartsAt  string        `json:"startsAt"` // RFC3339
	Duration  int           `json:"durationMin"`
	TimeZone  string        `json:"timeZone"`
	Kind      WebinarKind   `json:"kind"`
	Status    WebinarStatus `json:"status"`
	StartedAt string        `json:"startedAt,omitempty"`
	EndedAt   string        `json:"endedAt,omitempty"`

	Host      Person   `json:"host"`
	Panelists []Person `json:"panelists"`

	Agenda    []AgendaItem `json:"agenda"`
	Takeaways []string     `json:"takeaways"`

	RegistrationRequired bool         `json:"registrationRequired"`
	Approval             ApprovalMode `json:"approval"`
	/* GuestJoinAllowed decides whether the shared link offers a name-only door.
	 *
	 * DERIVED, not stored, and derived on the SERVER rather than in the browser. It is false
	 * whenever approval is manual, because a guest cannot be approved: there is no address to
	 * write to and nothing for the host to review, so letting one in would walk straight
	 * through the gate the host switched on.
	 *
	 * Sent so the landing page can hide a button rather than offer one that 409s. The endpoint
	 * still checks — see handleGuestJoin — because a hidden button is a courtesy, not a control.
	 * There is deliberately no matching field on WebinarInput: a settable copy would let a
	 * caller ask for a door the approval mode forbids.
	 */
	GuestJoinAllowed bool             `json:"guestJoinAllowed"`
	AttendeeLimit    int              `json:"attendeeLimit"`
	RegistrantCount  int              `json:"registrantCount"`
	PriceUsd         *int             `json:"priceUsd"`
	CustomQuestions  []CustomQuestion `json:"customQuestions"`

	Options  WebinarOptions  `json:"options"`
	Controls SessionControls `json:"controls"`

	/* The passcode, and who is allowed to see it.
	 *
	 * A shared secret the host hands out separately from the link, so it must only ever
	 * reach the host's own views. It was being serialised into two unauthenticated
	 * endpoints — the browse list and the public webinar page — which meant anybody could
	 * read it off the API and walk straight past the gate it exists to be.
	 *
	 * publicWebinar in the api package is what strips it. PasscodeRequired is what
	 * replaces it, because the registration form still has to know whether to ask. */
	Passcode         string `json:"passcode,omitempty"`
	PasscodeRequired bool   `json:"passcodeRequired"`

	/* SFUProject is which LiveKit project this webinar's room lives on, once chosen.
	 *
	 * Empty until the first join picks one. Operator information — it is what answers "which
	 * of my LiveKit accounts is this session billing against" and "what is still running on
	 * the project I want to retire" — so it reaches the host's own views and is stripped by
	 * publicWebinar, exactly like the passcode.
	 *
	 * Not stripped because it is a secret; a project id is not. Stripped because the audience
	 * has no use for it and every field that reaches an unauthenticated endpoint is a field
	 * somebody has to think about again later.
	 */
	SFUProject string `json:"sfuProject,omitempty"`

	Report *WebinarReport `json:"report,omitempty"`
}

// WebinarInput creates or replaces a webinar. PATCH has replace semantics
// rather than merge: the schedule form always holds the whole record, and
// merge semantics on a nested shape like Agenda is where partial-update bugs
// come from.
type WebinarInput struct {
	Topic    string        `json:"topic"`
	Summary  string        `json:"summary"`
	Descript string        `json:"description"`
	Track    string        `json:"track"`
	StartsAt string        `json:"startsAt"` // RFC3339, absolute instant
	Duration int           `json:"durationMin"`
	TimeZone string        `json:"timeZone"` // IANA name, for display
	Kind     WebinarKind   `json:"kind"`
	Status   WebinarStatus `json:"status"` // scheduled | draft only

	RegistrationRequired bool         `json:"registrationRequired"`
	Approval             ApprovalMode `json:"approval"`
	// No GuestJoinAllowed here. This is the request type for creating a webinar, and the flag
	// is derived from Approval on read — a settable copy would let a caller ask for a door the
	// approval mode forbids.
	AttendeeLimit   int              `json:"attendeeLimit"`
	Passcode        string           `json:"passcode"`
	Agenda          []AgendaItem     `json:"agenda"`
	Takeaways       []string         `json:"takeaways"`
	CustomQuestions []CustomQuestion `json:"customQuestions"`
	PanelistEmails  []string         `json:"panelistEmails"`

	Options  WebinarOptions  `json:"options"`
	Controls SessionControls `json:"controls"`
}

// ----------------------------------------------------------------- accounts

// Account is the signed-in person. Hosting is a capability on an ordinary
// account, not a separate kind of account: the same person registers for other
// people's webinars and runs their own.
type Account struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	Org      string `json:"org"`
	Initials string `json:"initials"`
	Hue      string `json:"hue"`
	// CanHost is GRANTED by an admin. It was once a checkbox on the signup form; see
	// migrations/0011 for why that had to stop.
	CanHost bool `json:"canHost"`
	// IsAdmin may grant CanHost to others. Set only from ADMIN_EMAILS at boot — there is no
	// endpoint that promotes an admin, deliberately, because a privilege grantable in-band is
	// grantable by whoever takes over one account.
	IsAdmin bool `json:"isAdmin"`
}

type SignupRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Org      string `json:"org,omitempty"`
	Title    string `json:"title,omitempty"`
	/* WantsHost is ACCEPTED AND IGNORED, and the field is kept for exactly that reason.
	 *
	 * It used to grant the hosting capability, which made "can create webinars and collect
	 * strangers' contact details" a checkbox anybody could tick. Removing the field outright
	 * would make an older cached bundle's signup fail on an unknown-field error — this API
	 * rejects unknown fields — so the request still parses and the value no longer does
	 * anything. See handleSignup, which records when somebody asked.
	 */
	WantsHost bool `json:"wantsHost"`
}

// HostGrant is an admin's decision about one account's hosting capability.
type HostGrant struct {
	CanHost bool `json:"canHost"`
}

/* AdminUser is one row of the admin panel.
 *
 * Carries what an admin needs to decide whether this person should be able to run webinars —
 * who they are, when they joined, whether they asked — and nothing more. No password hash, no
 * session data, and no registration history: the panel's job is granting a capability, not
 * profiling users.
 */
type AdminUser struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	Title     string `json:"title,omitempty"`
	Org       string `json:"org,omitempty"`
	Initials  string `json:"initials"`
	Hue       string `json:"hue"`
	CanHost   bool   `json:"canHost"`
	IsAdmin   bool   `json:"isAdmin"`
	CreatedAt string `json:"createdAt"`
	// WebinarCount is why revoking is not always safe: an account that owns scheduled
	// sessions still needs to be able to start them.
	WebinarCount int `json:"webinarCount"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

/* SupabaseAuthRequest exchanges a verified Supabase Auth access token for this
 * app's webcast_session cookie.
 *
 * The browser completes Google (or other) OAuth with Supabase JS; this body is
 * what arrives after that redirect. The API never talks to Google directly —
 * it only verifies Supabase's JWT and links or creates a local users row.
 */
type SupabaseAuthRequest struct {
	AccessToken string `json:"accessToken"`
}

type ProfilePatch struct {
	Name  *string `json:"name,omitempty"`
	Title *string `json:"title,omitempty"`
	Org   *string `json:"org,omitempty"`
	// WantsHost is accepted and ignored, for the same reason as on SignupRequest: an older
	// bundle still submitting the old profile form must be able to save the name change it
	// was really for. store.UpdateProfile no longer touches can_host.
	WantsHost *bool `json:"wantsHost,omitempty"`
}

// ------------------------------------------------------------- registration

type RegisterRequest struct {
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	Email     string `json:"email"`
	Company   string `json:"company,omitempty"`
	JobTitle  string `json:"jobTitle,omitempty"`
	Country   string `json:"country,omitempty"`
	/** The mobile number in E.164 shape — `+` then digits, no spaces. The form assembles it
	 *  from a dial-code picker and a national number; the wire carries one value, because a
	 *  number split across two fields is a property of the form and not of the number. */
	Phone   string            `json:"phone,omitempty"`
	Answers map[string]string `json:"answers,omitempty"`
	Consent bool              `json:"consent"`
	/** The webinar's passcode, when it has one. Checked at registration, which is the
	 *  one gate every attendee passes through — a join key is only issued here. */
	Passcode string `json:"passcode,omitempty"`
}

type Registration struct {
	WebinarID string `json:"webinarId"` // slug
	Email     string `json:"email"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	Company   string `json:"company,omitempty"`
	JobTitle  string `json:"jobTitle,omitempty"`
	Country   string `json:"country,omitempty"`
	Phone     string `json:"phone,omitempty"`
	/* IsGuest: entered by name only, through the guest door. No email was collected, so this
	 * row is not a lead and the host's registrant list marks it as such rather than showing a
	 * blank address that looks like a bug. */
	IsGuest      bool              `json:"isGuest,omitempty"`
	Answers      map[string]string `json:"answers,omitempty"`
	State        RegistrationState `json:"state"`
	JoinKey      string            `json:"joinKey"`
	RegisteredAt string            `json:"registeredAt"`
}

// RegisteredWebinar is one row of "My webinars" for a signed-in account: the
// registration plus the webinar it is for, so the page needs one request rather
// than the whole catalogue plus a filter.
type RegisteredWebinar struct {
	Webinar      Webinar      `json:"webinar"`
	Registration Registration `json:"registration"`
}

// LookupRequest resolves the join keys a browser is holding back into
// registrations. Registering without an account is still supported — the join
// key is the credential, exactly like the personal link Zoom emails out.
type LookupRequest struct {
	JoinKeys []string `json:"joinKeys"`
}

/* GuestJoinRequest is the whole guest form: one field.
 *
 * No email, deliberately. Asking for one and not verifying it produces a lead list full of
 * a@a.com, and asking for one at all is the friction this door exists to remove. A host who
 * wants addresses turns approval on, or points people at Register & Join.
 */
type GuestJoinRequest struct {
	Name string `json:"name"`
}

/* GuestJoinAllowedFor derives Webinar.GuestJoinAllowed, and lives here so there is exactly
 * one copy of the rule.
 *
 * Both readers need it and they are in different packages: the store sets the field on every
 * webinar it reads, and the API checks it again before it creates anything. Written twice, the
 * flag the landing page draws a button from and the rule the endpoint enforces are one edit away
 * from disagreeing — which shows up as a button that 409s, or worse, a door the host thought
 * they had closed.
 *
 * Manual approval closes it because a guest cannot be approved: no address to write to, nothing
 * for the host to review. A passcode closes it because the guest form has no field to type one
 * into, and adding one would make it the registration form.
 */
func GuestJoinAllowedFor(w Webinar) bool {
	return w.Approval != ApprovalManual && strings.TrimSpace(w.Passcode) == ""
}

type JoinRequest struct {
	// JoinKey is optional for a signed-in account: the server finds the
	// registration from the session instead.
	JoinKey string `json:"joinKey,omitempty"`
}

// JoinResponse is what the browser hands to the LiveKit client SDK.
type JoinResponse struct {
	Token       string `json:"token"`
	URL         string `json:"url"`
	Room        string `json:"room"`
	Role        Role   `json:"role"`
	Identity    string `json:"identity"`
	DisplayName string `json:"displayName"`
	// CanPublish is echoed so the UI can render the right controls without
	// having to decode the JWT.
	CanPublish bool `json:"canPublish"`
	// Controls is the session state at join time. Later changes arrive over
	// LiveKit room metadata rather than by polling this endpoint.
	Controls SessionControls `json:"controls"`
	Topic    string          `json:"topic"`
	/* StartedAt is when the host took the webinar live (RFC3339).
	 *
	 * The room header clock counts from this, not from the browser's connect
	 * time — a late joiner must see the same elapsed time as everyone else.
	 * Empty only if the session has somehow not been stamped live yet.
	 */
	StartedAt string `json:"startedAt,omitempty"`
	/* EndedAt is when the host ended the session (RFC3339). Present so a client
	 * that still holds a connection can freeze the elapsed clock on the final
	 * duration rather than keep ticking. */
	EndedAt string `json:"endedAt,omitempty"`
	// Hidden reports that the SFU will keep this participant invisible to the
	// other participants. Shown to attendees so the privacy claim is legible.
	Hidden bool `json:"hidden"`
	// CanRecord answers exactly the question the record button asks, decided by
	// the server rather than inferred from the role.
	//
	// It is NOT the same as CanPublish. The recording endpoints sit behind
	// requireStage, which wants an ACCOUNT on this webinar's stage roster — the
	// host, or a name on the panelist list. An attendee the host promoted
	// publishes exactly like a panelist and has no account at all, so inferring
	// this from publish permission offered them a button whose every request came
	// back 401. It also covers recording being turned off for the instance, which
	// the client otherwise learned from a 503 after the click.
	CanRecord bool `json:"canRecord"`
	/* JoinKey is the caller's own registration key, echoed back.
	 *
	 * For the guest door it is the point of the response: a guest has no account and no
	 * emailed link, so this string is the only thing that gets them back into the room after
	 * a reload, and the browser stores it exactly as a registrant's is stored.
	 *
	 * Echoed on the registered path too, where it is harmless — the caller either just sent
	 * it or holds a session that owns the registration. Empty for a host or panelist, who
	 * join on their account and have no registration at all.
	 */
	JoinKey string `json:"joinKey,omitempty"`
}

// RoomMeta is mirrored into LiveKit room metadata on every control change.
//
// It is how one host action reaches 500 browsers: the SFU pushes metadata down
// the signalling connection every client already holds open, so nobody polls.
// Public to the room by design — it carries no personal data.
type RoomMeta struct {
	Controls SessionControls `json:"controls"`
	Status   WebinarStatus   `json:"status"`
	Topic    string          `json:"topic"`
	/* StartedAt / EndedAt mirror the webinar row so every connected client can
	 * drive the same elapsed clock without a second HTTP round trip. */
	StartedAt string `json:"startedAt,omitempty"`
	EndedAt   string `json:"endedAt,omitempty"`
	// Recording is broadcast to every client rather than known only to the person
	// who pressed the button. Being recorded without being told is the kind of
	// thing people sue over, so the indicator has to come from the server and
	// reach the whole room.
	Recording bool `json:"recording"`
}

// ------------------------------------------------------------------ recordings

type RecordingStatus string

const (
	RecordingActive RecordingStatus = "recording"
	RecordingReady  RecordingStatus = "ready"
	RecordingFailed RecordingStatus = "failed"
)

// Recording is one captured session.
//
// The bytes live in object storage; this is everything needed to list, play and
// account for them without touching the storage backend.
type Recording struct {
	ID      string          `json:"id"`
	Webinar string          `json:"webinar"` // slug
	Topic   string          `json:"topic"`
	Status  RecordingStatus `json:"status"`
	// Mime is the container the recording browser actually produced — Safari
	// records MP4, Chrome records WebM — so it cannot be assumed on the way out.
	Mime       string `json:"mime"`
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMs int64  `json:"durationMs"`
	StartedBy  string `json:"startedBy"`
	CreatedAt  string `json:"createdAt"`
	StoppedAt  string `json:"stoppedAt,omitempty"`
	// Ext is the file extension for the download name, derived from Mime by the
	// server so no client has to parse codec strings.
	Ext string `json:"ext"`
}

// StartRecordingRequest is sent by the browser that will do the capturing. It
// names the container it can produce, because that differs by browser and the
// server has to store what it is actually given.
type StartRecordingRequest struct {
	Mime string `json:"mime"`
}

// ------------------------------------------------------------ host: in-session

// LiveParticipant is one row of the host's participant panel.
//
// This comes from LiveKit's *server* API, not from the host's browser, which
// matters: hidden attendees are excluded from client-side rosters by design, so
// the host would otherwise be unable to moderate the people they have hidden.
type LiveParticipant struct {
	Identity   string   `json:"identity"`
	Name       string   `json:"name"`
	Role       Role     `json:"role"`
	JoinedAt   string   `json:"joinedAt"`
	Publishing []string `json:"publishing"`
	AudioMuted bool     `json:"audioMuted"`
	Hidden     bool     `json:"hidden"`
	CanPublish bool     `json:"canPublish"`
	// CanSpeak reports a microphone grant specifically, so the host's panel can
	// tell "allowed to speak" apart from "on the stage with a camera".
	CanSpeak bool `json:"canSpeak"`
	// AudioOnly is the scope the host granted, read back from what we minted —
	// not inferred from what they happen to be publishing. A full panelist with
	// their camera off is not the same as somebody allowed only to speak, and
	// guessing from the track list conflates the two.
	AudioOnly bool `json:"audioOnly"`
	// MutedByHost is the difference between "not a speaker" and "a speaker the
	// host silenced". Both have CanSpeak false, and the host's panel has to offer
	// "allow to speak again" for the second one rather than treating them as
	// audience.
	MutedByHost bool `json:"mutedByHost"`
}

type LiveRoom struct {
	Room         string            `json:"room"`
	Status       WebinarStatus     `json:"status"`
	Controls     SessionControls   `json:"controls"`
	Participants []LiveParticipant `json:"participants"`
	Attendees    int               `json:"attendees"`
	OnStage      int               `json:"onStage"`
}

type MutePatch struct {
	Muted bool `json:"muted"`
}

// StageRequest promotes an attendee onto the stage or sends them back.
type StageRequest struct {
	Role Role `json:"role"` // panelist | attendee
	// AudioOnly is "allow to speak": the attendee gets a microphone and nothing
	// else — no camera, no screen share.
	//
	// This is the common case by far. A host taking a question wants to hear one
	// person, not hand them the stage, and a full promotion means an unprepared
	// attendee's camera and desktop are one click from 500 people.
	AudioOnly bool `json:"audioOnly"`
}

type MuteAllResponse struct {
	Muted int `json:"muted"`
}

type RegistrantRow struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Email      string            `json:"email"`
	Company    string            `json:"company,omitempty"`
	JobTitle   string            `json:"jobTitle,omitempty"`
	Phone      string            `json:"phone,omitempty"`
	State      RegistrationState `json:"state"`
	CreatedAt  string            `json:"createdAt"`
	HasAccount bool              `json:"hasAccount"`
	/* IsGuest marks a row that came through the name-only door.
	 *
	 * Surfaced to the host because the alternative is an empty Email cell that reads as a
	 * bug in the export. It is also the honest answer to "why can I not follow this person
	 * up": nothing was collected, by design.
	 */
	IsGuest bool `json:"isGuest,omitempty"`
}

type PanelistRequest struct {
	Email string `json:"email"`
}

// TransferHostRequest hands the webinar to another panelist already in the room.
//
// Identity is their LiveKit identity (user_<id>). The caller remains a panelist so
// they can rejoin the stage later; the target becomes the owner for every host
// endpoint that checks ownership. Publish grants are restored on handoff, so a
// muted panelist (CanPublish false) is still a valid target.
type TransferHostRequest struct {
	Identity string `json:"identity"`
}

// ---------------------------------------------------------------- app config

// AppConfig is public, unauthenticated, and read once by the frontend at boot.
// It exists so the UI has no build-time constants for things an operator sets:
// the product name, the public URL used to build share links, the attendee
// ceiling shown next to the seat count.
type AppConfig struct {
	AppName      string `json:"appName"`
	WebBaseURL   string `json:"webBaseUrl"`
	SupportEmail string `json:"supportEmail,omitempty"`
	MaxAttendees int    `json:"maxAttendees"`
	SignupOpen   bool   `json:"signupOpen"`
	// MinPasswordLength is served rather than duplicated in the bundle, so the
	// hint on the signup form can never promise a rule the server does not apply.
	MinPasswordLength int `json:"minPasswordLength"`
	// Tracks are the topic tags already in use, offered as suggestions rather
	// than a fixed enum so an operator never has to edit a list in the bundle.
	Tracks []string `json:"tracks"`
	// GoogleClientID and GoogleAPIKey turn on the Google Drive source in the
	// share-a-file picker. Both are public values — see config.Config — and both
	// are empty unless an operator sets them, which the picker reports as "not
	// configured" rather than failing on click.
	GoogleClientID string `json:"googleClientId,omitempty"`
	GoogleAPIKey   string `json:"googleApiKey,omitempty"`
	/* Supabase Auth (Google sign-in). Public values only — the JWT secret stays
	 * on the API. When googleAuth is false the Continue with Google button is hidden.
	 *
	 * Distinct from GoogleClientID above: that pair is Drive Picker, not login.
	 */
	SupabaseURL     string `json:"supabaseUrl,omitempty"`
	SupabaseAnonKey string `json:"supabaseAnonKey,omitempty"`
	GoogleAuth      bool   `json:"googleAuth,omitempty"`
}

type APIError struct {
	Error   string            `json:"error"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

type StatusResponse struct {
	Status string `json:"status"`
}
