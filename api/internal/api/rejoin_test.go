package api_test

import (
	"io"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Rejoining restores the room.
 *
 * Somebody who drops out and comes back — a reload, a new tab, a dead network — is
 * the same identity (att_<joinKey> or user_<id>), so everything keyed on that identity
 * has to come back with them: the conversation, the Q&A with their own upvotes, and
 * their poll answers. Each test posts, then "rejoins" by reading the history endpoints
 * afresh with the same credential, which is exactly what a new page load does.
 */

func (h *harness) questionsAsGuest(slug, joinKey string) types.RoomQuestions {
	h.t.Helper()
	res, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + slug + "/questions?joinKey=" + joinKey)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("room questions: status %d body %s", res.StatusCode, raw)
	}
	var out types.RoomQuestions
	h.decode(raw, &out)
	return out
}

func (h *harness) questionsAsHost(slug string) types.RoomQuestions {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/webinars/"+slug+"/questions", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("room questions (host): status %d body %s", res.StatusCode, raw)
	}
	var out types.RoomQuestions
	h.decode(raw, &out)
	return out
}

func findQuestion(list types.RoomQuestions, id string) (types.SessionQuestion, bool) {
	for _, q := range list.Questions {
		if q.ID == id {
			return q, true
		}
	}
	return types.SessionQuestion{}, false
}

func (h *harness) mustSayAsGuest(slug string, body types.SendMessageRequest) {
	h.t.Helper()
	if res, raw := h.sayAsGuest(slug, body); res.StatusCode != http.StatusOK {
		h.t.Fatalf("say %s: status %d body %s", body.Kind, res.StatusCode, raw)
	}
}

// The whole story in one: chat, Q&A and a poll vote, then a rejoin that reads it all
// back with the same join key.
func TestRejoinRestoresChatQuestionsAndPolls(t *testing.T) {
	h := newHarness(t)
	h.signup("Rejoin Host", "rejoin-host@test.dev", true)
	wb := h.liveWebinar("Rejoin", nil)
	alice := h.registerAsGuest(wb.ID, "rejoin-alice@test.dev")
	bob := h.registerAsGuest(wb.ID, "rejoin-bob@test.dev")

	// Chat from both halves of the room.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "rejoin-host-01", Text: "welcome",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("host chat: %d %s", res.StatusCode, raw)
	}
	h.mustSayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: alice.JoinKey, Kind: types.MsgChat, ID: "rejoin-alice-1", Text: "hi",
	})

	// A question from Alice, an anonymous one from Bob, and one from the host — the stage
	// used to publish its questions straight onto the data channel, so they were never
	// written down at all.
	h.mustSayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: alice.JoinKey, Kind: types.MsgQuestion, ID: "q-alice-0001", Text: "Slides?",
	})
	h.mustSayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: bob.JoinKey, Kind: types.MsgQuestion, ID: "q-bob-00001", Text: "Pricing?", Anonymous: true,
	})
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgQuestion, ID: "q-host-00001", Text: "Anyone from Berlin?",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("host question: %d %s", res.StatusCode, raw)
	}

	// Bob upvotes Alice's question — twice, as a rejoined tab whose button came back
	// would. It must count once.
	for i := 0; i < 2; i++ {
		h.mustSayAsGuest(wb.ID, types.SendMessageRequest{
			JoinKey: bob.JoinKey, Kind: types.MsgUpvote, QuestionID: "q-alice-0001",
		})
	}

	// The host pins Alice's and hides the host's own.
	pinned, dismissed := true, true
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/questions/q-alice-0001",
		types.QuestionPatch{Pinned: &pinned}); res.StatusCode != http.StatusOK {
		t.Fatalf("pin: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/questions/q-host-00001",
		types.QuestionPatch{Dismissed: &dismissed}); res.StatusCode != http.StatusOK {
		t.Fatalf("dismiss: %d %s", res.StatusCode, raw)
	}

	// A poll Bob answers, then the host closes.
	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Useful?", Kind: types.PollOpinion, Options: []string{"Yes", "No"},
	})
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil)
	if res, raw := h.voteAsGuest(wb.ID, poll.ID, bob.JoinKey, 1); res.StatusCode != http.StatusOK {
		t.Fatalf("vote: %d %s", res.StatusCode, raw)
	}
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/close", nil)

	// ---- Bob rejoins.

	chat := h.backlogAsGuest(wb.ID, bob.JoinKey, 0)
	if len(chat.Messages) != 2 {
		t.Fatalf("rejoin chat has %d messages, want 2", len(chat.Messages))
	}

	qs := h.questionsAsGuest(wb.ID, bob.JoinKey)
	if len(qs.Questions) != 2 {
		t.Fatalf("attendee sees %d questions, want 2 (the hidden one withheld): %+v",
			len(qs.Questions), qs.Questions)
	}
	if _, leaked := findQuestion(qs, "q-host-00001"); leaked {
		t.Error("a hidden question came back to the audience after a rejoin")
	}
	if len(qs.Hidden) != 1 || qs.Hidden[0] != "q-host-00001" {
		t.Errorf("hidden ids = %v, want [q-host-00001]", qs.Hidden)
	}
	a, ok := findQuestion(qs, "q-alice-0001")
	if !ok {
		t.Fatal("Alice's question is missing after a rejoin")
	}
	if a.Upvotes != 1 {
		t.Errorf("a double upvote counted %d times, want 1", a.Upvotes)
	}
	if !a.VotedByMe {
		t.Error("Bob's own upvote is not reported back to him — his button would come back")
	}
	if !a.Pinned {
		t.Error("the pin was lost on rejoin")
	}
	if a.Name == "" || a.Role != types.RoleAttendee {
		t.Errorf("Alice's question lost its asker: name %q role %q", a.Name, a.Role)
	}
	b, _ := findQuestion(qs, "q-bob-00001")
	if b.Identity == "" {
		t.Error("Bob's own anonymous question does not carry his identity back — '(you)' is lost")
	}

	// Alice's view of Bob's anonymous question: no identity, no name.
	aliceView := h.questionsAsGuest(wb.ID, alice.JoinKey)
	if ab, _ := findQuestion(aliceView, "q-bob-00001"); ab.Identity != "" || ab.Name != "" {
		t.Errorf("an anonymous question leaked its asker to another attendee: %+v", ab)
	}
	if aa, _ := findQuestion(aliceView, "q-alice-0001"); aa.VotedByMe {
		t.Error("Alice is told she upvoted a question only Bob upvoted")
	}

	// The host sees everything, including what they hid, with the host role on their own.
	hostView := h.questionsAsHost(wb.ID)
	hq, ok := findQuestion(hostView, "q-host-00001")
	if !ok || !hq.Dismissed {
		t.Errorf("the host's list is missing their hidden question: %+v", hostView.Questions)
	}
	if hq.Role != types.RoleHost {
		t.Errorf("host question role = %q, want host", hq.Role)
	}

	// Polls: the closed poll is still listed, with Bob's answer.
	polls := h.pollsAsGuest(wb.ID, bob.JoinKey)
	if len(polls) != 1 || polls[0].MyChoice != 1 {
		t.Fatalf("rejoin polls = %+v, want the closed poll with myChoice 1", polls)
	}
}

