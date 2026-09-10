package api_test

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Persistent chat.
 *
 * Four claims, and each of them is about what survives rather than what renders:
 *
 *   it is written down       Including the host's, which is why chat lost its direct
 *                            path onto the data channel.
 *   a reconnect loses nothing A cursor read returns exactly the gap, and re-sending a
 *                            message the response was lost for does not duplicate it.
 *   history obeys the rule   Replaying a transcript must not hand a late joiner the
 *                            panelists-only lines the SFU refused them live.
 *   images are checked       The bytes decide the type, not the header, and the URL in
 *                            the payload is one this API authorizes.
 */

// A one-pixel PNG. Enough to be sniffed as a real image.
var onePixelPNG = []byte{
	0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n',
	0, 0, 0, 0x0d, 'I', 'H', 'D', 'R',
	0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
	0x1f, 0x15, 0xc4, 0x89,
	0, 0, 0, 0x0a, 'I', 'D', 'A', 'T',
	0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1,
	0x0d, 0x0a, 0x2d, 0xb4,
	0, 0, 0, 0, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82,
}

func (h *harness) backlogAsGuest(slug, joinKey string, since int64) types.ChatBacklog {
	h.t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + slug +
		"/chat?since=" + strconv.FormatInt(since, 10) + "&joinKey=" + joinKey)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("backlog: status %d body %s", res.StatusCode, raw)
	}
	var out types.ChatBacklog
	h.decode(raw, &out)
	return out
}

func (h *harness) transcript(slug string) []types.ChatMessage {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/chat", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("transcript: status %d body %s", res.StatusCode, raw)
	}
	var out struct {
		Stats    types.ChatStats     `json:"stats"`
		Messages []types.ChatMessage `json:"messages"`
	}
	h.decode(raw, &out)
	return out.Messages
}

// ---------------------------------------------------------------- it is written down

// Both halves of the room. The host used to publish straight onto the data channel, and
// a transcript missing everything the presenter said is not a transcript.
func TestChatIsPersistedForEveryone(t *testing.T) {
	h := newHarness(t)
	h.signup("Archive Host", "chatarchive@test.dev", true)
	wb := h.liveWebinar("Archive", nil)
	reg := h.registerAsGuest(wb.ID, "chatarchive-attendee@test.dev")

	// The host, over their session.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{
			Kind: types.MsgChat, ID: "host-000001", Text: "welcome everyone",
		}); res.StatusCode != http.StatusOK {
		t.Fatalf("host say: status %d body %s", res.StatusCode, raw)
	}
	// An attendee, over their join key.
	if res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey, Kind: types.MsgChat, ID: "att-0000001", Text: "thanks!",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("attendee say: status %d body %s", res.StatusCode, raw)
	}

	messages := h.transcript(wb.ID)
	if len(messages) != 2 {
		t.Fatalf("transcript has %d messages, want 2: %+v", len(messages), messages)
	}
	// In the order they were said, by sequence rather than by timestamp.
	if messages[0].Message != "welcome everyone" || messages[1].Message != "thanks!" {
		t.Errorf("transcript is out of order: %q then %q",
			messages[0].Message, messages[1].Message)
	}
	if messages[0].SenderRole != types.RoleHost {
		t.Errorf("first sender role = %q, want host", messages[0].SenderRole)
	}
	// The host has an account, so the archive can be joined to it. The attendee does not,
	// which is the normal case for an audience.
	if messages[0].UserID == "" {
		t.Error("the host's message carries no userId — reporting could not join it to an account")
	}
	if messages[1].UserID != "" {
		t.Errorf("an attendee with no account carries userId %q", messages[1].UserID)
	}
	if messages[1].Seq <= messages[0].Seq {
		t.Errorf("sequences are not increasing: %d then %d", messages[0].Seq, messages[1].Seq)
	}
}

// ------------------------------------------------------------------- reconnection

