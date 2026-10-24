package types

/* Content repurposing, in the host's AI insights tab: one ended session's transcript turned
 * into drafts the host can publish elsewhere — a blog post, a newsletter, a long-form
 * whitepaper draft, and posts for LinkedIn, X and Instagram.
 *
 * Drafts, never the host's words until the host says so. Each is written by gpt-5-nano from
 * what was said (plus the title, description, agenda and Q&A), in the host's brand voice,
 * and nothing the session did not contain may be added. The host edits it, marks it
 * reviewed, and only then copies or downloads it. Regenerate writes a new draft and drops
 * the edits. See api/internal/api/repurpose.go. */

/* FeatureRepurpose is the switch: the Repurpose card in AI insights and the brand voice.
 * Needs FeatureAI (every call counts against the monthly AI caps). Off for every account
 * until an admin turns it on for a host (Admin -> Accounts), because absent means off. */
const FeatureRepurpose = "repurpose"

// AIFeatureRepurpose is the ai_usage feature name for every repurposing call.
const AIFeatureRepurpose = "repurpose"

// Repurpose formats (RepurposeDraft.Format), in the order the card offers them.
const (
	RepurposeBlog       = "blog"
	RepurposeNewsletter = "newsletter"
	RepurposeWhitepaper = "whitepaper"
	RepurposeLinkedIn   = "linkedin"
	RepurposeXThread    = "x_thread"
	RepurposeInstagram  = "instagram"
)

/* Draft states (RepurposeDraft.Status). queued is waiting for a request to write it (the
 * next poll does), writing is a model call in flight, failed carries a Reason. */
const (
	RepurposeQueued  = "queued"
	RepurposeWriting = "writing"
	RepurposeReady   = "ready"
	RepurposeFailed  = "failed"
)

/* RepurposeReasonNoTranscript is why nothing can be written: nothing anyone said was kept
 * (captions and the room's AI switch were off, or nobody spoke). The other reasons are the
 * recap's (ai_off, ai_session_off, ai_limit, ai_unavailable, not_ended, failed). */
const RepurposeReasonNoTranscript = "no_transcript"

/* RepurposeDraft is one format's draft. Markdown is the host's edit when Edited, else what
 * the model wrote; empty until the first one is ready. A regenerate keeps the old draft
 * readable while the new one is written (Status queued or writing, Markdown the old one).
 * Reviewed is the host's "I've read it": copy and download wait for it. */
type RepurposeDraft struct {
	Format      string `json:"format"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
	Markdown    string `json:"markdown"`
	Edited      bool   `json:"edited"`
	Reviewed    bool   `json:"reviewed"`
	GeneratedAt string `json:"generatedAt,omitempty"`
}

/* RepurposeResponse is GET /api/host/webinars/{slug}/repurpose. Status is ready when drafts
 * may be written, else why not (RepurposeReasonNoTranscript or one of the recap's reasons);
 * drafts already written stay readable either way. Source says what they are written from:
 * the after-session transcript, the live captions, or notes on a long one ("notes"). */
type RepurposeResponse struct {
	Status        string           `json:"status"`
	Source        string           `json:"source,omitempty"`
	Drafts        []RepurposeDraft `json:"drafts"`
	BrandVoiceSet bool             `json:"brandVoiceSet"`
}

// RepurposeRequest is POST /api/host/webinars/{slug}/repurpose: write (or rewrite) these.
type RepurposeRequest struct {
	Formats []string `json:"formats"`
}

/* RepurposeEditRequest is PUT /api/host/webinars/{slug}/repurpose/{format}: the host's
 * text, and whether they have reviewed it. Reviewed false on an edit takes the mark back. */
type RepurposeEditRequest struct {
	Markdown string `json:"markdown"`
	Reviewed bool   `json:"reviewed"`
}

/* BrandVoice is the host's voice for every draft (GET/PUT /api/host/brand-voice): how they
 * sound, who they write for, words to use and to avoid, and a sample of their own writing
 * for style only. Every field is optional; all empty means a plain, warm default. */
type BrandVoice struct {
	Tone      string `json:"tone"`
	Audience  string `json:"audience"`
	DoWords   string `json:"doWords"`
	DontWords string `json:"dontWords"`
	Sample    string `json:"sample"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}
