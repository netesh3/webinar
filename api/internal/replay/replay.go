/* Package replay builds a simulive session's engagement timeline: the chat, Q&A, host answers
 * and polls of the session a recording was made in, each placed at the offset into the video
 * at which it happened in the original.
 *
 *	offset = event time − recording start
 *
 * Events before the recording started (the pre-show) and after it ended are not in the video,
 * so they are not in the replay. A host answer given after the recording ended is shown at the
 * end; one with no recorded time (rows older than migration 0135) is shown with its question.
 *
 * Privacy is applied here, once, for every caller: an attendee's name becomes "Priya S.", and
 * phone numbers and email addresses are scrubbed out of every text. The audience timeline
 * carries no source ids, identities or join keys — item ids are positions ("r1", "r2", …) in
 * this one timeline. Only the host's preview carries Key, which names the source row so the
 * host can hide it (see Build's preview argument).
 *
 * Pure: no database, no clock. The store gathers a Source, the API applies the feature gate
 * and access control, and this turns one into the other.
 */
package replay

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/types"
)

// Chat is one original chat line, as the store read it. Only lines the original audience saw
// (destination everyone, not deleted, text) are ever put here.
type Chat struct {
	ID       string
	Identity string
	Name     string
	Role     types.Role
	Text     string
	At       time.Time
}

// Question is one original question that moderation did not hide.
type Question struct {
	ID         string
	Identity   string
	Name       string
	Role       types.Role
	Text       string
	Anonymous  bool
	Answered   bool
	Answer     string
	AnsweredAt *time.Time
	At         time.Time
}

// Poll is one poll that was opened during the original session.
type Poll struct {
	ID           string
	Question     string
	Quiz         bool
	Options      []string
	Correct      *int
	ShareResults bool
	Counts       []int
	OpenedAt     time.Time
	ClosedAt     *time.Time
}

// Source is everything the original session left behind, plus the recording's window.
type Source struct {
	RecordingStart time.Time
	// Zero when the recording's length is unknown: no upper bound then.
	Duration  time.Duration
	Chat      []Chat
	Questions []Question
	Polls     []Poll
}

// Item kinds (types.ReplayItem.Kind).
const (
	KindChat        = "chat"
	KindQuestion    = "question"
	KindAnswer      = "answer"
	KindPoll        = "poll"
	KindPollResults = "poll_results"
)

// Keys name a source row for the host's curation (simulive_replay_hidden.item_key).
func ChatKey(id string) string     { return "chat:" + id }
func QuestionKey(id string) string { return "question:" + id }
func PollKey(id string) string     { return "poll:" + id }

// ValidKey reports whether a key is one Build could have produced.
func ValidKey(key string) bool {
	for _, p := range []string{"chat:", "question:", "poll:"} {
		if strings.HasPrefix(key, p) && len(key) > len(p) && len(key) <= 200 {
			return true
		}
	}
	return false
}

// Offset is the event's position in the video, in milliseconds, and whether it is inside it.
func (src Source) Offset(at time.Time) (int64, bool) {
	d := at.Sub(src.RecordingStart)
	if d < 0 {
		return 0, false
	}
	if src.Duration > 0 && d > src.Duration {
		return 0, false
	}
	return d.Milliseconds(), true
}

// clampOffset is Offset for something that belongs to an item already on the timeline (an
// answer, a poll's results): before `floor` moves up to it, past the end moves down to it.
func (src Source) clampOffset(at time.Time, floor int64) int64 {
	ms := at.Sub(src.RecordingStart).Milliseconds()
	if src.Duration > 0 && ms > src.Duration.Milliseconds() {
		ms = src.Duration.Milliseconds()
	}
	if ms < floor {
		ms = floor
	}
	return ms
}

type entry struct {
	item  types.ReplayItem
	order int // kind order at the same instant: a poll before its results, a question before its answer
	seq   int // source order, for a total order
	ref   int // index into entries of the item this one belongs to, or -1
}

/* Build turns a Source into the timeline.
 *
 * hidden is the host's curation (keys). preview is the host's view of it: every item,
 * hidden ones included and marked, each with its Key. The audience's view (preview false)
 * leaves hidden items out entirely and carries no keys. Hiding a question hides its answer
 * and hiding a poll hides its results.
 */
