package api

import (
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/netkumar/webcast/api/internal/knowledge"
)

/* The free first pass of spam detection: rules, no model. Every attendee chat message and
 * question is scored as it is sent (spamScore), in microseconds, on the say path.
 *
 * Each rule that matches adds its weight; the score is the sum, held to 1. At spamFlagAt or
 * more the message is flagged at once. From spamSuspectAt it waits for the batched AI pass
 * (spam.go), which decides. Below that it is not recorded at all.
 *
 * Repeats and flooding need the sender's recent messages. Those are kept in this process
 * (spamHistory), not the database: the say path is the hottest in the product, and an
 * instance that misses a few of one person's messages only scores them a little lower. */

const (
	// spamSuspectAt and up waits for the AI pass.
	spamSuspectAt = 0.3
	// spamFlagAt and up is flagged by the rules alone.
	spamFlagAt = 0.7

	// spamRepeatWindow is how far back a repeat or a copy-paste counts.
	spamRepeatWindow = 10 * time.Minute
	// spamFloodWindow and spamFloodCount: this many messages from one person inside the
	// window is flooding (the say limiter's 90 a minute is for reactions, too).
	spamFloodWindow = 30 * time.Second
	spamFloodCount  = 6
)

// The rules' weights.
var spamWeights = map[string]float64{
	"whatsapp":   0.6,
	"phone":      0.4,
	"link":       0.35,
	"scam_words": 0.35, // per distinct phrase, at most two
	"dm_me":      0.35,
	"repeat":     0.3, // 0.5 from the third time
	"copy_paste": 0.4,
	"flood":      0.4,
	"caps":       0.25,
	"emoji":      0.25,
}

var (
	spamURL = regexp.MustCompile(`(?i)\b(?:https?://|www\.)\S+|\b[a-z0-9][a-z0-9-]*\.(?:com|in|net|org|io|me|xyz|top|ly|link|site|online|club|info|biz|co|app|shop|live)(?:/\S*)?\b`)
	// WhatsApp and Telegram invites, and "my WhatsApp number" in English and Hinglish.
	spamInvite = regexp.MustCompile(`(?i)chat\.whatsapp\.com|wa\.me/|t\.me/|whats\s*app\s*(?:group|grp|channel|me|no|number|num|pe|par|karo|kro)|(?:join|add)\s+(?:my\s+|our\s+)?(?:telegram|whats\s*app|wa)\b|telegram\s*(?:group|channel)`)
	spamDM     = regexp.MustCompile(`(?i)\b(?:dm|inbox|ping|msg|message|text|call|contact)\s+me\b|\bdm\s+(?:for|now)\b|\bcheck\s+(?:my\s+)?(?:bio|profile|dm)\b`)
)

// spamPhrases are scam and promotion phrases, matched in lower case.
var spamPhrases = []string{
	"crypto", "bitcoin", "btc ", "usdt", "forex", "binary option", "trading signal",
	"investment plan", "double your", "guaranteed return", "guaranteed profit", "100% profit",
	"earn ₹", "earn rs", "earn $", "earn money", "earn daily", "daily income", "daily earning",
	"per day earning", "work from home", "part time job", "part-time job", "airdrop",
	"giveaway", "free money", "lottery", "click here", "limited offer", "loan approved",
	"paisa kamao", "ghar baithe",
}

// spamRuleResult is one message's score and the rules that matched, by name.
type spamRuleResult struct {
	Score   float64
	Reasons []string
}

// spamCategoryFor is the category a rules-only flag is filed under.
func spamCategoryFor(reasons []string) string {
	has := map[string]bool{}
	for _, r := range reasons {
		has[r] = true
	}
	switch {
	case has["scam_words"]:
		return "scam"
	case has["whatsapp"] || has["link"] || has["phone"] || has["dm_me"]:
		return "promo"
	default:
		return "off_topic"
	}
}

// spamPrior is what the history knows about a sender when their message arrives.
type spamPrior struct {
	// Same is how many times this sender sent the same text inside spamRepeatWindow.
	Same int
	// Others is how many other people sent the same text inside spamRepeatWindow.
	Others int
	// Recent is how many messages this sender sent inside spamFloodWindow, this one included.
	Recent int
}

/* spamScore is the rules over one message. allowLinks is the host's setting: on, a link alone
 * is not a signal (a WhatsApp invite still is). */
