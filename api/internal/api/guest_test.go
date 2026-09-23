package api_test

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The guest door.
 *
 * These tests are mostly about what it must NOT do. It is the one path into a webinar that
 * asks for nothing verifiable, so the interesting cases are the gates it still has to clear
 * — and the two that are specific to it: a manual-approval webinar, where a guest could never
 * be approved, and a second guest, who must not be handed the first one's seat.
 */

// errorCode reads the machine-readable code out of an error body. Tests assert on this rather
// than on the sentence, because the sentence is copy and the code is the contract.
func errorCode(t *testing.T, raw []byte) string {
	t.Helper()
	var body types.APIError
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode error body %s: %v", raw, err)
	}
	return body.Error
}

func ptr[T any](v T) *T { return &v }

// guestJoin posts to the guest door with NO cookies at all, which is the only way anybody
// reaches it in reality: a forwarded link, opened by somebody with no account.
func (h *harness) guestJoin(slug, name string) (*http.Response, []byte) {
	h.t.Helper()
	body, err := json.Marshal(types.GuestJoinRequest{Name: name})
	if err != nil {
		h.t.Fatal(err)
	}
	res, err := (&http.Client{}).Post(
		h.srv.URL+"/api/webinars/"+slug+"/guest-join", "application/json", bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

// registrantCount counts the rows behind a webinar, so a test can assert that a REFUSED
// guest left nothing behind. Asserting only on the status code would pass while the table
// filled up with seats nobody could use.
func (h *harness) registrantCount(slug string) int {
	h.t.Helper()
	rows, err := h.store.Registrants(context.Background(), slug, 0)
	if err != nil {
		h.t.Fatalf("registrants %s: %v", slug, err)
	}
	return len(rows)
}

// openWebinar is a live, automatic-approval, passcode-free webinar: the shape the guest door
// is for.
func (h *harness) openWebinar(topic string) types.Webinar {
	h.t.Helper()
	wb := h.newWebinar(topic, func(in *types.WebinarInput) {
		in.Approval = types.ApprovalAutomatic
		in.Passcode = ""
	})
	h.goLive(wb.ID)
	return wb
}

func TestGuestJoinLetsANameStraightIn(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Guest door")

	res, raw := h.guestJoin(wb.ID, "  Asha   Menon ")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("guest join: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)

	if join.Token == "" {
		t.Error("no token: the guest cannot connect to anything")
	}
	// The whole reason the response carries it. Without the key this browser has no way
	// back into the room after a reload, and a guest has no account to fall back on.
	if join.JoinKey == "" {
		t.Error("no joinKey: a guest who reloads the page is locked out")
	}
	if join.Role != types.RoleAttendee {
		t.Errorf("role %q: a guest must never arrive publishable", join.Role)
	}
	if join.CanPublish {
		t.Error("canPublish true for a guest")
	}
	if join.CanRecord {
		t.Error("canRecord true for a guest")
	}
	// Whitespace collapsed, so the tile and the chat show a name rather than the spacing
	// somebody's phone keyboard inserted.
	if join.DisplayName != "Asha Menon" {
		t.Errorf("displayName %q, want %q", join.DisplayName, "Asha Menon")
	}
	if want := "att_" + join.JoinKey; join.Identity != want {
		t.Errorf("identity %q, want %q", join.Identity, want)
	}
}

// The row a guest leaves behind is a real registration, marked as a guest, with no email —
// which is what lets the host's list tell it apart from a lead instead of showing a blank
// address that looks like a bug.
func TestGuestJoinRecordsAGuestRegistration(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Guest rows")

	if _, raw := h.guestJoin(wb.ID, "Asha Menon"); raw == nil {
		t.Fatal("no response")
	}

	rows, err := h.store.Registrants(context.Background(), wb.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("registrants %d, want 1", len(rows))
	}
	got := rows[0]
	if !got.IsGuest {
		t.Error("row is not marked as a guest")
	}
	if got.Email != "" {
		t.Errorf("email %q: the guest form has no email field", got.Email)
	}
	if got.Name != "Asha Menon" {
		t.Errorf("name %q, want %q", got.Name, "Asha Menon")
	}
	// Never pending. There is no address to notify and nothing for the host to review, so a
	// pending guest is a seat that can never be actioned.
	if got.State != types.RegApproved {
		t.Errorf("state %q, want approved", got.State)
	}
}

/* Two guests, two seats.
 *
 * This is the test that migration 0012 exists for. Both guest rows have an empty email, so
 * under the original `UNIQUE (webinar_id, lower(email))` the second insert collided with the
 * first — and the collision path in the register flow returns the EXISTING row, which would
 * have handed guest two guest one's join key, seat and chat identity. Dropping the index and
 * recreating it as partial (`WHERE NOT is_guest`) is what makes this pass.
 */
func TestTwoGuestsGetTwoSeats(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Two guests")

	var first, second types.JoinResponse
	res, raw := h.guestJoin(wb.ID, "Guest One")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("first guest: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &first)

	res, raw = h.guestJoin(wb.ID, "Guest Two")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("second guest: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &second)

	if first.JoinKey == second.JoinKey {
		t.Fatalf("both guests were given join key %q — the second is sitting in the "+
			"first one's seat", first.JoinKey)
	}
	if first.Identity == second.Identity {
		// Worse than a shared key: LiveKit disconnects the older session when a duplicate
		// identity connects, so guest one is kicked out the moment guest two arrives.
		t.Fatalf("both guests have identity %q; one will disconnect the other", first.Identity)
	}
	if n := h.registrantCount(wb.ID); n != 2 {
		t.Errorf("registrants %d, want 2", n)
	}
}

/* Manual approval closes the guest door, and closes it before anything is created.
 *
 * The gate a host switches on to decide who gets in cannot have a button beside it that
 * skips the decision. A guest has no address to write to, so there is no version of this
 * where the host reviews them later.
 */
func TestGuestJoinRefusedWhenTheHostApprovesEachAttendee(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Approval required", func(in *types.WebinarInput) {
		in.Approval = types.ApprovalManual
		in.Passcode = ""
	})
	h.goLive(wb.ID)

	res, raw := h.guestJoin(wb.ID, "Uninvited")
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("status %d body %s, want 409", res.StatusCode, raw)
	}
	if code := errorCode(t, raw); code != "guest_join_disabled" {
		t.Errorf("code %q, want guest_join_disabled", code)
	}
	if n := h.registrantCount(wb.ID); n != 0 {
		t.Errorf("registrants %d, want 0: a refused guest must leave no row", n)
	}
	// And the landing page is told, so it hides the button rather than offering one that 409s.
	if wb.GuestJoinAllowed {
		t.Error("guestJoinAllowed true on a manual-approval webinar")
	}
}

// A passcode closes it too: the guest form has no field to type one into, and adding one
// would make it the registration form.
func TestGuestJoinRefusedWhenAPasscodeIsSet(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Passcode", func(in *types.WebinarInput) {
		in.Approval = types.ApprovalAutomatic
		in.Passcode = "228104"
	})
	h.goLive(wb.ID)

	res, raw := h.guestJoin(wb.ID, "Chancer")
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d body %s, want 403", res.StatusCode, raw)
	}
	if code := errorCode(t, raw); code != "passcode_required" {
		t.Errorf("code %q, want passcode_required", code)
	}
	if n := h.registrantCount(wb.ID); n != 0 {
		t.Errorf("registrants %d, want 0", n)
	}
	if wb.GuestJoinAllowed {
		t.Error("guestJoinAllowed true on a passcode-protected webinar")
	}
}

