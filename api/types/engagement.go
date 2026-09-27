package types

/* Engagement analytics: the wire contract for the host's Engagement page.
 *
 * Every minute offset below is relative to webinars.started_at, so the lobby is negative
 * and the session runs 0..SessionMin. Series are bucketed server-side with the bucket width
 * carried beside them, which keeps a four-hour session the same payload size as a
 * forty-minute one. See docs/plans/engagement-analytics.md.
 */

/** `high`, `engaged`, `passive`, `risk`; `no_show` only ever appears as a count. */
type EngagementTier string

const (
	TierHigh    EngagementTier = "high"
	TierEngaged EngagementTier = "engaged"
	TierPassive EngagementTier = "passive"
	TierRisk    EngagementTier = "risk"
	TierNoShow  EngagementTier = "no_show"
)

/** `excellent`, `strong`, `good`, `attention` — the band of the session index. */
type EngagementBand string

const (
	BandExcellent EngagementBand = "excellent"
	BandStrong    EngagementBand = "strong"
	BandGood      EngagementBand = "good"
	BandAttention EngagementBand = "attention"
)

/** Why a summary has no numbers yet. Empty when it does. */
type EngagementState string

const (
	EngagementReady      EngagementState = "ready"
	EngagementNotStarted EngagementState = "not_started"
	EngagementNoAudience EngagementState = "no_audience"
)

type EngagementWebinar struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	HostName  string `json:"hostName"`
	TimeZone  string `json:"timeZone"`
	Status    string `json:"status"`
	StartedAt string `json:"startedAt,omitempty"`
	EndedAt   string `json:"endedAt,omitempty"`
	/** Length of the live window in whole minutes (at least 1 once started). */
	SessionMin int `json:"sessionMin"`
}

type EngagementKPIs struct {
	Registered        int `json:"registered"`
	Attended          int `json:"attended"`
	NoShows           int `json:"noShows"`
	AttendanceRatePct int `json:"attendanceRatePct"`
	AvgWatchMin       int `json:"avgWatchMin"`
	MedianWatchMin    int `json:"medianWatchMin"`
	AvgWatchPct       int `json:"avgWatchPct"`
	StayedPastHalfPct int `json:"stayedPastHalfPct"`
	PeakLive          int `json:"peakLive"`
	PeakMinute        int `json:"peakMinute"`
	ChatMessages      int `json:"chatMessages"`
	Chatters          int `json:"chatters"`
	Questions         int `json:"questions"`
	AnsweredQuestions int `json:"answeredQuestions"`
	Upvotes           int `json:"upvotes"`
	/** -1 when no poll ran. */
	PollResponsePct int `json:"pollResponsePct"`
	/** -1 when no quiz ran. */
	QuizAccuracyPct int `json:"quizAccuracyPct"`
	Reactions       int `json:"reactions"`
	HandRaises      int `json:"handRaises"`
}

/** One retention sample: people in the room at Minute. */
type EngagementPoint struct {
	Minute int `json:"minute"`
	Live   int `json:"live"`
}

/** Arrivals whose first join fell in [FromMin, FromMin+width). Open means "and later". */
type EngagementJoinBucket struct {
	FromMin int  `json:"fromMin"`
	Count   int  `json:"count"`
	Open    bool `json:"open,omitempty"`
}

type EngagementJoinSplit struct {
	Early  int `json:"early"`
	OnTime int `json:"onTime"`
	Late   int `json:"late"`
}

/** Interactions per bucket of BucketMin minutes from minute 0, one array per type. */
type EngagementActivity struct {
	BucketMin int   `json:"bucketMin"`
	Chat      []int `json:"chat"`
	QA        []int `json:"qa"`
	Poll      []int `json:"poll"`
	Reaction  []int `json:"reaction"`
}

/** `poll`, `quiz`, `qa`, `offer`, `rating`. */
type EngagementMarker struct {
	Minute int    `json:"minute"`
	Kind   string `json:"kind"`
	Label  string `json:"label"`
}

type EngagementTierCounts struct {
	High    int `json:"high"`
	Engaged int `json:"engaged"`
	Passive int `json:"passive"`
	Risk    int `json:"risk"`
	NoShow  int `json:"noShow"`
}

type EngagementMoment struct {
	Minute  int `json:"minute"`
	Actions int `json:"actions"`
	/** The type that contributed most: chat, qa, poll or reaction. */
	Kind string `json:"kind"`
}

