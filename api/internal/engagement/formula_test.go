package engagement

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

type scoreCase struct {
	Name    string `json:"name"`
	Session struct {
		Polls, Quiz, Chat, QA, Reactions, Hands, Survey bool
	} `json:"session"`
	Input struct {
		WatchSec, SessionSec, Chats, Questions, Upvotes       int
		PollsPresent, PollsAnswered, QuizPresent, QuizCorrect int
		Reactions, Hands                                      int
		SurveyDone, SurveyClicked                             bool
	} `json:"input"`
	Score int                  `json:"score"`
	Tier  types.EngagementTier `json:"tier"`
}

func loadCases(t *testing.T) []scoreCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/score_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		FormulaVersion int         `json:"formulaVersion"`
		Cases          []scoreCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.FormulaVersion != Current().Version {
		t.Fatalf("table is for formula v%d, current is v%d", doc.FormulaVersion, Current().Version)
	}
	return doc.Cases
}

func TestScoreMatchesSharedTable(t *testing.T) {
	f := Current()
	for _, c := range loadCases(t) {
		t.Run(c.Name, func(t *testing.T) {
			u := Usage{KeyPolls: c.Session.Polls, KeyQuiz: c.Session.Quiz, KeyChat: c.Session.Chat,
				KeyQA: c.Session.QA, KeyReactions: c.Session.Reactions, KeyHands: c.Session.Hands,
				KeySurvey: c.Session.Survey}
			in := c.Input
			var probe Input
			probe.AddSurvey("x", in.SurveyDone, in.SurveyClicked, 0)
			got, parts := f.Score(u, Signals{
				Extra:    probe.Extra["x"],
				WatchSec: in.WatchSec, SessionSec: in.SessionSec, Chats: in.Chats,
				Questions: in.Questions, Upvotes: in.Upvotes,
				PollsPresent: in.PollsPresent, PollsAnswered: in.PollsAnswered,
				QuizPresent: in.QuizPresent, QuizCorrect: in.QuizCorrect,
				Reactions: in.Reactions, Hands: in.Hands,
			})
			if got != c.Score {
				t.Fatalf("score = %d, want %d (%+v)", got, c.Score, parts)
			}
			if tier := f.Tiers.Tier(got); tier != c.Tier {
				t.Fatalf("tier = %s, want %s", tier, c.Tier)
			}
			weight := 0.0
			for _, p := range parts {
				weight += p.Weight
			}
			if len(parts) > 0 && (weight < 99.5 || weight > 100.5) {
				t.Fatalf("weights sum to %.1f, want 100", weight)
			}
		})
	}
}

func TestSurveyNeverAppliesUntilASourcePlugsIn(t *testing.T) {
	f := Current()
	for _, w := range f.Weights(Usage{KeyChat: true}) {
		if w.Key == KeySurvey && w.Weight != 0 {
			t.Fatalf("survey weight %.1f in a session with no surveys", w.Weight)
		}
	}
	u := Usage{KeySurvey: true}
	done, _ := f.Score(u, Signals{SessionSec: 3600, Extra: map[string]float64{surveySignal: 1}})
	notDone, _ := f.Score(u, Signals{SessionSec: 3600})
	if done <= notDone {
		t.Fatalf("a completed survey should add points once the tool is used: %d vs %d", done, notDone)
	}
}

func TestSurveyTermCreditsAndDetail(t *testing.T) {
	var in Input
	in.AddSurvey("att_a", true, false, 4)
	in.AddSurvey("att_b", false, true, 0)
	in.AddSurvey("att_c", false, false, 0)
	for id, want := range map[string]struct {
		ratio  float64
		detail string
	}{
		"att_a": {1, "Completed · rated 4/5"},
		"att_b": {0.5, "Opened the survey link"},
		"att_c": {0, "Not completed"},
	} {
		r, d := surveyRatio(Signals{Extra: in.Extra[id]})
		if r != want.ratio || d != want.detail {
			t.Errorf("%s: ratio %.2f %q, want %.2f %q", id, r, d, want.ratio, want.detail)
		}
	}
}

// v1 is still registered, and a session with no survey scores identically under v1 and v2.
func TestV2MatchesV1WithoutASurvey(t *testing.T) {
	v1, _ := Lookup(1)
	v2, ok := Lookup(2)
	if !ok || Current().Version != 2 {
		t.Fatal("v2 must be registered and current")
	}
	u := Usage{KeyChat: true, KeyPolls: true}
	sig := Signals{WatchSec: 1800, SessionSec: 3600, Chats: 2, PollsPresent: 1, PollsAnswered: 1,
		Extra: map[string]float64{SignalSurveyDone: 1}}
	a, _ := v1.Score(u, sig)
	b, _ := v2.Score(u, sig)
	if a != b {
		t.Fatalf("v1 %d vs v2 %d with no survey sent", a, b)
	}
}

func TestRegistryKeepsOlderVersionsReadable(t *testing.T) {
	v1, ok := Lookup(1)
	if !ok || v1.Version != 1 {
		t.Fatal("v1 not registered")
	}
	Register(Formula{Version: 99, Tiers: v1.Tiers, Components: v1.Components[:1]})
	defer func() {
		registryMu.Lock()
		delete(registry, 99)
		current = 2
		registryMu.Unlock()
	}()
	if Current().Version != 99 {
		t.Fatal("highest version should be current")
	}
	if _, ok := Lookup(1); !ok {
		t.Fatal("v1 disappeared after registering v99")
	}
}

func TestThresholdBoundaries(t *testing.T) {
	th := Current().Tiers
	for score, want := range map[int]types.EngagementTier{
		100: types.TierHigh, 75: types.TierHigh, 74: types.TierEngaged, 50: types.TierEngaged,
		49: types.TierPassive, 25: types.TierPassive, 24: types.TierRisk, 0: types.TierRisk,
	} {
		if got := th.Tier(score); got != want {
			t.Errorf("Tier(%d) = %s, want %s", score, got, want)
		}
	}
}
