package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Polls and quizzes.
 *
 * The claim worth testing is not that a tally adds up. It is that no tally ever
 * reaches the audience, that the answer to a live quiz is never SENT to the people
 * answering it, and that one person cannot vote twice. Each of those is a property of
 * the response body, so that is what these assert on — a check in the UI would leave
 * the numbers one devtools tab away.
 */

func (h *harness) pollsAsGuest(slug, joinKey string) []types.Poll {
	h.t.Helper()
	res, err := (&http.Client{}).Get(
		h.srv.URL + "/api/webinars/" + slug + "/polls?joinKey=" + joinKey)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("audience polls: status %d body %s", res.StatusCode, raw)
	}
	var out []types.Poll
	h.decode(raw, &out)
	return out
}

func (h *harness) voteAsGuest(slug, id, joinKey string, choice int) (*http.Response, []byte) {
	h.t.Helper()
	body, err := json.Marshal(types.PollVoteRequest{JoinKey: joinKey, Choice: choice})
	if err != nil {
		h.t.Fatal(err)
	}
	res, err := (&http.Client{}).Post(
		h.srv.URL+"/api/webinars/"+slug+"/polls/"+id+"/vote",
		"application/json", bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

func (h *harness) createPoll(slug string, in types.PollInput) types.Poll {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/polls", in)
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("create poll: status %d body %s", res.StatusCode, raw)
	}
	var poll types.Poll
	h.decode(raw, &poll)
	return poll
}

func quiz(question string, correct int, options ...string) types.PollInput {
	return types.PollInput{
		Question:      question,
		Kind:          types.PollQuizKind,
		Options:       options,
		CorrectOption: &correct,
	}
}

// ------------------------------------------------------------ the audience view

// A draft is the host's notes. The audience must not see a question before it is
// launched, or the room reads ahead.
func TestDraftPollsAreInvisibleToTheAudience(t *testing.T) {
	h := newHarness(t)
	h.signup("Poll Host", "polldraft@test.dev", true)
	wb := h.liveWebinar("Drafts", nil)
	reg := h.registerAsGuest(wb.ID, "polldraft-attendee@test.dev")

	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Ready?", Kind: types.PollOpinion,
		Options: []string{"Yes", "No"},
	})
	if poll.State != types.PollDraft {
		t.Fatalf("a new poll is %q, want draft", poll.State)
	}

	if got := h.pollsAsGuest(wb.ID, reg.JoinKey); len(got) != 0 {
		t.Errorf("the audience can see %d draft poll(s)", len(got))
	}

	// The host sees their own drafts.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/polls", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host polls: status %d body %s", res.StatusCode, raw)
	}
	var hostView []types.Poll
	h.decode(raw, &hostView)
	if len(hostView) != 1 {
		t.Fatalf("the host sees %d polls, want 1", len(hostView))
	}
}

// The load-bearing test. A quiz answer must not reach the people answering it.
func TestQuizAnswerIsWithheldUntilVotingCloses(t *testing.T) {
	h := newHarness(t)
	h.signup("Quiz Host", "pollquiz@test.dev", true)
	wb := h.liveWebinar("Quizzes", nil)
	reg := h.registerAsGuest(wb.ID, "pollquiz-attendee@test.dev")

	poll := h.createPoll(wb.ID, quiz("Which is a SFU?", 1, "STUN", "LiveKit", "DTLS"))
	if poll.CorrectOption != 1 {
		t.Fatalf("the host cannot see the answer: correctOption=%d", poll.CorrectOption)
	}

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("open: status %d body %s", res.StatusCode, raw)
	}

	// Open: the answer is absent from the audience's copy. Not hidden by their
	// client — not present in the response.
	live := h.pollsAsGuest(wb.ID, reg.JoinKey)
	if len(live) != 1 {
		t.Fatalf("the audience sees %d polls, want 1", len(live))
	}
	if live[0].CorrectOption != -1 {
		t.Errorf("the answer to a LIVE quiz reached the audience: correctOption=%d",
			live[0].CorrectOption)
	}

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/close", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("close: status %d body %s", res.StatusCode, raw)
	}

	// Closed: now it is a result, and withholding it would be pointless.
	after := h.pollsAsGuest(wb.ID, reg.JoinKey)
	if after[0].CorrectOption != 1 {
		t.Errorf("the answer is still hidden after closing: correctOption=%d",
			after[0].CorrectOption)
	}
}

