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
	// NotifyRegistrationConfirmed is auto-approve signup: they are in without a host review.
	NotifyRegistrationConfirmed NotificationKind = "registration_confirmed"
	NotifyReminder24h           NotificationKind = "reminder_24h"
	NotifyReminder1h            NotificationKind = "reminder_1h"

	/* The same three things said on WhatsApp, which are separate kinds rather than
	 * the same kinds on another channel. A host may well want both — an email with
	 * a calendar file and a message on the phone the person will actually be
	 * holding — and one kind per row is what lets the outbox guarantee one of each
	 * per registration. */
	NotifyWhatsAppConfirmed   NotificationKind = "wa_registration_confirmed"
	NotifyWhatsAppReminder24h NotificationKind = "wa_reminder_24h"
	NotifyWhatsAppReminder1h  NotificationKind = "wa_reminder_1h"

	/* NotifyWhatsAppBroadcast is one recipient of one broadcast: the host's own
	 * message, written once and queued per person, rather than anything this
	 * application decided to send. It is not in WhatsAppReminderKinds because it has
	 * no settings row — the template and its values belong to the broadcast. */
	NotifyWhatsAppBroadcast NotificationKind = "wa_broadcast"

	/* NotifyWhatsAppDrip is one step of one person's sequence, queued when it comes
	 * due rather than all at once — the next step's time is only known once the
	 * previous one has actually gone. Also not in WhatsAppReminderKinds: the template
	 * belongs to the step, and nothing about a webinar's clock may reschedule it. */
	NotifyWhatsAppDrip NotificationKind = "wa_drip"

	/* NotifyReplayReady is the email that says the recording is up, with the link to
	 * watch it. Sent when the host shares one, not when it finishes processing: a
	 * replay link that arrives before anybody has decided to publish it would hand out
	 * a recording the host has not looked at yet. */
	NotifyReplayReady NotificationKind = "replay_ready"
	/* NotifyWhatsAppReplay is the same sentence on WhatsApp, and it is in
	 * WhatsAppReminderKinds because it works the way the other automatic messages do:
	 * the host picks an approved template for it once, and it is sent to the people
	 * who registered for the webinar it belongs to. */
	NotifyWhatsAppReplay NotificationKind = "wa_replay"
)

/* WhatsAppReminderKinds are the automatic WhatsApp messages, in the order they
 * reach somebody. Iterated by the settings endpoint and the enqueue path, so a new
 * kind is added here rather than in three switch statements.
 */
var WhatsAppReminderKinds = []NotificationKind{
	NotifyWhatsAppConfirmed,
	NotifyWhatsAppReminder24h,
	NotifyWhatsAppReminder1h,
	NotifyWhatsAppReplay,
}

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
	// EmailReminders defaults true for existing rows that never stored the key.
	EmailReminders bool `json:"emailReminders"`
	/* WhatsAppReminders defaults FALSE, unlike its email counterpart, and the
	 * asymmetry is deliberate: every WhatsApp message is charged to the host's own
	 * Meta account, so spending their money on a webinar has to be something they
	 * asked for. It also gates the confirmation message and not only the timed
	 * reminders — one switch per webinar for "message my registrants on WhatsApp",
	 * because a host turning it off does not mean "but keep sending one of them". */
	WhatsAppReminders bool `json:"whatsappReminders"`
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
	// CaptionsEnabled is the live-caption switch, and it is a CONTROL rather than
	// something the host's own browser remembers. Recognition runs against each
	// speaker's own microphone, so every publisher has to know captions are on or
	// only the person who pressed the button is ever transcribed. Initialised from
	// the scheduled Options.Captions when the webinar is created.
	CaptionsEnabled bool `json:"captionsEnabled"`
	Locked          bool `json:"locked"`

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
	CaptionsEnabled  *bool `json:"captionsEnabled,omitempty"`
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

/* AttendanceVisit is one arrival and one departure.
 *
 * A person who left and came back is several of these, which is the whole reason the type
 * exists: watch time used to be last_seen_at minus first_joined_at, and for anybody who
 * rejoined that is the span of their evening rather than the time they were present.
 */
type AttendanceVisit struct {
	JoinedAt string `json:"joinedAt"`
	// LeftAt is absent while somebody is still in the room — a report pulled during a live
	// session is a legitimate thing to ask for, and "" says "still here" without inventing
	// a departure that has not happened.
	LeftAt string `json:"leftAt,omitempty"`
	// Minutes is this visit CLIPPED to the live window, so it can be less than
	// LeftAt-JoinedAt for somebody who arrived early and sat on the waiting screen.
	Minutes int `json:"minutes"`
}

type AttendanceRow struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	Email    string `json:"email,omitempty"`
	/* Role is "host", "panelist" or "attendee", derived from the identity.
	 *
	 * Carried because the stage is in this list too and a reader needs to know which rows
	 * are the audience — but the Attended and AvgWatchMin figures above count attendees
	 * only, so a host's own presence never inflates their audience numbers. */
	Role string `json:"role"`
	// WatchMin is the SUM of the visits below, not the span between the first and the last.
	WatchMin int `json:"watchMin"`
	// FirstJoinedAt / LastLeftAt bracket the visits, so a summary row can be read without
	// expanding it. LastLeftAt is absent while they are still in the room.
	FirstJoinedAt string            `json:"firstJoinedAt,omitempty"`
	LastLeftAt    string            `json:"lastLeftAt,omitempty"`
	Visits        []AttendanceVisit `json:"visits"`
}

type SessionQuestion struct {
	ID        string `json:"id"`
	Identity  string `json:"identity,omitempty"`
	Name      string `json:"name"`
	Text      string `json:"text"`
	Anonymous bool   `json:"anonymous,omitempty"`
	Answered  bool   `json:"answered"`
	Answer    string `json:"answer,omitempty"`
	Pinned    bool   `json:"pinned,omitempty"`
	Dismissed bool   `json:"dismissed,omitempty"`
	Upvotes   int    `json:"upvotes"`
	CreatedAt string `json:"createdAt,omitempty"`
}

type QuestionPatch struct {
	Answered  *bool   `json:"answered,omitempty"`
	Answer    *string `json:"answer,omitempty"`
	Pinned    *bool   `json:"pinned,omitempty"`
	Dismissed *bool   `json:"dismissed,omitempty"`
}

type SessionReport struct {
	Registered   int               `json:"registered"`
	Approved     int               `json:"approved"`
	Attended     int               `json:"attended"`
	AvgWatchMin  int               `json:"avgWatchMin"`
	Questions    int               `json:"questions"`
	PollVoters   int               `json:"pollVoters"`
	QuestionRows []SessionQuestion `json:"questionRows"`
	Attendees    []AttendanceRow   `json:"attendees"`
}

