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
	/** How many of those they joined: "came to 2 of 3". */
	AttendedWebinars int `json:"attendedWebinars"`
	/** The latest of those, by start time. Empty when there are none. */
	LastWebinar   string `json:"lastWebinar,omitempty"`
	LastWebinarID string `json:"lastWebinarId,omitempty"`
	Attended      bool   `json:"attended"`
	WatchMin      int    `json:"watchMin"`
	/** Across webinars, from the Audience rollup: average score over the ones they joined
	 *  (0 when none), and their latest tier. */
	AvgScore int    `json:"avgScore"`
	Tier     string `json:"tier,omitempty"`
}

/* People filters. Everyone is the empty filter. */
const (
	PeopleAttended      = "attended"
	PeopleNeverAttended = "never_attended"
	PeopleReplied       = "replied"
	PeopleOptedIn       = "opted_in"
	/** Tagged by the hot-lead recipe. */
	PeopleHotLeads = "hot_leads"
	/** Came 2+ and average score 50+ (the Audience tab's "best people"). */
	PeopleHighlyEngaged = "highly_engaged"
	/** Came to 2 or more. */
	PeopleCameBack = "came_back"
	/** Registered 2+ and never came. */
	PeopleSlipping = "slipping"
)

// CRMPeopleCounts are the chips over the People list, counted through the webinar filter
// but not the search box or the chosen chip.
type CRMPeopleCounts struct {
	Everyone      int `json:"everyone"`
	Attended      int `json:"attended"`
	NeverAttended int `json:"neverAttended"`
	Replied       int `json:"replied"`
	OptedIn       int `json:"optedIn"`
	HotLeads      int `json:"hotLeads"`
	HighlyEngaged int `json:"highlyEngaged"`
	CameBack      int `json:"cameBack"`
	Slipping      int `json:"slipping"`
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
	/** Waiting on the host but snoozed until later. */
	InboxSnoozed = "snoozed"
	/** Tagged by the hot-lead recipe. */
	InboxHotLeads = "hot_leads"
	/** Their newest inbound message has not been opened, and the thread is not snoozed. */
	InboxUnread = "unread"
)

// CRMInboxThread is one row of the Messages tab.
type CRMInboxThread struct {
	Contact     CRMContact  `json:"contact"`
	LastMessage *CRMMessage `json:"lastMessage,omitempty"`
	NeedsReply  bool        `json:"needsReply"`
	/** Their newest inbound message has not been opened. Independent of NeedsReply:
	 *  opening the thread clears this without counting as an answer. */
	Unread bool `json:"unread"`
	/** The webinar of the last message sent to them — what the line under a name says.
	 *  Empty when none was about a webinar. */
	Webinar   string `json:"webinar,omitempty"`
	WebinarID string `json:"webinarId,omitempty"`
	/** RFC3339 when a snooze is running, else empty. */
	SnoozedUntil string `json:"snoozedUntil,omitempty"`
	/** Tagged by the hot-lead recipe. */
	HotLead bool `json:"hotLead"`
}

type CRMInboxCounts struct {
	NeedsReply int `json:"needsReply"`
	All        int `json:"all"`
	Done       int `json:"done"`
	Snoozed    int `json:"snoozed"`
	HotLeads   int `json:"hotLeads"`
	/** Conversations whose newest inbound message the host has not opened. */
	Unread int `json:"unread"`
}

// CRMSnoozeRequest snoozes a conversation until a time, or wakes it with an empty until.
type CRMSnoozeRequest struct {
	/** RFC3339, in the future and within 30 days; empty wakes it now. */
	Until string `json:"until"`
}

/* CRMSnippet is one of the host's saved quick replies. */
type CRMSnippet struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

// CRMSnippetsResponse is the host's quick replies, in their order.
type CRMSnippetsResponse struct {
	Snippets []CRMSnippet `json:"snippets"`
}

// CRMSnippetRequest writes one quick reply.
type CRMSnippetRequest struct {
	Title string `json:"title"`
	Body  string `json:"body"`
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
	/** Where this page starts. */
	Offset int `json:"offset"`
	/** Threads in the current view, of which Threads is one page. */
	Total int `json:"total"`
}

// CRMDoneRequest marks a conversation done, or reopens it.
type CRMDoneRequest struct {
	Done bool `json:"done"`
}

/* CRMReplyAlert is one conversation waiting, for the bell. */
type CRMReplyAlert struct {
	ContactID string `json:"contactId"`
	Name      string `json:"name"`
	/** Their last message, for a one-line preview. */
	Preview   string `json:"preview,omitempty"`
	Webinar   string `json:"webinar,omitempty"`
	WebinarID string `json:"webinarId,omitempty"`
	At        string `json:"at"`
}

/* CRMRepliesResponse is the bell's share of the inbox: how many are waiting, the newest
 * few, and the waiting count per webinar for "N replies to answer" on its card. */