func spamScore(text string, allowLinks bool, prior spamPrior) spamRuleResult {
	var res spamRuleResult
	add := func(reason string, w float64) {
		res.Reasons = append(res.Reasons, reason)
		res.Score += w
	}
	lower := strings.ToLower(text)

	invite := spamInvite.MatchString(text)
	if invite {
		add("whatsapp", spamWeights["whatsapp"])
	}
	if !allowLinks && !invite && spamURL.MatchString(text) {
		add("link", spamWeights["link"])
	}
	if strings.Contains(knowledge.ScrubPII(text), knowledge.PhonePlaceholder) &&
		!strings.Contains(text, knowledge.PhonePlaceholder) {
		add("phone", spamWeights["phone"])
	}
	phrases := 0
	for _, p := range spamPhrases {
		if strings.Contains(lower+" ", p) {
			phrases++
		}
	}
	if phrases > 0 {
		if phrases > 2 {
			phrases = 2
		}
		res.Reasons = append(res.Reasons, "scam_words")
		res.Score += spamWeights["scam_words"] * float64(phrases)
	}
	if spamDM.MatchString(text) {
		add("dm_me", spamWeights["dm_me"])
	}
	switch {
	case prior.Same >= 2:
		add("repeat", 0.5)
	case prior.Same == 1:
		add("repeat", spamWeights["repeat"])
	}
	if prior.Others >= 2 {
		add("copy_paste", spamWeights["copy_paste"])
	}
	if prior.Recent >= spamFloodCount {
		add("flood", spamWeights["flood"])
	}
	if shouting(text) {
		add("caps", spamWeights["caps"])
	}
	if emojiFlood(text) {
		add("emoji", spamWeights["emoji"])
	}
	if res.Score > 1 {
		res.Score = 1
	}
	res.Score = float64(int(res.Score*100+0.5)) / 100
	return res
}

// shouting is a message of twelve letters or more, four in five of them capitals.
func shouting(text string) bool {
	letters, upper := 0, 0
	for _, r := range text {
		if unicode.IsLetter(r) && r < 0x250 {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	return letters >= 12 && upper*5 >= letters*4
}

// emojiFlood is ten emoji or more, or six or more that are most of the message.
func emojiFlood(text string) bool {
	emoji, other := 0, 0
	for _, r := range text {
		switch {
		case isEmoji(r):
			emoji++
		case r == 0x200D || r == 0xFE0F || unicode.IsSpace(r) || unicode.Is(unicode.Mn, r):
		default:
			other++
		}
	}
	return emoji >= 10 || (emoji >= 6 && emoji > other)
}

func isEmoji(r rune) bool {
	return (r >= 0x1F300 && r <= 0x1FAFF) || (r >= 0x2600 && r <= 0x27BF) || (r >= 0x1F000 && r <= 0x1F2FF)
}

// ---------------------------------------------------------------- history

type spamSeen struct {
	sender string
	text   string
	at     time.Time
}

// spamHistory is one session's recent attendee messages in this process, for the repeat,
// copy-paste and flood rules. Bounded: older than spamRepeatWindow is dropped, and at most
// spamHistoryCap messages are kept.
type spamHistory struct {
	mu   sync.Mutex
	seen []spamSeen
}

const spamHistoryCap = 2000

// observe records one message and returns what was known before it.
func (h *spamHistory) observe(sender, text string, now time.Time) spamPrior {
	norm := qaNormalize(text)
	h.mu.Lock()
	defer h.mu.Unlock()
	cut := 0
	for cut < len(h.seen) && now.Sub(h.seen[cut].at) > spamRepeatWindow {
		cut++
	}
	if len(h.seen)-cut >= spamHistoryCap {
		cut = len(h.seen) - spamHistoryCap + 1
	}
	h.seen = h.seen[cut:]

	var p spamPrior
	others := map[string]bool{}
	for _, m := range h.seen {
		if m.sender == sender {
			if now.Sub(m.at) <= spamFloodWindow {
				p.Recent++
			}
			if norm != "" && m.text == norm {
				p.Same++
			}
		} else if len([]rune(norm)) >= 15 && m.text == norm {
			others[m.sender] = true
		}
	}
	p.Recent++
	p.Others = len(others)
	h.seen = append(h.seen, spamSeen{sender: sender, text: norm, at: now})
	return p
}