/* The derived flag and the enforced rule are the same rule.
 *
 * Read off the PUBLIC endpoint, which is the one the landing page calls and the one where the
 * passcode has been stripped — so this also pins the ordering: the flag has to be computed
 * before the passcode is blanked, or every protected webinar advertises a guest door.
 */
func TestGuestJoinAllowedMatchesWhatTheEndpointDoes(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	cases := []struct {
		name    string
		mutate  func(*types.WebinarInput)
		allowed bool
	}{
		{"open", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalAutomatic
			in.Passcode = ""
		}, true},
		{"manual approval", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalManual
			in.Passcode = ""
		}, false},
		{"passcode", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalAutomatic
			in.Passcode = "228104"
		}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wb := h.newWebinar("Flag "+tc.name, tc.mutate)
			h.goLive(wb.ID)

			res, raw := h.do(http.MethodGet, "/api/webinars/"+wb.ID, nil)
			if res.StatusCode != http.StatusOK {
				t.Fatalf("get webinar: status %d body %s", res.StatusCode, raw)
			}
			var public types.Webinar
			h.decode(raw, &public)
			if public.Passcode != "" {
				t.Fatal("the public payload still carries the passcode")
			}
			if public.GuestJoinAllowed != tc.allowed {
				t.Fatalf("guestJoinAllowed %v, want %v", public.GuestJoinAllowed, tc.allowed)
			}

			// The claim, checked against the behaviour.
			res, raw = h.guestJoin(wb.ID, "Prospective Guest")
			gotIn := res.StatusCode == http.StatusOK
			if gotIn != tc.allowed {
				t.Fatalf("guest join status %d (in=%v) but the flag said %v: body %s",
					res.StatusCode, gotIn, tc.allowed, raw)
			}
		})
	}
}