type CRMRepliesResponse struct {
	NeedsReply int `json:"needsReply"`
	/** Conversations the host has not opened. This is the chat badge. NeedsReply
	 *  stays the unanswered count: opening a thread clears Unread and leaves
	 *  NeedsReply until they answer or mark it done. */
	Unread    int             `json:"unread"`
	Recent    []CRMReplyAlert `json:"recent"`
	ByWebinar map[string]int  `json:"byWebinar"`
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
	Waiting           []CRMReplyAlert   `json:"waiting"`
	Results           CRMWebinarResults `json:"results"`
	WhatsAppConnected bool              `json:"whatsappConnected"`
	/** Resolved message slots for this webinar, and which layer each field came from. */
	Slots []MessageSlot `json:"slots"`
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
	/** Their webinars with this host, newest first: the profile panel's watch bars and
	 *  the thread's day markers ("Joined live, watched 55 of 60 min"). */
	History []CRMThreadWebinar `json:"history"`
}

/* CRMThreadWebinar is one webinar a person registered for. */
type CRMThreadWebinar struct {
	ID          string `json:"id"`
	Topic       string `json:"topic"`
	StartsAt    string `json:"startsAt"`
	DurationMin int    `json:"durationMin"`
	Ended       bool   `json:"ended"`
	Joined      bool   `json:"joined"`
	WatchMin    int    `json:"watchMin"`
}

/* CRMWebinarResults is what WhatsApp did for one webinar: the Messages tab's results
 * panel and the journey's Live step. Show-up is split by whether a WhatsApp reminder
 * actually reached the registrant, which is the comparison a coach is paying for. */
type CRMWebinarResults struct {
	Registered  int `json:"registered"`
	Joined      int `json:"joined"`
	AvgWatchMin int `json:"avgWatchMin"`
	/** Registrants a WhatsApp reminder was sent to, and how many of them joined. */
	Reminded       int `json:"reminded"`
	RemindedJoined int `json:"remindedJoined"`
	/** Everybody else (email only), and how many of them joined. */
	Others       int `json:"others"`
	OthersJoined int `json:"othersJoined"`
	/** Messages about this webinar that left: automatic and follow-ups. */
	Sent int `json:"sent"`
	Read int `json:"read"`
	/** Of those, template messages — the ones Meta bills — by category. */
	Marketing int `json:"marketing"`
	Utility   int `json:"utility"`
	/** People who wrote back after the first message about this webinar. */
	Replied int `json:"replied"`
}

/* CRMSummaryResponse is the Hosting home's "WhatsApp this week" card. */
type CRMSummaryResponse struct {
	Days int `json:"days"`
	Sent int `json:"sent"`
	Read int `json:"read"`
	/** People who wrote in during the period. */
	Replied    int  `json:"replied"`
	NeedsReply int  `json:"needsReply"`
	NewOptIns  int  `json:"newOptIns"`
	Connected  bool `json:"connected"`
	/** The next thing that will go out: a reminder or a scheduled follow-up. */
	NextSendAt    string `json:"nextSendAt,omitempty"`
	NextSendLabel string `json:"nextSendLabel,omitempty"`
}

/* CRMFollowupGroup is one card of the Engagement tab's Follow up: an engagement tier, or
 * the no-shows, as the segment a send resolves — so the card, the count in the send
 * dialog and the people messaged are the same. */
type CRMFollowupGroup struct {
	/** `high`, `engaged`, `passive`, `risk` or `no_show`. */
	ID      EngagementTier `json:"id"`
	Segment CRMSegment     `json:"segment"`
	/** Who in the group WhatsApp can reach, in the audience's four buckets. */
	Audience CRMAudienceResponse `json:"audience"`
	/** A few reachable people, for the card's faces. Params is empty. */
	Faces []CRMAudienceSample `json:"faces"`
	/** The latest follow-up sent or scheduled to exactly this group; nil when none. */
	Broadcast *CRMBroadcast `json:"broadcast,omitempty"`
}

/* CRMFollowupsResponse is the Engagement tab's Follow up section. */
type CRMFollowupsResponse struct {
	WebinarID string `json:"webinarId"`
	/** False until the webinar's engagement has been computed: tiers match nobody yet. */
	Scored            bool               `json:"scored"`
	Groups            []CRMFollowupGroup `json:"groups"`
	WhatsAppConnected bool               `json:"whatsappConnected"`
}

/* A recipe is a ready-made automation a host turns on: a preset over the drip and bot
 * engines (and one small rule of its own), so a coach starts from "Replay for people who
 * missed it" rather than an empty builder. See migrations/0062. */
const (
	RecipeReminders = "reminders"
	RecipeNoShow    = "replay_no_show"
	RecipeHigh      = "offer_high"
	RecipeEngaged   = "thanks_engaged"
	RecipePassive   = "replay_passive"
	RecipeRisk      = "replay_risk"
	RecipeKeywords  = "keyword_replies"
	RecipeHotLeads  = "hot_leads"
)

