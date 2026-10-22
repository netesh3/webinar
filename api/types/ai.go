package types

/* The AI model chain, as an admin sees it.
 *
 * Which provider is answering right now and which have been set aside, so an operator can
 * tell "Cloudflare's free Neurons ran out at 3pm and Groq took over" from "every key is
 * wrong" without reading logs. Keys never appear here. */

// AIProviderStatus is one provider in the chain, in the order it is tried.
type AIProviderStatus struct {
	ID    string `json:"id"`
	Model string `json:"model"`
	// Available is false while the provider is benched after a failure.
	Available bool `json:"available"`
	// BenchedUntil is when it will be tried again (RFC 3339); empty when available.
	BenchedUntil string `json:"benchedUntil,omitempty"`
	// Reason is why it was benched, e.g. "daily quota used up".
	Reason string `json:"reason,omitempty"`
}

// AIStatus is GET /api/admin/ai.
type AIStatus struct {
	// Enabled is false when no provider is configured at all.
	Enabled   bool               `json:"enabled"`
	Providers []AIProviderStatus `json:"providers"`
	// Month is this calendar month's (UTC) AI use, against the caps.
	Month AIMonthUsage `json:"month"`
}

// AI feature names, as recorded in ai_usage and reported per feature.
const (
	AIFeatureSalesChat    = "sales_chat"
	AIFeatureWebinarSetup = "webinar_setup"
	AIFeatureRecap        = "recap"
	// The live Q&A assistant: grouping duplicate questions, and a host's draft answer.
	AIFeatureQACluster = "qa_cluster"
	AIFeatureQAAnswer  = "qa_answer"
	// Draft answers the assistant writes unasked, from the AI knowledge, batched with grouping.
	AIFeatureQAAutoDraft = "qa_autodraft"
	// Past answers drafted from an ended session's transcript, for questions answered aloud.
	AIFeatureQAHarvest = "qa_harvest"
	// Embeddings for the AI knowledge's vector search (text-embedding-3-small).
	AIFeatureEmbed = "embed"
)

