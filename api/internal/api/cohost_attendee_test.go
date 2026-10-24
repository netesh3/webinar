package api_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* "Make co-host" on someone the host brought up from the audience (an "att_" identity), by
 * the account behind their registration: handleSetParticipantCoHost. */

func uniqueEmail(prefix string) string {
	return fmt.Sprintf("%s-%d@test.dev", prefix, time.Now().UnixNano())
}

func coHostPath(slug, identity string) string {
	return "/api/host/webinars/" + slug + "/participants/" + identity + "/co-host"
}

// promote brings an attendee identity on stage, as the signed-in host.
func (h *harness) promote(slug, joinKey string) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/participants/att_"+joinKey+"/stage",
		types.StageRequest{Role: types.RolePanelist})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("promote: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(slug, joinKey)
}

// signedInRegistrant is an account that registered for slug while signed in, in its own browser.
func (h *harness) signedInRegistrant(slug, name string) (*harness, types.Account, types.Registration) {
	h.t.Helper()
	b := h.browser()
	email := uniqueEmail("registrant")
	acct := b.signup(name, email, false)
	reg := b.postRegister(slug, email, name, "", h.validAnswers(slug))
	if reg.JoinKey == "" {
		h.t.Fatalf("signed-in registration has no join key: %+v", reg)
	}
	return b, acct, reg
}

func (h *harness) lastRoleChange() lk.Spec {
	h.t.Helper()
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	if len(h.rooms.roleChanges) == 0 {
		h.t.Fatal("no live role change")
	}
	return h.rooms.roleChanges[len(h.rooms.roleChanges)-1]
}

func TestPromotedAttendeeWithAccountBecomesCoHost(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Asha", uniqueEmail("host"), true)
	wb := h.newWebinar("Promoted co-host", nil)
	ravi, _, reg := h.signedInRegistrant(wb.ID, "Ravi")
	identity := "att_" + reg.JoinKey
	participants := "/api/host/webinars/" + wb.ID + "/participants"

	h.login(host.Email)
	h.promote(wb.ID, reg.JoinKey)

	// On stage, but not a co-host yet: no host tools.
	if res, _ := ravi.do(http.MethodGet, participants, nil); res.StatusCode == http.StatusOK {
		t.Fatal("a promoted attendee read the participants before being made co-host")
	}

	h.login(host.Email)
	if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host: status %d body %s", res.StatusCode, raw)
	}
	// Applied to their current connection, keeping the promotion.
	if spec := h.lastRoleChange(); spec.Identity != identity || !spec.CoHost || spec.Role != types.RolePanelist || !spec.Promoted {
		t.Errorf("live change = %+v, want a promoted panelist with co-host", spec)
	}

	// Their account now has the co-host tools…
	for _, path := range []string{participants, "/api/host/webinars/" + wb.ID + "/polls"} {
		if res, raw := ravi.do(http.MethodGet, path, nil); res.StatusCode != http.StatusOK {
			t.Errorf("co-host GET %s: status %d body %s", path, res.StatusCode, raw)
		}
	}
	// …but not the owner's.
	res, raw := ravi.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil)
	ravi.wantError(res, raw, http.StatusForbidden, "host_only")

	// A reconnect signed in as that account comes back co-host…
	if res, raw := ravi.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; !spec.CoHost || spec.Role != types.RolePanelist {
		t.Errorf("signed-in rejoin spec = %+v, want a co-host panelist", spec)
	}
	// …and the bare join key (a forwarded link) does not carry co-host into a token.
	if res, _, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("key rejoin: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; spec.CoHost || spec.Role != types.RolePanelist {
		t.Errorf("key-only rejoin spec = %+v, want a plain panelist", spec)
	}

	// The host is not changeable through their own attendee identity, nor through the account id.
	h.login(host.Email)
	res, raw = h.do(http.MethodPatch, coHostPath(wb.ID, "user_"+host.ID), types.CoHostPatch{CoHost: false})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "is_the_host")

	// Back to the audience: co-host goes with the seat.
	if res, raw := h.do(http.MethodPost, participants+"/"+identity+"/stage",
		types.StageRequest{Role: types.RoleAttendee}); res.StatusCode != http.StatusOK {
		t.Fatalf("demote: status %d body %s", res.StatusCode, raw)
	}
	if res, _ := ravi.do(http.MethodGet, participants, nil); res.StatusCode == http.StatusOK {
		t.Error("a demoted attendee kept the co-host tools")
	}
}

