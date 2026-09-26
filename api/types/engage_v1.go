package types

/* Engage v1: the People and Messages tabs on Hosting, and a webinar's Messages tab.
 * See docs/engage/V1.md.
 */

/* CRMPerson is one row of the People tab: a contact, and what they did across this
 * host's webinars. Watch minutes are the session report's, summed. */
type CRMPerson struct {
	Contact CRMContact `json:"contact"`
	/** One of the CRMStatus* consent values: opted_in, no_opt_in, opted_out, no_number. */
	WhatsAppStatus string `json:"whatsappStatus"`
	/** How many of this host's webinars they registered for (declined seats excluded). */
	Webinars int `json:"webinars"`
	/** The latest of those, by start time. Empty when there are none. */
	LastWebinar   string `json:"lastWebinar,omitempty"`
	LastWebinarID string `json:"lastWebinarId,omitempty"`
	Attended      bool   `json:"attended"`
	WatchMin      int    `json:"watchMin"`
}

/* People filters. Everyone is the empty filter. */
const (
	PeopleAttended      = "attended"
	PeopleNeverAttended = "never_attended"
	PeopleReplied       = "replied"
	PeopleOptedIn       = "opted_in"
)

// CRMPeopleCounts are the chips over the People list, counted through the webinar filter
// but not the search box or the chosen chip.
type CRMPeopleCounts struct {
	Everyone      int `json:"everyone"`
	Attended      int `json:"attended"`
	NeverAttended int `json:"neverAttended"`
	Replied       int `json:"replied"`
	OptedIn       int `json:"optedIn"`
}

// CRMWebinarRef names one of the host's webinars for a filter menu.
type CRMWebinarRef struct {
	ID       string `json:"id"`
	Topic    string `json:"topic"`
	StartsAt string `json:"startsAt"`
}

type CRMPeopleResponse struct {
	People []CRMPerson     `json:"people"`
	Counts CRMPeopleCounts `json:"counts"`
	/** Rows matching the chosen chip and search, of which People is one page. */
	Total    int             `json:"total"`
	Offset   int             `json:"offset"`
	Filter   string          `json:"filter,omitempty"`
	Webinars []CRMWebinarRef `json:"webinars"`
	/** How many of those webinars have anybody registered: "412 people from 6 webinars". */
	WebinarCount      int  `json:"webinarCount"`
	WhatsAppConnected bool `json:"whatsappConnected"`
}

/* CRMContactIDsResponse is every contact a People filter matches who may be messaged,
 * for "Message these N" on a filter bigger than one page. */
type CRMContactIDsResponse struct {
	ContactIDs []string `json:"contactIds"`
}

/* Inbox views. A conversation needs a reply while its newest inbound message is later
 * than both the host's last reply (from here or from their phone) and Mark done. */
const (
	InboxNeedsReply = "needs_reply"
	InboxAll        = "all"
	InboxDone       = "done"
)

// CRMInboxThread is one row of the Messages tab.
type CRMInboxThread struct {
	Contact     CRMContact  `json:"contact"`
	LastMessage *CRMMessage `json:"lastMessage,omitempty"`
	NeedsReply  bool        `json:"needsReply"`
	/** The webinar of the last message sent to them — what the line under a name says.
	 *  Empty when none was about a webinar. */
	Webinar   string `json:"webinar,omitempty"`
	WebinarID string `json:"webinarId,omitempty"`
}

type CRMInboxCounts struct {
	NeedsReply int `json:"needsReply"`
	All        int `json:"all"`
	Done       int `json:"done"`
}

type CRMInboxResponse struct {
	Threads           []CRMInboxThread `json:"threads"`
	Counts            CRMInboxCounts   `json:"counts"`
	View              string           `json:"view"`
	Webinars          []CRMWebinarRef  `json:"webinars"`
	WhatsAppConnected bool             `json:"whatsappConnected"`
	/** The number is on the WhatsApp Business app too (Coexistence): replies can also be
	 *  typed on the phone, and show up here. */
	Coexistence bool `json:"coexistence"`
}

// CRMDoneRequest marks a conversation done, or reopens it.
type CRMDoneRequest struct {
	Done bool `json:"done"`
}

/* CRMReplyAlert is one conversation waiting, for the bell. */
type CRMReplyAlert struct {
	ContactID string `json:"contactId"`
	Name      string `json:"name"`
	Webinar   string `json:"webinar,omitempty"`
	WebinarID string `json:"webinarId,omitempty"`
	At        string `json:"at"`
}

/* CRMRepliesResponse is the bell's share of the inbox: how many are waiting, the newest
 * few, and the waiting count per webinar for "N replies to answer" on its card. */
type CRMRepliesResponse struct {
	NeedsReply int             `json:"needsReply"`
	Recent     []CRMReplyAlert `json:"recent"`
	ByWebinar  map[string]int  `json:"byWebinar"`
}

/* CRMAutomaticStats is one automatic message for one webinar: the confirmation, one
 * reminder time, or the replay. */
type CRMAutomaticStats struct {
	Kind NotificationKind `json:"kind"`
	/** Minutes before the start, for a reminder. */
	OffsetMin int `json:"offsetMin,omitempty"`
	/** RFC3339, when a reminder is due. Empty for the others. */
	DueAt     string `json:"dueAt,omitempty"`
	Queued    int    `json:"queued"`
	Sent      int    `json:"sent"`
	Delivered int    `json:"delivered"`
	Read      int    `json:"read"`
	Failed    int    `json:"failed"`
	Skipped   int    `json:"skipped"`
}

/* CRMWebinarMessagesResponse is one webinar's Messages tab. */
type CRMWebinarMessagesResponse struct {
	WebinarID string `json:"webinarId"`
	/** Who this webinar's WhatsApp messages can reach, in the audience's four buckets:
	 *  "81 of 96 will get WhatsApp messages · 15 didn't give consent". */
	Audience  CRMAudienceResponse `json:"audience"`
	Automatic []CRMAutomaticStats `json:"automatic"`
	/** The template chosen for each automatic kind. Host-wide, shown here to be changed. */
	Templates  []CRMReminder  `json:"templates"`
	Broadcasts []CRMBroadcast `json:"broadcasts"`
	/** Conversations with this webinar's people that need a reply, newest first. */
	Waiting           []CRMReplyAlert `json:"waiting"`
	WhatsAppConnected bool            `json:"whatsappConnected"`
}

/* CRMTestSendRequest sends a template once to the host's own number, to see it. */
type CRMTestSendRequest struct {
	Template  string     `json:"template"`
	Language  string     `json:"language"`
	Params    []CRMParam `json:"params,omitempty"`
	WebinarID string     `json:"webinarId,omitempty"`
	Phone     string     `json:"phone"`
}

/* CRMThreadMeta is what the Messages tab's thread header says about a person. */
type CRMThreadMeta struct {
	Webinars   int  `json:"webinars"`
	WatchMin   int  `json:"watchMin"`
	NeedsReply bool `json:"needsReply"`
}