// AIFeatureUsage is one AI feature's calls this month.
type AIFeatureUsage struct {
	Feature string `json:"feature"`
	// Calls counts every call; Failed the ones no provider answered.
	Calls            int     `json:"calls"`
	Failed           int     `json:"failed"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	CostUSD          float64 `json:"costUsd"`
}

/* AIMonthUsage is month-to-date spend, estimated from token counts. The caps are what
 * the server refuses past: MonthlyCapUSD for the instance, HostMonthlyCapUSD for any
 * one host. */
type AIMonthUsage struct {
	// Since is the start of the month (RFC 3339, UTC).
	Since             string           `json:"since"`
	SpendUSD          float64          `json:"spendUsd"`
	MonthlyCapUSD     float64          `json:"monthlyCapUsd"`
	HostMonthlyCapUSD float64          `json:"hostMonthlyCapUsd"`
	Features          []AIFeatureUsage `json:"features"`
}

/* AIWebinarSetupRequest is POST /api/host/ai/webinar-setup: "Write with AI" on the
 * schedule form. Idea is the host's one line (required, at most 300 characters);
 * Language is "en" (the default), "hinglish" or "hi-roman" — both Hindi forms in
 * Roman script. */
type AIWebinarSetupRequest struct {
	Idea     string `json:"idea"`
	Language string `json:"language,omitempty"`
}

// AISocialPosts is a ready-to-paste post per channel.
type AISocialPosts struct {
	LinkedIn  string `json:"linkedin"`
	Instagram string `json:"instagram"`
	WhatsApp  string `json:"whatsapp"`
}

/* AIWebinarSetup is the draft: nothing is saved. Description is 2–4 paragraphs
 * separated by a blank line; RegistrationBullets is 3–5 points. Errors: 403
 * feature_off (AI writing is off for the account), 422 invalid_idea, 429 ai_limit
 * (a monthly AI cap), 503 ai_unavailable (no provider configured or answering). */
type AIWebinarSetup struct {
	Title                string        `json:"title"`
	Description          string        `json:"description"`
	RegistrationHeadline string        `json:"registrationHeadline"`
	RegistrationBullets  []string      `json:"registrationBullets"`
	SocialPosts          AISocialPosts `json:"socialPosts"`
}

/* The live Q&A assistant, for the host and co-hosts only (api/internal/api/qa_assist.go).
 *
 * QACluster is questions that ask the same thing, under one short canonical wording. A
 * question no grouping pass has reached yet is reported as a cluster of its own, with
 * Provisional set and an id of "q_" + the question's id, so the panel and the ranking treat
 * every open question alike. */
type QACluster struct {
	ID          string   `json:"id"`
	Canonical   string   `json:"canonical"`
	QuestionIDs []string `json:"questionIds"`
	// Askers is how many different people asked it; Upvotes is the questions' votes summed.
	Askers  int `json:"askers"`
	Upvotes int `json:"upvotes"`
	// Open is how many of its questions are neither answered nor hidden.
	Open int `json:"open"`
	// LatestAt is when its newest question was asked (RFC 3339).
	LatestAt    string  `json:"latestAt"`
	Score       float64 `json:"score"`
	Provisional bool    `json:"provisional,omitempty"`
	// Draft is the answer waiting for the host team's review, if any (host team only).
	Draft *QADraft `json:"draft,omitempty"`
}

/* QADraft is a draft answer to one cluster (or one ungrouped question), for the host and
 * co-hosts only. Nothing reaches the audience until a host posts it (POST
 * /qa/drafts/{id}/post), after editing it if they like; it is then the host's answer on each
 * open question, through the ordinary answer path. */
type QADraft struct {
	ID     string `json:"id"`
	Answer string `json:"answer"`
	// Grounded is true when the answer comes from the host's AI knowledge (or what was said in
	// the session). False is a general answer, and the answer then starts "Not in your
	// knowledge — general answer:" when the session has knowledge to draw on.
	Grounded bool `json:"grounded"`
	// Sources are the titles of the knowledge documents the answer drew on.
	Sources []string `json:"sources"`
	// Auto is a draft written unasked, when the question arrived.
	Auto      bool   `json:"auto"`
	CreatedAt string `json:"createdAt"`
}

// QAPostDraftRequest is POST /api/host/webinars/{slug}/qa/drafts/{id}/post: the answer as the
// host edited it (at most QAAnswerMaxRunes characters).
type QAPostDraftRequest struct {
	Answer string `json:"answer"`
}

// QAAnswerMaxRunes bounds a posted answer: what the room's answer packet carries.
const QAAnswerMaxRunes = 600

// QAPostDraftResponse is the questions the answer was posted on, now answered.
type QAPostDraftResponse struct {
	QuestionIDs []string `json:"questionIds"`
	Answer      string   `json:"answer"`
}

// QAClustersResponse is GET /api/host/webinars/{slug}/qa/clusters.
type QAClustersResponse struct {
	// Enabled is false when the session may not use AI (the account feature or the room's
	// AI switch is off): the panel then shows the plain list, as without the assistant.
	Enabled bool `json:"enabled"`
	// Limited is set while grouping is paused at an AI cap.
	Limited  bool        `json:"limited"`
	Clusters []QACluster `json:"clusters"`
	// Top is the "Top questions" strip: cluster ids, best first, ranked on upvotes, askers
	// and recency. Empty with fewer than two open clusters.
	Top []string `json:"top"`
}

/* QASuggestResponse is POST /api/host/webinars/{slug}/qa/clusters/{id}/suggest: a draft for
 * the host team, grounded in the session's AI knowledge where it covers the question. Kept as
 * the cluster's draft (replacing an earlier one) until posted or discarded; never posted by
 * itself. Answer is Draft.Answer. */
type QASuggestResponse struct {
	Answer string  `json:"answer"`
	Draft  QADraft `json:"draft"`
}

/* The AI knowledge: a host's library of documents (pasted text, or TXT, Markdown, PDF and
 * DOCX uploads, of which only the extracted text is kept) that grounds the live Q&A
 * assistant's draft answers. Every session uses every document unless a host unticks it for
 * that session. Only for accounts with the ai feature. See api/internal/api/knowledge.go. */

// The library's limits. Separate from the media quota: no file is stored, only its text.
const (
	KnowledgeMaxDocs        = 50
	KnowledgeMaxDocWords    = 50_000
	KnowledgeMaxWords       = 250_000
	KnowledgeMaxUploadBytes = 10 << 20
	KnowledgeMaxTitleRunes  = 120
)

// KnowledgeDoc is one document in the library.
type KnowledgeDoc struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Source is text (pasted), txt, md, pdf or docx.
	Source   string `json:"source"`
	Filename string `json:"filename,omitempty"`
	// Folder is a vault note's folder inside the vault ("Course/Week 1"), shown as a tag.
	Folder string `json:"folder,omitempty"`
	Bytes  int64  `json:"bytes"`
	Words  int    `json:"words"`
	Chunks int    `json:"chunks"`
	// Preview is the start of the extracted text.
	Preview   string `json:"preview"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// KnowledgeLimits are the caps the library is held to.
type KnowledgeLimits struct {
	MaxDocs        int   `json:"maxDocs"`
	MaxDocWords    int   `json:"maxDocWords"`
	MaxWords       int   `json:"maxWords"`
	MaxUploadBytes int64 `json:"maxUploadBytes"`
}

// KnowledgeLibrary is GET /api/host/knowledge: the host's documents, newest first.
type KnowledgeLibrary struct {
	Docs      []KnowledgeDoc  `json:"docs"`
	UsedWords int             `json:"usedWords"`
	Limits    KnowledgeLimits `json:"limits"`
}

// KnowledgeDocDetail is GET /api/host/knowledge/{id}: a document with its extracted text (the
// first KnowledgeTextPreviewRunes characters; Truncated when there is more).
type KnowledgeDocDetail struct {
	Doc       KnowledgeDoc `json:"doc"`
	Text      string       `json:"text"`
	Truncated bool         `json:"truncated"`
}

// KnowledgeTextPreviewRunes bounds the text a document's detail returns.
const KnowledgeTextPreviewRunes = 20_000

/* KnowledgeCreateRequest is POST /api/host/knowledge: pasted text. Uploads are POST
 * /api/host/knowledge/upload?filename=…&title=… with the raw file as the body. Errors: 403
 * feature_off, 413 too_large, 415 unsupported, 422 (fields title/text; unreadable, no_text,
 * too_long, library_full). */
type KnowledgeCreateRequest struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

// KnowledgeRenameRequest is PATCH /api/host/knowledge/{id}.
type KnowledgeRenameRequest struct {
	Title string `json:"title"`
}

// SessionKnowledgeDoc is one library document as a session sees it.
type SessionKnowledgeDoc struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Source   string `json:"source"`
	Words    int    `json:"words"`
	Included bool   `json:"included"`
}