func TestGuestJoinNeedsAName(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Names")

	for _, name := range []string{"", "   ", "\t\n"} {
		res, raw := h.guestJoin(wb.ID, name)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("name %q: status %d body %s, want 422", name, res.StatusCode, raw)
		}
	}
	// Counted in runes, not bytes: a name in Devanagari must not be rejected for being
	// three bytes a character.
	long := strings.Repeat("अ", 60)
	if res, raw := h.guestJoin(wb.ID, long); res.StatusCode != http.StatusOK {
		t.Errorf("60 Devanagari characters: status %d body %s, want 200", res.StatusCode, raw)
	}
	if res, raw := h.guestJoin(wb.ID, strings.Repeat("x", 61)); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("61 characters: status %d body %s, want 422", res.StatusCode, raw)
	}
	if n := h.registrantCount(wb.ID); n != 1 {
		t.Errorf("registrants %d, want 1: only the valid name should have created a row", n)
	}
}

/* Every gate the registered door has, the guest door has — and it has them BEFORE it creates
 * anything, which is the difference between a refusal and a refusal plus litter.
 *
 * Each case here is a rule somebody could reasonably have forgotten while adding a second
 * entrance. They pass because both doors call one function; the test is what stops that
 * quietly becoming two.
 */
func TestGuestJoinClearsTheSameGatesAsRegisteredEntry(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	t.Run("locked", func(t *testing.T) {
		wb := h.openWebinar("Locked")
		res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
			types.ControlsPatch{Locked: ptr(true)})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("lock: status %d body %s", res.StatusCode, raw)
		}

		res, raw = h.guestJoin(wb.ID, "Late Arrival")
		if res.StatusCode != http.StatusConflict {
			t.Fatalf("status %d body %s, want 409", res.StatusCode, raw)
		}
		if code := errorCode(t, raw); code != "locked" {
			t.Errorf("code %q, want locked", code)
		}
		if n := h.registrantCount(wb.ID); n != 0 {
			t.Errorf("registrants %d, want 0", n)
		}
	})

	t.Run("too early", func(t *testing.T) {
		// Three weeks out, and not started: outside the 15-minute door.
		wb := h.newWebinar("Weeks away", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalAutomatic
			in.Passcode = ""
			in.StartsAt = time.Now().Add(21 * 24 * time.Hour).UTC().Format(time.RFC3339)
		})

		res, raw := h.guestJoin(wb.ID, "Very Early")
		if res.StatusCode != http.StatusConflict {
			t.Fatalf("status %d body %s, want 409", res.StatusCode, raw)
		}
		if code := errorCode(t, raw); code != "too_early" {
			t.Errorf("code %q, want too_early", code)
		}
		if n := h.registrantCount(wb.ID); n != 0 {
			t.Errorf("registrants %d, want 0: an early guest leaves an emailless row "+
				"the host cannot do anything with", n)
		}
	})

	t.Run("ended", func(t *testing.T) {
		wb := h.openWebinar("Finished")
		if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
			t.Fatal(err)
		}
		res, raw := h.guestJoin(wb.ID, "Too Late")
		if res.StatusCode != http.StatusConflict {
			t.Fatalf("status %d body %s, want 409", res.StatusCode, raw)
		}
		if code := errorCode(t, raw); code != "not_joinable" {
			t.Errorf("code %q, want not_joinable", code)
		}
	})

	t.Run("draft", func(t *testing.T) {
		wb := h.newWebinar("Unpublished", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalAutomatic
			in.Passcode = ""
			in.Status = types.StatusDraft
		})
		// 404, not 409: a draft is not public, and saying "this exists but isn't running"
		// tells an anonymous caller that a slug they guessed is real.
		if res, raw := h.guestJoin(wb.ID, "Snooper"); res.StatusCode != http.StatusNotFound {
			t.Fatalf("status %d body %s, want 404", res.StatusCode, raw)
		}
	})

	t.Run("full", func(t *testing.T) {
		wb := h.newWebinar("One seat", func(in *types.WebinarInput) {
			in.Approval = types.ApprovalAutomatic
			in.Passcode = ""
			in.AttendeeLimit = 1
		})
		h.goLive(wb.ID)

		if res, raw := h.guestJoin(wb.ID, "First"); res.StatusCode != http.StatusOK {
			t.Fatalf("first guest: status %d body %s", res.StatusCode, raw)
		}
		res, raw := h.guestJoin(wb.ID, "Second")
		if res.StatusCode != http.StatusConflict {
			t.Fatalf("status %d body %s, want 409", res.StatusCode, raw)
		}
		if code := errorCode(t, raw); code != "webinar_full" {
			t.Errorf("code %q, want webinar_full", code)
		}
		if n := h.registrantCount(wb.ID); n != 1 {
			t.Errorf("registrants %d, want 1: the ceiling was overshot", n)
		}
	})
}