// A cursor read returns exactly the gap. This is the whole reconnection story: the data
// channel does not replay what it delivered while a socket was down.
func TestChatBacklogReturnsOnlyTheGap(t *testing.T) {
	h := newHarness(t)
	h.signup("Sync Host", "chatsync@test.dev", true)
	wb := h.liveWebinar("Sync", nil)
	reg := h.registerAsGuest(wb.ID, "chatsync-attendee@test.dev")

	for i, text := range []string{"first", "second", "third"} {
		if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
			types.SendMessageRequest{
				Kind: types.MsgChat, ID: "sync-00000" + strconv.Itoa(i), Text: text,
			}); res.StatusCode != http.StatusOK {
			t.Fatalf("say %q: status %d body %s", text, res.StatusCode, raw)
		}
	}

	// Joining: cursor zero, the whole conversation. Somebody arriving twenty minutes
	// late can read what they walked in on.
	all := h.backlogAsGuest(wb.ID, reg.JoinKey, 0)
	if len(all.Messages) != 3 {
		t.Fatalf("fresh join got %d messages, want 3", len(all.Messages))
	}
	if all.Cursor != all.Messages[2].Seq {
		t.Errorf("cursor = %d, want the last seq %d", all.Cursor, all.Messages[2].Seq)
	}
	if all.More {
		t.Error("More is set on a three-message session")
	}

	// Reconnecting: cursor at the first message, so only what came after.
	gap := h.backlogAsGuest(wb.ID, reg.JoinKey, all.Messages[0].Seq)
	if len(gap.Messages) != 2 {
		t.Fatalf("resuming got %d messages, want 2", len(gap.Messages))
	}
	if gap.Messages[0].Message != "second" {
		t.Errorf("gap starts at %q, want second", gap.Messages[0].Message)
	}

	// Caught up: nothing, and the cursor holds. A poll that returns the last message
	// forever is a duplicate on every reconnect.
	none := h.backlogAsGuest(wb.ID, reg.JoinKey, all.Cursor)
	if len(none.Messages) != 0 {
		t.Errorf("a caught-up client got %d messages", len(none.Messages))
	}
	if none.Cursor != all.Cursor {
		t.Errorf("cursor moved to %d with nothing to return", none.Cursor)
	}
}

// Re-sending is idempotent, because the sender's own id is the primary key. A response
// lost on the way back must not become a second line in everybody's chat.
func TestResendingAMessageDoesNotDuplicateIt(t *testing.T) {
	h := newHarness(t)
	h.signup("Dedupe Host", "chatdedupe@test.dev", true)
	wb := h.liveWebinar("Dedupe", nil)

	send := func() {
		res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
			types.SendMessageRequest{
				Kind: types.MsgChat, ID: "dupe-000001", Text: "did that send?",
			})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("say: status %d body %s", res.StatusCode, raw)
		}
	}
	send()
	send()
	send()

	messages := h.transcript(wb.ID)
	if len(messages) != 1 {
		t.Errorf("three sends of one id produced %d messages, want 1", len(messages))
	}
}

// History obeys the same audience rule live delivery did. Without this, replaying a
// transcript to a late joiner hands them the panelists-only lines the SFU refused.
func TestBacklogHidesPanelistsOnlyMessagesFromTheAudience(t *testing.T) {
	h := newHarness(t)
	h.signup("Private Host", "chatbacklogpriv@test.dev", true)
	wb := h.liveWebinar("Private history", nil)
	reg := h.registerAsGuest(wb.ID, "chatbacklogpriv-attendee@test.dev")

	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_host", Role: types.RoleHost},
		types.LiveParticipant{Identity: "user_panelist", Role: types.RolePanelist},
	)

	// The host, to the stage only.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{
			Kind: types.MsgChat, ID: "stage-00001", Text: "two minutes to go",
			Destination: types.ChatToPanelists,
		}); res.StatusCode != http.StatusOK {
		t.Fatalf("stage say: status %d body %s", res.StatusCode, raw)
	}
	// And to the room.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{
			Kind: types.MsgChat, ID: "room-000001", Text: "starting shortly",
		}); res.StatusCode != http.StatusOK {
		t.Fatalf("room say: status %d body %s", res.StatusCode, raw)
	}

	got := h.backlogAsGuest(wb.ID, reg.JoinKey, 0)
	if len(got.Messages) != 1 {
		t.Fatalf("the audience's backlog has %d messages, want 1: %+v",
			len(got.Messages), got.Messages)
	}
	if got.Messages[0].Message != "starting shortly" {
		t.Errorf("the audience can read %q from history", got.Messages[0].Message)
	}
	// The cursor still advances past the hidden message, or every reconnect re-reads it.
	if got.Cursor < got.Messages[0].Seq {
		t.Errorf("cursor %d is behind the message it returned", got.Cursor)
	}

	// The host's archive has both.
	if len(h.transcript(wb.ID)) != 2 {
		t.Error("the archive is missing the stage-only message")
	}
}