type Webinar struct {
	ID        string `json:"id"` // slug, used in URLs
	WebinarID string `json:"webinarId"`
	Topic     string `json:"topic"`
	Summary   string `json:"summary"`
	Descript  string `json:"description"`
	Track     string `json:"track"`
	/* ImageURL is a path back to this API, never a bucket URL — same reasoning as
	 * MediaKey on a chat image, so the backend can move where the bytes live without
	 * breaking a link already on a registration page. Carries a `?v=` that changes
	 * every time the image is replaced, so a cache never serves stale bytes under a
	 * URL that looks unchanged. Empty when no image was uploaded; the frontend falls
	 * back to its own generated cover in that case. */
	ImageURL       string        `json:"imageUrl,omitempty"`
	StartsAt       string        `json:"startsAt"` // RFC3339
	Duration       int           `json:"durationMin"`
	TimeZone       string        `json:"timeZone"`
	Kind           WebinarKind   `json:"kind"`
	Status         WebinarStatus `json:"status"`
	StartedAt      string        `json:"startedAt,omitempty"`
	EndedAt        string        `json:"endedAt,omitempty"`
	MaxDurationMin int           `json:"maxDurationMin"`
	// SimuliveRecordingID is the ready recording played as the audience video
	// when Kind is simulive.
	SimuliveRecordingID string `json:"simuliveRecordingId,omitempty"`

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

	/* StreamWatchURL is the YouTube (or other) watch link for a live this
	 * webinar was pushed to. Empty when the host never set a destination.
	 * The ingest URL with the stream key is NOT on this type — it never
	 * leaves the database except toward LiveKit Egress.
	 *
	 * Host views only. publicWebinar strips it, because an unlisted YouTube
	 * live is not public just because someone opened the registration page.
	 * The recordings tab is where it is meant to be found, after the session. */
	StreamWatchURL string `json:"streamWatchUrl,omitempty"`
	// StreamConfigured is true while the mix is being pushed to that
	// destination — what the control-bar button lights up on.
	StreamConfigured bool `json:"streamConfigured,omitempty"`
	// StreamKeySaved is true when a destination is stored, whether or not it
	// is currently pushing, so the form can say "already set" without echoing
	// the key and the host can go live again without re-pasting it.
	StreamKeySaved bool `json:"streamKeySaved,omitempty"`

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

/* HostWebinarPage is one screen of a host's own webinars.
 *
 * The host list used to answer with every webinar the account had ever run —
 * fine at five, wasteful at five hundred, and it is re-read on every visit to
 * the portal. This carries a bounded slice plus the two things the UI cannot
 * work out for itself once it no longer holds every row: where the next slice
 * starts, and how many sessions are in each tab.
 */
type HostWebinarPage struct {
	Items []Webinar `json:"items"`
	/* NextCursor resumes after the last item, and is empty on the last page.
	 *
	 * Opaque on purpose. It encodes a (starts_at, slug) keyset position, and a
	 * client that parsed it would be depending on an ordering the server is
	 * free to change per tab — which it does, ascending for upcoming and
	 * descending for past. Emptiness is the only thing worth reading off it.
	 */
	NextCursor string `json:"nextCursor,omitempty"`
	/* Counts sizes every tab under the same search and date filters as the
	 * page itself, not the account's whole history. A host who searches for
	 * "onboarding" wants the badges to say where the matches are; three
	 * numbers describing a list they are not looking at would be noise. */
	Counts HostWebinarCounts `json:"counts"`
	/* Total is how many rows the active tab holds in full, so the list can say
	 * "10 of 34" rather than only knowing whether more exist. Always equal to
	 * the Counts field for the requested tab — sent separately so the footer
	 * does not have to re-derive which tab it is rendering. */
	Total int `json:"total"`
}

// HostWebinarCounts is the per-tab tally behind the host list's badges.
type HostWebinarCounts struct {
	Upcoming int `json:"upcoming"`
	Past     int `json:"past"`
	Drafts   int `json:"drafts"`
}

// WebinarInput creates or replaces a webinar. PATCH has replace semantics
// rather than merge: the schedule form always holds the whole record, and
// merge semantics on a nested shape like Agenda is where partial-update bugs
// come from.
type WebinarInput struct {
	Topic               string        `json:"topic"`
	Summary             string        `json:"summary"`
	Descript            string        `json:"description"`
	Track               string        `json:"track"`
	StartsAt            string        `json:"startsAt"` // RFC3339, absolute instant
	Duration            int           `json:"durationMin"`
	TimeZone            string        `json:"timeZone"` // IANA name, for display
	Kind                WebinarKind   `json:"kind"`
	Status              WebinarStatus `json:"status"` // scheduled | draft only
	SimuliveRecordingID string        `json:"simuliveRecordingId,omitempty"`

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

// SetStreamRequest is the host's RTMP destination.
//
// Three ways in:
//   - paste a Studio stream key + watch URL (manual)
//   - ViaYouTube, which creates an Unlisted live on the host's connected
//     channel and fills both URLs itself
//   - Off, which stops the RTMP push. The watch link stays for Recordings
//     unless DropWatch is set (turning the option off on the schedule form).
type SetStreamRequest struct {
	StreamKey string `json:"streamKey"`
	IngestURL string `json:"ingestUrl,omitempty"`
	WatchURL  string `json:"watchUrl"`
	Off       bool   `json:"off,omitempty"`
	DropWatch bool   `json:"dropWatch,omitempty"`
	// ViaYouTube creates the live through YouTube OAuth instead of a pasted key.
	ViaYouTube bool `json:"viaYouTube,omitempty"`
	// Privacy is public, unlisted (default), or private. Only used with ViaYouTube.
	Privacy string `json:"privacy,omitempty"`
}

// ----------------------------------------------------------------- accounts

// Account is the signed-in person. Hosting is a capability on an ordinary
// account, not a separate kind of account: the same person registers for other
// people's webinars and runs their own.
type Account struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Title string `json:"title"`
	Org   string `json:"org"`
	// Phone is E.164 shape (`+` then digits), same convention as
	// Registration.Phone — the caller's own number, never shown to anyone
	// else (not on Person, the type other attendees/panelists see).
	Phone    string `json:"phone"`
	Initials string `json:"initials"`
	Hue      string `json:"hue"`
	// CanHost is GRANTED by an admin. It was once a checkbox on the signup form; see
	// migrations/0011 for why that had to stop.
	CanHost bool `json:"canHost"`
	// IsAdmin may grant CanHost to others. Set only from ADMIN_EMAILS at boot — there is no
	// endpoint that promotes an admin, deliberately, because a privilege grantable in-band is
	// grantable by whoever takes over one account.
	IsAdmin bool `json:"isAdmin"`
	// MaxDurationMin is an optional custom maximum meeting duration in minutes for this user.
	// NULL means use the system default (e.g. 180 min = 3 hours).
	MaxDurationMin *int `json:"maxDurationMin,omitempty"`
	// CanCdnBroadcast allows this host's webinars to broadcast to audience via CDN HLS.
	CanCdnBroadcast bool `json:"canCdnBroadcast"`
	/* Features switched on for this account by an admin — the Feature constants, and
	 * never anything else. Sent to the browser so a screen can leave out a tab the
	 * server would refuse anyway; the server checks it again on every request, because
	 * a hidden button is not a permission. */
	Features []string `json:"features"`
	// YouTube is present when this account has granted live-stream access.
	YouTube *YouTubeLink `json:"youtube,omitempty"`
	// WhatsApp is present when this account has connected a WhatsApp Business
	// Account through Meta Embedded Signup.
	WhatsApp *WhatsAppLink `json:"whatsapp,omitempty"`
}

/* Per-account features, switched on and off by an admin.
 *
 * A list of keys on the account rather than a boolean column each, unlike CanHost
 * and CanCdnBroadcast. Those two are old enough to be part of what an account IS;
 * these are the switches on individual pieces of the CRM, and there will be more of
 * them with every phase. One column, one endpoint and one catalogue means the next
 * feature is a line here instead of a migration, a handler, a scan list and a toggle
 * — and the admin screen renders whatever this server declares rather than a list
 * the browser keeps its own copy of.
 *
 * Absent means off. There is no feature that defaults to on: every one of these
 * either spends the host's money or writes to other people's phones, so an
 * administrator turning it on for an account is the record that somebody decided to.
 */
const (
	// FeatureCRMTags is labelling contacts, and everything that reads a label: the
	// tag audience for a broadcast, the "tag added" sequence trigger, the bot step.
	FeatureCRMTags = "crm_tags"
	// FeatureCRMNotes is writing private notes on a contact.
	FeatureCRMNotes = "crm_notes"
	// FeatureReplayLinks is the replay email, and the WhatsApp replay message with
	// it: sharing a recording tells everybody who registered where to watch it.
	FeatureReplayLinks = "replay_links"
	// FeatureWhatsAppRegister is registering the connected number with Cloud API from
	// the connect flow, using a two-step PIN the host types.
	FeatureWhatsAppRegister = "whatsapp_register"
)

/* Feature is one switch as the admin screen renders it.
 *
 * Label and Description are here rather than in the browser so that the two cannot
 * disagree about what a switch does — the server owns both the key and the sentence
 * explaining it.
 */
type Feature struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

/* Features is the catalogue, in the order an admin is offered it. Iterated by the
 * admin endpoint's validation and sent to the admin screen, so a new switch is added
 * here and nowhere else.
 */
var Features = []Feature{
	{
		Key:         FeatureCRMTags,
		Label:       "Contact tags",
		Description: "Label contacts, message a tag, and start a sequence when one is added.",
	},
	{
		Key:         FeatureCRMNotes,
		Label:       "Contact notes",
		Description: "Keep private notes on a contact, visible only to this account.",
	},
	{
		Key:         FeatureReplayLinks,
		Label:       "Replay links",
		Description: "Sharing a recording emails the replay link to everyone who registered, and sends it on WhatsApp where a template is set.",
	},
	{
		Key:         FeatureWhatsAppRegister,
		Label:       "Register WhatsApp number",
		Description: "Let this host register a number created in the signup dialog, with a two-step PIN they choose.",
	},
}

// KnownFeature reports whether a key is one of the switches this server has.
func KnownFeature(key string) bool {
	for _, f := range Features {
		if f.Key == key {
			return true
		}
	}
	return false
}

// YouTubeLink is the public half of a host's YouTube OAuth grant. The refresh
// token never appears here.
type YouTubeLink struct {
	Connected    bool   `json:"connected"`
	ChannelID    string `json:"channelId,omitempty"`
	ChannelTitle string `json:"channelTitle,omitempty"`
}

/* WhatsAppLink is the public half of a host's WhatsApp Cloud API grant. The
 * access token never appears here.
 *
 * Deliberately the human-readable half and not the ids: a host recognises
 * "+27 82 000 0000 (Acme Coaching)" as their own number, and can tell at a glance
 * that they connected the right one. The WABA and phone-number ids are ours to
 * send with, not theirs to read.
 *
 * TokenExpiresAt is almost always absent, which means the grant does not expire —
 * see wa.Token. When it is set, it is there so the UI can say a connection has
 * gone stale instead of letting a host find out when a reminder fails to send.
 */
type WhatsAppLink struct {
	Connected    bool   `json:"connected"`
	DisplayPhone string `json:"displayPhone,omitempty"`
	VerifiedName string `json:"verifiedName,omitempty"`
	// RFC3339, like every other timestamp on the wire here. Empty rather than a
	// zero instant when there is none.
	ConnectedAt    string `json:"connectedAt,omitempty"`
	TokenExpiresAt string `json:"tokenExpiresAt,omitempty"`
	/* When this number was registered with Cloud API from here, if it ever was.
	 *
	 * Only ever set by the host asking for it — see WhatsAppRegisterRequest. A number
	 * that was already registered when it was connected (every number a host had
	 * before, and every one they migrated in) has nothing here and needs nothing: this
	 * says "we did this", not "this number works". */
	RegisteredAt string `json:"registeredAt,omitempty"`
}

/* WhatsAppSignup is everything the browser needs to open Meta's Embedded Signup
 * dialog, and nothing else.
 *
 * Connecting WhatsApp is not an OAuth redirect like Connect YouTube: Meta's JS
 * SDK opens a popup, the host picks or creates a WhatsApp Business Account inside
 * it, and the dialog hands the code back to the page that opened it. So there is
 * no URL to send a host to — hence a payload here rather than a 302, and hence
 * GraphVersion, which the SDK must be initialised with.
 *
 * All three values are public. The app secret is what must never leave the API,
 * and it is not here.
 */
type WhatsAppSignup struct {
	AppID        string `json:"appId"`
	ConfigID     string `json:"configId"`
	GraphVersion string `json:"graphVersion"`
}

/* WhatsAppCallbackRequest is what the browser posts once that dialog closes.
 *
 * Three values from two different places, which is why they arrive together:
 * Code comes from the SDK's login callback, while WABAID and PhoneNumberID come
 * from the dialog's own postMessage. Both halves are required — the code alone
 * would buy a token with nothing to send from.
 */
type WhatsAppCallbackRequest struct {
	Code          string `json:"code"`
	WABAID        string `json:"wabaId"`
	PhoneNumberID string `json:"phoneNumberId"`
}

/* WhatsAppRegisterRequest registers the connected number with Cloud API.
 *
 * A number created inside the Embedded Signup dialog is not usable until it has been
 * registered, and Meta asks for a six-digit two-step verification PIN to do it. The
 * PIN is the host's to choose and it is theirs to keep: it is read out of this
 * request, passed to Meta, and never stored, logged or returned. If they forget it,
 * Meta's own two-step settings is where it is reset — this server cannot tell them
 * what it was, on purpose.
 *
 * Its own request rather than part of the callback because it can fail on its own: a
 * number that is already registered, or a PIN that does not match the one on the
 * account, must not undo a connection that worked.
 */
type WhatsAppRegisterRequest struct {
	// Exactly six digits. Checked here and by Meta.
	Pin string `json:"pin"`
}

/* CRMContact is one person a host may message.
 *
 * Not a Registration, even where the fields look alike: a registration is what
 * somebody submitted for one webinar and stays as it was, while a contact is the
 * person behind however many of those there are and keeps changing. A host with
 * four sessions has four registrations and one contact.
 *
 * Name is assembled server-side rather than sent as first/last, because nothing
 * in the CRM edits half a name and every surface that shows a contact shows the
 * whole of it.
 */
type CRMContact struct {
	ID string `json:"id"`
	/** E.164 — `+` then digits. Empty for a contact who only ever gave an email,
	 *  which is also a contact who cannot be sent a WhatsApp message. */
	Phone   string `json:"phone,omitempty"`
	Email   string `json:"email,omitempty"`
	Name    string `json:"name,omitempty"`
	Company string `json:"company,omitempty"`
	/** Where the contact came from: `registration`, `whatsapp`, or empty for the
	 *  rows that predate anyone recording it. */
	Source string `json:"source,omitempty"`
	/** Whether a WhatsApp message may be sent to this person at all — opt-in
	 *  present, and no later opt-out. Computed, so the UI and the send path cannot
	 *  read the two timestamps and disagree. */
	WhatsAppOptIn bool `json:"whatsappOptIn"`
	/** RFC3339, all four. Empty when there is none. */
	WhatsAppOptInAt  string `json:"whatsappOptInAt,omitempty"`
	WhatsAppOptOutAt string `json:"whatsappOptOutAt,omitempty"`
	LastSeenAt       string `json:"lastSeenAt,omitempty"`
	CreatedAt        string `json:"createdAt"`
	/** RFC3339, when a person took this conversation over from the bot. While it is
	 *  set no bot answers this contact — see CRMBot. Set by a handoff node, and by the
	 *  host from the inbox; cleared only by the host. */
	BotPausedAt string `json:"botPausedAt,omitempty"`
	/** The labels on this contact, alphabetically. Always present, and empty for a
	 *  contact with none — a list the browser has to guard against being null is a
	 *  list every screen guards differently. */
	Tags []CRMTag `json:"tags"`
	/** The last thing said in either direction, for an inbox row. Absent on a
	 *  contact nobody has messaged. */
	LastMessage *CRMMessage `json:"lastMessage,omitempty"`
}

/** CRMMessage is one message in a thread, from the host's point of view:
 *  `in` is the contact writing to the business. */
type CRMMessage struct {
	ID        string `json:"id"`
	ContactID string `json:"contactId"`
	/** `in` or `out`. */
	Direction string `json:"direction"`
	Body      string `json:"body,omitempty"`
	/** Meta's own type for an inbound message that is not text — `image`, `audio`,
	 *  `location`, `button`. Empty for text, which is the only kind with a Body
	 *  worth showing. */
	Kind         string `json:"kind,omitempty"`
	TemplateName string `json:"templateName,omitempty"`
	/** queued / sent / delivered / read / failed. Inbound messages are written
	 *  `delivered`: they arrived, and nothing further will be reported. */
	Status string `json:"status"`
	/** Meta's words when Status is `failed` — usually something only the host can
	 *  fix, like a WABA with no payment method on it. */
	Error string `json:"error,omitempty"`
	/** The bot that sent this, when one did. Empty for everything a person sent or
	 *  received, which is most of a thread. Reading a handed-over conversation, this
	 *  is how the host tells which half of it they did not write. */
	FromBot   string `json:"fromBot,omitempty"`
	CreatedAt string `json:"createdAt"`
}

/* CRMContactScope names the webinar a contacts list was narrowed to.
 *
 * The topic comes from the server rather than riding along in the link, because the
 * heading it fills in is a claim about whose webinar this is. A topic passed in a query
 * string could say anything, and a heading built from the slug instead would show the
 * host a URL fragment where the name of their webinar belongs.
 */
type CRMContactScope struct {
	/** The webinar's slug — the same value its own pages use in the path, and what
	 *  ?webinarId= was set to. Echoed so the UI can be sure the server honoured the
	 *  filter rather than quietly listing everybody. */
	WebinarID string `json:"webinarId"`
	Topic     string `json:"topic"`
}

// CRMContactsResponse is the contacts list, newest activity first.
type CRMContactsResponse struct {
	Contacts []CRMContact `json:"contacts"`
	/** How many contacts are in the list being looked at — every contact this host
	 *  has, or every contact of one webinar when Scope is set. Not len(Contacts):
	 *  the search box and the page limit both narrow the rows without changing this,
	 *  so the count in the heading holds still while somebody types. */
	Total int `json:"total"`
	/** Set when ?webinarId= narrowed the list, and absent when it did not. Absent
	 *  rather than empty so "the whole CRM" is one state and not two. */
	Scope *CRMContactScope `json:"scope,omitempty"`
	/** Every tag this host has, so the list can offer them as a filter and the thread
	 *  can offer them as a picker without a request per contact. Empty when the tags
	 *  feature is off. */
	Tags []CRMTag `json:"tags"`
	/** False once WhatsApp is disconnected, so the CRM can keep showing a host
	 *  their leads while explaining why nothing can be sent. */
	WhatsAppConnected bool `json:"whatsappConnected"`
}

// CRMThreadResponse is one contact and the conversation with them, oldest first.
type CRMThreadResponse struct {
	Contact  CRMContact   `json:"contact"`
	Messages []CRMMessage `json:"messages"`
	/** RFC3339 deadline for writing free-form text to this contact, or empty when
	 *  there is none open. WhatsApp only allows a business to type its own words
	 *  for 24 hours after the contact's last message; outside that, the only thing
	 *  that may be sent is an approved template. Sent as the deadline rather than a
	 *  boolean so the UI can say "until 14:32" instead of "yes". */
	ServiceWindowUntil string `json:"serviceWindowUntil,omitempty"`
	/** False once WhatsApp is disconnected, which is why a compose box would be
	 *  refused even to a contact who is opted in and mid-conversation. */
	WhatsAppConnected bool `json:"whatsappConnected"`
	/** This contact's notes, newest first. Empty unless the notes feature is on for
	 *  this account, which is also when the pane is not shown. */
	Notes []CRMNote `json:"notes"`
}

/* CRMTag is one label a host puts on people.
 *
 * A name and nothing else — no colour, no group, no description. A tag earns its
 * place by being something this server can act on: an audience for a broadcast, a
 * sequence trigger, a step in a bot. A colour would be a preference that changes
 * nothing about who gets messaged, and every tag would then need one.
 *
 * Names are the host's own words, trimmed and single-spaced, and unique per account
 * case-insensitively: "VIP" and "vip" are one label, because a host who typed the
 * second meant the first.
 */
type CRMTag struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	/** How many of this host's contacts carry it. Sent with the list, because "delete
	 *  this tag" is a different decision at 2 contacts and at 900. */
	Contacts  int    `json:"contacts"`
	CreatedAt string `json:"createdAt"`
}