// SessionKnowledge is GET /api/host/webinars/{slug}/knowledge: the session host's library,
// each document ticked unless it was left out of this session, and the past answers' tick.
type SessionKnowledge struct {
	Docs        []SessionKnowledgeDoc `json:"docs"`
	PastAnswers SessionPastAnswers    `json:"pastAnswers"`
}

// SessionPastAnswers is the "Past answers" item of a session's knowledge: on unless the
// session left them out. Count is the host's approved entries.
type SessionPastAnswers struct {
	Count    int  `json:"count"`
	Included bool `json:"included"`
}

// SessionKnowledgePatch is PATCH /api/host/webinars/{slug}/knowledge/{docId}.
type SessionKnowledgePatch struct {
	Included bool `json:"included"`
}

/* KnowledgeVaultImport is POST /api/host/knowledge/vault?filename=…: an Obsidian vault as a
 * .zip, the raw file as the body. Each Markdown note becomes a document (source "md", its
 * folder kept as Folder); .obsidian/, hidden files and anything not Markdown are skipped. All
 * the notes are added or none: errors 413 too_large, 415 unsupported (not a .zip), 422
 * unreadable, too_many_files, note_too_large, vault_too_large, no_notes, too_long (a note over
 * KnowledgeMaxDocWords) and library_full (the notes would not fit the library's caps). */