// An attendee sees their OWN stage-only message. A chat that swallows what you just said
// looks broken, and they know what they wrote.
func TestSendersSeeTheirOwnPanelistsOnlyMessages(t *testing.T) {
	h := newHarness(t)
	h.signup("Echo Host", "chatecho@test.dev", true)
	wb := h.liveWebinar("Echo", nil)
	h.setDestination(wb.ID, types.ChatToPanelists)
	reg := h.registerAsGuest(wb.ID, "chatecho-attendee@test.dev")
	other := h.registerAsGuest(wb.ID, "chatecho-other@test.dev")

	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_host", Role: types.RoleHost},
		types.LiveParticipant{Identity: "att_" + reg.JoinKey, Role: types.RoleAttendee},
	)

	if res, raw := h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey, Kind: types.MsgChat, ID: "mine-000001",
		Text: "a question for the panel",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("say: status %d body %s", res.StatusCode, raw)
	}

	mine := h.backlogAsGuest(wb.ID, reg.JoinKey, 0)
	if len(mine.Messages) != 1 {
		t.Errorf("the sender cannot see their own message: %+v", mine.Messages)
	}

	// And nobody else in the audience can.
	theirs := h.backlogAsGuest(wb.ID, other.JoinKey, 0)
	if len(theirs.Messages) != 0 {
		t.Errorf("another attendee can read a stage-only message: %+v", theirs.Messages)
	}
}

// ------------------------------------------------------------------------ images

func (h *harness) uploadImage(slug, id string, body []byte, contentType string) (*http.Response, []byte) {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodPost,
		h.srv.URL+"/api/webinars/"+slug+"/chat/image?id="+id+"&w=1&h=1",
		bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	res, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

func TestChatImageIsStoredAndServed(t *testing.T) {
	h := newHarness(t)
	h.signup("Image Host", "chatimage@test.dev", true)
	wb := h.liveWebinar("Images", nil)

	res, raw := h.uploadImage(wb.ID, "img-0000001", onePixelPNG, "image/png")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload: status %d body %s", res.StatusCode, raw)
	}
	var created types.ChatImageResponse
	h.decode(raw, &created)

	if created.Message.Type != types.ChatImage {
		t.Errorf("messageType = %q, want image", created.Message.Type)
	}
	if created.Message.MediaBytes != int64(len(onePixelPNG)) {
		t.Errorf("mediaBytes = %d, want %d", created.Message.MediaBytes, len(onePixelPNG))
	}
	// The URL points at this API, not at storage. A bucket URL would be a link that
	// works for anybody who ever saw it, long after the session.
	want := "/api/webinars/" + wb.ID + "/chat/media/img-0000001"
	if created.Message.MediaURL != want {
		t.Errorf("mediaUrl = %q, want %q", created.Message.MediaURL, want)
	}

	// And it serves the bytes back.
	got, body := h.do(http.MethodGet, created.Message.MediaURL, nil)
	if got.StatusCode != http.StatusOK {
		t.Fatalf("fetch image: status %d body %s", got.StatusCode, body)
	}
	if !bytes.Equal(body, onePixelPNG) {
		t.Errorf("served %d bytes, want the %d uploaded", len(body), len(onePixelPNG))
	}
	if ct := got.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	if got.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Error("no nosniff header on a stored upload")
	}
}

// The bytes decide the type, not the header. A file claiming to be a PNG and containing
// something else must not become a URL five hundred browsers will load.
func TestChatImageRejectsNonImages(t *testing.T) {
	h := newHarness(t)
	h.signup("Sniff Host", "chatsniff@test.dev", true)
	wb := h.liveWebinar("Sniffing", nil)

	cases := []struct {
		name string
		body []byte
		want int
	}{
		{"html pretending to be a png", []byte("<html><script>alert(1)</script>"), http.StatusUnsupportedMediaType},
		{"empty", []byte{}, http.StatusBadRequest},
		{"a few random bytes", []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, http.StatusUnsupportedMediaType},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.uploadImage(wb.ID, "bad-0000001", tc.body, "image/png")
			if res.StatusCode != tc.want {
				t.Errorf("status %d body %s, want %d", res.StatusCode, raw, tc.want)
			}
		})
	}

	// Nothing was recorded.
	if n := len(h.transcript(wb.ID)); n != 0 {
		t.Errorf("%d messages were recorded for refused uploads", n)
	}
}

// An image is behind the same credential as the room.
func TestChatImageNeedsACredential(t *testing.T) {
	h := newHarness(t)
	h.signup("Guard Host", "chatguard@test.dev", true)
	wb := h.liveWebinar("Guarded", nil)

	res, raw := h.uploadImage(wb.ID, "img-0000002", onePixelPNG, "image/png")
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("upload: status %d body %s", res.StatusCode, raw)
	}

	// No cookies and no join key.
	anon, err := (&http.Client{}).Get(
		h.srv.URL + "/api/webinars/" + wb.ID + "/chat/media/img-0000002")
	if err != nil {
		t.Fatal(err)
	}
	defer anon.Body.Close()
	if anon.StatusCode != http.StatusUnauthorized {
		t.Errorf("an anonymous fetch got %d, want 401", anon.StatusCode)
	}
}