// The audience never sees a tally. Not per option, not as a percentage, and not as a
// running total.
//
// Withholding it in the UI would leave the numbers one devtools tab away, so the test
// asserts on the RESPONSE: a visible count makes the answers stop being independent,
// and whoever has not voted yet could see which way the room is going.
func TestTheAudienceNeverSeesATally(t *testing.T) {
	h := newHarness(t)
	h.signup("Private Host", "pollprivate@test.dev", true)
	wb := h.liveWebinar("Private results", nil)
	reg := h.registerAsGuest(wb.ID, "pollprivate-attendee@test.dev")

	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Have you used WebRTC?", Kind: types.PollOpinion,
		Options: []string{"Yes", "No"},
	})
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil)

	if res, raw := h.voteAsGuest(wb.ID, poll.ID, reg.JoinKey, 0); res.StatusCode != http.StatusOK {
		t.Fatalf("vote: status %d body %s", res.StatusCode, raw)
	}

	got := h.pollsAsGuest(wb.ID, reg.JoinKey)
	if len(got[0].Votes) != 0 {
		t.Errorf("a tally reached the audience: %v", got[0].Votes)
	}
	// Not even the running total. "12 of 40 have answered" still tells the room how
	// far along it is, and the presenter is the only person who needs that.
	if got[0].TotalVotes != 0 {
		t.Errorf("totalVotes = %d reached the audience, want 0", got[0].TotalVotes)
	}
	// Their own answer comes back, or their client would offer to vote again.
	if got[0].MyChoice != 0 {
		t.Errorf("myChoice = %d, want 0", got[0].MyChoice)
	}

	// The host sees all of it. Withholding it from the audience is not withholding it
	// from the presenter, who needs to read the room and decide when to move on.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/polls", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host polls: status %d body %s", res.StatusCode, raw)
	}
	var hostView []types.Poll
	h.decode(raw, &hostView)
	if len(hostView[0].Votes) != 2 || hostView[0].Votes[0] != 1 {
		t.Errorf("the host's tally is %v, want [1 0]", hostView[0].Votes)
	}
}

// ------------------------------------------------------------------- voting

// One vote each, enforced by the primary key rather than by a lookup — two requests
// from a reloaded tab both find no existing vote.
func TestOneVotePerPerson(t *testing.T) {
	h := newHarness(t)
	h.signup("Vote Host", "pollvote@test.dev", true)
	wb := h.liveWebinar("Voting", nil)
	reg := h.registerAsGuest(wb.ID, "pollvote-attendee@test.dev")

	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Coffee or tea?", Kind: types.PollOpinion,
		Options: []string{"Coffee", "Tea"},
	})
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil)

	if res, raw := h.voteAsGuest(wb.ID, poll.ID, reg.JoinKey, 0); res.StatusCode != http.StatusOK {
		t.Fatalf("first vote: status %d body %s", res.StatusCode, raw)
	}
	res, raw := h.voteAsGuest(wb.ID, poll.ID, reg.JoinKey, 1)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("second vote: status %d body %s, want 409", res.StatusCode, raw)
	}

	// The tally is checked on the HOST's copy, because the audience's carries none.
	// What the voter gets back is their own answer — the first one, unchanged.
	mine := h.pollsAsGuest(wb.ID, reg.JoinKey)
	if mine[0].MyChoice != 0 {
		t.Errorf("myChoice = %d, want the first answer to have stood", mine[0].MyChoice)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/polls", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host polls: status %d body %s", res.StatusCode, raw)
	}
	var hostView []types.Poll
	h.decode(raw, &hostView)
	if hostView[0].TotalVotes != 1 {
		t.Errorf("totalVotes = %d after voting twice, want 1", hostView[0].TotalVotes)
	}
	if hostView[0].Votes[0] != 1 || hostView[0].Votes[1] != 0 {
		t.Errorf("tally is %v, want the first answer to have stood", hostView[0].Votes)
	}
}

func TestVotingRequiresAnOpenPoll(t *testing.T) {
	h := newHarness(t)
	h.signup("Closed Host", "pollclosed@test.dev", true)
	wb := h.liveWebinar("Closed voting", nil)
	reg := h.registerAsGuest(wb.ID, "pollclosed-attendee@test.dev")

	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Ready?", Kind: types.PollOpinion,
		Options: []string{"Yes", "No"},
	})

	// Still a draft.
	res, raw := h.voteAsGuest(wb.ID, poll.ID, reg.JoinKey, 0)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("voting on a draft: status %d body %s, want 409", res.StatusCode, raw)
	}

	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil)
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/close", nil)

	res, raw = h.voteAsGuest(wb.ID, poll.ID, reg.JoinKey, 0)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("voting on a closed poll: status %d body %s, want 409", res.StatusCode, raw)
	}
}

// ---------------------------------------------------------------- the host's rules

// Launching the next question closes the last one. Two open polls at once leaves the
// audience unable to tell which the host meant, and the room answers both.
func TestOpeningAPollClosesThePreviousOne(t *testing.T) {
	h := newHarness(t)
	h.signup("Sequence Host", "pollseq@test.dev", true)
	wb := h.liveWebinar("Sequence", nil)

	first := h.createPoll(wb.ID, types.PollInput{
		Question: "One?", Kind: types.PollOpinion, Options: []string{"A", "B"},
	})
	second := h.createPoll(wb.ID, types.PollInput{
		Question: "Two?", Kind: types.PollOpinion, Options: []string{"A", "B"},
	})

	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+first.ID+"/open", nil)
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+second.ID+"/open", nil)

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/polls", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host polls: status %d body %s", res.StatusCode, raw)
	}
	var polls []types.Poll
	h.decode(raw, &polls)

	open := 0
	for _, p := range polls {
		if p.State == types.PollOpen {
			open++
			if p.ID != second.ID {
				t.Errorf("the open poll is %q, want the one just launched", p.Question)
			}
		}
	}
	if open != 1 {
		t.Errorf("%d polls are open, want exactly 1", open)
	}
}