/* A guest who reloads is still a guest.
 *
 * The key from the guest door has to work on the ordinary join endpoint, because that is
 * where the room sends every attendee on arrival — including after a refresh, a dropped
 * connection, or the back button. If this fails, guests get exactly one page load.
 */
func TestAGuestKeyWorksOnTheOrdinaryJoinEndpoint(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Reload")

	res, raw := h.guestJoin(wb.ID, "Asha Menon")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("guest join: status %d body %s", res.StatusCode, raw)
	}
	var first types.JoinResponse
	h.decode(raw, &first)

	body, err := json.Marshal(types.JoinRequest{JoinKey: first.JoinKey})
	if err != nil {
		t.Fatal(err)
	}
	again, err := (&http.Client{}).Post(
		h.srv.URL+"/api/webinars/"+wb.ID+"/join", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer again.Body.Close()
	raw, _ = io.ReadAll(again.Body)
	if again.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", again.StatusCode, raw)
	}
	var second types.JoinResponse
	h.decode(raw, &second)

	if second.Identity != first.Identity {
		t.Errorf("identity changed on rejoin: %q then %q", first.Identity, second.Identity)
	}
	if second.DisplayName != first.DisplayName {
		t.Errorf("displayName changed on rejoin: %q then %q", first.DisplayName, second.DisplayName)
	}
	if second.Role != types.RoleAttendee || second.CanPublish {
		t.Errorf("rejoining upgraded the guest: role %q canPublish %v",
			second.Role, second.CanPublish)
	}
	// Rejoining must not take a second seat.
	if n := h.registrantCount(wb.ID); n != 1 {
		t.Errorf("registrants %d, want 1", n)
	}
}

/* The host can tell a guest apart, in the UI and in the export.
 *
 * This is the test behind the claim in the type comment: a guest row has no email, and an
 * empty Email cell with nothing to explain it reads as a broken export rather than as a
 * person who was never asked. The flag is what the list and the CSV key off.
 *
 * The CSV column is asserted to exist even when there are no guests at all, because a column
 * that appears and disappears with the data breaks whatever the host built on top of it.
 */