type KnowledgeVaultImport struct {
	Docs []KnowledgeDoc `json:"docs"`
	// Skipped counts the zip's entries that were not notes (settings, pictures, empty notes).
	Skipped int `json:"skipped"`
}

/* The past answers: a section of the host's AI knowledge holding answers to questions asked in
 * their own sessions, one question and answer per entry. Only the text is kept, never who
 * asked, with phone numbers and email addresses scrubbed.
 *
 *   typed     what a host answered in the Q&A panel, saved when the session ends (status
 *             approved: it was already posted)
 *   aloud     drafted by the AI from the session's transcript for a question the host answered
 *             out loud (status pending until the host approves it; a pending entry is never
 *             used to draft answers)
 *
 * The host can correct (edit) or delete any entry.
 * A new approved answer to a question an entry already holds updates that entry instead of
 * adding another: UpdatedFrom says so, and Undo puts the previous version back (once). */
type PastAnswer struct {
	ID       string `json:"id"`
	Question string `json:"question"`
	Answer   string `json:"answer"`
	// Status is approved or pending.
	Status string `json:"status"`
	// Origin is typed or aloud.
	Origin string `json:"origin"`
	// SourceTopic and SourceAt are the session the current text came from.
	SourceTopic string `json:"sourceTopic,omitempty"`
	SourceAt    string `json:"sourceAt,omitempty"`
	// CanUndo is set when a repeat replaced an earlier version that Undo would restore.
	CanUndo bool `json:"canUndo"`
	// UpdatedFrom names the session a repeat came from ("Updated from <topic>"), with CanUndo.
	UpdatedFrom   string `json:"updatedFrom,omitempty"`
	UpdatedFromAt string `json:"updatedFromAt,omitempty"`
	UpdatedAt     string `json:"updatedAt"`
}

// Past answer states and origins.
const (
	PastAnswerApproved = "approved"
	PastAnswerPending  = "pending"
	PastAnswerTyped    = "typed"
	PastAnswerAloud    = "aloud"
)

// The past answers' limits.
const (
	PastAnswerMaxEntries       = 2000
	PastAnswerMaxQuestionRunes = 600
	PastAnswerMaxAnswerRunes   = 2000
)

// PastAnswers is GET /api/host/knowledge/answers: pending entries first, then approved, newest
// first. The read is also when ended sessions not yet harvested are (see knowledge_answers.go).
type PastAnswers struct {
	Answers  []PastAnswer `json:"answers"`
	Pending  int          `json:"pending"`
	Approved int          `json:"approved"`
	Max      int          `json:"max"`
}

/* PastAnswerEdit is PATCH /api/host/knowledge/answers/{id} (a correction: the new text
 * replaces the old, and the earlier version an Undo would restore is dropped) and POST
 * /api/host/knowledge/answers/{id}/approve (a pending draft, as the host edited it; both
 * fields optional there). Errors: 404 not_found, 422 (fields question/answer). */
type PastAnswerEdit struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

/* PastAnswerResult is an entry after an approve, edit or undo. Merged is set when approving
 * matched an existing entry, which was updated instead (Answer is that entry; the draft is
 * gone). */
type PastAnswerResult struct {
	Answer PastAnswer `json:"answer"`
	Merged bool       `json:"merged"`
}

// SessionPastAnswersPatch is PATCH /api/host/webinars/{slug}/knowledge/past-answers.
type SessionPastAnswersPatch struct {
	Included bool `json:"included"`
}