// A quiz needs a right answer and a poll must not carry one. A quiz with no correct
// option marks every response wrong and nothing downstream could tell that apart
// from an ordinary poll.
func TestPollValidation(t *testing.T) {
	h := newHarness(t)
	h.signup("Strict Host", "pollstrict@test.dev", true)
	wb := h.liveWebinar("Validation", nil)

	correct := 0
	outOfRange := 9
	cases := []struct {
		name string
		in   types.PollInput
	}{
		{"no question", types.PollInput{Options: []string{"A", "B"}, Kind: types.PollOpinion}},
		{"one option", types.PollInput{Question: "?", Options: []string{"A"}, Kind: types.PollOpinion}},
		{"blank options collapse to one", types.PollInput{
			Question: "?", Options: []string{"A", "   "}, Kind: types.PollOpinion,
		}},
		{"quiz with no answer", types.PollInput{
			Question: "?", Options: []string{"A", "B"}, Kind: types.PollQuizKind,
		}},
		{"quiz answer out of range", types.PollInput{
			Question: "?", Options: []string{"A", "B"}, Kind: types.PollQuizKind,
			CorrectOption: &outOfRange,
		}},
		{"unknown kind", types.PollInput{
			Question: "?", Options: []string{"A", "B"}, Kind: types.PollKind("survey"),
			CorrectOption: &correct,
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls", tc.in)
			if res.StatusCode != http.StatusUnprocessableEntity {
				t.Errorf("status %d body %s, want 422", res.StatusCode, raw)
			}
		})
	}
}

// Only the host writes them. An attendee account with a valid session must not be
// able to reach the host's endpoints.
func TestPollsAreHostOnly(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "pollowner@test.dev", true)
	wb := h.liveWebinar("Ownership", nil)
	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "?", Kind: types.PollOpinion, Options: []string{"A", "B"},
	})
	h.logout()

	h.signup("Bystander", "pollbystander@test.dev", true)
	for _, path := range []struct{ method, url string }{
		{http.MethodGet, "/api/host/webinars/" + wb.ID + "/polls"},
		{http.MethodPost, "/api/host/webinars/" + wb.ID + "/polls/" + poll.ID + "/open"},
		{http.MethodPost, "/api/host/webinars/" + wb.ID + "/polls/" + poll.ID + "/close"},
		{http.MethodDelete, "/api/host/webinars/" + wb.ID + "/polls/" + poll.ID},
	} {
		res, raw := h.do(path.method, path.url, nil)
		if res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s: status %d body %s, want 403 or 404",
				path.method, path.url, res.StatusCode, raw)
		}
	}
}

// The control governs the audience, not the stage. With polls off, an attendee sees
// none and cannot vote; the host still writes and launches them, because turning it
// on afterwards is the point.
func TestPollsControlAppliesToTheAudienceOnly(t *testing.T) {
	h := newHarness(t)
	h.signup("Control Host", "pollcontrol@test.dev", true)
	wb := h.liveWebinar("Polls off", func(in *types.WebinarInput) {
		in.Controls.PollsEnabled = false
	})
	reg := h.registerAsGuest(wb.ID, "pollcontrol-attendee@test.dev")

	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Anyone?", Kind: types.PollOpinion,
		Options: []string{"A", "B"},
	})
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("the host cannot launch with the control off: status %d body %s", res.StatusCode, raw)
	}

	if got := h.pollsAsGuest(wb.ID, reg.JoinKey); len(got) != 0 {
		t.Errorf("the audience sees %d polls with the control off", len(got))
	}
	res, raw := h.voteAsGuest(wb.ID, poll.ID, reg.JoinKey, 0)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("voting with polls off: status %d body %s, want 403", res.StatusCode, raw)
	}

	// Turning it on makes the launched poll appear, with no further host action.
	on := true
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{PollsEnabled: &on}); res.StatusCode != http.StatusOK {
		t.Fatalf("controls: status %d body %s", res.StatusCode, raw)
	}
	if got := h.pollsAsGuest(wb.ID, reg.JoinKey); len(got) != 1 {
		t.Errorf("the audience sees %d polls after turning them on, want 1", len(got))
	}
}

// Ending the webinar closes whatever was open. A poll still accepting votes on a room
// nobody is in would leave its tally labelled provisional when it is the result.
func TestEndingTheWebinarClosesOpenPolls(t *testing.T) {
	h := newHarness(t)
	h.signup("End Host", "pollend@test.dev", true)
	wb := h.liveWebinar("Ending", nil)

	poll := h.createPoll(wb.ID, types.PollInput{
		Question: "Last one?", Kind: types.PollOpinion,
		Options: []string{"A", "B"},
	})
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/polls", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host polls: status %d body %s", res.StatusCode, raw)
	}
	var polls []types.Poll
	h.decode(raw, &polls)
	if polls[0].State != types.PollClosed {
		t.Errorf("the poll is %q after the webinar ended, want closed", polls[0].State)
	}
}