func Build(src Source, hidden map[string]bool, preview bool) []types.ReplayItem {
	var all []entry
	seq := 0
	add := func(it types.ReplayItem, order, ref int) int {
		seq++
		all = append(all, entry{item: it, order: order, seq: seq, ref: ref})
		return len(all) - 1
	}

	for _, c := range src.Chat {
		at, ok := src.Offset(c.At)
		text := Scrub(c.Text)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}
		add(types.ReplayItem{
			Kind: KindChat, AtMs: at, Name: DisplayName(c.Name, c.Identity, c.Role),
			Role: replayRole(c.Role, c.Identity), Text: text, Key: ChatKey(c.ID),
		}, 0, -1)
	}

	for _, q := range src.Questions {
		at, ok := src.Offset(q.At)
		text := Scrub(q.Text)
		if !ok || strings.TrimSpace(text) == "" {
			continue
		}
		it := types.ReplayItem{
			Kind: KindQuestion, AtMs: at, Text: text, Anonymous: q.Anonymous,
			Key: QuestionKey(q.ID),
		}
		if q.Anonymous {
			it.Role = types.RoleAttendee
		} else {
			it.Name = DisplayName(q.Name, q.Identity, q.Role)
			it.Role = replayRole(q.Role, q.Identity)
		}
		qi := add(it, 1, -1)
		if !q.Answered {
			continue
		}
		answerAt := at
		if q.AnsweredAt != nil {
			answerAt = src.clampOffset(*q.AnsweredAt, at)
		}
		add(types.ReplayItem{
			Kind: KindAnswer, AtMs: answerAt, Role: types.RoleHost,
			Text: Scrub(q.Answer), Key: QuestionKey(q.ID),
		}, 2, qi)
	}

	for _, p := range src.Polls {
		at, ok := src.Offset(p.OpenedAt)
		if !ok {
			continue
		}
		poll := types.ReplayPoll{Question: Scrub(p.Question), Quiz: p.Quiz}
		for _, o := range p.Options {
			poll.Options = append(poll.Options, Scrub(o))
		}
		pi := add(types.ReplayItem{Kind: KindPoll, AtMs: at, Role: types.RoleHost, Poll: &poll, Key: PollKey(p.ID)}, 1, -1)
		if p.ClosedAt == nil || !p.ShareResults {
			continue
		}
		closed := src.clampOffset(*p.ClosedAt, at)
		res := poll
		res.Counts = append([]int(nil), p.Counts...)
		for len(res.Counts) < len(res.Options) {
			res.Counts = append(res.Counts, 0)
		}
		for _, n := range res.Counts {
			res.Total += n
		}
		if p.Quiz {
			res.Correct = p.Correct
		}
		add(types.ReplayItem{Kind: KindPollResults, AtMs: closed, Role: types.RoleHost, Poll: &res, Key: PollKey(p.ID)}, 3, pi)
	}

	idx := make([]int, len(all))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		x, y := all[idx[a]], all[idx[b]]
		if x.item.AtMs != y.item.AtMs {
			return x.item.AtMs < y.item.AtMs
		}
		if x.order != y.order {
			return x.order < y.order
		}
		return x.seq < y.seq
	})

	ids := make([]string, len(all))
	out := make([]types.ReplayItem, 0, len(all))
	n := 0
	for _, i := range idx {
		e := all[i]
		isHidden := hidden[e.item.Key]
		if isHidden && !preview {
			continue
		}
		n++
		ids[i] = "r" + strconv.Itoa(n)
		it := e.item
		it.ID = ids[i]
		if e.ref >= 0 {
			it.Ref = ids[e.ref]
		}
		if preview {
			it.Hidden = isHidden
		} else {
			it.Key = ""
		}
		out = append(out, it)
	}
	return out
}

/* replayRole is the role a replayed line is badged with. A host or panelist with an account
 * (identity user_…) keeps their role; anyone else — including an attendee the host brought on
 * stage, who was "panelist" for the length of the promotion — is the audience. */
func replayRole(role types.Role, identity string) types.Role {
	if (role == types.RoleHost || role == types.RolePanelist) && strings.HasPrefix(identity, "user_") {
		return role
	}
	return types.RoleAttendee
}

/* DisplayName is the name a replayed item shows.
 *
 * The presenters (an account on the stage) keep their name: the audience is watching them.
 * Everybody else is "First L." — enough to read as a person, not enough to find one. A name
 * that is really contact details (an email, a phone number typed into the name field) is
 * "Attendee".
 */
func DisplayName(name, identity string, role types.Role) string {
	name = strings.Join(strings.Fields(name), " ")
	if replayRole(role, identity) != types.RoleAttendee {
		if name == "" {
			return "Host"
		}
		return name
	}
	return ShortName(name)
}

// ShortName is "Priya Sharma" → "Priya S.". One word stays as it is.
func ShortName(name string) string {
	if Scrub(name) != name || strings.ContainsRune(name, '@') {
		return "Attendee"
	}
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return "Attendee"
	}
	first := truncateRunes(parts[0], 24)
	if len(parts) == 1 {
		return first
	}
	last := parts[len(parts)-1]
	r, _ := utf8.DecodeRuneInString(last)
	if r == utf8.RuneError || !unicode.IsLetter(r) {
		return first
	}
	return first + " " + string(unicode.ToUpper(r)) + "."
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

var (
	emailRe = regexp.MustCompile(`(?i)[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,}`)
	// A run of digits with the separators people put in phone numbers. Whether it IS a phone
	// number is decided by counting its digits (looksLikePhone), not by this pattern.
	phoneRe = regexp.MustCompile(`\+?\(?\d[\d\s().\-]{5,}\d`)
	dateRe  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$|^\d{2}[-./]\d{2}[-./]\d{4}$`)
)

// Placeholders that replace what Scrub takes out.
const (
	EmailRemoved = "[email removed]"
	PhoneRemoved = "[phone removed]"
)

/* Scrub removes email addresses and phone numbers from a text.
 *
 * Phone numbers: Indian (+91 98765 43210, 098765-43210, 9876543210) and international (+44 20
 * 7946 0958, (555) 123-4567). A run counts as a phone number at 8 to 15 digits; fewer is a
 * time, a price or a year, and more is not a number anyone dials. A bare date is left alone.
 */
func Scrub(text string) string {
	text = emailRe.ReplaceAllString(text, EmailRemoved)
	return phoneRe.ReplaceAllStringFunc(text, func(m string) string {
		trimmed := strings.TrimSpace(m)
		if dateRe.MatchString(trimmed) {
			return m
		}
		if !looksLikePhone(trimmed) {
			return m
		}
		// Keep the whitespace the match swallowed at either end, so words do not run together.
		lead := m[:len(m)-len(strings.TrimLeft(m, " \t"))]
		trail := m[len(strings.TrimRight(m, " \t")):]
		return lead + PhoneRemoved + trail
	})
}

func looksLikePhone(s string) bool {
	digits := 0
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	return digits >= 8 && digits <= 15
}
