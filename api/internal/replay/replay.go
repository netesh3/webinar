/* Package replay builds a simulive session's engagement timeline: the chat, Q&A, host answers,
 * polls and quizzes, and reactions of the session a recording was made in, each placed at the
 * offset into the video at which it happened in the original.
 *
 * Polls carry no numbers. A poll is two moments — opened, closed — and at each the simulive's
 * own copy of it opens or closes (Schedule, PollActions; api/simulive_live.go), so the new
 * audience votes and sees its own results. Reactions are per-second counts with no identity,
 * folded into bursts (reactionBursts).
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

// Poll is one poll that was opened during the original session. Its votes are never read:
// the simulive's audience votes in a copy of their own (see Schedule and PollActions).
type Poll struct {
	ID           string
	Question     string
	Quiz         bool
	Options      []string
	Correct      *int
	ShareResults bool
	OpenedAt     time.Time
	ClosedAt     *time.Time
}

// ReactionBucket is how many of one emoji the original audience sent in one second.
type ReactionBucket struct {
	At    time.Time
	Emoji string
	N     int
}

// Source is everything the original session left behind, plus the recording's window.
type Source struct {
	RecordingStart time.Time
	// Zero when the recording's length is unknown: no upper bound then.
	Duration  time.Duration
	Chat      []Chat
	Questions []Question
	Polls     []Poll
	Reactions []ReactionBucket
}

// Item kinds (types.ReplayItem.Kind).
const (
	KindChat      = "chat"
	KindQuestion  = "question"
	KindAnswer    = "answer"
	KindPoll      = "poll"
	KindPollClose = "poll_close"
	KindReaction  = "reaction"
)

// ReactionWindow is the length of one replayed reaction burst: every reaction the original
// audience sent in these few seconds is one item, played as one burst.
const ReactionWindow = 5 * time.Second

// Keys name a source row for the host's curation (simulive_replay_hidden.item_key). A
// reaction burst has no row; its key is its window's index into the recording.
func ChatKey(id string) string     { return "chat:" + id }
func QuestionKey(id string) string { return "question:" + id }
func PollKey(id string) string     { return "poll:" + id }
func ReactionKey(window int64) string {
	return "reaction:" + strconv.FormatInt(window, 10)
}

// ValidKey reports whether a key is one Build could have produced.
func ValidKey(key string) bool {
	for _, p := range []string{"chat:", "question:", "poll:", "reaction:"} {
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
// answer, a poll's close): before `floor` moves up to it, past the end moves down to it.
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

/* ScheduledPoll is one original poll as the simulive replays it: when to open its copy and
 * when to close it, in ms into the recording. CloseMs is -1 when nothing closes it before the
 * session ends (the end closes every open poll).
 *
 * The close is the original's own close. An original that was never closed by hand was
 * closed by the next launch (one open poll at a time, see store.OpenPoll), so the next
 * poll's open is its close; failing that, the end of the recording. */
type ScheduledPoll struct {
	Key          string
	Question     string
	Quiz         bool
	Options      []string
	Correct      *int
	ShareResults bool
	OpenMs       int64
	CloseMs      int64
}

// Open reports whether the copy should be accepting votes at this position.
func (p ScheduledPoll) Open(posMs int64) bool {
	return posMs >= p.OpenMs && (p.CloseMs < 0 || posMs < p.CloseMs)
}

// Schedule is every original poll inside the recording, in launch order. Hidden ones too:
// whether one is replayed is PollActions' decision, so a host can hide and show it again.
func Schedule(src Source) []ScheduledPoll {
	var out []ScheduledPoll
	for _, p := range src.Polls {
		at, ok := src.Offset(p.OpenedAt)
		if !ok {
			continue
		}
		sp := ScheduledPoll{
			Key: PollKey(p.ID), Question: Scrub(p.Question), Quiz: p.Quiz,
			ShareResults: p.ShareResults, OpenMs: at, CloseMs: -1,
		}
		for _, o := range p.Options {
			sp.Options = append(sp.Options, Scrub(o))
		}
		if p.Quiz && p.Correct != nil {
			c := *p.Correct
			sp.Correct = &c
		}
		if p.ClosedAt != nil {
			sp.CloseMs = src.clampOffset(*p.ClosedAt, at)
		}
		out = append(out, sp)
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].OpenMs < out[b].OpenMs })
	for i := range out {
		if out[i].CloseMs >= 0 {
			continue
		}
		if i+1 < len(out) {
			out[i].CloseMs = out[i+1].OpenMs
		} else if src.Duration > 0 {
			out[i].CloseMs = src.Duration.Milliseconds()
		}
	}
	return out
}

// Poll actions (PollAction.Op).
const (
	OpOpen  = "open"
	OpClose = "close"
)

// PollAction is one change to the simulive's replayed polls.
type PollAction struct {
	Op   string
	Poll ScheduledPoll
}

