package api_test

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Engage v1: following up after a webinar, and the one inbox.
 *
 * The claims under test:
 *   - watch time is the session report's number, per registrant, and the segment
 *     audience ("watched 45+ min", "didn't join") selects the same people the
 *     Attendees tab shows in that bucket;
 *   - a hand-picked audience reaches only the opted-in people among those picked;
 *   - the People list counts attendance across webinars;
 *   - "needs reply" clears when the host replies, from the inbox or from the phone
 *     (Coexistence echo), and when marked done, and a new message reopens it;
 *   - a webinar's automatic messages are counted, delivered and read included.
 */

// seedWatch gives one registrant `minutes` of watch time inside a pinned live window.
func seedWatch(t *testing.T, h *harness, slug, email string, minutes int, start time.Time) {
	t.Helper()
	ctx := context.Background()
	identity := "att_" + strings.ReplaceAll(email, "@", "_")
	if err := h.store.TouchAttendance(ctx, slug, identity, idOf(t, h, slug, email), email); err != nil {
		t.Fatalf("touch attendance: %v", err)
	}
	mustOpen(t, h, ctx, slug, identity, email, start)
	mustClose(t, h, ctx, slug, identity, start.Add(time.Duration(minutes)*time.Minute))
}

func registrants(t *testing.T, h *harness, slug string) []types.RegistrantRow {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("registrants: status %d body %s", res.StatusCode, raw)
	}
	var rows []types.RegistrantRow
	h.decode(raw, &rows)
	return rows
}

func postAudience(t *testing.T, h *harness, body types.CRMBroadcastRequest) (int, types.CRMAudienceResponse, []byte) {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/audience", body)
	var out types.CRMAudienceResponse
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res.StatusCode, out, raw
}