// CRMTagsResponse is every tag this host has, alphabetically.
type CRMTagsResponse struct {
	Tags []CRMTag `json:"tags"`
}

/* CRMTagRequest creates a tag or renames one.
 *
 * The same body for both, because a tag is its name: there is nothing else to edit.
 */
type CRMTagRequest struct {
	Name string `json:"name"`
}

/* CRMContactTagRequest puts a tag on a contact, or takes it off.
 *
 * By id rather than by name, so a typo cannot quietly create a second label — the
 * tag has to exist first. Creating one and applying it are two calls for the same
 * reason.
 */
type CRMContactTagRequest struct {
	TagID string `json:"tagId"`
}

/* CRMNote is something the host wrote down about a contact.
 *
 * Private to the account: never sent to anybody, never merged into a template, and
 * not readable by the person it is about. That is the whole point of it — "asked us
 * to call after 5", "already a customer" — and it is why notes are their own thing
 * rather than an extra field on the contact.
 *
 * Immutable once written. A note is a dated observation, and editing one silently
 * rewrites what the host knew in February; the way to correct one is to delete it and
 * write another.
 */
type CRMNote struct {
	ID        string `json:"id"`
	ContactID string `json:"contactId"`
	Body      string `json:"body"`
	/** Who wrote it, for the accounts that share a login between colleagues. The
	 *  account's name at the time it is read, not when it was written. */
	Author    string `json:"author,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// CRMNotesResponse is one contact's notes, newest first.
type CRMNotesResponse struct {
	Notes []CRMNote `json:"notes"`
}

// CRMNoteRequest writes one note. There is no edit: see CRMNote.
type CRMNoteRequest struct {
	Body string `json:"body"`
}

/* NoteMaxLength caps one note.
 *
 * Long enough for a paragraph about somebody, short enough that the notes pane stays
 * a list of observations rather than a document store.
 */
const NoteMaxLength = 2000

// TagMaxLength caps a tag name: a label, not a sentence.
const TagMaxLength = 48

// TagMaxPerHost caps how many tags one account may have. A host with a hundred
// labels has a taxonomy nobody can pick from, and the picker is a list.
const TagMaxPerHost = 100

/* CRMTemplate is one of the host's WhatsApp message templates, as Meta last
 * described it.
 *
 * Read-only here, and that is Meta's rule rather than a simplification: a
 * template is submitted and approved in WhatsApp Manager, and a send must match
 * the approved text word for word.
 */
type CRMTemplate struct {
	Name string `json:"name"`
	/** Meta's language code — `en`, `en_US`, `pt_BR`. Part of the identity: the
	 *  same template is approved once per translation, and a send names both. */
	Language string `json:"language"`
	/** Meta's own: APPROVED / PENDING / REJECTED / PAUSED / DISABLED. */
	Status string `json:"status"`
	/** MARKETING / UTILITY / AUTHENTICATION. Marketing needs the contact's opt-in;
	 *  it is also the category Meta charges most for. */
	Category string `json:"category"`
	Header   string `json:"header,omitempty"`
	/** The approved text with `{{1}}`-style placeholders left in, so a host can
	 *  read what they are about to send. */
	Body   string `json:"body,omitempty"`
	Footer string `json:"footer,omitempty"`
	/** How many values a send has to supply, in order. Meta rejects a mismatch. */
	Variables int `json:"variables"`
	/** Whether this one can actually be sent from here: approved, and made only of
	 *  the parts this implementation fills in. */
	Sendable bool `json:"sendable"`
	/** Why not, in words, when Sendable is false. */
	Unsupported string `json:"unsupported,omitempty"`
}

// CRMTemplatesResponse is the host's cached template list, alphabetical.
type CRMTemplatesResponse struct {
	Templates []CRMTemplate `json:"templates"`
	/** RFC3339 of the last time Meta was asked. Empty when it never has been. */
	SyncedAt string `json:"syncedAt,omitempty"`
	/** False once WhatsApp is disconnected: the list is then whatever was last
	 *  cached, and nothing can be sent from it. */
	WhatsAppConnected bool `json:"whatsappConnected"`
}

/* CRMSendRequest is one outbound message: either free-form text or a template,
 * never both.
 *
 * Which one is allowed depends on CRMThreadResponse.ServiceWindowUntil, and the
 * server decides rather than trusting this: a client that sends Body outside the
 * window is refused instead of quietly having a template picked for it.
 */
type CRMSendRequest struct {
	/** Free-form text, allowed only inside the 24-hour service window. */
	Body string `json:"body,omitempty"`
	/** Template name; requires Language too. */
	Template string `json:"template,omitempty"`
	Language string `json:"language,omitempty"`
	/** Values for the template's `{{1}}`, `{{2}}` … in order. The count must match
	 *  CRMTemplate.Variables exactly. */
	Params []string `json:"params,omitempty"`
}

/* CRMReminder is the template one kind of automatic WhatsApp message uses.
 *
 * A host-level choice, and a choice rather than a name this application invents:
 * Meta only delivers templates it has approved, so the only names that exist are
 * the ones already in this host's account. Nothing is sent for a kind that has not
 * been set, which is the honest behaviour when the alternative is naming a
 * template that would be rejected.
 */
type CRMReminder struct {
	/** One of the `wa_` NotificationKind values. */
	Kind NotificationKind `json:"kind"`
	/** Empty means this kind is off. */
	Template string `json:"template"`
	Language string `json:"language"`
	/** One merge-field token per `{{n}}`, in order — see CRMMergeField. Tokens
	 *  rather than values, because the values differ for every recipient and are
	 *  resolved when the message is queued. */
	Params []string `json:"params"`
}

/* CRMMergeField is one fact a reminder template can be filled in with.
 *
 * Sent to the browser rather than hardcoded there, so a picker cannot offer a
 * token the server would refuse — and so the set can grow in one place.
 */
type CRMMergeField struct {
	Token string `json:"token"`
	Label string `json:"label"`
	/** What it looks like filled in, for the preview beside the picker. */
	Example string `json:"example"`
	/** When set, the token resolves to something only on this one message kind, and
	 *  the server refuses it anywhere else. The replay link is the case it exists
	 *  for: there is no recording to point at in a broadcast or a drip step, so
	 *  offering it there would produce a message whose whole subject is a dash. */
	OnlyKind NotificationKind `json:"onlyKind,omitempty"`
}

// CRMRemindersResponse is the host's automatic-message settings.
type CRMRemindersResponse struct {
	/** One entry per kind, always all of them, in the order they happen. An unset
	 *  kind is present with an empty Template rather than absent, so the UI renders
	 *  the same rows whether or not anything has been configured. */
	Reminders []CRMReminder   `json:"reminders"`
	Fields    []CRMMergeField `json:"fields"`
	/** False once WhatsApp is disconnected: the settings are kept, and nothing is
	 *  sent from them. */
	WhatsAppConnected bool `json:"whatsappConnected"`
}

// CRMRemindersRequest replaces the whole set — the kinds omitted are turned off.
type CRMRemindersRequest struct {
	Reminders []CRMReminder `json:"reminders"`
}

/* CRMParam fills one `{{n}}` in a broadcast: either the same words for everybody
 * or a fact about the person receiving it.
 *
 * Two shapes rather than one, because a broadcast needs both in the same sentence.
 * "Hi {{1}}, {{2}} starts on {{3}}" wants the name filled in per recipient and the
 * other two typed once — and a bare string could not tell the difference between a
 * host who meant the merge field `name` and a host whose message really does say
 * the word "name".
 */
type CRMParam struct {
	/** A merge-field token — see CRMMergeField. Empty means Text is used instead. */
	Field string `json:"field,omitempty"`
	/** The literal words, when Field is empty. */
	Text string `json:"text,omitempty"`
}

/* Broadcast audiences. Deliberately few: every one of them has to be a set this
 * server can resolve to phone numbers on its own, without a host uploading a list
 * of people who never agreed to anything.
 */
const (
	/** AudienceOptedIn is every contact of this host who has opted in and has a
	 *  number — the marketing list, and the only audience that needs no webinar. */
	AudienceOptedIn = "opted_in"
	/** AudienceWebinar is the opted-in contacts who registered for one webinar. */
	AudienceWebinar = "webinar"
	/** AudienceTag is the opted-in contacts carrying one tag — the host's own
	 *  segment, and the only audience they define themselves. Needs the tags
	 *  feature. */
	AudienceTag = "tag"
)

/* CRMBroadcast is one message the host sent, or will send, to many people.
 *
 * Status is derived rather than stored: it is whatever the queued messages say —
 * see the store. A broadcast has no draft state, because a draft is a message
 * nobody has decided to send and there is nothing to keep about it.
 */
type CRMBroadcast struct {
	ID string `json:"id"`
	/** The host's own label for it, shown in the list. Never sent to anybody. */
	Name     string `json:"name"`
	Template string `json:"template"`
	Language string `json:"language"`
	/** One entry per `{{n}}`, in order, as configured — merge tokens unresolved. */
	Params []CRMParam `json:"params"`
	/** `opted_in`, `webinar` or `tag`. */
	Audience string `json:"audience"`
	/** The tag this went to, when Audience is `tag`. The name is sent with it so a
	 *  list can say which segment was messaged without a second request — and it is
	 *  the name as it is now, because a renamed tag is the same tag. */
	TagID   string `json:"tagId,omitempty"`
	TagName string `json:"tagName,omitempty"`
	/** The webinar slug this message is about: the audience when Audience is
	 *  `webinar`, and the source of the `topic` and `when` merge fields either way.
	 *  Empty when the broadcast names no webinar. */
	WebinarID string `json:"webinarId,omitempty"`
	/** Its topic, so a list can name the webinar without a second request. */
	WebinarTopic string `json:"webinarTopic,omitempty"`
	/** scheduled / sending / sent / cancelled. */
	Status string `json:"status"`
	/** RFC3339. In the past for a broadcast sent immediately. */
	ScheduledAt string `json:"scheduledAt"`
	CreatedAt   string `json:"createdAt"`
	/** How it is going, counted from the outbox and the conversations. */
	Stats CRMBroadcastStats `json:"stats"`
}

/* CRMBroadcastStats is one broadcast's progress.
 *
 * Recipients is fixed when the broadcast is created — the audience is frozen then,
 * so the number a host approved is the number that gets messaged. The rest move as
 * the outbox drains and as Meta reports back.
 */
type CRMBroadcastStats struct {
	Recipients int `json:"recipients"`
	/** Still waiting in the outbox. */
	Queued int `json:"queued"`
	/** Accepted by Meta. Delivered and Read are subsets of it, reported later by
	 *  webhook — a message can be sent and never delivered, to a number that is no
	 *  longer on WhatsApp. */
	Sent      int `json:"sent"`
	Delivered int `json:"delivered"`
	Read      int `json:"read"`
	/** Meta refused it. Both kinds of refusal: one at send time, after the retries
	 *  ran out, and one reported by webhook about a message it had already accepted —
	 *  which is also counted in Sent, because it was. */
	Failed int `json:"failed"`
	/** Not sent, and never will be: the contact opted out, or the template stopped
	 *  being approved, or the broadcast was cancelled before this one went out. */
	Skipped int `json:"skipped"`
}

// CRMBroadcastsResponse is the host's broadcasts, newest first.
type CRMBroadcastsResponse struct {
	Broadcasts []CRMBroadcast  `json:"broadcasts"`
	Fields     []CRMMergeField `json:"fields"`
	/** The tags a `tag` audience may name, alphabetically. Empty when the tags feature
	 *  is off for this account, which is also when that audience is refused. */
	Tags []CRMTag `json:"tags"`
	/** False once WhatsApp is disconnected: the history stays readable and nothing
	 *  new can be queued. */
	WhatsAppConnected bool `json:"whatsappConnected"`
}

/* CRMBroadcastRequest creates one, and sends it: there is no separate send call.
 *
 * ScheduledAt in the past or absent means now, which is also what "Send now"
 * posts. The audience is resolved and the per-recipient messages are queued while
 * this request is being handled, so the recipient count in the response is the
 * real one rather than an estimate.
 */
type CRMBroadcastRequest struct {
	Name     string     `json:"name"`
	Template string     `json:"template"`
	Language string     `json:"language"`
	Params   []CRMParam `json:"params,omitempty"`
	Audience string     `json:"audience"`
	/** Required when Audience is `webinar`; optional otherwise, and then only used
	 *  for the `topic` and `when` merge fields. */
	WebinarID string `json:"webinarId,omitempty"`
	/** Required when Audience is `tag`, ignored otherwise. */
	TagID string `json:"tagId,omitempty"`
	/** RFC3339, or empty for now. */
	ScheduledAt string `json:"scheduledAt,omitempty"`
}

/* CRMAudienceResponse is how many people an audience would reach, before anybody
 * commits to messaging them.
 *
 * Its own endpoint because the count is the decision: a host picking "everyone who
 * opted in" is entitled to know whether that is eleven people or four thousand,
 * and to find out without creating something.
 */
type CRMAudienceResponse struct {
	Audience string `json:"audience"`
	/** Contacts who would be messaged: opted in, not opted out, with a number. */
	Recipients int `json:"recipients"`
	/** Why the rest are not being messaged. Four disjoint buckets, so they add up to
	 *  the size of the audience: the point of showing them is that "40 of your 900
	 *  contacts" is a reasonable thing to see and a silent 40 is not. */
	NoOptIn  int `json:"noOptIn"`
	OptedOut int `json:"optedOut"`
	NoNumber int `json:"noNumber"`
}

/* How somebody enters a drip.
 *
 * Every one of these is an event this server already records, which is the rule that
 * decided the list: a trigger nobody can observe is a setting that does nothing.
 */
const (
	/** DripManual is a sequence the host puts people on themselves. */
	DripManual = "manual"
	/** DripRegistered fires when somebody registers, before any approval. */
	DripRegistered = "registered"
	/** DripAttended fires when a webinar ends, for the registrants who joined. */
	DripAttended = "attended"
	/** DripNoShow fires when a webinar ends, for the registrants who did not. */
	DripNoShow = "no_show"
	/** DripEnded fires when a webinar ends, for every registrant either way. */
	DripEnded = "ended"
	/** DripTagAdded fires when a tag is put on a contact — by the host, or by a bot
	 *  step. The one trigger that is not about a webinar at all, so a sequence on it
	 *  has no `topic` or `when` to fill a template with. Needs the tags feature. */
	DripTagAdded = "tag_added"
)

/* DripTriggers are the entry triggers, in the order a host is offered them.
 *
 * Iterated by the API's validation and sent to the builder, so a new trigger is added
 * here rather than in a switch statement and a form.
 */
var DripTriggers = []string{DripManual, DripRegistered, DripAttended, DripNoShow, DripEnded, DripTagAdded}

/* CRMDripStep is one message of a sequence.
 *
 * The delay is from the step before it — from entering, for the first one — because
 * that is how a sequence is written ("then two days later") and because inserting a
 * step in the middle then does not move every step after it.
 */
type CRMDripStep struct {
	/** Minutes to wait after the previous step. 0 means as soon as they enter. */
	DelayMinutes int `json:"delayMinutes"`
	/** The approved template's name and language — its identity at Meta. */
	Template string `json:"template"`
	Language string `json:"language"`
	/** One entry per `{{n}}`, in order, as configured: merge tokens unresolved. */
	Params []CRMParam `json:"params"`
}

/* CRMDrip is a sequence the host wrote, and the rule that puts people on it.
 *
 * Unlike a broadcast, this is not a record of something that happened: it is a rule
 * that keeps applying to people who have not registered yet. That is why it has an
 * on/off switch and why editing it is allowed — a drip with nobody on it yet and a
 * drip that has been running for a month are the same row.
 */
type CRMDrip struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	/** One of DripTriggers. */
	Trigger string `json:"trigger"`
	/** The webinar the trigger is about, or empty for every webinar. Never set for
	 *  the manual trigger. */
	WebinarID string `json:"webinarId,omitempty"`
	/** Its topic, so a list can name the webinar without a second request. */
	WebinarTopic string `json:"webinarTopic,omitempty"`
	/** The tag the trigger is about when Trigger is `tag_added`, or empty for any tag.
	 *  The name comes with it so the list can say "when VIP is added" without a second
	 *  request. Never set for the other triggers. */
	TagID   string `json:"tagId,omitempty"`
	TagName string `json:"tagName,omitempty"`
	/** False pauses it: nobody new enters and nobody already on it is sent anything,
	 *  without losing the sequence or anybody's place in it. */
	Active bool `json:"active"`
	/** In order. A drip with no steps cannot be saved. */
	Steps []CRMDripStep `json:"steps"`
	Stats CRMDripStats  `json:"stats"`
	/** RFC3339. */
	CreatedAt string `json:"createdAt"`
}

/* CRMDripStats is how a sequence is going.
 *
 * Enrollment counts and outbox counts, which are the two halves of the question: how
 * many people are on it, and how many messages that has cost so far.
 */
type CRMDripStats struct {
	/** People still moving through it, waiting for their next step. */
	Active int `json:"active"`
	/** People who have had every step. */
	Done int `json:"done"`
	/** People who stopped early: opted out, or the host took them off. */
	Exited int `json:"exited"`
	/** Steps queued and not yet away. */
	Queued int `json:"queued"`
	/** Steps accepted by Meta, and the ones it refused. */
	Sent   int `json:"sent"`
	Failed int `json:"failed"`
}

/* CRMDripEnrollment is one person's place in one sequence.
 *
 * Step is how many they have had, which for somebody active is also the index of the
 * one they are waiting for. A finished enrollment keeps its row: it is the record
 * that this person has already been through this sequence, and the reason a second
 * registration does not start them again.
 */
type CRMDripEnrollment struct {
	ID        string `json:"id"`
	ContactID string `json:"contactId"`
	/** For the list, so it reads as people rather than ids. */
	ContactName string `json:"contactName,omitempty"`
	Phone       string `json:"phone,omitempty"`
	/** How many steps they have had. */
	Step int `json:"step"`
	/** active / done / exited. */
	State string `json:"state"`
	/** Why they stopped early. Empty unless State is `exited`. */
	ExitReason string `json:"exitReason,omitempty"`
	/** RFC3339, when the next step is due. Meaningless once they are not active. */
	NextDueAt string `json:"nextDueAt,omitempty"`
	/** The webinar they entered from, when they entered from one. */
	WebinarTopic string `json:"webinarTopic,omitempty"`
	CreatedAt    string `json:"createdAt"`
}

// CRMDripsResponse is the host's sequences, newest first.
type CRMDripsResponse struct {
	Drips  []CRMDrip       `json:"drips"`
	Fields []CRMMergeField `json:"fields"`
	/** The triggers this server can fire, so the builder cannot offer one it would
	 *  refuse. */
	Triggers []string `json:"triggers"`
	/** The tags a `tag_added` trigger may name. Empty when the tags feature is off,
	 *  which is also when `tag_added` is not in Triggers. */
	Tags []CRMTag `json:"tags"`
	/** False once WhatsApp is disconnected: the sequences stay readable and their
	 *  steps stay queued, unsent, until it is reconnected. */
	WhatsAppConnected bool `json:"whatsappConnected"`
}

// CRMDripResponse is one sequence with the people on it.
type CRMDripResponse struct {
	Drip CRMDrip `json:"drip"`
	/** Newest first, capped: this is a view of who is on it, not an export. */
	Enrollments []CRMDripEnrollment `json:"enrollments"`
}

/* CRMDripRequest writes a sequence, and is the whole of it: the steps come with it
 * rather than being added one call at a time.
 *
 * A sequence read back has to be the sequence that was sent, and a step-at-a-time API
 * would have a state where half of one exists and the sweep can already see it.
 */
type CRMDripRequest struct {
	Name    string `json:"name"`
	Trigger string `json:"trigger"`
	/** Optional for the webinar triggers, where empty means every webinar. Ignored
	 *  for `manual`. */
	WebinarID string `json:"webinarId,omitempty"`
	/** Optional for `tag_added`, where empty means any tag. Ignored otherwise. */
	TagID string `json:"tagId,omitempty"`
	/** Whether it runs. Absent is false, so a request that forgets it creates a
	 *  paused sequence rather than one that starts messaging people. */
	Active bool          `json:"active"`
	Steps  []CRMDripStep `json:"steps"`
}

/* CRMDripEnrollRequest puts one person on a sequence by hand.
 *
 * The webinar is needed when the steps use the `topic` or `when` merge fields and the
 * drip is not already scoped to one — there is no registration to infer it from.
 */
type CRMDripEnrollRequest struct {
	ContactID string `json:"contactId"`
	WebinarID string `json:"webinarId,omitempty"`
}

/* What starts a bot.
 *
 * An inbound message and nothing else, which is the shape of the thing: a bot exists
 * to answer somebody, so the only question is whether it answers everything or only
 * certain words. The other triggers a chatbot might want — a click on an ad, a button
 * on a template — arrive at this server as a message too, and are matched by their
 * text like anything else.
 */
const (
	/** BotAnyMessage answers any message from somebody it is not already talking to. */
	BotAnyMessage = "any_message"
	/** BotKeyword answers only the words the host listed. */
	BotKeyword = "keyword"
)

/* What one step of a flow does.
 *
 * The plan asked for message, buttons/list, condition, wait, set tag, enroll drip and
 * handoff. Buttons are the `ask` node, because a question and its answers are one step
 * rather than two. A condition is that node's branches — there is nothing else in a
 * flow to test. And a tag is a thing contacts still do not have.
 */
const (
	/** BotNodeMessage says something and carries on to the next node. */
	BotNodeMessage = "message"
	/** BotNodeAsk says something with buttons and waits for the answer. */
	BotNodeAsk = "ask"
	/** BotNodeWait pauses the flow for DelayMinutes, then carries on. */
	BotNodeWait = "wait"
	/** BotNodeEnroll puts the contact on a drip sequence, then carries on. */
	BotNodeEnroll = "enroll"
	/** BotNodeHandoff stops the bot and gives the conversation to a person. */
	BotNodeHandoff = "handoff"
	/** BotNodeTag puts a tag on the contact, then carries on. Sends nothing, so it is
	 *  the one step the person on the other end cannot see happening. Needs the tags
	 *  feature. */
	BotNodeTag = "set_tag"
)

/* Meta's limits on an interactive message, which are therefore the builder's.
 *
 * Exported so the form enforces the same numbers the API does and the server is not
 * the first thing to mention them.
 */
const (
	/** BotMaxButtons is three reply buttons per question — Meta's cap. */
	BotMaxButtons = 3
	/** BotMaxButtonLabel is 20 characters on a button, also Meta's. */
	BotMaxButtonLabel = 20
	/** BotMaxText is the body of an interactive message: 1024, against 4096 for plain
	 *  text. One limit for both, so adding a button to a message cannot make its text
	 *  suddenly invalid. */
	BotMaxText = 1024
	/** BotMaxNodes is how big one flow may be. A bound rather than a design: past this
	 *  a flowchart is not the tool. */
	BotMaxNodes = 40
)

/* CRMBotButton is one reply button, and the edge the flow takes when it is pressed.
 *
 * Label is what the contact sees and also how their answer is matched: Meta sends the
 * button's id back, but a person who types "yes" instead of pressing anything is
 * answering the same question, so both are compared against the label.
 */
type CRMBotButton struct {
	Label string `json:"label"`
	/** The node this answer goes to, or empty to end the conversation there. */
	Next string `json:"next,omitempty"`
}

/* CRMBotNode is one step of a flow.
 *
 * One struct for all five kinds, with the fields each ignores left empty, because a
 * node is edited as one card in a builder where changing its kind must not throw away
 * what was typed into it.
 */
type CRMBotNode struct {
	/** The node's name inside this bot, and what every edge is written as. Generated
	 *  by the builder; never shown to the contact. */
	Key string `json:"key"`
	/** One of the BotNode constants. */
	Kind string `json:"kind"`
	/** What it says. Required for `message` and `ask`, optional for `handoff`, unused
	 *  by the rest. */
	Text string `json:"text,omitempty"`
	/** An `ask`'s buttons, in the order they are shown. At most BotMaxButtons. */
	Buttons []CRMBotButton `json:"buttons,omitempty"`
	/** Where the flow goes when this node is done, or empty to stop.
	 *
	 *  On an `ask` this is the fallback: where an answer that matched no button goes.
	 *  Empty there means hand the conversation to a person, on the grounds that a bot
	 *  which did not understand somebody should stop guessing. */
	Next string `json:"next,omitempty"`
	/** How long a `wait` pauses. Capped at 24 hours: Meta's service window closes then
	 *  and a flow that slept through it cannot speak. */
	DelayMinutes int `json:"delayMinutes,omitempty"`
	/** The sequence an `enroll` node uses. */
	DripID string `json:"dripId,omitempty"`
	/** Its name, read-only, so the builder can show the sequence without a second
	 *  request. Empty also means the sequence has since been deleted — the node is
	 *  then broken, and the runtime steps over it rather than stopping. */
	DripName string `json:"dripName,omitempty"`
	/** The tag a `set_tag` node applies, and its name read-only, on the same terms as
	 *  the sequence above: empty means the tag was deleted and the step does nothing. */
	TagID   string `json:"tagId,omitempty"`
	TagName string `json:"tagName,omitempty"`
}

/* CRMBot is a flow and the rule that starts it.
 *
 * The only thing in this CRM that sends without the host asking, message by message,
 * which is why Active defaults off and why the runtime checks opt-out, the service
 * window and a per-conversation step budget before every send.
 */
type CRMBot struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	/** BotAnyMessage or BotKeyword. */
	Trigger string `json:"trigger"`
	/** The words that start it, lower-cased, matched against the whole message.
	 *  Only for BotKeyword. */
	Keywords []string `json:"keywords,omitempty"`
	/** The node a new conversation starts at. */
	Entry string `json:"entry"`
	/** False parks it: no new conversations, and the ones under way stop at their next
	 *  step. A host may have only one active bot on BotAnyMessage, since two would
	 *  both match every message. */
	Active bool `json:"active"`
	/** Every node, in the builder's order. A bot with none cannot be saved. */
	Nodes []CRMBotNode `json:"nodes"`
	Stats CRMBotStats  `json:"stats"`
	/** RFC3339. */
	CreatedAt string `json:"createdAt"`
}

/* CRMBotStats is how many conversations this bot is in, by what became of them.
 *
 * Disjoint, and they add up to every conversation it has ever had.
 */
type CRMBotStats struct {
	/** Mid-question: the bot has asked and is waiting for an answer. */
	Waiting int `json:"waiting"`
	/** Held by a `wait` node until its time comes. */
	Sleeping int `json:"sleeping"`
	/** Ran to the end of the flow. */
	Done int `json:"done"`
	/** Given to a person. */
	HandedOff int `json:"handedOff"`
	/** Ended for a reason nobody chose — see CRMBotSession.EndedReason. */
	Stopped int `json:"stopped"`
}

/* CRMBotSession is one person's trip through one flow.
 *
 * Kept after it finishes: where conversations stop is the only honest review of a
 * flow, and a stack of sessions ending at the same question is the thing worth seeing.
 */
type CRMBotSession struct {
	ID        string `json:"id"`
	ContactID string `json:"contactId"`
	/** For the list, so it reads as people rather than ids. */
	ContactName string `json:"contactName,omitempty"`
	Phone       string `json:"phone,omitempty"`
	/** The node it is at, or the one it stopped at. */
	NodeKey string `json:"nodeKey,omitempty"`
	/** waiting / sleeping / done / handoff / stopped. */
	State string `json:"state"`
	/** Why it ended, in codes: `handed_over` (a handoff node), `host_took_over`,
	 *  `window_closed` (asleep past WhatsApp's 24 hours), `node_missing` (the flow
	 *  was edited underneath it), `too_many_steps`, `opted_out`, `bot_off`,
	 *  `send_failed`, `whatsapp_disconnected`. Empty for a flow that simply ran to
	 *  the end. */
	EndedReason string `json:"endedReason,omitempty"`
	/** RFC3339, when a sleeping flow wakes. */
	ResumeAt string `json:"resumeAt,omitempty"`
	/** Nodes run so far, which is what the step budget counts. */
	Steps     int    `json:"steps"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

/** CRMBotSequence is one of the host's drip sequences, as an `enroll` node's options:
 *  the id to store and the name to show, and nothing else the builder needs. */
type CRMBotSequence struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CRMBotsResponse is the host's bots, newest first.
type CRMBotsResponse struct {
	Bots []CRMBot `json:"bots"`
	/** The triggers and node kinds this server implements, so the builder cannot offer
	 *  one it would refuse. */
	Triggers  []string `json:"triggers"`
	NodeKinds []string `json:"nodeKinds"`
	/** What an `enroll` node may point at. */
	Sequences []CRMBotSequence `json:"sequences"`
	/** What a `set_tag` node may point at. Empty when the tags feature is off for this
	 *  account, which is also when `set_tag` is not in NodeKinds. */
	Tags []CRMTag `json:"tags"`
	/** False once WhatsApp is disconnected. Bots stay readable and stay off: a flow
	 *  cannot answer anybody when nothing is receiving their messages. */
	WhatsAppConnected bool `json:"whatsappConnected"`
}

// CRMBotResponse is one bot with the conversations it has had.
type CRMBotResponse struct {
	Bot CRMBot `json:"bot"`
	/** Newest first, capped: a view of who it talked to, not an export. */
	Sessions []CRMBotSession `json:"sessions"`
}

/* CRMBotRequest writes a bot, nodes and all.
 *
 * The whole flow in one call, for the reason CRMDripRequest gives and one more: the
 * edges are checked against each other — every `next` has to name a node that exists,
 * and the graph has to be free of cycles — which is only possible when the nodes
 * arrive together.
 */
type CRMBotRequest struct {
	Name    string `json:"name"`
	Trigger string `json:"trigger"`
	/** Required for BotKeyword, ignored otherwise. Lower-cased and de-duplicated by
	 *  the server. */
	Keywords []string `json:"keywords,omitempty"`
	Entry    string   `json:"entry"`
	/** Whether it answers anybody. Absent is false, so a request that forgets it
	 *  creates a bot nobody is talking to yet. */
	Active bool         `json:"active"`
	Nodes  []CRMBotNode `json:"nodes"`
}

/* CRMBotPauseRequest hands a conversation between the bot and a person.
 *
 * On the contact rather than on a session because that is the scope of the decision:
 * "I am dealing with this person" has to hold for their next message too, which may
 * arrive after the flow they were in has ended.
 */
type CRMBotPauseRequest struct {
	/** True stops any bot answering this contact; false lets them run again. */
	Paused bool `json:"paused"`
}

type SignupRequest struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Org      string `json:"org,omitempty"`
	Title    string `json:"title,omitempty"`
	// Phone is E.164 shape, same as Registration.Phone — see validateSignup
	// for the shape check and store.normalisePhone for how it's stored.
	Phone string `json:"phone,omitempty"`
	/* WantsHost is ACCEPTED AND IGNORED, and the field is kept for exactly that reason.
	 *
	 * Every new account gets hosting automatically now (see handleSignup) — nothing left to
	 * ask for. Removing the field outright would make an older cached bundle's signup fail
	 * on an unknown-field error, since this API rejects unknown fields, so the request still
	 * parses and the value no longer does anything either way.
	 */
	WantsHost bool `json:"wantsHost"`
}