func TestCoHostRevokeOnPromotedAttendee(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Revoke", uniqueEmail("host"), true)
	wb := h.newWebinar("Revoke co-host", nil)
	ravi, _, reg := h.signedInRegistrant(wb.ID, "Ravi")
	identity := "att_" + reg.JoinKey
	h.login(host.Email)
	h.promote(wb.ID, reg.JoinKey)
	for _, on := range []bool{true, false} {
		if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: on}); res.StatusCode != http.StatusOK {
			t.Fatalf("co-host %v: status %d body %s", on, res.StatusCode, raw)
		}
	}
	if spec := h.lastRoleChange(); spec.CoHost || spec.Role != types.RolePanelist || !spec.Promoted {
		t.Errorf("revoke live change = %+v, want a promoted panelist without co-host", spec)
	}
	if res, _ := ravi.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil); res.StatusCode == http.StatusOK {
		t.Error("a revoked co-host kept the tools")
	}
}

func TestCoHostGuestWithoutAccountNeedsSignIn(t *testing.T) {
	h := newHarness(t)
	h.signup("Host Guest", uniqueEmail("host"), true)
	wb := h.newWebinar("Guest co-host", nil)
	reg := h.registerAsGuest(wb.ID, uniqueEmail("no-account"))
	identity := "att_" + reg.JoinKey

	// Not on stage yet: refused before anything about accounts.
	res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "not_a_panelist")

	h.promote(wb.ID, reg.JoinKey)

	/* The form links a registration to the account for its email (one is made for a new
	 * address), so a guest with no account is a name-only row: the guest door, which is
	 * paused for webinars. Modelled by unlinking this one. */
	var userID string
	if err := h.store.Pool().QueryRow(t.Context(),
		`SELECT COALESCE(user_id::text, '') FROM registrations WHERE join_key = $1`, reg.JoinKey).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE registrations SET user_id = NULL WHERE join_key = $1`, reg.JoinKey); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true})
	h.wantError(res, raw, http.StatusConflict, "cohost_needs_account")
	if grant, err := h.store.StageGrant(t.Context(), wb.ID, identity); err != nil || grant.CoHost {
		t.Errorf("grant after a refused co-host = %+v, %v", grant, err)
	}

	// Linked to an account whose email was never confirmed: refused the same way, since
	// anybody can sign up with an address that is not theirs.
	if userID == "" {
		t.Fatal("the form registration had no account to relink")
	}
	if _, err := h.store.Pool().Exec(t.Context(), `
		UPDATE registrations SET user_id = $2::uuid WHERE join_key = $1`, reg.JoinKey, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Pool().Exec(t.Context(), `UPDATE users SET email_verified_at = NULL WHERE id = $1::uuid`, userID); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true})
	h.wantError(res, raw, http.StatusConflict, "cohost_needs_account")

	// Confirmed: a form registrant is a co-host like anyone with an account.
	if _, err := h.store.Pool().Exec(t.Context(), `UPDATE users SET email_verified_at = now() WHERE id = $1::uuid`, userID); err != nil {
		t.Fatal(err)
	}
	if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("co-host a confirmed form registrant: status %d body %s", res.StatusCode, raw)
	}
}

func TestCoHostRefusesAnotherWebinarsIdentity(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Cross", uniqueEmail("host"), true)
	wb := h.newWebinar("This session", nil)
	other := h.newWebinar("Other session", nil)
	ravi, _, otherReg := h.signedInRegistrant(other.ID, "Ravi")

	h.login(host.Email)
	h.promote(other.ID, otherReg.JoinKey)
	// The other session's join key, asked of this session: not a participant here.
	res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, "att_"+otherReg.JoinKey), types.CoHostPatch{CoHost: true})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "not_a_participant")
	// Nonsense identities too.
	for _, id := range []string{"att_", "user_", "egress_123", "att_NOSUCHKEY"} {
		res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, id), types.CoHostPatch{CoHost: true})
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("co-host %q: status %d body %s, want 422", id, res.StatusCode, raw)
		}
	}

	// Co-host on the other session gives nothing on this one.
	if res, raw := h.do(http.MethodPatch, coHostPath(other.ID, "att_"+otherReg.JoinKey), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("co-host on the other session: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := ravi.do(http.MethodGet, "/api/host/webinars/"+other.ID+"/participants", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("co-host on their own session: status %d body %s", res.StatusCode, raw)
	}
	if res, _ := ravi.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil); res.StatusCode == http.StatusOK {
		t.Error("co-host of one session read another session's participants")
	}
}

func TestCoHostGrantNeedsTheHost(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Grant", uniqueEmail("host"), true)
	wb := h.newWebinar("Who may grant", nil)
	ravi, _, reg := h.signedInRegistrant(wb.ID, "Ravi")
	identity := "att_" + reg.JoinKey
	h.login(host.Email)
	h.promote(wb.ID, reg.JoinKey)

	// The promoted attendee cannot make themselves co-host…
	if res, raw := ravi.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true}); res.StatusCode == http.StatusOK {
		t.Fatalf("self co-host: status %d body %s", res.StatusCode, raw)
	}
	// …nor can another host's account, or an ordinary signed-in account.
	stranger := h.browser()
	stranger.signup("Other Host", uniqueEmail("stranger"), true)
	if res, raw := stranger.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true}); res.StatusCode == http.StatusOK {
		t.Fatalf("stranger co-host: status %d body %s", res.StatusCode, raw)
	}
	if grant, err := h.store.StageGrant(t.Context(), wb.ID, identity); err != nil || grant.CoHost {
		t.Errorf("grant after refused attempts = %+v, %v", grant, err)
	}

	// A co-host may make another promoted attendee co-host, as with panelists.
	h.login(host.Email)
	if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host: status %d body %s", res.StatusCode, raw)
	}
	_, _, second := h.signedInRegistrant(wb.ID, "Mira")
	h.login(host.Email)
	h.promote(wb.ID, second.JoinKey)
	if res, raw := ravi.do(http.MethodPatch, coHostPath(wb.ID, "att_"+second.JoinKey), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Errorf("co-host grants co-host: status %d body %s", res.StatusCode, raw)
	}
}

// The roster's identity route covers an invited panelist the same as the panelist route.
func TestCoHostByIdentityForPanelist(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Panel", uniqueEmail("host"), true)
	guest := h.signup("Guest Panel", uniqueEmail("panelist"), false)
	h.login(host.Email)
	wb := h.newWebinar("Panel co-host", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists", types.PanelistRequest{Email: guest.Email}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, "user_"+guest.ID), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host: status %d body %s", res.StatusCode, raw)
	}
	h.login(guest.Email)
	if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil); res.StatusCode != http.StatusOK {
		t.Errorf("panelist co-host: status %d body %s", res.StatusCode, raw)
	}
}

/* A meeting guest is co-host by the account that knocked, signed in. A guest who knocked with
 * no session is told to sign in instead. */
func TestMeetingGuestCoHostNeedsSignedInKnock(t *testing.T) {
	h := newHarness(t)
	meetingHost(t, h)
	wb := h.instantMeeting("Meeting co-host", nil)

	priya := h.browser()
	priya.signup("Priya Raman", uniqueEmail("priya"), false)
	res, raw := priya.do(http.MethodPost, "/api/webinars/"+wb.ID+"/meeting/knock", types.MeetingKnockRequest{})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("signed-in knock: status %d body %s", res.StatusCode, raw)
	}
	var knocked types.MeetingKnockResponse
	h.decode(raw, &knocked)
	anon := h.mustKnock(wb.ID, "Walk In")

	// Waiting in the lobby is not being in the meeting.
	res, raw = h.do(http.MethodPatch, coHostPath(wb.ID, "att_"+knocked.JoinKey), types.CoHostPatch{CoHost: true})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "not_a_panelist")

	for _, name := range []string{"Priya Raman", "Walk In"} {
		id := h.lobbyID(wb.ID, name)
		if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+id+"/admit", nil); res.StatusCode != http.StatusOK {
			t.Fatalf("admit %s: status %d body %s", name, res.StatusCode, raw)
		}
	}

	res, raw = h.do(http.MethodPatch, coHostPath(wb.ID, "att_"+anon.JoinKey), types.CoHostPatch{CoHost: true})
	h.wantError(res, raw, http.StatusConflict, "cohost_needs_account")

	if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, "att_"+knocked.JoinKey), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make meeting guest co-host: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.lastRoleChange(); !spec.CoHost || spec.Promoted || spec.Role != types.RolePanelist {
		t.Errorf("live change = %+v, want an unpromoted co-host panelist", spec)
	}
	if res, raw := priya.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/lobby", nil); res.StatusCode != http.StatusOK {
		t.Errorf("meeting co-host reads the lobby: status %d body %s", res.StatusCode, raw)
	}
	// Their signed-in rejoin comes back co-host.
	if res, raw := priya.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: knocked.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("meeting rejoin: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; !spec.CoHost {
		t.Errorf("meeting rejoin spec = %+v, want co-host", spec)
	}
}
