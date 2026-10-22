package api_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* A signed-in visitor knocks without typing a name: the account's name stands in. A name
 * that was typed still wins over the account's, and somebody with no session still has to
 * give one. */
func TestMeetingKnockSignedInUsesAccountName(t *testing.T) {
	h := newHarness(t)
	meetingHost(t, h)
	wb := h.instantMeeting("Signed-in door", nil)

	guest := h.browser()
	guest.signup("Priya Raman", fmt.Sprintf("priya-%d@test.dev", time.Now().UnixNano()), false)
	res, raw := guest.do(http.MethodPost, "/api/webinars/"+wb.ID+"/meeting/knock",
		types.MeetingKnockRequest{Name: ""})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("signed-in knock with no name: status %d body %s", res.StatusCode, raw)
	}
	var out types.MeetingKnockResponse
	h.decode(raw, &out)
	if out.State != types.LobbyWaiting || out.JoinKey == "" {
		t.Fatalf("signed-in knock = %+v, want waiting with a key", out)
	}
	h.lobbyID(wb.ID, "Priya Raman") // fails unless the host sees the account's name

	typed := h.browser()
	typed.signup("Account Name", fmt.Sprintf("typed-%d@test.dev", time.Now().UnixNano()), false)
	if res, raw := typed.do(http.MethodPost, "/api/webinars/"+wb.ID+"/meeting/knock",
		types.MeetingKnockRequest{Name: "Typed Name"}); res.StatusCode != http.StatusOK {
		t.Fatalf("signed-in knock with a name: status %d body %s", res.StatusCode, raw)
	}
	h.lobbyID(wb.ID, "Typed Name")

	// No session and no name: still refused.
	res, _, raw = h.knock(wb.ID, "", "")
	if res.StatusCode < 400 || res.StatusCode >= 500 {
		t.Fatalf("anonymous knock with no name: status %d body %s, want a field error", res.StatusCode, raw)
	}
}

/* kind splits the portal's two lists: the Webinars page never shows (or counts) a meeting,
 * the Meetings page shows nothing else, and no kind is both, as before. */
func TestHostListKindSplitsWebinarsAndMeetings(t *testing.T) {
	h := newHarness(t)
	h.signup("Kind Host", "kind-host@test.dev", true)

	day := time.Now().AddDate(0, 0, 3).UTC().Truncate(time.Minute)
	h.createAt("A webinar", day.Format(time.RFC3339), "scheduled")
	res, raw := h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "A meeting", Kind: types.KindMeeting, StartsAt: day.Add(time.Hour).Format(time.RFC3339),
		Duration: 30, TimeZone: "UTC",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create meeting: status %d body %s", res.StatusCode, raw)
	}

	for _, tc := range []struct {
		query string
		want  []string
	}{
		{"", []string{"A webinar", "A meeting"}},
		{"?kind=webinar", []string{"A webinar"}},
		{"?kind=meeting", []string{"A meeting"}},
	} {
		got := h.hostPage(tc.query)
		if names := topics(got.Items); len(names) != len(tc.want) || names[0] != tc.want[0] {
			t.Errorf("%q: rows %v, want %v", tc.query, names, tc.want)
		}
		if got.Counts.Upcoming != len(tc.want) || got.Total != len(tc.want) {
			t.Errorf("%q: counts %+v total %d, want %d upcoming", tc.query, got.Counts, got.Total, len(tc.want))
		}
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars?kind=simulive", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "bad_kind" {
		t.Errorf("kind=simulive: status %d body %s, want 422 bad_kind", res.StatusCode, raw)
	}
}