// HostGrant is an admin's decision about one account's hosting capability —
// still the only way to take it away from an account after signup.
type HostGrant struct {
	CanHost bool `json:"canHost"`
}

// CdnBroadcastGrant is an admin's grant allowing a host account to use CDN broadcast mode.
type CdnBroadcastGrant struct {
	CanCdnBroadcast bool `json:"canCdnBroadcast"`
}

/* FeatureGrant switches one feature on or off for one account.
 *
 * One feature per request, with the state it should end in rather than a verb, for the
 * reason handleSetHostCapability gives: the UI is a switch and a retried request must
 * not toggle anything back. Sending the whole set instead would make two admins on two
 * screens overwrite each other's decisions about features neither of them touched.
 */
type FeatureGrant struct {
	/** One of the Feature keys. Anything else is refused rather than stored. */
	Feature string `json:"feature"`
	Enabled bool   `json:"enabled"`
}

/* AdminUser is one row of the admin panel.
 *
 * Carries what an admin needs to decide whether this person should be able to run webinars —
 * who they are, how to reach them about it, when they joined — and nothing more. No password
 * hash, no session data, and no registration history: the panel's job is granting a capability,
 * not profiling users.
 */
type AdminUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Title string `json:"title,omitempty"`
	Org   string `json:"org,omitempty"`
	// Phone is E.164 shape, same as Account.Phone — the number given at signup, so an
	// admin can reach the account holder about hosting without going to the database.
	// Admin-only: it is still absent from Person, which is what other attendees see.
	Phone     string `json:"phone,omitempty"`
	Initials  string `json:"initials"`
	Hue       string `json:"hue"`
	CanHost   bool   `json:"canHost"`
	IsAdmin   bool   `json:"isAdmin"`
	CreatedAt string `json:"createdAt"`
	// WebinarCount is why revoking is not always safe: an account that owns scheduled
	// sessions still needs to be able to start them.
	WebinarCount int `json:"webinarCount"`
	// MaxDurationMin is an optional custom maximum meeting duration in minutes configured by an admin.
	MaxDurationMin *int `json:"maxDurationMin,omitempty"`
	// CanCdnBroadcast reports whether this user is enabled for CDN broadcast webinars.
	CanCdnBroadcast bool `json:"canCdnBroadcast"`
	// Features are the per-account switches that are on — see Features and
	// FeatureGrant. Always present, empty for an account with none.
	Features []string `json:"features"`
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
	Phone *string `json:"phone,omitempty"`
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
	/** Permission for the HOST to send WhatsApp messages to Phone — a separate
	 *  decision from Consent, which covers the registration itself.
	 *
	 *  Its own field rather than an answer, because Meta requires opt-in to be
	 *  recorded per person and it has to be as auditable as the number it applies
	 *  to. Ignored without a phone number: there is nothing to opt a person in to
	 *  when there is no way to reach them. */
	WhatsAppOptIn bool `json:"whatsappOptIn,omitempty"`
	/** The webinar's passcode, when it has one. Checked at registration, which is the
	 *  one gate every attendee passes through — a join key is only issued here. */
	Passcode string `json:"passcode,omitempty"`
}

