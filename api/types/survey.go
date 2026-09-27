package types

/* Post-event surveys: the wire contract.
 *
 * One survey per webinar, in one of two modes the host chooses:
 *
 *   builtin  attendees rate the session 1–5 (always asked, always required) and answer up to
 *            MaxSurveyQuestions short questions the host adds.
 *   link     attendees get an "Open survey" button to the host's own form (Google Forms,
 *            Typeform…). AskRating, on by default, still asks the 1–5 rating first so every
 *            webinar has a comparable number whichever mode it ran.
 *
 * The overall 1–5 rating is a column of the response rather than a question, because it is
 * the one figure that must mean the same thing across every webinar and both modes.
 *
 * Two views, like polls: the host's (counts, lock state) and the audience's (the questions
 * and their own response, nothing about anybody else's).
 */

/** Limits, enforced by the API and mirrored by the builder so the host is told before saving. */
const (
	MaxSurveyQuestions       = 5
	MaxSurveyOptions         = 6
	MaxSurveyPromptChars     = 200
	MaxSurveyOptionChars     = 80
	MaxSurveyTitleChars      = 120
	MaxSurveyButtonChars     = 40
	MaxSurveyURLChars        = 2048
	MaxSurveyTextAnswerChars = 1000
)

/** `builtin` (rating + questions) or `link` (an external form). */
type SurveyMode string

const (
	SurveyBuiltin SurveyMode = "builtin"
	SurveyLink    SurveyMode = "link"
)

/** `draft` (not sent), `live` (attendees can answer) or `closed` (no more answers). */
type SurveyStatus string

const (
	SurveyDraft  SurveyStatus = "draft"
	SurveyLive   SurveyStatus = "live"
	SurveyClosed SurveyStatus = "closed"
)

/** `manual`: the host puts it on screen from the room, usually just before ending (the
 *  recommended way: people answer while they are still there);
 *  `at_minute`: sent automatically SendAfterMin minutes after the webinar goes live;
 *  `on_end`: sent when the host ends the webinar (and offered to anyone who leaves early).
 *  Whichever is chosen, the host can still send it early from the room. */
type SurveySendAt string

const (
	SurveyOnEnd    SurveySendAt = "on_end"
	SurveyManual   SurveySendAt = "manual"
	SurveyAtMinute SurveySendAt = "at_minute"
)

/** The latest minute an at_minute survey may be set for: ten hours. */
const MaxSurveySendAfterMin = 600

/** `rating_5` (1–5), `nps_10` (0–10), `single_choice` (an option index) or `text`. */
type SurveyQuestionKind string

const (
	SurveyRating5      SurveyQuestionKind = "rating_5"
	SurveyNPS10        SurveyQuestionKind = "nps_10"
	SurveySingleChoice SurveyQuestionKind = "single_choice"
	SurveyText         SurveyQuestionKind = "text"
)

type SurveyQuestion struct {
	ID       string             `json:"id"`
	Kind     SurveyQuestionKind `json:"kind"`
	Prompt   string             `json:"prompt"`
	Required bool               `json:"required"`
	/** Only for single_choice; empty otherwise. */
	Options []string `json:"options"`
}

type Survey struct {
	ID          string       `json:"id"`
	Mode        SurveyMode   `json:"mode"`
	Title       string       `json:"title"`
	ButtonLabel string       `json:"buttonLabel"`
	ExternalURL string       `json:"externalUrl"`
	AskRating   bool         `json:"askRating"`
	Status      SurveyStatus `json:"status"`
	SendAt      SurveySendAt `json:"sendAt"`
	/** at_minute only: minutes after going live; 0 otherwise. */
	SendAfterMin int `json:"sendAfterMin"`
	/** Only in builtin mode; always empty for link mode. */
	Questions  []SurveyQuestion `json:"questions"`
	LaunchedAt string           `json:"launchedAt,omitempty"`
	ClosedAt   string           `json:"closedAt,omitempty"`
	UpdatedAt  string           `json:"updatedAt"`
	/** Host view only: submitted responses and link clicks. Zero for the audience. */
	Responses  int `json:"responses"`
	LinkClicks int `json:"linkClicks"`
	/** Host view only: once anyone has answered, the mode, the rating toggle and the questions
	 *  are fixed so every answer means what it meant when it was given. */
	Locked bool `json:"locked"`
}

type SurveyQuestionInput struct {
	/** The id of an existing question being kept; empty for a new one. */
	ID       string             `json:"id,omitempty"`
	Kind     SurveyQuestionKind `json:"kind"`
	Prompt   string             `json:"prompt"`
	Required bool               `json:"required"`
	Options  []string           `json:"options,omitempty"`
}

/** PUT /api/host/webinars/{slug}/survey. The whole configuration, replacing what was there. */
type SurveyInput struct {
	Mode        SurveyMode   `json:"mode"`
	Title       string       `json:"title"`
	ButtonLabel string       `json:"buttonLabel"`
	ExternalURL string       `json:"externalUrl"`
	AskRating   bool         `json:"askRating"`
	SendAt      SurveySendAt `json:"sendAt"`
	/** Required for at_minute (1..MaxSurveySendAfterMin); ignored otherwise. */
	SendAfterMin int                   `json:"sendAfterMin,omitempty"`
	Questions    []SurveyQuestionInput `json:"questions"`
}

