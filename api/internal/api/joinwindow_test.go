package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* When the doors open.
 *
 * There was no window: an approved registration could be exchanged for a token at any
 * time, including weeks before the scheduled start. That created an SFU room and dropped
 * the attendee into the room's "Waiting for the host to start" state, which is the wrong
 * explanation — the host was not late, the webinar was not that day.
 *
 * The rule has two halves and both need protecting, because tightening the first is how
 * you break the second:
 *
 *   too early    refused, with the time it opens
 *   started late accepted regardless of the clock, because people are already waiting
 */

// scheduleAt builds a webinar starting at a given offset from now.
func scheduleAt(t *testing.T, h *harness, topic string, offset time.Duration) types.Webinar {
	t.Helper()
	return h.newWebinar(topic, func(in *types.WebinarInput) {
		in.StartsAt = time.Now().Add(offset).UTC().Format(time.RFC3339)
	})
}

func TestAttendeeCannotJoinLongBeforeTheStart(t *testing.T) {
	h := newHarness(t)
	h.signup("Window Host", "window-host@test.dev", true)
	wb := scheduleAt(t, h, "Next Month", 30*24*time.Hour)
	h.logout()

	reg := h.registerAs(wb.ID, "early-bird@test.dev")
	if reg.State != types.RegApproved {
		t.Fatalf("registration state %q, want approved — the join check is not what is being tested here", reg.State)
	}

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode == http.StatusOK {
		t.Fatalf("a token was issued a month early: %s", raw)
	}
	if res.StatusCode != http.StatusConflict {
		t.Errorf("status %d, want 409 so the UI can tell this apart from a real failure", res.StatusCode)
	}
	// The message has to carry the answer, or the attendee is left guessing.
	if !containsAll(string(raw), "too_early", "join from") {
		t.Errorf("the refusal must say when it opens: %s", raw)
	}
}

func TestAttendeeCanJoinJustBeforeTheStart(t *testing.T) {
	h := newHarness(t)
	h.signup("Window Host", "window-host2@test.dev", true)
	// Inside the grace period, and deliberately NOT started: arriving a few minutes
	// early and waiting for the host is the normal way a webinar begins.
	wb := scheduleAt(t, h, "Starting Soon", 5*time.Minute)
	h.logout()

	reg := h.registerAs(wb.ID, "punctual@test.dev")
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("an attendee five minutes early was turned away: status %d body %s",
			res.StatusCode, raw)
	}
}

/* Go live stays shut until five minutes before the start.
 *
 * Once a webinar IS live, the schedule stops mattering for the audience — that
 * is the `status != live` guard. A host can no longer reach that state a month
 * early through Go live, so this test refuses the early start and then marks
 * the row live the way a session that already opened would be. Verified by
 * removing the guard: the join below fails and the late-start test does not. */
func TestStartingEarlyOpensTheDoors(t *testing.T) {
	h := newHarness(t)
	h.signup("Eager Host", "eager-host@test.dev", true)
	wb := scheduleAt(t, h, "Opened Early", 30*24*time.Hour)
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "too_soon" {
		t.Fatalf("start a month early: status %d code %q, want 403 too_soon\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	if strings.Contains(string(raw), "hour from now") {
		t.Fatalf("early Go live used the schedule-form message: %s", raw)
	}
	if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusLive); err != nil {
		t.Fatalf("mark live: %v", err)
	}
	h.logout()

	reg := h.registerAs(wb.ID, "keen@test.dev")
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("the host started it, so the schedule must stop mattering: status %d body %s",
			res.StatusCode, raw)
	}
}

func TestALateStartDoesNotLockTheAudienceOut(t *testing.T) {
	h := newHarness(t)
	h.signup("Late Host", "late-host@test.dev", true)
	/* Scheduled for two hours ago and only being started now. The clock is well past the
	 * window in both directions, so a naive "within grace of startsAt" rule would refuse
	 * everybody — which is the failure mode that matters, because it happens exactly when
	 * an audience is already sitting there. */
	wb := scheduleAt(t, h, "Running Late", -2*time.Hour)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	h.logout()

	reg := h.registerAs(wb.ID, "still-here@test.dev")
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("a live webinar refused an attendee because of its scheduled time: status %d body %s",
			res.StatusCode, raw)
	}
}