// ------------------------------------------------------------------- the archive

// The per-session summary, for reporting. One pass, so a report does not read the
// transcript in order to count it.
func TestChatStatsSummariseTheSession(t *testing.T) {
	h := newHarness(t)
	h.signup("Stats Host", "chatstats@test.dev", true)
	wb := h.liveWebinar("Stats", nil)
	reg := h.registerAsGuest(wb.ID, "chatstats-attendee@test.dev")
	h.rooms.setRoster(types.LiveParticipant{Identity: "user_host", Role: types.RoleHost})

	h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "st-00000001", Text: "hello",
	})
	h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "st-00000002", Text: "to the panel",
		Destination: types.ChatToPanelists,
	})
	h.sayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: reg.JoinKey, Kind: types.MsgChat, ID: "st-00000003", Text: "hi",
	})
	h.uploadImage(wb.ID, "st-00000004", onePixelPNG, "image/png")

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/chat/stats", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stats: status %d body %s", res.StatusCode, raw)
	}
	var stats types.ChatStats
	h.decode(raw, &stats)

	if stats.Messages != 4 {
		t.Errorf("messages = %d, want 4", stats.Messages)
	}
	if stats.Images != 1 {
		t.Errorf("images = %d, want 1", stats.Images)
	}
	// The host and one attendee: the engagement number is how many people SPOKE, not
	// how many were in the room.
	if stats.Senders != 2 {
		t.Errorf("senders = %d, want 2", stats.Senders)
	}
	if stats.ToPanelists != 1 {
		t.Errorf("toPanelists = %d, want 1", stats.ToPanelists)
	}
	if stats.MediaBytes != int64(len(onePixelPNG)) {
		t.Errorf("mediaBytes = %d, want %d", stats.MediaBytes, len(onePixelPNG))
	}
	if stats.FirstAt == "" || stats.LastAt == "" {
		t.Error("the summary has no time range")
	}
}

// CSV for a spreadsheet, with the archival column names spelled out. Anyone opening the
// file later should not have to guess which column is which.
func TestChatTranscriptExportsCsv(t *testing.T) {
	h := newHarness(t)
	h.signup("Csv Host", "chatcsv@test.dev", true)
	wb := h.liveWebinar("Csv", nil)

	h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "csv-0000001", Text: "line one",
	})

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/chat?format=csv", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("csv: status %d body %s", res.StatusCode, raw)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	body := string(raw)
	for _, column := range []string{
		"sessionId", "messageId", "senderId", "userId", "messageType",
		"mediaUrl", "timestamp", "messageContent",
	} {
		if !bytes.Contains(raw, []byte(column)) {
			t.Errorf("the header row is missing %q", column)
		}
	}
	if !bytes.Contains(raw, []byte("line one")) {
		t.Errorf("the export is missing the message: %s", body)
	}
}

// The archive is the host's. An attendee account with a session must not be able to
// read a transcript that includes the panelists-only lines.
func TestChatTranscriptIsHostOnly(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "chatarchiveowner@test.dev", true)
	wb := h.liveWebinar("Archive ownership", nil)
	h.logout()

	h.signup("Bystander", "chatarchivebystander@test.dev", true)
	for _, path := range []string{"/chat", "/chat/stats"} {
		res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+path, nil)
		if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s: status %d body %s, want 403 or 404", path, res.StatusCode, raw)
		}
	}
}

// Ending the session does not lose anything. There is no cache to flush — which is the
// point of not having one — so this asserts the transcript is intact afterwards.
func TestTranscriptSurvivesTheSessionEnding(t *testing.T) {
	h := newHarness(t)
	h.signup("End Host", "chatendarchive@test.dev", true)
	wb := h.liveWebinar("Ending", nil)

	h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "end-0000001", Text: "thanks for coming",
	})

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}

	messages := h.transcript(wb.ID)
	if len(messages) != 1 || messages[0].Message != "thanks for coming" {
		t.Errorf("the transcript did not survive the session ending: %+v", messages)
	}
}

// A message id is required, because it is the transcript's primary key and what makes a
// resend idempotent. A server-generated one would leave the sender unable to match it up.
func TestChatRequiresAMessageId(t *testing.T) {
	h := newHarness(t)
	h.signup("Id Host", "chatid@test.dev", true)
	wb := h.liveWebinar("Ids", nil)

	for _, id := range []string{"", "short"} {
		res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
			types.SendMessageRequest{Kind: types.MsgChat, ID: id, Text: "hello"})
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("id %q: status %d body %s, want 400", id, res.StatusCode, raw)
		}
	}
}