type Registration struct {
	ID        string `json:"id,omitempty"`
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
	/* CanRecord answers whether this ACCOUNT may see the record control at all,
	 * decided by the server rather than inferred from the role.
	 *
	 * It is NOT the same as CanPublish. The recording endpoints sit behind
	 * requireStage, which wants an ACCOUNT on this webinar's stage roster — the
	 * host, or a name on the panelist list. An attendee the host promoted
	 * publishes exactly like a panelist and has no account at all, so inferring
	 * this from publish permission offered them a button whose every request came
	 * back 401.
	 *
	 * Deliberately NOT gated on whether the instance has recording storage
	 * configured any more — that used to fold into this field, which hid the
	 * button outright on an instance with RECORDINGS_ENABLED=false, even though
	 * local, on-device recording needs no server storage at all. See
	 * AppConfig.CloudRecordingEnabled for that half of the question; the record
	 * control combines both to decide which destinations to offer.
	 */
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
	// MaxDurationMin is the maximum allowed duration for this session in minutes.
	MaxDurationMin int `json:"maxDurationMin"`
	// CdnBroadcast is true when this webinar's *audience* is on the mixed
	// program (WHEP live, HLS/file for simulive), including for a promoted
	// attendee — so demote can put them back on the mix player.
	// CdnStreamURL is what to play; set whenever the webinar is in that mode
	// so a demote remount still has a URL.
	CdnBroadcast bool   `json:"cdnBroadcast,omitempty"`
	CdnStreamURL string `json:"cdnStreamUrl,omitempty"`
	// CdnLowLatency is true when CdnStreamURL is the live origin (WHEP),
	// so the player can sit close to the live edge. False for simulive.
	CdnLowLatency bool `json:"cdnLowLatency,omitempty"`
}

