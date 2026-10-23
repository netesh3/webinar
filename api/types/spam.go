package types

/* Spam detection on a live session's chat and Q&A (api/internal/api/spam.go). Host team only:
 * the audience never sees a flag.
 *
 * Free rules score every attendee message as it is sent (links, phone numbers, WhatsApp
 * invites, repeats, flooding, scam words, all-caps and emoji floods). A high score is flagged at
 * once; a middling one waits for a batched AI pass (feature chat_spam), which also reads a
 * small sample of the recent chat. Nothing is deleted unless a host does it, or turns on
 * Auto-hide for spam flagged at 0.9 or more. */

// SpamFlag is one flagged chat message or question, as the host team's Flagged filter shows it.
type SpamFlag struct {
	// Kind is "chat" or "question"; ID is the message's or question's own id.
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Identity string `json:"identity"`
	Name     string `json:"name"`
	Text     string `json:"text"`
	// Category is promo, scam, abuse, off_topic or other.
	Category   string  `json:"category"`
	Confidence float64 `json:"confidence"`
	// Source is "rules" or "ai"; Reasons are the rules that matched (link, phone, whatsapp,
	// scam_words, dm_me, repeat, copy_paste, flood, caps, emoji).
	Source  string   `json:"source"`
	Reasons []string `json:"reasons"`
	// Status is flagged (waiting for the host team), auto_hidden, or what a host did: deleted,
	// hidden, removed, muted, not_spam.
	Status string `json:"status"`
	At     string `json:"at"`
}

// SpamSettings is one session's spam settings.
type SpamSettings struct {
	// AllowLinks off (the default) counts a link from an attendee as a spam signal.
	AllowLinks bool `json:"allowLinks"`
	// AutoHide hides spam flagged at 0.9 or more without waiting for the host. Off by default.
	AutoHide bool `json:"autoHide"`
}

// SpamSettingsPatch is PATCH /api/host/webinars/{slug}/spam/settings; a missing field is unchanged.
type SpamSettingsPatch struct {
	AllowLinks *bool `json:"allowLinks,omitempty"`
	AutoHide   *bool `json:"autoHide,omitempty"`
}

// SpamFlagsResponse is GET /api/host/webinars/{slug}/spam.
type SpamFlagsResponse struct {
	// AI is whether the batched AI pass may run for this session (sessionAIAllowed); the rules
	// run either way.
	AI bool `json:"ai"`
	// Limited is set while the AI pass is paused at an AI cap.
	Limited  bool         `json:"limited"`
	Settings SpamSettings `json:"settings"`
	// Flags, newest first: waiting ones and ones already acted on.
	Flags []SpamFlag `json:"flags"`
	// Muted is who a host has muted in chat.
	Muted []string `json:"muted"`
}

// SpamActionRequest is POST /api/host/webinars/{slug}/spam/{kind}/{id}: one host action on a
// flagged item. Action is delete, hide, remove, mute, unmute or not_spam.
type SpamActionRequest struct {
	Action string `json:"action"`
}
