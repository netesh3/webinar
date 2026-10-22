package types

/* Sending the AI follow-ups from Results → ✨ Follow-ups (api/internal/api/followup_send.go).
 *
 * The host picks people (one, or several), the server plans each one — which channels can
 * reach them and how — and the web shows ONE review screen with every message, editable,
 * rows removable. Only the host's Send sends; nothing is ever sent on its own.
 *
 *   email     from the host's name through our SMTP, Reply-To the host, with an
 *             unsubscribe link; skipped for an address that unsubscribed.
 *   whatsapp  through the host's own WABA, only to a contact who opted in. Inside the
 *             24-hour customer-service window the text goes as it is (freeform); outside
 *             it goes as our approved template wl_session_followup. Not opted in, or the
 *             template not approved yet: the review screen offers email instead.
 *
 * Every send is filed where its replies land (the contact's WhatsApp thread, the host's
 * email inbox) and recorded per person, session and channel, so the same follow-up is
 * not sent twice without an explicit "send again". */

// Channels, modes and per-recipient outcomes.
const (
	FollowupChannelEmail    = "email"
	FollowupChannelWhatsApp = "whatsapp"

	FollowupModeEmail    = "email"
	FollowupModeFreeform = "freeform"
	FollowupModeTemplate = "template"

	FollowupStatusSent    = "sent"
	FollowupStatusFailed  = "failed"
	FollowupStatusSkipped = "skipped"
)

// Why a channel cannot be used for somebody, or why a send was skipped or failed.
const (
	FollowupReasonAlreadySent  = "already_sent"
	FollowupReasonInProgress   = "in_progress"
	FollowupReasonUnsubscribed = "unsubscribed"
	FollowupReasonNoEmail      = "no_email"
	FollowupReasonMailOff      = "mail_unconfigured"
	FollowupReasonNotConnected = "whatsapp_not_connected"
	FollowupReasonNoContact    = "no_contact"
	FollowupReasonNoNumber     = "no_number"
	FollowupReasonOptedOut     = "opted_out"
	FollowupReasonNoOptIn      = "no_opt_in"
	FollowupReasonTemplate     = "template_not_approved"
	FollowupReasonNotInSession = "not_in_session"
	FollowupReasonEmpty        = "empty"
	FollowupReasonTooLong      = "too_long"
	FollowupReasonBadChannel   = "bad_channel"
	FollowupReasonSendFailed   = "send_failed"
	FollowupReasonRateLimited  = "rate_limited"
)

// FollowupTemplateName is our standard WhatsApp follow-up template, submitted per WABA.
const FollowupTemplateName = "wl_session_followup"

/* FollowupPlanRequest is POST /api/host/webinars/{slug}/followups/plan: the people to
 * review (types.Lead.Key), and the drafts' language as on GET …/followups. */
type FollowupPlanRequest struct {
	Keys     []string `json:"keys"`
	Language string   `json:"language,omitempty"`
}

/* FollowupChannelPlan is whether one channel can reach one person now. Mode is how a
 * WhatsApp would go (freeform or template). Sent is true when this follow-up already went
 * on this channel (SentAt): sending again needs "send again". */
type FollowupChannelPlan struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Mode      string `json:"mode,omitempty"`
	Sent      bool   `json:"sent,omitempty"`
	SentAt    string `json:"sentAt,omitempty"`
}

/* FollowupRecipient is one row of the review screen: the person, what each channel can do,
 * and their group's drafts with {{first_name}} and {{replay_link}} filled in for them. */
type FollowupRecipient struct {
	Key       string              `json:"key"`
	Name      string              `json:"name"`
	Group     string              `json:"group"`
	Tag       string              `json:"tag"`
	Email     string              `json:"email,omitempty"`
	Phone     string              `json:"phone,omitempty"`
	ContactID string              `json:"contactId,omitempty"`
	EmailPlan FollowupChannelPlan `json:"emailPlan"`
	WAPlan    FollowupChannelPlan `json:"whatsappPlan"`
	Subject   string              `json:"subject"`
	Body      string              `json:"body"`
	WhatsApp  string              `json:"whatsappText"`
}

/* FollowupPlanResponse is the review screen. TemplateStatus is Meta's status of
 * wl_session_followup on the host's WABA (empty: not submitted). MaxPerRequest is how many
 * items one POST …/followups/send takes; the web sends a longer list in chunks. */
type FollowupPlanResponse struct {
	Recipients        []FollowupRecipient `json:"recipients"`
	EmailEnabled      bool                `json:"emailEnabled"`
	WhatsAppConnected bool                `json:"whatsappConnected"`
	TemplateStatus    string              `json:"templateStatus,omitempty"`
	MaxPerRequest     int                 `json:"maxPerRequest"`
}

/* FollowupSendItem is one message the host reviewed: who, which channel, and the text as
 * they left it (Subject only for email; Body is the email body or the WhatsApp text). */
type FollowupSendItem struct {
	Key     string `json:"key"`
	Channel string `json:"channel"`
	Subject string `json:"subject,omitempty"`
	Body    string `json:"body"`
}

/* FollowupSendRequest is POST /api/host/webinars/{slug}/followups/send. Again sends to
 * people who already had this follow-up on that channel; without it they are skipped. */
type FollowupSendRequest struct {
	Items []FollowupSendItem `json:"items"`
	Again bool               `json:"again,omitempty"`
}

// FollowupSendResult is one item's outcome: sent, failed or skipped, and why.
type FollowupSendResult struct {
	Key       string `json:"key"`
	Channel   string `json:"channel"`
	Status    string `json:"status"`
	Mode      string `json:"mode,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Error     string `json:"error,omitempty"`
	ContactID string `json:"contactId,omitempty"`
}

type FollowupSendResponse struct {
	Results []FollowupSendResult `json:"results"`
}

/* FollowupTemplateResponse is GET/POST /api/host/crm/followup-template: our follow-up
 * template's wording and its status on the host's WABA (empty: not submitted yet). */
type FollowupTemplateResponse struct {
	Connected bool     `json:"connected"`
	Name      string   `json:"name"`
	Language  string   `json:"language"`
	Category  string   `json:"category"`
	Body      string   `json:"body"`
	Footer    string   `json:"footer"`
	Examples  []string `json:"examples"`
	Status    string   `json:"status,omitempty"`
}

/* FollowupWAState is the CRM's answer about reaching a session's people on WhatsApp (the
 * api.Engage boundary, not the wire): by registration id. */
type FollowupWAState struct {
	Connected      bool                         `json:"connected"`
	TemplateStatus string                       `json:"templateStatus,omitempty"`
	Contacts       map[string]FollowupWAContact `json:"contacts"`
}

// FollowupWAContact is one person: their contact, and how a WhatsApp would go (or why not).
type FollowupWAContact struct {
	ContactID string `json:"contactId,omitempty"`
	Mode      string `json:"mode,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// FollowupWASend is one WhatsApp follow-up for the CRM to send (the api.Engage boundary).
type FollowupWASend struct {
	RegistrationID string `json:"registrationId"`
	FirstName      string `json:"firstName"`
	Topic          string `json:"topic"`
	Text           string `json:"text"`
}

// FollowupWAResult is how the CRM's send went, and the number it went to.
type FollowupWAResult struct {
	Status    string `json:"status"`
	Mode      string `json:"mode,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Error     string `json:"error,omitempty"`
	ContactID string `json:"contactId,omitempty"`
	Phone     string `json:"phone,omitempty"`
}
