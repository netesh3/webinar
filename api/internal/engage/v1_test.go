package engage

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/types"
)

func TestReplyDigestMessage(t *testing.T) {
	m := replyDigestMessage("coach@example.com", 5, []string{"Thandi", "Sam", "Ayanda"}, "https://webinarliv.com/")
	if m.To != "coach@example.com" || m.Subject != "5 WhatsApp replies waiting" {
		t.Fatalf("message = %+v", m)
	}
	if !strings.Contains(m.Body, "Thandi, Sam, Ayanda and 2 more") ||
		!strings.Contains(m.Body, "https://webinarliv.com/host?tab=messages") {
		t.Errorf("body = %q", m.Body)
	}
	if one := replyDigestMessage("c@x", 1, []string{"Thandi"}, "http://x"); one.Subject != "1 WhatsApp reply waiting" {
		t.Errorf("singular subject = %q", one.Subject)
	}
}

func TestSegmentLabel(t *testing.T) {
	for _, tc := range []struct {
		seg  types.CRMSegment
		want string
	}{
		{types.CRMSegment{}, "Everyone registered"},
		{types.CRMSegment{Attendance: types.SegmentNoShow}, "Didn't join"},
		{types.CRMSegment{MinWatchMin: 45}, "Watched 45+ min"},
		{types.CRMSegment{MinWatchMin: 15, MaxWatchMin: 45}, "Watched 15–45 min"},
		{types.CRMSegment{Attendance: types.SegmentJoined, MaxWatchMin: 15}, "Watched under 15 min"},
		{types.CRMSegment{Attendance: types.SegmentJoined, Replied: true}, "Attended · Replied"},
	} {
		if got := crmstore.SegmentLabel(tc.seg); got != tc.want {
			t.Errorf("SegmentLabel(%+v) = %q, want %q", tc.seg, got, tc.want)
		}
	}
}

func TestWatchedText(t *testing.T) {
	if watchedText(1) != "1 minute" || watchedText(58) != "58 minutes" || watchedText(0) != "0 minutes" {
		t.Error("watchedText wrong")
	}
}
