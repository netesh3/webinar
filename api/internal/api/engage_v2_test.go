package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Engage v2: the numbers the redesigned screens read.
 *
 *   - the send preview gets each real recipient's values, filled in the way the
 *     broadcast will fill them;
 *   - a webinar's results count registered, joined and average watch time;
 *   - the thread carries the person's webinars with watch time;
 *   - the bell's replies carry a preview of what they said;
 *   - the home summary counts the week's sends and replies.
 */
func TestEngageV2PreviewResultsHistorySummary(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Scale your coaching practice")

	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)
	registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone3, true)

	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Minute)
	pinSessionWindow(t, wb.ID, start, start.Add(90*time.Minute))
	seedWatch(t, h, wb.ID, "thandi@example.com", 58, start)
	seedWatch(t, h, wb.ID, "ayanda@example.com", 12, start)

	// Preview: real names and real values, not the example ones.
	code, aud, raw := postAudience(t, h, types.CRMBroadcastRequest{
		Audience: types.AudienceSegment, WebinarID: wb.ID,
		Segment: &types.CRMSegment{Attendance: types.SegmentJoined},
		Params:  []types.CRMParam{{Field: "first_name"}, {Field: "watched"}, {Text: "  see   you  "}},
	})
	if code != http.StatusOK || aud.Recipients != 2 || len(aud.Samples) != 2 {
		t.Fatalf("audience with params = %d %+v (%s), want two samples", code, aud, raw)
	}
	byName := map[string][]string{}
	for _, s := range aud.Samples {
		byName[s.Name] = s.Params
	}
	if p := byName["Thandi"]; len(p) != 3 || p[0] != "Thandi" || p[1] != "58 minutes" || p[2] != "see you" {
		t.Errorf("Thandi's preview values = %q (samples %+v)", p, aud.Samples)
	}
	// Without params, no samples: the count alone is the cheap call.
	if _, plain, _ := postAudience(t, h, types.CRMBroadcastRequest{
		Audience: types.AudienceSegment, WebinarID: wb.ID,
		Segment: &types.CRMSegment{Attendance: types.SegmentJoined},
	}); len(plain.Samples) != 0 {
		t.Errorf("samples without params = %+v", plain.Samples)
	}

	// Results.
	res, raw := h.do(http.MethodGet, "/api/host/crm/webinars/"+wb.ID+"/messages", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("webinar messages: status %d body %s", res.StatusCode, raw)
	}
	var wm types.CRMWebinarMessagesResponse
	h.decode(raw, &wm)
	if r := wm.Results; r.Registered != 3 || r.Joined != 2 || r.AvgWatchMin != 35 ||
		r.Reminded+r.Others != 3 {
		t.Errorf("results = %+v, want 3 registered, 2 joined, 35 min average", r)
	}

	// The thread's history, and the bell's preview.
	postWebhook(t, h, inboundNow("wamid.V2IN1", crmPhoneDigits, "Thandi", "Is there a replay?"))
	th := threadFor(t, h, thandi.ID)
	if len(th.Meta.History) != 1 || th.Meta.History[0].ID != wb.ID ||
		!th.Meta.History[0].Joined || th.Meta.History[0].WatchMin != 58 {
		t.Errorf("history = %+v, want this webinar with 58 min", th.Meta.History)
	}
	res, raw = h.do(http.MethodGet, "/api/host/crm/replies", nil)
	var replies types.CRMRepliesResponse
	h.decode(raw, &replies)
	if res.StatusCode != http.StatusOK || len(replies.Recent) != 1 || replies.Recent[0].Preview != "Is there a replay?" {
		t.Errorf("replies = %d %+v, want the preview", res.StatusCode, replies)
	}

	// Summary.
	res, raw = h.do(http.MethodGet, "/api/host/crm/summary", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("summary: status %d body %s", res.StatusCode, raw)
	}
	var sum types.CRMSummaryResponse
	h.decode(raw, &sum)
	if sum.Days != 7 || !sum.Connected || sum.Replied != 1 || sum.NeedsReply != 1 || sum.NewOptIns != 3 {
		t.Errorf("summary = %+v", sum)
	}
}