type EngagementDrop struct {
	Minute int `json:"minute"`
	Lost   int `json:"lost"`
}

type EngagementRecap struct {
	PollID     string `json:"pollId"`
	Question   string `json:"question"`
	CorrectPct int    `json:"correctPct"`
}

type EngagementCallouts struct {
	BestMoment  *EngagementMoment `json:"bestMoment,omitempty"`
	BiggestDrop *EngagementDrop   `json:"biggestDrop,omitempty"`
	NeedsRecap  *EngagementRecap  `json:"needsRecap,omitempty"`
}

type EngagementPoll struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Question string   `json:"question"`
	Options  []string `json:"options"`
	Correct  *int     `json:"correct,omitempty"`
	Votes    []int    `json:"votes"`
	Minute   int      `json:"minute"`
	/** Attendees in the room when it opened: the response-rate denominator. */
	LiveAtOpen int `json:"liveAtOpen"`
}

type EngagementCount struct {
	Label string `json:"label"`
	Count int    `json:"count"`
}

/** One emoji's reactions per bucket of the enclosing BucketMin. */
type EngagementEmojiSeries struct {
	Emoji  string `json:"emoji"`
	Total  int    `json:"total"`
	Counts []int  `json:"counts"`
}

type EngagementReactions struct {
	BucketMin int                     `json:"bucketMin"`
	Series    []EngagementEmojiSeries `json:"series"`
}

type EngagementChatLine struct {
	Minute int    `json:"minute"`
	Name   string `json:"name"`
	Text   string `json:"text"`
}

type EngagementChat struct {
	BucketMin   int                  `json:"bucketMin"`
	PerBucket   []int                `json:"perBucket"`
	TopChatters []EngagementCount    `json:"topChatters"`
	Latest      []EngagementChatLine `json:"latest"`
}

/** A question as the dashboard lists it. Name is empty for an anonymous question. */
type EngagementQuestion struct {
	ID       string `json:"id"`
	Minute   int    `json:"minute"`
	Name     string `json:"name"`
	Text     string `json:"text"`
	Upvotes  int    `json:"upvotes"`
	Answered bool   `json:"answered"`
}

/** One score component as configured for this session, after redistribution. */
type EngagementWeight struct {
	Key        string  `json:"key"`
	Label      string  `json:"label"`
	BaseWeight float64 `json:"baseWeight"`
	/** Zero when the tool was not used in this session. */
	Weight float64 `json:"weight"`
	/** Plain-language rule, e.g. "max at 5 messages". */
	Rule string `json:"rule"`
}

/** The column layout the attendee heatmap rows are bucketed on. */
type EngagementAxis struct {
	BucketMin int `json:"bucketMin"`
	/** Minute offset of column 0 (negative when lobby columns are included). */
	StartMin int `json:"startMin"`
	Columns  int `json:"columns"`
	/** Columns before minute 0. */
	LobbyColumns int `json:"lobbyColumns"`
}

/** GET /api/host/webinars/{slug}/engagement */
type EngagementSummary struct {
	FormulaVersion int                    `json:"formulaVersion"`
	ComputedAt     string                 `json:"computedAt"`
	State          EngagementState        `json:"state"`
	Webinar        EngagementWebinar      `json:"webinar"`
	Index          int                    `json:"index"`
	Band           EngagementBand         `json:"band"`
	KPIs           EngagementKPIs         `json:"kpis"`
	RetentionStep  int                    `json:"retentionStep"`
	Retention      []EngagementPoint      `json:"retention"`
	JoinHistogram  []EngagementJoinBucket `json:"joinHistogram"`
	JoinBucketMin  int                    `json:"joinBucketMin"`
	JoinSplit      EngagementJoinSplit    `json:"joinSplit"`
	Activity       EngagementActivity     `json:"activity"`
	Markers        []EngagementMarker     `json:"markers"`
	Tiers          EngagementTierCounts   `json:"tiers"`
	Callouts       EngagementCallouts     `json:"callouts"`
	Polls          []EngagementPoll       `json:"polls"`
	Reactions      EngagementReactions    `json:"reactions"`
	Chat           EngagementChat         `json:"chat"`
	Questions      []EngagementQuestion   `json:"questions"`
	Weights        []EngagementWeight     `json:"weights"`
	Axis           EngagementAxis         `json:"axis"`
}