func TestEngageV1WatchTimeSegmentsAndPicked(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Scale your coaching practice")

	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	ayanda := registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)
	sam := registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone3, true)
	// Opted out of nothing, but never opted in: reachable by no audience.
	registerWithPhone(t, h, wb.ID, "Lerato", "lerato@example.com", "+27 84 999 0000", false)

	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Minute)
	pinSessionWindow(t, wb.ID, start, start.Add(90*time.Minute))
	seedWatch(t, h, wb.ID, "thandi@example.com", 58, start)
	seedWatch(t, h, wb.ID, "ayanda@example.com", 12, start)
	seedWatch(t, h, wb.ID, "lerato@example.com", 70, start)
	// Sam never joined.

	// The Attendees tab's numbers.
	by := map[string]types.RegistrantRow{}
	for _, r := range registrants(t, h, wb.ID) {
		by[r.Email] = r
	}
	if r := by["thandi@example.com"]; !r.Joined || r.WatchMin != 58 || r.ContactID != thandi.ID {
		t.Errorf("thandi row = joined %v watch %d contact %q, want joined 58 %s", r.Joined, r.WatchMin, r.ContactID, thandi.ID)
	}
	if r := by["sam@example.com"]; r.Joined || r.WatchMin != 0 {
		t.Errorf("sam row = joined %v watch %d, want a no-show", r.Joined, r.WatchMin)
	}

	for _, tc := range []struct {
		name    string
		seg     types.CRMSegment
		reach   int
		noOptIn int
	}{
		{"watched 45+", types.CRMSegment{MinWatchMin: 45}, 1, 1},
		{"watched under 15", types.CRMSegment{MaxWatchMin: 15}, 1, 0},
		{"attended", types.CRMSegment{Attendance: types.SegmentJoined}, 2, 1},
		{"didn't join", types.CRMSegment{Attendance: types.SegmentNoShow}, 1, 0},
		{"everyone", types.CRMSegment{}, 3, 1},
	} {
		code, got, raw := postAudience(t, h, types.CRMBroadcastRequest{
			Audience: types.AudienceSegment, WebinarID: wb.ID, Segment: &tc.seg,
		})
		if code != http.StatusOK || got.Recipients != tc.reach || got.NoOptIn != tc.noOptIn {
			t.Errorf("%s: status %d audience %+v, want %d reachable and %d without consent (%s)",
				tc.name, code, got, tc.reach, tc.noOptIn, raw)
		}
	}

	// Refusals.
	for _, tc := range []struct {
		name string
		body types.CRMBroadcastRequest
		code string
	}{
		{"segment with no rule", types.CRMBroadcastRequest{Audience: types.AudienceSegment, WebinarID: wb.ID}, "crm_bad_segment"},
		{"empty range", types.CRMBroadcastRequest{Audience: types.AudienceSegment, WebinarID: wb.ID,
			Segment: &types.CRMSegment{MinWatchMin: 30, MaxWatchMin: 10}}, "crm_bad_segment"},
		{"no-show with watch time", types.CRMBroadcastRequest{Audience: types.AudienceSegment, WebinarID: wb.ID,
			Segment: &types.CRMSegment{Attendance: types.SegmentNoShow, MinWatchMin: 5}}, "crm_bad_segment"},
		{"segment with no webinar", types.CRMBroadcastRequest{Audience: types.AudienceSegment,
			Segment: &types.CRMSegment{MinWatchMin: 5}}, "crm_no_webinar"},
		{"no contacts picked", types.CRMBroadcastRequest{Audience: types.AudienceContacts}, "crm_no_contacts"},
		{"a malformed id", types.CRMBroadcastRequest{Audience: types.AudienceContacts, ContactIDs: []string{"nope"}}, "crm_no_contacts"},
	} {
		code, _, raw := postAudience(t, h, tc.body)
		if code != http.StatusUnprocessableEntity || errorCode(t, raw) != tc.code {
			t.Errorf("%s: status %d code %q, want 422 %s (%s)", tc.name, code, errorCode(t, raw), tc.code, raw)
		}
	}

	// Picked: three ticked, one of them never opted in.
	lerato := contactWithPhone(t, crmContacts(t, h).Contacts, "+27849990000")
	code, picked, raw := postAudience(t, h, types.CRMBroadcastRequest{
		Audience: types.AudienceContacts, ContactIDs: []string{ayanda.ID, sam.ID, lerato.ID},
	})
	if code != http.StatusOK || picked.Recipients != 2 || picked.NoOptIn != 1 {
		t.Errorf("picked audience = %d %+v (%s), want 2 reachable and 1 without consent", code, picked, raw)
	}

	// A follow-up to the 45+ bucket, with the watched merge field, sends to Thandi only.
	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Thanks for staying", Template: testTemplateUtility, Language: "en_US",
		Params:   []types.CRMParam{{Field: "watched"}},
		Audience: types.AudienceSegment, WebinarID: wb.ID, Segment: &types.CRMSegment{MinWatchMin: 45},
	})
	if b.Stats.Recipients != 1 || b.SegmentLabel != "Watched 45+ min" || b.Segment == nil || b.Segment.MinWatchMin != 45 {
		t.Fatalf("broadcast = %+v, want one recipient labelled Watched 45+ min", b)
	}
	drainWhatsAppOutbox(t, h, wb.ID)
	if got := threadFor(t, h, thandi.ID); len(got.Messages) == 0 ||
		got.Messages[len(got.Messages)-1].Body != "Hi 58 minutes, your webinar starts in an hour." {
		t.Errorf("thandi's thread = %+v, want the watched minutes merged in", got.Messages)
	}

	// Listed on the webinar's Messages tab.
	res, raw := h.do(http.MethodGet, "/api/host/crm/webinars/"+wb.ID+"/messages", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("webinar messages: status %d body %s", res.StatusCode, raw)
	}
	var wm types.CRMWebinarMessagesResponse
	h.decode(raw, &wm)
	if len(wm.Broadcasts) != 1 || wm.Broadcasts[0].ID != b.ID {
		t.Errorf("webinar broadcasts = %+v, want the follow-up", wm.Broadcasts)
	}
	if wm.Audience.Recipients != 3 || wm.Audience.NoOptIn != 1 {
		t.Errorf("webinar audience = %+v", wm.Audience)
	}

	// People: attended counts across webinars.
	res, raw = h.do(http.MethodGet, "/api/host/crm/people", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("people: status %d body %s", res.StatusCode, raw)
	}
	var people types.CRMPeopleResponse
	h.decode(raw, &people)
	if people.Counts.Attended != 3 || people.Counts.NeverAttended < 1 || people.Counts.OptedIn != 3 {
		t.Errorf("people counts = %+v", people.Counts)
	}
	for _, p := range people.People {
		if p.Contact.ID == thandi.ID && (p.Webinars != 1 || p.AttendedWebinars != 1 || p.WatchMin != 58 || !p.Attended ||
			p.LastWebinar != "Scale your coaching practice" || p.WhatsAppStatus != types.CRMStatusOptedIn) {
			t.Errorf("thandi in people = %+v", p)
		}
	}
	// Sam, plus the email-only registrants drainWhatsAppOutbox adds; never Thandi.
	res, raw = h.do(http.MethodGet, "/api/host/crm/people?filter=never_attended&webinarId="+wb.ID, nil)
	h.decode(raw, &people)
	foundSam := false
	for _, p := range people.People {
		foundSam = foundSam || p.Contact.ID == sam.ID
		if p.Attended || p.AttendedWebinars != 0 || p.Contact.ID == thandi.ID {
			t.Errorf("never attended lists %+v", p)
		}
	}
	if res.StatusCode != http.StatusOK || !foundSam {
		t.Errorf("never attended = %d %+v, want Sam", res.StatusCode, people.People)
	}
	res, raw = h.do(http.MethodGet, "/api/host/crm/people/ids?filter=attended&webinarId="+wb.ID, nil)
	var ids types.CRMContactIDsResponse
	h.decode(raw, &ids)
	if res.StatusCode != http.StatusOK || len(ids.ContactIDs) != 2 {
		t.Errorf("attended ids = %d %+v, want the two opted-in attendees", res.StatusCode, ids)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/crm/people?filter=bogus", nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("bogus filter: status %d", res.StatusCode)
	}
}

func inbox(t *testing.T, h *harness, view string) types.CRMInboxResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/inbox?view="+view, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("inbox: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMInboxResponse
	h.decode(raw, &out)
	return out
}