type SetUserMaxDurationRequest struct {
	MaxDurationMin *int `json:"maxDurationMin"`
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
	// MaxDurationMin is the maximum allowed duration for this session in minutes.
	MaxDurationMin int `json:"maxDurationMin,omitempty"`
}

// ------------------------------------------------------------------ recordings

type RecordingStatus string

const (
	RecordingActive     RecordingStatus = "recording"
	RecordingProcessing RecordingStatus = "processing"
	RecordingReady      RecordingStatus = "ready"
	RecordingFailed     RecordingStatus = "failed"
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
	Ext              string `json:"ext"`
	EgressID         string `json:"egressId,omitempty"`
	IsPublic         bool   `json:"isPublic"`
	Passcode         string `json:"passcode,omitempty"`
	PasscodeRequired bool   `json:"passcodeRequired"`
	UploadedToS3     bool   `json:"uploadedToS3"`
	UploadPercent    int    `json:"uploadPercent"`
	// RetentionDays is how long cloud recordings are kept (from createdAt).
	// 0 means the instance does not auto-delete.
	RetentionDays int `json:"retentionDays"`
	// ExpiresAt is when this file will be deleted from cloud storage, RFC3339.
	// Empty when retention is disabled or createdAt could not be parsed.
	ExpiresAt string `json:"expiresAt,omitempty"`
	// Parts is every take in this session, oldest first. Stop-then-record-again
	// appends a part rather than listing a second recording. A session with a
	// single take still has one entry, so the player does not have to special-case
	// the shape.
	Parts []RecordingPart `json:"parts,omitempty"`
}