func TestGoLiveOpensFiveMinutesBefore(t *testing.T) {
	h := newHarness(t)
	h.signup("Punctual Host", "punctual-host@test.dev", true)

	early := scheduleAt(t, h, "Two Hours Out", 2*time.Hour)
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+early.ID+"/start", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "too_soon" {
		t.Fatalf("start two hours early: status %d code %q, want 403 too_soon\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	soon := scheduleAt(t, h, "Four Minutes Out", 4*time.Minute)
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+soon.ID+"/start", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("start four minutes out: status %d body %s", res.StatusCode, raw)
	}
}

func TestHostCanEnterEarlyToSetUp(t *testing.T) {
	h := newHarness(t)
	h.signup("Prep Host", "prep-host@test.dev", true)
	wb := scheduleAt(t, h, "Prep Time", 30*24*time.Hour)

	/* The window is an audience rule only. A host has to be able to get in beforehand to
	 * check their camera and rehearse, which is what the practice-session option is for —
	 * applying the attendee window to them would make that impossible. */
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("the host was locked out of their own webinar: status %d body %s",
			res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if !join.CanPublish {
		t.Error("the host's early token cannot publish, so there is nothing to set up with")
	}
}

/* The time in the refusal must be the webinar's own clock, not UTC.
 *
 * This is the one place a server-rendered time reaches an attendee's eyes, and it reaches them
 * at the worst moment — they pressed Join and were turned away. "You can join from 19:26 UTC"
 * asks somebody in Bengaluru to convert before they know whether to wait five minutes or come
 * back tomorrow. Two zones are checked because a test with only Asia/Kolkata would also pass
 * against a hardcoded IST, which is the same bug in a friendlier disguise.
 */
func TestTheRefusalQuotesTheWebinarsOwnClock(t *testing.T) {
	for _, tc := range []struct{ zone, abbrev string }{
		{"Asia/Kolkata", "IST"},
		{"America/New_York", "E"}, // EST or EDT depending on the date
	} {
		t.Run(tc.zone, func(t *testing.T) {
			h := newHarness(t)
			h.signup("Zone Host", "zone-"+tc.abbrev+"@test.dev", true)
			wb := h.newWebinar("Zoned", func(in *types.WebinarInput) {
				in.StartsAt = time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
				in.TimeZone = tc.zone
			})
			h.logout()

			reg := h.registerAs(wb.ID, "reader-"+tc.abbrev+"@test.dev")
			res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
				types.JoinRequest{JoinKey: reg.JoinKey})
			if res.StatusCode != http.StatusConflict {
				t.Fatalf("status %d, want 409: %s", res.StatusCode, raw)
			}
			if !containsAll(string(raw), tc.abbrev) {
				t.Errorf("the refusal does not name %s's clock: %s", tc.zone, raw)
			}

			/* And the hour has to be that zone's hour, not UTC's wearing its label.
			 *
			 * Checked by reading the time back out of the message, interpreting it in the
			 * webinar's zone, and asking how far before the start it lands. The grace period
			 * is deliberately NOT mirrored here — a copy of a constant in a test is a copy
			 * that can drift — so the bound is loose: some time in the hour before the start.
			 * A UTC hour read as IST lands 5h45m early and a UTC hour read as EDT lands
			 * after the start, so both mistakes fail this even though it names no interval.
			 */
			loc, err := time.LoadLocation(tc.zone)
			if err != nil {
				t.Fatalf("LoadLocation(%q): %v", tc.zone, err)
			}
			opens := quotedTime(t, string(raw), loc)
			gap := mustParse(t, wb.StartsAt).Sub(opens)
			if gap <= 0 || gap > time.Hour {
				t.Errorf("the message names %s, %v before the start — that is not %s's clock: %s",
					opens.Format(time.RFC3339), gap, tc.zone, raw)
			}
		})
	}
}

/* quotedTime pulls "15:04 on 2 January 2006 MST" back out of a refusal message.
 *
 * Reading the server's own words rather than recomputing what they should have been: the point
 * of the assertion is that the text an attendee sees is right, and a test that recomputes the
 * expected string tests the recomputation.
 */
func quotedTime(t *testing.T, body string, loc *time.Location) time.Time {
	t.Helper()
	const layout = "15:04 on 2 January 2006 MST"
	from := strings.Index(body, "join from ")
	if from < 0 {
		t.Fatalf("no %q in the refusal: %s", "join from ", body)
	}
	rest := body[from+len("join from "):]
	end := strings.IndexAny(rest, `."`)
	if end < 0 {
		t.Fatalf("the quoted time is not terminated: %s", body)
	}
	at, err := time.ParseInLocation(layout, rest[:end], loc)
	if err != nil {
		t.Fatalf("parsing %q as %q: %v", rest[:end], layout, err)
	}
	return at
}

func mustParse(t *testing.T, rfc3339 string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		t.Fatalf("startsAt %q: %v", rfc3339, err)
	}
	return at
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		found := false
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
