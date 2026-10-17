package api

import (
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func TestCopyInputMakesAStandaloneDraft(t *testing.T) {
	now := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	src := types.Webinar{
		Topic: "Weekly office hours", Kind: types.KindRecurring, SeriesID: "series-1",
		StartsAt: "2026-10-10T10:30:00Z", Duration: 45, TimeZone: "Asia/Kolkata",
		CustomQuestions: []types.CustomQuestion{{ID: "q-old", Label: "Why?"}},
	}
	in := copyInput(src, nil, now)
	if in.Kind != types.KindLive || in.Recurrence != nil || in.Status != types.StatusDraft {
		t.Fatalf("kind %q recurrence %v status %q, want a live draft with no series", in.Kind, in.Recurrence, in.Status)
	}
	if in.CustomQuestions[0].ID != "" {
		t.Errorf("question id carried over: %q", in.CustomQuestions[0].ID)
	}
	// Same weekday and time, the first one more than a day out: Sat 24 Oct 10:30.
	if in.StartsAt != "2026-10-24T10:30:00Z" {
		t.Errorf("start = %s, want 2026-10-24T10:30:00Z", in.StartsAt)
	}
}

func TestCopyTopicStaysUnderTheLimit(t *testing.T) {
	long := strings.Repeat("é", 150)
	if got := copyTopic(long); len(got) > 200 || !strings.HasPrefix(got, "Copy of ") {
		t.Fatalf("copyTopic = %d bytes %q", len(got), got[:20])
	}
}