// RecordingPart is one start/stop take inside a session. The bytes are a
// finished file; the session is the thing a host plays, shares and deletes.
type RecordingPart struct {
	ID         string          `json:"id"`
	Status     RecordingStatus `json:"status"`
	SizeBytes  int64           `json:"sizeBytes"`
	DurationMs int64           `json:"durationMs"`
	CreatedAt  string          `json:"createdAt"`
}

// StartRecordingRequest is sent by the browser that will do the capturing. It
// names the container it can produce, because that differs by browser and the
// server has to store what it is actually given.
type StartRecordingRequest struct {
	Mime string `json:"mime"`
}

// ShareRecordingRequest is sent by the host to configure public access and passcode.
type ShareRecordingRequest struct {
	IsPublic *bool   `json:"isPublic,omitempty"`
	Passcode *string `json:"passcode,omitempty"`
}

// PublicRecording is the sanitized recording metadata returned to anonymous viewers.
type PublicRecording struct {
	ID               string          `json:"id"`
	Webinar          string          `json:"webinar"`
	Topic            string          `json:"topic"`
	Status           RecordingStatus `json:"status"`
	HostName         string          `json:"hostName"`
	DurationMs       int64           `json:"durationMs"`
	SizeBytes        int64           `json:"sizeBytes"`
	CreatedAt        string          `json:"createdAt"`
	Ext              string          `json:"ext"`
	PasscodeRequired bool            `json:"passcodeRequired"`
	Unlocked         bool            `json:"unlocked"`
	UploadedToS3     bool            `json:"uploadedToS3"`
	UploadPercent    int             `json:"uploadPercent"`
	RetentionDays    int             `json:"retentionDays"`
	ExpiresAt        string          `json:"expiresAt,omitempty"`
	Parts            []RecordingPart `json:"parts,omitempty"`
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
	// CoHost is a panelist the host made their equal: full moderation rights,
	// not just a stage seat. See lk.Spec.CoHost.
	CoHost bool `json:"coHost"`
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
	// AudioOnly is "allow to speak": the attendee gets a microphone and a screen
	// share, but no camera.
	//
	// This is the common case by far. A host taking a question wants to hear one
	// person, not hand them the stage, and a full promotion means an unprepared
	// attendee's camera and desktop are one click from 500 people.
	AudioOnly bool `json:"audioOnly"`
}