func TestTheHostCanTellAGuestApart(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Mixed audience")

	if res, raw := h.guestJoin(wb.ID, "Nameless Guest"); res.StatusCode != http.StatusOK {
		t.Fatalf("guest join: status %d body %s", res.StatusCode, raw)
	}
	h.registerAs(wb.ID, "lead@test.dev")

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("registrants: status %d body %s", res.StatusCode, raw)
	}
	var rows []types.RegistrantRow
	h.decode(raw, &rows)
	if len(rows) != 2 {
		t.Fatalf("rows %d, want 2", len(rows))
	}

	guests, leads := 0, 0
	for _, row := range rows {
		if row.IsGuest {
			guests++
			if row.Email != "" {
				t.Errorf("guest row carries email %q", row.Email)
			}
		} else {
			leads++
			if row.Email == "" {
				t.Error("a registered row has no email")
			}
		}
	}
	if guests != 1 || leads != 1 {
		t.Errorf("guests=%d leads=%d, want 1 and 1", guests, leads)
	}

	// The export, header and all.
	rows2 := exportedCSV(t, h, wb.ID)
	if len(rows2) != 3 {
		t.Fatalf("csv has %d records, want a header and two rows: %+v", len(rows2), rows2)
	}
	guest := csvColumn(t, rows2[0], "guest")
	// One "true" and one "false" in that column, whichever order the rows came in.
	trues := 0
	for _, row := range rows2[1:] {
		if row[guest] == "true" {
			trues++
		}
	}
	if trues != 1 {
		t.Errorf("csv marked %d rows as guests, want 1: %+v", trues, rows2)
	}
}

/* exportedCSV reads the registrant export as records rather than as text.
 *
 * Parsed, because the export quotes fields — the phone is written with a leading tab so
 * spreadsheets stop eating the + — and splitting on commas gets that right only by luck.
 */
func exportedCSV(t *testing.T, h *harness, slug string) [][]string {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/registrants.csv", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("csv: status %d body %s", res.StatusCode, raw)
	}
	records, err := csv.NewReader(bytes.NewReader(raw)).ReadAll()
	if err != nil {
		t.Fatalf("csv: %v\n  body: %s", err, raw)
	}
	return records
}

/* csvColumn finds a column by NAME and fails if it is missing.
 *
 * By name and not by position, which is the whole point: columns are only ever appended
 * to this export (see handleExportRegistrants), so a test that pinned "guest" to the last
 * field would fail the next time something legitimate is added after it — and a test that
 * pinned it to index 8 would pass while the column it is reading changed meaning.
 */
func csvColumn(t *testing.T, header []string, name string) int {
	t.Helper()
	for i, h := range header {
		if h == name {
			return i
		}
	}
	t.Fatalf("csv header has no %q column: %v", name, header)
	return -1
}

// A webinar with no guests still has the column, so a host's spreadsheet does not change
// shape between exports.
func TestTheGuestColumnIsAlwaysInTheExport(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("No guests")
	h.registerAs(wb.ID, "only-lead@test.dev")

	records := exportedCSV(t, h, wb.ID)
	if len(records) != 2 {
		t.Fatalf("csv has %d records, want a header and one row: %+v", len(records), records)
	}
	guest := csvColumn(t, records[0], "guest")
	if records[1][guest] != "false" {
		t.Errorf("the only row reads %q in the guest column, want false", records[1][guest])
	}
}

// The door does not exist on a slug that does not exist, and the answer is the same 404 an
// unpublished webinar gets — so it cannot be used to find out which slugs are real.
func TestGuestJoinOnAnUnknownWebinarIs404(t *testing.T) {
	h := newHarness(t)
	if res, raw := h.guestJoin("no-such-webinar", "Nobody"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d body %s, want 404", res.StatusCode, raw)
	}
}

/* The guest door cannot be talked into a publishing token.
 *
 * A client cannot ask for a role anywhere in this API, and this is the newest place somebody
 * might try. The request type has exactly one field and the decoder REFUSES unknown ones, so
 * an attempt to smuggle a role in is a 400 rather than something quietly discarded — which is
 * the stronger answer, and the one that shows up in a log.
 */
func TestGuestJoinRefusesAnythingButTheName(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.openWebinar("Role grab")

	res, err := (&http.Client{}).Post(
		h.srv.URL+"/api/webinars/"+wb.ID+"/guest-join", "application/json",
		strings.NewReader(`{"name":"Chancer","role":"host","canPublish":true,`+
			`"state":"approved","isGuest":false}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d body %s, want 400", res.StatusCode, raw)
	}
	if n := h.registrantCount(wb.ID); n != 0 {
		t.Errorf("registrants %d, want 0", n)
	}

	// The name alone is accepted, so the test above is about the extra fields and not about
	// a body the endpoint could never read.
	if res, raw := h.guestJoin(wb.ID, "Chancer"); res.StatusCode != http.StatusOK {
		t.Fatalf("plain name: status %d body %s", res.StatusCode, raw)
	}
}
