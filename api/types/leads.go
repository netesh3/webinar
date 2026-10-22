package types

/* Hot leads and the follow-up writer, in the host's Results tab.
 *
 * The ranking is counted (internal/leads), never written by a model; the AI adds a one-line
 * reason to the top leads, and drafts a follow-up email and WhatsApp message per group.
 * Both are written once per session end and cached: there is no regenerate. The host may
 * edit the drafts, and the edits are kept. Nothing is sent from here: sending is the host's
 * own press, after a review screen (followup_send.go). */

// AI feature names for these two, as recorded in ai_usage.
const (
	AIFeatureLeads     = "leads"
	AIFeatureFollowups = "followups"
)

/* Why the AI part is not there (LeadsResponse.AIStatus, FollowupsResponse.Status):
 * ready, or one of the recap's reasons — ai_off (the ACCOUNT has no ai feature),
 * ai_session_off (the account has AI but this session's AI switch was off), ai_limit (the
 * monthly AI budget is used up), ai_unavailable, not_ended, processing, failed — or empty
 * (nobody took part, so nobody to write for). */
const (
	AIStatusReady = "ready"
)

// LeadSignals is what one person did, counted. WatchPct is of the live session.
type LeadSignals struct {
	WatchMin     int  `json:"watchMin"`
	WatchPct     int  `json:"watchPct"`
	Joined       bool `json:"joined"`
	ReplayMin    int  `json:"replayMin,omitempty"`
	ReplayOpened bool `json:"replayOpened,omitempty"`
	Questions    int  `json:"questions,omitempty"`
	Upvotes      int  `json:"upvotes,omitempty"`
	Chats        int  `json:"chats,omitempty"`
	PollAnswers  int  `json:"pollAnswers,omitempty"`
	RaisedHand   bool `json:"raisedHand,omitempty"`
	OnStage      bool `json:"onStage,omitempty"`
	OfferClicks  int  `json:"offerClicks,omitempty"`
}

/* Lead is one ranked person. Key is stable for the session (a registration id, else the
 * room identity). Email and Phone are what the host already sees in People. Tag is hot,
 * warm or cold; Group is attended, left_early or no_show. Reason is the AI's line, for the
 * top leads only, empty otherwise. RegistrationID is empty for somebody who never
 * registered (a meeting guest). */
type Lead struct {
	Key            string      `json:"key"`
	RegistrationID string      `json:"registrationId,omitempty"`
	Name           string      `json:"name"`
	Email          string      `json:"email,omitempty"`
	Phone          string      `json:"phone,omitempty"`
	Score          int         `json:"score"`
	Tag            string      `json:"tag"`
	Group          string      `json:"group"`
	Signals        LeadSignals `json:"signals"`
	Reason         string      `json:"reason,omitempty"`
	/** The person's CRM contact and WhatsApp standing, as on the People tab's roster; empty
	 * when WhatsApp is not connected or there is no contact. */
	ContactID      string `json:"contactId,omitempty"`
	WhatsAppStatus string `json:"whatsappStatus,omitempty"`
}

/* LeadsResponse is GET /api/host/webinars/{slug}/leads: everybody, ranked. AIStatus is
 * ready when the reasons are in; otherwise why not (the list is there either way, since it
 * is counted). SessionMin is the live session's length. */
type LeadsResponse struct {
	Leads       []Lead `json:"leads"`
	AIStatus    string `json:"aiStatus"`
	SessionMin  int    `json:"sessionMin"`
	GeneratedAt string `json:"generatedAt,omitempty"`
}

// FollowupDraft is one group's drafts: an email and a WhatsApp message.
type FollowupDraft struct {
	EmailSubject string `json:"emailSubject"`
	EmailBody    string `json:"emailBody"`
	WhatsApp     string `json:"whatsapp"`
}

/* FollowupGroup is one group: hot, attended, left_early or no_show. Count is how many
 * people are in it (the people are in GET …/leads, by group and tag). Draft is the host's
 * edit when Edited, else what the AI wrote; nil when the group is empty. */
type FollowupGroup struct {
	Group  string         `json:"group"`
	Count  int            `json:"count"`
	Draft  *FollowupDraft `json:"draft,omitempty"`
	Edited bool           `json:"edited,omitempty"`
}

/* FollowupsResponse is GET /api/host/webinars/{slug}/followups[?lang=en|hinglish].
 * Language is what the drafts are in: detected from what was said unless the host picked.
 * ReplayLink fills {{replay_link}}: the latest public recording, empty when there is none. Errors: 429 ai_limit, 503 ai_unavailable. Status says why there are no drafts
 * otherwise (ai_off, ai_session_off, not_ended, empty, processing, failed). */
type FollowupsResponse struct {
	Status      string          `json:"status"`
	Language    string          `json:"language"`
	Groups      []FollowupGroup `json:"groups"`
	ReplayLink  string          `json:"replayLink,omitempty"`
	GeneratedAt string          `json:"generatedAt,omitempty"`
}

// FollowupEditRequest is PUT /api/host/webinars/{slug}/followups/{group}[?lang=]: the host's edit.
type FollowupEditRequest struct {
	Draft FollowupDraft `json:"draft"`
}