/** GET /api/host/webinars/{slug}/survey. Survey is absent when none has been set up. */
type HostSurvey struct {
	Survey *Survey `json:"survey,omitempty"`
	/** Attendees who have been in the room: the response-rate denominator. */
	Attended int `json:"attended"`
}

/** One answer as sent: Number for rating_5, nps_10 and single_choice (the option index),
 *  Text for text. */
type SurveyAnswerInput struct {
	QuestionID string `json:"questionId"`
	Number     *int   `json:"number,omitempty"`
	Text       string `json:"text,omitempty"`
}

/** POST /api/webinars/{slug}/survey/responses. */
type SurveySubmitRequest struct {
	JoinKey string `json:"joinKey,omitempty"`
	/** 1–5. Required in builtin mode and in link mode with AskRating. */
	Rating  *int                `json:"rating,omitempty"`
	Answers []SurveyAnswerInput `json:"answers"`
}

/** POST /api/webinars/{slug}/survey/click. */
type SurveyClickRequest struct {
	JoinKey string `json:"joinKey,omitempty"`
}

/** What the caller has already done, so a reload never asks twice. */
type MySurveyResponse struct {
	Submitted   bool   `json:"submitted"`
	Rating      int    `json:"rating,omitempty"`
	LinkClicked bool   `json:"linkClicked"`
	SubmittedAt string `json:"submittedAt,omitempty"`
}

/** GET /api/webinars/{slug}/survey — the audience's view.
 *
 *  Survey is present when it is live, or when it is armed to go out at the end (status draft,
 *  sendAt on_end): an attendee leaving early is offered it then. Live says which, so the room
 *  only pops it up once it is really sent. Absent otherwise, and always for the stage. */
type AudienceSurvey struct {
	Survey *Survey          `json:"survey,omitempty"`
	Live   bool             `json:"live"`
	Mine   MySurveyResponse `json:"mine"`
}

// ------------------------------------------------------------------ results

type SurveyChoiceCount struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

/** NPS: the percentage of promoters (9–10) minus the percentage of detractors (0–6). */
type SurveyNPS struct {
	Score      int `json:"score"`
	Promoters  int `json:"promoters"`
	Passives   int `json:"passives"`
	Detractors int `json:"detractors"`
	Responses  int `json:"responses"`
}

type SurveyQuestionResult struct {
	ID       string             `json:"id"`
	Kind     SurveyQuestionKind `json:"kind"`
	Prompt   string             `json:"prompt"`
	Answered int                `json:"answered"`
	/** rating_5 and nps_10: the mean, one decimal; -1 when nobody answered. */
	Average float64 `json:"average"`
	/** rating_5: counts for 1..5; nps_10: counts for 0..10; single_choice: one per option. */
	Distribution []int `json:"distribution"`
	/** single_choice only. */
	Choices []SurveyChoiceCount `json:"choices,omitempty"`
	/** nps_10 only. */
	NPS *SurveyNPS `json:"nps,omitempty"`
}

type SurveyTextAnswer struct {
	Name        string `json:"name"`
	Text        string `json:"text"`
	SubmittedAt string `json:"submittedAt"`
}

/** GET /api/host/webinars/{slug}/survey/results. */
type SurveyResults struct {
	Configured bool         `json:"configured"`
	Mode       SurveyMode   `json:"mode,omitempty"`
	Status     SurveyStatus `json:"status,omitempty"`
	Title      string       `json:"title,omitempty"`
	LaunchedAt string       `json:"launchedAt,omitempty"`
	Attended   int          `json:"attended"`
	Responses  int          `json:"responses"`
	/** responses / attended, 0..100; -1 when nobody attended. */
	ResponseRatePct int `json:"responseRatePct"`
	/** Link mode: attendees who pressed Open survey. */
	LinkClicks int `json:"linkClicks"`
	/** linkClicks / attended, 0..100; -1 when nobody attended. */
	ClickThroughPct int `json:"clickThroughPct"`
	/** The overall 1–5 rating: mean (one decimal, -1 when none) and counts for 1..5. */
	Ratings            int     `json:"ratings"`
	AverageRating      float64 `json:"averageRating"`
	RatingDistribution []int   `json:"ratingDistribution"`
	/** The first nps_10 question's score, when there is one. */
	NPS       *SurveyNPS             `json:"nps,omitempty"`
	Questions []SurveyQuestionResult `json:"questions"`
	/** The newest few answers to text questions, across all of them; the rest are paged. */
	Comments []SurveyComment `json:"comments"`
}

type SurveyComment struct {
	QuestionID  string `json:"questionId"`
	Prompt      string `json:"prompt"`
	Name        string `json:"name"`
	Text        string `json:"text"`
	SubmittedAt string `json:"submittedAt"`
}

/** GET /api/host/webinars/{slug}/survey/answers?question=&cursor=&limit= */
type SurveyTextPage struct {
	Answers    []SurveyTextAnswer `json:"answers"`
	Total      int                `json:"total"`
	NextCursor string             `json:"nextCursor,omitempty"`
}
