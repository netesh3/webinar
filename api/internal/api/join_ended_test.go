package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* An attendee who arrives after the session is over must not be told it
 * "isn't running" — that is the same sentence as a session that has not
 * started, and it is what the Try again button was hanging off.
 *
 * Ended covers a row whose status is ended and a scheduled row markLapsed
 * rewrites on read (the end passed, it never went live). A scheduled session
 * the host has not started is a different code: too_early before the doors
 * open, and a token once they have, so the waiting room still works.
 */

func TestAttendeeJoinDistinguishesEndedFromNotStarted(t *testing.T) {
	h := newHarness(t)
	h.signup("Ended Host", "ended-host@test.dev", true)

	t.Run("ended", func(t *testing.T) {
		wb := h.newWebinar("Finished session", nil)
		h.logout()
		reg := h.registerAs(wb.ID, "after-end@test.dev")
		if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
			t.Fatal(err)
		}
		code, raw := joinCode(t, h, wb.ID, reg.JoinKey)
		if code != "ended" {
			t.Fatalf("code %q, want ended\n  body: %s", code, raw)
		}
		if strings.Contains(string(raw), "isn't running") {
			t.Fatalf("an ended webinar still says it isn't running: %s", raw)
		}
		if !strings.Contains(string(raw), "ended this session") {
			t.Fatalf("the refusal must say the session has ended: %s", raw)
		}
	})

	t.Run("lapsed without going live", func(t *testing.T) {
		h.login("ended-host@test.dev")
		/* Three hours ago, duration 60 minutes: the slot ended two hours ago
		 * and the host never went live. The row stays scheduled; the read
		 * presents it as ended. */
		wb := scheduleAt(t, h, "Never went live", -3*time.Hour)
		var stored string
		if err := h.store.Pool().QueryRow(context.Background(),
			`SELECT status FROM webinars WHERE slug = $1`, wb.ID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored != string(types.StatusScheduled) {
			t.Fatalf("stored status %q, want scheduled — ended is a read, not a write", stored)
		}
		h.logout()
		reg := h.registerAs(wb.ID, "missed-it@test.dev")
		code, raw := joinCode(t, h, wb.ID, reg.JoinKey)
		if code != "ended" {
			t.Fatalf("a lapsed session code %q, want ended\n  body: %s", code, raw)
		}
	})

	t.Run("scheduled not started", func(t *testing.T) {
		h.login("ended-host@test.dev")
		wb := scheduleAt(t, h, "Next month", 30*24*time.Hour)
		h.logout()
		reg := h.registerAs(wb.ID, "early-again@test.dev")
		code, raw := joinCode(t, h, wb.ID, reg.JoinKey)
		if code != "too_early" {
			t.Fatalf("scheduled, not started: code %q, want too_early (not ended)\n  body: %s", code, raw)
		}
	})

	t.Run("scheduled waiting for the host", func(t *testing.T) {
		h.login("ended-host@test.dev")
		wb := scheduleAt(t, h, "Starting soon", 5*time.Minute)
		h.logout()
		reg := h.registerAs(wb.ID, "on-time@test.dev")
		res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
			types.JoinRequest{JoinKey: reg.JoinKey})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("doors are open and the host has not started: status %d body %s, want a token",
				res.StatusCode, raw)
		}
	})

	t.Run("draft", func(t *testing.T) {
		h.login("ended-host@test.dev")
		wb := h.newWebinar("Still a draft", nil)
		h.logout()
		reg := h.registerAs(wb.ID, "draft-guest@test.dev")
		if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusDraft); err != nil {
			t.Fatal(err)
		}
		code, raw := joinCode(t, h, wb.ID, reg.JoinKey)
		if code != "not_started" {
			t.Fatalf("draft code %q, want not_started (not ended)\n  body: %s", code, raw)
		}
	})
}

func joinCode(t *testing.T, h *harness, slug, key string) (string, []byte) {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/join",
		types.JoinRequest{JoinKey: key})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status %d, want 409\n  body: %s", res.StatusCode, raw)
	}
	return errorCode(t, raw), raw
}