func echoPayload(wamid, to, text string) string {
	return `{"entry":[{"id":"` + testMetaWABAID + `","changes":[{"field":"smb_message_echoes","value":{
	  "metadata":{"phone_number_id":"` + testMetaPhoneID + `"},
	  "message_echoes":[{"from":"` + testMetaPhoneID + `","to":"` + to + `","id":"` + wamid + `",
	    "timestamp":"` + unixNow() + `","type":"text","text":{"body":"` + text + `"}}]}}]}]}`
}

// inboundNow is inboundPayload stamped now, so the 24-hour window is open.
func inboundNow(wamid, from, name, text string) string {
	return strings.Replace(inboundPayload(wamid, from, name, text), `"1700000000"`, `"`+unixNow()+`"`, 1)
}

func unixNow() string { return strconv.FormatInt(time.Now().Unix(), 10) }

func TestEngageV1InboxNeedsReply(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Scale your coaching practice")
	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)

	if got := inbox(t, h, types.InboxNeedsReply); got.Counts.NeedsReply != 0 {
		t.Fatalf("needs reply before anybody wrote = %+v", got.Counts)
	}

	postWebhook(t, h, inboundNow("wamid.IN1", crmPhoneDigits, "Thandi", "Is there a replay?"))
	got := inbox(t, h, types.InboxNeedsReply)
	if got.Counts.NeedsReply != 1 || len(got.Threads) != 1 || got.Threads[0].Contact.ID != thandi.ID || !got.Threads[0].NeedsReply {
		t.Fatalf("after an inbound = %+v", got)
	}

	res, raw := h.do(http.MethodGet, "/api/host/crm/replies", nil)
	var replies types.CRMRepliesResponse
	h.decode(raw, &replies)
	if res.StatusCode != http.StatusOK || replies.NeedsReply != 1 || len(replies.Recent) != 1 {
		t.Errorf("replies = %d %+v", res.StatusCode, replies)
	}

	// Answered from the inbox.
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+thandi.ID+"/send", types.CRMSendRequest{Body: "Yes, tonight."})
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		t.Fatalf("send: status %d body %s", res.StatusCode, raw)
	}
	if got := inbox(t, h, types.InboxNeedsReply); got.Counts.NeedsReply != 0 || got.Counts.Done != 1 {
		t.Errorf("after replying = %+v, want nothing waiting", got.Counts)
	}

	// A new message reopens it; a reply typed on the phone (echo) answers it.
	time.Sleep(1100 * time.Millisecond)
	postWebhook(t, h, inboundNow("wamid.IN2", crmPhoneDigits, "Thandi", "Thanks! And the slides?"))
	if got := inbox(t, h, types.InboxNeedsReply); got.Counts.NeedsReply != 1 {
		t.Fatalf("after a second inbound = %+v", got.Counts)
	}
	time.Sleep(1100 * time.Millisecond)
	postWebhook(t, h, echoPayload("wamid.ECHO1", crmPhoneDigits, "Sending them now"))
	if got := inbox(t, h, types.InboxNeedsReply); got.Counts.NeedsReply != 0 {
		t.Errorf("after a phone reply = %+v, want it answered", got.Counts)
	}
	th := threadFor(t, h, thandi.ID)
	last := th.Messages[len(th.Messages)-1]
	if last.Direction != "out" || last.Body != "Sending them now" || !last.Manual {
		t.Errorf("echo in thread = %+v", last)
	}

	// Mark done, and reopen.
	time.Sleep(1100 * time.Millisecond)
	postWebhook(t, h, inboundNow("wamid.IN3", crmPhoneDigits, "Thandi", "Got them 👍"))
	if res, raw := h.do(http.MethodPut, "/api/host/crm/contacts/"+thandi.ID+"/done", types.CRMDoneRequest{Done: true}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("done: status %d body %s", res.StatusCode, raw)
	}
	if got := inbox(t, h, types.InboxNeedsReply); got.Counts.NeedsReply != 0 {
		t.Errorf("after mark done = %+v", got.Counts)
	}
	if res, _ := h.do(http.MethodPut, "/api/host/crm/contacts/"+thandi.ID+"/done", types.CRMDoneRequest{Done: false}); res.StatusCode != http.StatusNoContent {
		t.Fatalf("undo done: status %d", res.StatusCode)
	}
	if got := inbox(t, h, types.InboxNeedsReply); got.Counts.NeedsReply != 1 {
		t.Errorf("after reopen = %+v", got.Counts)
	}

	// Another host sees none of it.
	h.logout()
	h.login("lucia@cabify.com")
	if got := inbox(t, h, types.InboxAll); got.Counts.All != 0 {
		t.Errorf("another host's inbox = %+v", got.Counts)
	}
	if res, _ := h.do(http.MethodPut, "/api/host/crm/contacts/"+thandi.ID+"/done", types.CRMDoneRequest{Done: true}); res.StatusCode != http.StatusNotFound {
		t.Errorf("another host marking done: status %d, want 404", res.StatusCode)
	}
}