/* PollActions is what to do to the simulive's replayed polls at this position.
 *
 * have is the copies already in the simulive, key → state ("open" / "closed"). A copy is
 * opened once, inside its window, and never again: closed (by its moment, by the host, by
 * another launch) stays closed, so a host who closes one early is not overruled. One that
 * is open past its moment, or that the host has hidden since, is closed. A window that
 * passed with no copy made (nobody in the room asked during it) is skipped — there was
 * nobody to vote. Closes come first and at most one opens, so "one open poll" holds.
 */
func PollActions(sched []ScheduledPoll, hidden map[string]bool, have map[string]string, posMs int64) []PollAction {
	var closes []PollAction
	var open *ScheduledPoll
	for i := range sched {
		p := sched[i]
		state, made := have[p.Key]
		switch {
		case made && state == "open" && (hidden[p.Key] || !p.Open(posMs)):
			closes = append(closes, PollAction{Op: OpClose, Poll: p})
		case !made && !hidden[p.Key] && p.Open(posMs):
			open = &sched[i]
		}
	}
	if open != nil {
		closes = append(closes, PollAction{Op: OpOpen, Poll: *open})
	}
	return closes
}

// NextBoundary is the first moment after posMs at which PollActions could answer differently
// (a poll opens or closes), or -1 when there is none.
func NextBoundary(sched []ScheduledPoll, posMs int64) int64 {
	next := int64(-1)
	consider := func(ms int64) {
		if ms > posMs && (next < 0 || ms < next) {
			next = ms
		}
	}
	for _, p := range sched {
		consider(p.OpenMs)
		if p.CloseMs >= 0 {
			consider(p.CloseMs)
		}
	}
	return next
}

type entry struct {
	item  types.ReplayItem
	order int // kind order at the same instant: a poll before its close, a question before its answer
	seq   int // source order, for a total order
	ref   int // index into entries of the item this one belongs to, or -1
}

/* Build turns a Source into the timeline.
 *
 * hidden is the host's curation (keys). preview is the host's view of it: every item,
 * hidden ones included and marked, each with its Key (and a quiz's answer). The audience's
 * view (preview false) leaves hidden items out entirely and carries no keys. Hiding a
 * question hides its answer and hiding a poll hides its close.
 *
 * A poll is two moments with no numbers: where the original opened it and where it closed.
 * The room re-reads its own polls at each; the poll it votes in is the simulive's copy.
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

	for _, p := range Schedule(src) {
		poll := types.ReplayPoll{Question: p.Question, Options: p.Options, Quiz: p.Quiz}
		if preview && p.Quiz {
			poll.Correct = p.Correct
		}
		pi := add(types.ReplayItem{Kind: KindPoll, AtMs: p.OpenMs, Role: types.RoleHost, Poll: &poll, Key: p.Key}, 1, -1)
		if p.CloseMs < 0 {
			continue
		}
		closed := poll
		add(types.ReplayItem{Kind: KindPollClose, AtMs: p.CloseMs, Role: types.RoleHost, Poll: &closed, Key: p.Key}, 3, pi)
	}

	for _, b := range reactionBursts(src) {
		add(b, 0, -1)
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

/* reactionBursts folds the per-second reaction counts into one item per ReactionWindow of
 * the recording that had any: at the first second in it, each emoji with its count, most
 * sent first. Nobody's name — a reaction never carried one. */
func reactionBursts(src Source) []types.ReplayItem {
	type burst struct {
		at     int64
		counts map[string]int
	}
	win := ReactionWindow.Milliseconds()
	byWindow := map[int64]*burst{}
	var order []int64
	for _, r := range src.Reactions {
		at, ok := src.Offset(r.At)
		if !ok || r.N <= 0 || r.Emoji == "" {
			continue
		}
		w := at / win
		b := byWindow[w]
		if b == nil {
			b = &burst{at: at, counts: map[string]int{}}
			byWindow[w] = b
			order = append(order, w)
		}
		if at < b.at {
			b.at = at
		}
		b.counts[r.Emoji] += r.N
	}
	sort.Slice(order, func(a, b int) bool { return order[a] < order[b] })
	out := make([]types.ReplayItem, 0, len(order))
	for _, w := range order {
		b := byWindow[w]
		rs := make([]types.ReplayReaction, 0, len(b.counts))
		for e, n := range b.counts {
			rs = append(rs, types.ReplayReaction{Emoji: e, Count: n})
		}
		sort.Slice(rs, func(a, c int) bool {
			if rs[a].Count != rs[c].Count {
				return rs[a].Count > rs[c].Count
			}
			return rs[a].Emoji < rs[c].Emoji
		})
		out = append(out, types.ReplayItem{Kind: KindReaction, AtMs: b.at, Reactions: rs, Key: ReactionKey(w)})
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
