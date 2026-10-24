package api

import (
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The early-start refusal names the button the host pressed: "Start meeting" for a meeting,
 * "Go live" for a webinar. */
func TestGoLiveClosedNamesTheButton(t *testing.T) {
	startsAt := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	for kind, want := range map[types.WebinarKind]string{
		types.KindMeeting: "Start meeting opens 15 minutes before the start",
		"":                "Go live opens 15 minutes before the start",
	} {
		msg, closed := goLiveClosed(types.Webinar{Kind: kind, StartsAt: startsAt, TimeZone: "UTC"})
		if !closed || !strings.HasPrefix(msg, want) {
			t.Errorf("kind %q: closed=%v msg=%q, want a refusal starting %q", kind, closed, msg, want)
		}
	}
}
