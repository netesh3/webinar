package types

/* The AI recap of a session: written automatically after every webinar and meeting ends,
 * from the after-session transcript, the live captions, or (with no captions) only the
 * Q&A, polls and chat. Emailed to the host once; never to attendees. */

// Where a recap was written from (session_recaps.source).
const (
	RecapSourceServerTranscript = "server_transcript"
	RecapSourceCaptions         = "captions"
	RecapSourceEngagementOnly   = "engagement_only"
)

// Recap states (session_recaps.status), plus RecapNone for a session without a row.
const (
	RecapNone    = "none"
	RecapPending = "pending"
	RecapReady   = "ready"
	RecapSkipped = "skipped"
	RecapFailed  = "failed"
)

/* Why a recap is not ready (SessionRecapResponse.Reason). waiting_transcript and
 * processing go with pending; the others with skipped, failed or none. */
const (
	RecapReasonWaitingTranscript = "waiting_transcript"
	RecapReasonProcessing        = "processing"
	RecapReasonAIOff             = "ai_off"
	// RecapReasonAISessionOff is the room's AI switch (SessionControls.AIEnabled) being off
	// when the session ended: the host kept this one session out of AI.
	RecapReasonAISessionOff  = "ai_session_off"
	RecapReasonAILimit       = "ai_limit"
	RecapReasonAIUnavailable = "ai_unavailable"
	RecapReasonEmpty         = "empty"
	RecapReasonFailed        = "failed"
	RecapReasonNotEnded      = "not_ended"
)

// Who an action item is for.
const (
	RecapOwnerHost       = "host"
	RecapOwnerAttendee   = "attendee"
	RecapOwnerUnassigned = "unassigned"
)

// RecapActionItem is a follow-up from the session. Owner is host, attendee or unassigned.
type RecapActionItem struct {
	Text  string `json:"text"`
	Owner string `json:"owner"`
}

// RecapChapter is a moment in the session, in seconds from when it went live.
type RecapChapter struct {
	StartSec int    `json:"startSec"`
	Title    string `json:"title"`
}

// RecapQuestion is one of the audience's questions, similar ones merged.
type RecapQuestion struct {
	Question string `json:"question"`
	Answered bool   `json:"answered"`
	Upvotes  int    `json:"upvotes"`
}

// RecapQuote is something said worth keeping, in the words it was said in.
type RecapQuote struct {
	Text    string `json:"text"`
	Speaker string `json:"speaker"`
}

// RecapAttendance is counted from the session, never written by the model.
type RecapAttendance struct {
	Registered   int `json:"registered"`
	Attended     int `json:"attended"`
	Peak         int `json:"peak"`
	AvgWatchMin  int `json:"avgWatchMin"`
	Questions    int `json:"questions"`
	PollVoters   int `json:"pollVoters"`
	ChatMessages int `json:"chatMessages"`
}

/* SessionRecap is the recap itself. Chapters is empty when nothing said had a time
 * (engagement_only). Notice is a line for the host, such as turning captions on. */
type SessionRecap struct {
	Summary       string            `json:"summary"`
	KeyPoints     []string          `json:"keyPoints"`
	ActionItems   []RecapActionItem `json:"actionItems"`
	Chapters      []RecapChapter    `json:"chapters"`
	TopQuestions  []RecapQuestion   `json:"topQuestions"`
	NotableQuotes []RecapQuote      `json:"notableQuotes"`
	Attendance    RecapAttendance   `json:"attendance"`
	Notice        string            `json:"notice,omitempty"`
}

/* SessionRecapResponse is GET /api/host/webinars/{slug}/recap. The recap is written
 * automatically after the session; there is no way to ask for another. Status is none,
 * pending, ready, skipped or failed; Reason says why it is not ready. */
type SessionRecapResponse struct {
	Status      string        `json:"status"`
	Reason      string        `json:"reason,omitempty"`
	Source      string        `json:"source,omitempty"`
	Model       string        `json:"model,omitempty"`
	GeneratedAt string        `json:"generatedAt,omitempty"`
	EmailedAt   string        `json:"emailedAt,omitempty"`
	Recap       *SessionRecap `json:"recap,omitempty"`
	/* AIPausedMin is how long the room's AI switch was off during the live session (the
	 * session_ai_off_intervals windows, migration 0143), rounded up; 0 when never. What was
	 * said, asked or chatted then is not in the recap, and the Results page says so. */
	AIPausedMin int `json:"aiPausedMin,omitempty"`
}