type MuteAllResponse struct {
	Muted int `json:"muted"`
}

// StageAllResponse reports a bulk allow-all-to-speak or revoke-all-speaking
// action — how many attendees it actually applied to, the same shape as
// MuteAllResponse and for the same reason: a host clicking a bulk action on
// an empty or already-settled room needs to see that nothing silently
// failed, not just a bare 200.
type StageAllResponse struct {
	Count int `json:"count"`
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

// CoHostPatch turns a panelist into a second, equal moderator for this run of
// the webinar, or turns them back into an ordinary panelist. See
// lk.Spec.CoHost for exactly what that grants and withholds.
type CoHostPatch struct {
	CoHost bool `json:"coHost"`
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
	// DefaultMaxMeetingMin is the system default maximum meeting duration in minutes (default 180 = 3h).
	DefaultMaxMeetingMin int `json:"defaultMaxMeetingMin"`
	// Tracks are the topic tags already in use, offered as suggestions rather
	// than a fixed enum so an operator never has to edit a list in the bundle.
	Tracks []string `json:"tracks"`
	// GoogleClientID and GoogleAPIKey turn on the Google Drive source in the
	// share-a-file picker. Both are public values — see config.Config — and both
	// are empty unless an operator sets them, which the picker reports as "not
	// configured" rather than failing on click.
	GoogleClientID string `json:"googleClientId,omitempty"`
	GoogleAPIKey   string `json:"googleApiKey,omitempty"`
	/* YouTubeOAuth is whether GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both
	 * set, so Account settings can offer Connect YouTube. Distinct from GoogleAuth
	 * (Supabase sign-in) and from GoogleClientID used for Drive Picker. */
	YouTubeOAuth bool `json:"youtubeOAuth,omitempty"`
	/* WhatsAppConnect is whether META_APP_ID, META_APP_SECRET and
	 * META_WHATSAPP_CONFIG_ID are all set, so Account settings can offer Connect
	 * WhatsApp. Only the flag is public: the app id and the signup configuration id
	 * are handed out by GET /api/host/whatsapp/connect, to a signed-in host at the
	 * moment they click, rather than to every anonymous visitor at boot. */
	WhatsAppConnect bool `json:"whatsappConnect,omitempty"`
	/* Supabase Auth (Google sign-in). Public values only — the JWT secret stays
	 * on the API. When googleAuth is false the Continue with Google button is hidden.
	 *
	 * Distinct from GoogleClientID above: that pair is Drive Picker, not login.
	 */
	SupabaseURL     string `json:"supabaseUrl,omitempty"`
	SupabaseAnonKey string `json:"supabaseAnonKey,omitempty"`
	GoogleAuth      bool   `json:"googleAuth,omitempty"`
	/* CloudRecordingEnabled is whether this instance has object storage for
	 * recordings at all (RECORDINGS_ENABLED). Separate from JoinResponse.CanRecord,
	 * which is about the ACCOUNT (host or panelist); this is about the INSTANCE.
	 * The record control uses it to decide whether to offer "the cloud" as a
	 * destination at all, rather than offering a button that always 503s — local,
	 * on-device recording (see web/lib/local-recording.ts) needs neither this nor
	 * the server's storage, so it is unaffected by it either way.
	 */
	CloudRecordingEnabled bool   `json:"cloudRecordingEnabled"`
	RecordingMode         string `json:"recordingMode,omitempty"`
	// RecordingsRetentionDays is how long cloud recordings are kept before
	// automatic deletion. 0 means they are kept until a host deletes them.
	RecordingsRetentionDays int `json:"recordingsRetentionDays"`
	// EmailConfigured is whether SMTP can actually deliver. The UI uses it to
	// say "we'll email you" vs "save this join link; mail is off".
	EmailConfigured bool `json:"emailConfigured"`
	// TelemetryEnabled mirrors config.Config.TelemetryEnabled: whether POST
	// /telemetry accepts anything. The frontend's telemetry poller checks this
	// before attaching a single listener or sampling a single stat, so turning
	// the flag off also turns off the client-side work, not just the endpoint.
	TelemetryEnabled bool `json:"telemetryEnabled,omitempty"`
	/* FeatureCatalogue is every per-account switch this server has, with the sentence
	 * that explains each one — see Features. Sent here rather than with the accounts
	 * list so that adding a switch does not change the shape of that response, and so
	 * the admin screen renders what this build actually supports instead of a list the
	 * browser keeps its own copy of. */
	FeatureCatalogue []Feature `json:"featureCatalogue"`
}

/* TelemetryEvent is one entry in a POST /telemetry batch — the shape is
 * intentionally loose (Payload is a bag of whatever the client measured)
 * because this is a temporary diagnostic path for one test window, not a
 * contract anything else in the app depends on. See handleTelemetry.
 */
type TelemetryEvent struct {
	Event     string         `json:"event"`
	Timestamp int64          `json:"timestamp"` // epoch ms, client clock
	Payload   map[string]any `json:"payload,omitempty"`
}

type APIError struct {
	Error   string            `json:"error"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

type StatusResponse struct {
	Status string `json:"status"`
}