// A reconnect that missed the live chat-deleted packet is told about it by the backlog.
func TestReconnectBacklogReportsDeletions(t *testing.T) {
	h := newHarness(t)
	h.signup("Moderating Host", "rejoin-mod@test.dev", true)
	wb := h.liveWebinar("Moderated", nil)
	reg := h.registerAsGuest(wb.ID, "rejoin-mod-attendee@test.dev")
	other := h.registerAsGuest(wb.ID, "rejoin-mod-other@test.dev")

	h.mustSayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: other.JoinKey, Kind: types.MsgChat, ID: "mod-spam-0001", Text: "spam",
	})
	h.mustSayAsGuest(wb.ID, types.SendMessageRequest{
		JoinKey: other.JoinKey, Kind: types.MsgChat, ID: "mod-fine-0001", Text: "fine",
	})
	held := h.backlogAsGuest(wb.ID, reg.JoinKey, 0)
	if len(held.Messages) != 2 {
		t.Fatalf("held %d messages, want 2", len(held.Messages))
	}

	// The attendee drops; meanwhile the host deletes the spam.
	if res, raw := h.do(http.MethodDelete, "/api/webinars/"+wb.ID+"/chat/mod-spam-0001", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}

	gap := h.backlogAsGuest(wb.ID, reg.JoinKey, held.Cursor)
	if len(gap.Deleted) != 1 || gap.Deleted[0] != "mod-spam-0001" {
		t.Errorf("reconnect backlog deleted = %v, want [mod-spam-0001]", gap.Deleted)
	}
	// And a fresh page load simply does not get it.
	fresh := h.backlogAsGuest(wb.ID, reg.JoinKey, 0)
	if len(fresh.Messages) != 1 || fresh.Messages[0].ID != "mod-fine-0001" {
		t.Errorf("fresh join got %+v, want only the undeleted message", fresh.Messages)
	}
	if len(fresh.Deleted) != 0 {
		t.Errorf("a fresh join is sent deletions it has no use for: %v", fresh.Deleted)
	}
}