type EngagementCounts struct {
	Chats        int `json:"chats"`
	Questions    int `json:"questions"`
	Upvotes      int `json:"upvotes"`
	Polls        int `json:"polls"`
	PollsPresent int `json:"pollsPresent"`
	QuizCorrect  int `json:"quizCorrect"`
	QuizAnswered int `json:"quizAnswered"`
	QuizPresent  int `json:"quizPresent"`
	Reactions    int `json:"reactions"`
	Hands        int `json:"hands"`
	/** Post-event survey: submitted, or (link mode) only opened; Rating is 1–5, 0 for none. */
	SurveyDone    bool `json:"surveyDone,omitempty"`
	SurveyClicked bool `json:"surveyClicked,omitempty"`
	Rating        int  `json:"rating,omitempty"`
}

/** `early`, `on_time` or `late`. */
type JoinTiming string

const (
	JoinEarly  JoinTiming = "early"
	JoinOnTime JoinTiming = "on_time"
	JoinLate   JoinTiming = "late"
)

/** One heatmap row. Presence is percent of each Axis column present (0..100). */
type EngagementAttendeeRow struct {
	Identity     string           `json:"identity"`
	Name         string           `json:"name"`
	Email        string           `json:"email,omitempty"`
	Score        int              `json:"score"`
	Tier         EngagementTier   `json:"tier"`
	WatchMin     int              `json:"watchMin"`
	FirstJoinMin int              `json:"firstJoinMin"`
	LastLeaveMin int              `json:"lastLeaveMin"`
	JoinTiming   JoinTiming       `json:"joinTiming"`
	Visits       int              `json:"visits"`
	Counts       EngagementCounts `json:"counts"`
	Presence     []int            `json:"presence"`
	Intensity    []int            `json:"intensity"`
}

/** `score`, `name`, `watch`, `join`. */
type EngagementSort string

const (
	SortScore EngagementSort = "score"
	SortName  EngagementSort = "name"
	SortWatch EngagementSort = "watch"
	SortJoin  EngagementSort = "join"
)

/** GET /engagement/attendees?sort=&dir=&tier=&q=&cursor=&limit= */
type EngagementAttendeePage struct {
	Rows []EngagementAttendeeRow `json:"rows"`
	/** Rows matching the filters, across every page. */
	Total      int            `json:"total"`
	NextCursor string         `json:"nextCursor,omitempty"`
	Axis       EngagementAxis `json:"axis"`
}

type EngagementComponent struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Weight float64 `json:"weight"`
	Ratio  float64 `json:"ratio"`
	Points float64 `json:"points"`
	Detail string  `json:"detail"`
}

/** `join`, `leave`, `chat`, `question`, `upvote`, `poll`, `quiz`, `reaction`, `hand`, `stage`. */
type EngagementEventKind string

const (
	EventJoin     EngagementEventKind = "join"
	EventLeave    EngagementEventKind = "leave"
	EventChat     EngagementEventKind = "chat"
	EventQuestion EngagementEventKind = "question"
	EventUpvote   EngagementEventKind = "upvote"
	EventPoll     EngagementEventKind = "poll"
	EventQuiz     EngagementEventKind = "quiz"
	EventReaction EngagementEventKind = "reaction"
	EventHand     EngagementEventKind = "hand"
	EventStage    EngagementEventKind = "stage"
)

type EngagementTimelineEvent struct {
	/** Seconds from the start, so sub-minute order survives. */
	AtSec   int                 `json:"atSec"`
	Kind    EngagementEventKind `json:"kind"`
	Text    string              `json:"text"`
	Correct *bool               `json:"correct,omitempty"`
	Emoji   string              `json:"emoji,omitempty"`
}

type EngagementVisitSpan struct {
	FromMin int `json:"fromMin"`
	/** Absent (-1) while still in the room. */
	ToMin int `json:"toMin"`
}

/** GET /engagement/attendees/{identity} */
type EngagementAttendeeDetail struct {
	Row        EngagementAttendeeRow     `json:"row"`
	Components []EngagementComponent     `json:"components"`
	Visits     []EngagementVisitSpan     `json:"visits"`
	Timeline   []EngagementTimelineEvent `json:"timeline"`
	/** True when the timeline hit its cap and older entries were dropped. */
	Truncated bool `json:"truncated,omitempty"`
	/** Nil when the person has no CRM contact to consult. */
	WhatsAppOptIn *bool             `json:"whatsAppOptIn,omitempty"`
	Reactions     []EngagementCount `json:"reactions"`
	SessionMin    int               `json:"sessionMin"`
}
