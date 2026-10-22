package leads

import "testing"

const hour = 3600

func TestScoreFormula(t *testing.T) {
	cases := []struct {
		name string
		s    Signals
		want int
		tag  string
	}{
		{"no-show", Signals{SessionSec: hour}, 0, TagCold},
		{"stayed to the end, silent", Signals{Joined: true, WatchSec: hour, SessionSec: hour}, 40, TagWarm},
		{"half, silent", Signals{Joined: true, WatchSec: hour / 2, SessionSec: hour}, 20, TagCold},
		{"stayed and asked twice", Signals{Joined: true, WatchSec: hour, SessionSec: hour, Questions: 2}, 60, TagHot},
		{"questions cap at 20, upvotes at 5", Signals{Joined: true, WatchSec: hour, SessionSec: hour, Questions: 5, Upvotes: 9}, 65, TagHot},
		{"chat caps at 10", Signals{Joined: true, WatchSec: hour, SessionSec: hour, Chats: 20}, 50, TagWarm},
		{"polls cap at 9", Signals{Joined: true, WatchSec: hour, SessionSec: hour, PollAnswers: 7}, 49, TagWarm},
		{"hand and stage", Signals{Joined: true, WatchSec: hour, SessionSec: hour, RaisedHand: true, OnStage: true}, 55, TagHot},
		{"offer click", Signals{Joined: true, WatchSec: hour, SessionSec: hour, OfferClicks: 3}, 55, TagHot},
		{"no-show who watched all the replay", Signals{SessionSec: hour, ReplaySec: hour}, 15, TagCold},
		{"no-show who only opened the replay", Signals{SessionSec: hour, ReplayOpened: true}, 10, TagCold},
		{"replay ignored once they stayed past half", Signals{Joined: true, WatchSec: hour, SessionSec: hour, ReplaySec: hour}, 40, TagWarm},
		{"capped at 100", Signals{Joined: true, WatchSec: hour, SessionSec: hour, Questions: 9, Upvotes: 50, Chats: 50, PollAnswers: 9, RaisedHand: true, OnStage: true, OfferClicks: 1}, 100, TagHot},
		{"watch over the session is clamped", Signals{Joined: true, WatchSec: 2 * hour, SessionSec: hour}, 40, TagWarm},
	}
	for _, c := range cases {
		got := Score(c.s)
		if got != c.want {
			t.Errorf("%s: score %d, want %d", c.name, got, c.want)
		}
		if tag := Tag(got); tag != c.tag {
			t.Errorf("%s: tag %s, want %s", c.name, tag, c.tag)
		}
	}
}

func TestTagThresholds(t *testing.T) {
	for score, want := range map[int]string{0: TagCold, 29: TagCold, 30: TagWarm, 54: TagWarm, 55: TagHot, 100: TagHot} {
		if got := Tag(score); got != want {
			t.Errorf("Tag(%d) = %s, want %s", score, got, want)
		}
	}
}

func TestGroupThresholds(t *testing.T) {
	cases := []struct {
		s    Signals
		want string
	}{
		{Signals{SessionSec: hour}, GroupNoShow},
		{Signals{SessionSec: hour, ReplaySec: hour}, GroupNoShow},
		{Signals{Joined: true, WatchSec: hour/2 - 1, SessionSec: hour}, GroupLeftEarly},
		{Signals{Joined: true, WatchSec: hour / 2, SessionSec: hour}, GroupAttended},
		{Signals{Joined: true, WatchSec: hour, SessionSec: hour}, GroupAttended},
		// A session with no recorded length: joining is attending.
		{Signals{Joined: true}, GroupAttended},
	}
	for i, c := range cases {
		if got := Group(c.s); got != c.want {
			t.Errorf("case %d: group %s, want %s", i, got, c.want)
		}
	}
}

func TestRankOrderAndGroups(t *testing.T) {
	people := []Person{
		{Key: "b", Name: "Bina", Signals: Signals{Joined: true, WatchSec: hour, SessionSec: hour}},
		{Key: "a", Name: "Asha", Signals: Signals{Joined: true, WatchSec: hour, SessionSec: hour, Questions: 2}},
		{Key: "c", Name: "Chetan", Signals: Signals{Joined: true, WatchSec: 600, SessionSec: hour}},
		{Key: "d", Name: "Dev", Signals: Signals{SessionSec: hour}},
		{Key: "e", Name: "Esha", Signals: Signals{Joined: true, WatchSec: hour, SessionSec: hour}},
	}
	r := Rank(people)
	order := ""
	for _, p := range r {
		order += p.Key
	}
	if order != "abecd" {
		t.Fatalf("order %s, want abecd (score, then watch, then name)", order)
	}
	top := Top(r, 10)
	if len(top) != 4 {
		t.Fatalf("top %d, want the 4 who scored anything", len(top))
	}
	if len(Top(r, 2)) != 2 {
		t.Fatal("Top does not stop at n")
	}
	counts := GroupCounts(r)
	if counts[GroupAttended] != 3 || counts[GroupLeftEarly] != 1 || counts[GroupNoShow] != 1 || counts[GroupHot] != 1 {
		t.Fatalf("counts %v", counts)
	}
	if !InGroup(r[0], GroupHot) || !InGroup(r[0], GroupAttended) || InGroup(r[1], GroupHot) {
		t.Fatal("InGroup")
	}
	if !ValidGroup("hot") || ValidGroup("everyone") {
		t.Fatal("ValidGroup")
	}
}