/* CRMRecipe is one card on the Automations page. */
type CRMRecipe struct {
	/** One of the Recipe constants. */
	ID    string `json:"id"`
	Title string `json:"title"`
	/** The flow in a few words, one per step: "Didn't join", "2 h after end", "Replay link". */
	Flow []string `json:"flow"`
	/** `followup` (a drip after every webinar), `reminders` (the reminder settings),
	 *  `keywords` (a bot) or `hot_leads` (a tagging rule). */
	Kind string `json:"kind"`
	/** The Follow up group a `followup` recipe is for: an engagement tier or `no_show`. */
	Group EngagementTier `json:"group,omitempty"`
	/** Whether it is running. */
	Active bool `json:"active"`
	/** Set up but paused, so turning it on keeps what was chosen. */
	Configured bool `json:"configured"`
	/** A line from the coach's own data: "Would have reached 4 people from Morning Routines". */
	Hint string `json:"hint,omitempty"`
	/** For `followup`: the template, its params, and minutes after the end. */
	Template string     `json:"template,omitempty"`
	Language string     `json:"language,omitempty"`
	Params   []CRMParam `json:"params,omitempty"`
	DelayMin int        `json:"delayMin,omitempty"`
	/** For `keywords`: word → reply. For `hot_leads`: the words. */
	Keywords []CRMRecipeKeyword `json:"keywords,omitempty"`
	Words    []string           `json:"words,omitempty"`
	/** The drip or bot behind it, for "Open in builder". */
	DripID string `json:"dripId,omitempty"`
	BotID  string `json:"botId,omitempty"`
	/** Sent so far by the drip, or people tagged by the rule. */
	Sent int `json:"sent"`
}

/* CRMRecipeKeyword is one keyword reply: a word someone sends and what is sent back. */
type CRMRecipeKeyword struct {
	Word  string `json:"word"`
	Reply string `json:"reply"`
}

/* CRMRecipesResponse is the Automations page. */
type CRMRecipesResponse struct {
	Recipes           []CRMRecipe `json:"recipes"`
	WhatsAppConnected bool        `json:"whatsappConnected"`
}

/* CRMRecipeRequest turns a recipe on or off, with the choices it needs. */
type CRMRecipeRequest struct {
	Active   bool               `json:"active"`
	Template string             `json:"template,omitempty"`
	Language string             `json:"language,omitempty"`
	Params   []CRMParam         `json:"params,omitempty"`
	DelayMin int                `json:"delayMin,omitempty"`
	Keywords []CRMRecipeKeyword `json:"keywords,omitempty"`
	Words    []string           `json:"words,omitempty"`
}

/* CRMStarterTemplate is one of the ready-made templates a host can submit to Meta from
 * the Templates tab. Params are the merge fields to fill each {{n}} with. */
type CRMStarterTemplate struct {
	Name     string `json:"name"`
	Category string `json:"category"`
	/** What it is for: Confirmation, Reminder, Replay, Follow up. */
	Use      string              `json:"use"`
	Body     string              `json:"body"`
	Params   []string            `json:"params"`
	Examples []string            `json:"examples"`
	Buttons  []CRMTemplateButton `json:"buttons"`
	/** Meta's status once created (PENDING, APPROVED, REJECTED); empty when not yet. */
	Status string `json:"status,omitempty"`
	/** Meta's refusal, when submitting it failed. */
	Error string `json:"error,omitempty"`
}

type CRMStarterTemplatesResponse struct {
	Templates []CRMStarterTemplate `json:"templates"`
}

/* CRMAudienceSummary is the Audience tab: engagement across the host's webinars, read from
 * the per-person rollup (migrations/0065) and the saved per-webinar snapshots. */
type CRMAudienceSummary struct {
	/** People who registered for at least one webinar. */
	People int `json:"people"`
	/** Came to 2 or more. */
	CameBack int `json:"cameBack"`
	/** Came 2+ and average score 50+, and registered 2+ but never came. */
	BestCount     int `json:"bestCount"`
	SlippingCount int `json:"slippingCount"`
	/** Came to a webinar in the last 30 days. */
	ActiveMonth int `json:"activeMonth"`
	/** Over the webinars in Webinars: attended / registered, and the average session index. */
	ShowUpPct int                  `json:"showUpPct"`
	AvgIndex  int                  `json:"avgIndex"`
	Webinars  []CRMAudienceWebinar `json:"webinars"`
	Best      []CRMAudiencePerson  `json:"best"`
	Slipping  []CRMAudiencePerson  `json:"slipping"`
}

type CRMAudienceWebinar struct {
	ID         string `json:"id"`
	Topic      string `json:"topic"`
	StartsAt   string `json:"startsAt"`
	Registered int    `json:"registered"`
	Attended   int    `json:"attended"`
	Index      int    `json:"index"`
}

type CRMAudiencePerson struct {
	ContactID  string `json:"contactId"`
	Name       string `json:"name"`
	Registered int    `json:"registered"`
	Attended   int    `json:"attended"`
	AvgScore   int    `json:"avgScore"`
	Tier       string `json:"tier,omitempty"`
}
