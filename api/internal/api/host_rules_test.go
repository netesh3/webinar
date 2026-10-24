package api_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The host and co-host rules (host_transfer.go): only the host makes or unmakes a co-host;
 * the host hands over only to a co-host; exactly one host at a time. */

// makeCoHost makes identity a co-host, as the signed-in host.
func (h *harness) makeCoHost(slug, identity string) {
	h.t.Helper()
	if res, raw := h.do(http.MethodPatch, coHostPath(slug, identity), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		h.t.Fatalf("make co-host %s: status %d body %s", identity, res.StatusCode, raw)
	}
}

func (h *harness) addPanelist(slug, email string) {
	h.t.Helper()
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/panelists", types.PanelistRequest{Email: email}); res.StatusCode != http.StatusOK {
		h.t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
}

func (h *harness) startSession(slug string) {
	h.t.Helper()
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/start", nil); res.StatusCode != http.StatusOK {
		h.t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
}

func transferPath(slug string) string { return "/api/host/webinars/" + slug + "/transfer-host" }

// liveRoles is the last live role each identity was given.
func (h *harness) liveRoles() map[string]types.Role {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	roles := map[string]types.Role{}
	for _, spec := range h.rooms.roleChanges {
		roles[spec.Identity] = spec.Role
	}
	return roles
}

func TestCoHostCannotGrantOrRevokeCoHost(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Rules", uniqueEmail("host"), true)
	co := h.signup("Co Host", uniqueEmail("co"), false)
	other := h.signup("Other Panelist", uniqueEmail("other"), false)
	h.login(host.Email)
	wb := h.newWebinar("Who makes co-hosts", nil)
	h.addPanelist(wb.ID, co.Email)
	h.addPanelist(wb.ID, other.Email)
	h.makeCoHost(wb.ID, "user_"+co.ID)

	byAccount := func(id string) string { return "/api/host/webinars/" + wb.ID + "/panelists/" + id + "/co-host" }

	// A co-host grants: refused on both routes.
	h.login(co.Email)
	for _, path := range []string{byAccount(other.ID), coHostPath(wb.ID, "user_"+other.ID)} {
		res, raw := h.do(http.MethodPatch, path, types.CoHostPatch{CoHost: true})
		h.wantError(res, raw, http.StatusForbidden, "host_only")
	}
	if g, err := h.store.StageGrant(t.Context(), wb.ID, "user_"+other.ID); err != nil || g.CoHost {
		t.Fatalf("grant after a co-host's attempt = %+v, %v", g, err)
	}

	// The host grants; the co-host then tries to revoke it, or their own: refused.
	h.login(host.Email)
	h.makeCoHost(wb.ID, "user_"+other.ID)
	h.login(co.Email)
	for _, path := range []string{
		byAccount(other.ID), coHostPath(wb.ID, "user_"+other.ID),
		byAccount(co.ID), coHostPath(wb.ID, "user_"+co.ID),
	} {
		res, raw := h.do(http.MethodPatch, path, types.CoHostPatch{CoHost: false})
		h.wantError(res, raw, http.StatusForbidden, "host_only")
	}
	if ok, err := h.store.IsCoHost(t.Context(), wb.ID, other.ID); err != nil || !ok {
		t.Fatalf("co-host after a co-host's revoke = %v, %v", ok, err)
	}

	// The host revokes, on either route.
	h.login(host.Email)
	if res, raw := h.do(http.MethodPatch, byAccount(other.ID), types.CoHostPatch{CoHost: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("host revokes by account: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, coHostPath(wb.ID, "user_"+co.ID), types.CoHostPatch{CoHost: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("host revokes by identity: status %d body %s", res.StatusCode, raw)
	}
}

func TestTransferHostRefusesWhoIsNotACoHost(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Refuse", uniqueEmail("host"), true)
	panelist := h.signup("Plain Panelist", uniqueEmail("panel"), false)
	h.login(host.Email)
	wb := h.newWebinar("Not a co-host", nil)
	h.addPanelist(wb.ID, panelist.Email)
	_, _, reg := h.signedInRegistrant(wb.ID, "Ravi")
	h.login(host.Email)
	h.promote(wb.ID, reg.JoinKey)
	h.startSession(wb.ID)
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_" + host.ID, Name: "Host", Role: types.RoleHost},
		types.LiveParticipant{Identity: "user_" + panelist.ID, Name: "Plain Panelist", Role: types.RolePanelist},
		types.LiveParticipant{Identity: "att_" + reg.JoinKey, Name: "Ravi", Role: types.RolePanelist},
	)

	for _, id := range []string{"user_" + panelist.ID, "att_" + reg.JoinKey} {
		res, raw := h.do(http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: id})
		h.wantError(res, raw, http.StatusUnprocessableEntity, "not_a_cohost")
	}
	res, raw := h.do(http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: "user_" + host.ID})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "same_host")
	if got, _ := h.store.HostIDFor(t.Context(), wb.ID); got != host.ID {
		t.Fatalf("host after refused transfers = %q, want %q", got, host.ID)
	}

	// A co-host cannot hand the host role to anybody, themselves included.
	h.makeCoHost(wb.ID, "user_"+panelist.ID)
	h.login(panelist.Email)
	res, raw = h.do(http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: "user_" + panelist.ID})
	h.wantError(res, raw, http.StatusForbidden, "host_only")
}

// A promoted attendee with a confirmed account, made co-host, takes over a webinar.
func TestTransferHostToPromotedAttendeeCoHost(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Hand", uniqueEmail("host"), true)
	h.login(host.Email)
	wb := h.newWebinar("Hand to attendee", nil)
	ravi, raviAcct, reg := h.signedInRegistrant(wb.ID, "Ravi")
	identity := "att_" + reg.JoinKey
	h.login(host.Email)
	h.promote(wb.ID, reg.JoinKey)
	h.makeCoHost(wb.ID, identity)
	h.startSession(wb.ID)
	hostID := "user_" + host.ID
	h.rooms.setRoster(
		types.LiveParticipant{Identity: hostID, Name: "Host Hand", Role: types.RoleHost},
		types.LiveParticipant{Identity: identity, Name: "Ravi", Role: types.RolePanelist, CoHost: true},
	)

	res, raw := h.do(http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: identity})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("transfer to attendee co-host: status %d body %s", res.StatusCode, raw)
	}
	var got types.Webinar
	h.decode(raw, &got)
	if got.Host.ID != raviAcct.ID {
		t.Fatalf("host after transfer = %q, want %q", got.Host.ID, raviAcct.ID)
	}
	// The new host is not also a co-host; they keep their stage seat.
	if g, err := h.store.StageGrant(t.Context(), wb.ID, identity); err != nil || g.CoHost || !g.Granted {
		t.Errorf("new host's grant = %+v, %v; want on stage, not co-host", g, err)
	}
	roles := h.liveRoles()
	if roles[identity] != types.RoleHost || roles[hostID] != types.RolePanelist {
		t.Errorf("live roles = %v, want %s host and %s panelist", roles, identity, hostID)
	}

	// The old host: an ordinary panelist now, without the owner's routes or the host tools.
	if role, err := h.store.HostIDFor(t.Context(), wb.ID); err != nil || role == host.ID {
		t.Fatalf("old host still the host: %q %v", role, err)
	}
	for _, try := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPatch, coHostPath(wb.ID, identity), types.CoHostPatch{CoHost: false}},
		{http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: identity}},
		{http.MethodPost, "/api/host/webinars/" + wb.ID + "/end", nil},
	} {
		if res, raw := h.do(try.method, try.path, try.body); res.StatusCode != http.StatusNotFound {
			t.Errorf("old host %s %s: status %d body %s, want 404", try.method, try.path, res.StatusCode, raw)
		}
	}

	// The new host has them: making the old host co-host is the owner's own route.
	if res, raw := ravi.do(http.MethodPatch, coHostPath(wb.ID, hostID), types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("new host makes a co-host: status %d body %s", res.StatusCode, raw)
	}

	// Their signed-in reconnect on the attendee link comes back the host; the bare key does not.
	if res, raw := ravi.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("new host rejoin: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; spec.Role != types.RoleHost || spec.Identity != identity {
		t.Errorf("new host rejoin spec = %+v, want host", spec)
	}
	if res, _, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("key rejoin: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; spec.Role == types.RoleHost {
		t.Errorf("key-only rejoin spec = %+v, must not be the host", spec)
	}
	// The old host's own door now gives them a panelist seat, not the host's.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("old host join: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; spec.Role != types.RolePanelist || spec.Identity != hostID {
		t.Errorf("old host rejoin spec = %+v, want a panelist", spec)
	}

	// And the new host hands it back: the attendee identity holding the role is demoted.
	h.rooms.setRoster(
		types.LiveParticipant{Identity: hostID, Name: "Host Hand", Role: types.RolePanelist, CoHost: true},
		types.LiveParticipant{Identity: identity, Name: "Ravi", Role: types.RoleHost},
	)
	if res, raw := ravi.do(http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: hostID}); res.StatusCode != http.StatusOK {
		t.Fatalf("hand back: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.lastRoleChange(); spec.Identity != identity || spec.Role != types.RolePanelist || !spec.Promoted {
		t.Errorf("demoted attendee host = %+v, want a promoted panelist", spec)
	}
	if got, _ := h.store.HostIDFor(t.Context(), wb.ID); got != host.ID {
		t.Fatalf("host after hand-back = %q, want %q", got, host.ID)
	}
}

// A meeting guest who knocked signed in, made co-host, takes over the meeting.
func TestTransferMeetingHostToSignedInGuest(t *testing.T) {
	h := newHarness(t)
	host := meetingHost(t, h)
	wb := h.instantMeeting("Meeting hand-over", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK && res.StatusCode != http.StatusConflict {
		t.Fatalf("start meeting: status %d body %s", res.StatusCode, raw)
	}

	priya := h.browser()
	priyaAcct := priya.signup("Priya Raman", uniqueEmail("priya"), false)
	res, raw := priya.do(http.MethodPost, "/api/webinars/"+wb.ID+"/meeting/knock", types.MeetingKnockRequest{})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("knock: status %d body %s", res.StatusCode, raw)
	}
	var knocked types.MeetingKnockResponse
	h.decode(raw, &knocked)
	id := h.lobbyID(wb.ID, "Priya Raman")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/lobby/"+id+"/admit", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("admit: status %d body %s", res.StatusCode, raw)
	}
	identity := "att_" + knocked.JoinKey
	h.makeCoHost(wb.ID, identity)
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_" + host.ID, Name: "Meeting Host", Role: types.RoleHost},
		types.LiveParticipant{Identity: identity, Name: "Priya Raman", Role: types.RolePanelist, CoHost: true},
	)

	res, raw = h.do(http.MethodPost, transferPath(wb.ID), types.TransferHostRequest{Identity: identity})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("transfer meeting: status %d body %s", res.StatusCode, raw)
	}
	if got, _ := h.store.HostIDFor(t.Context(), wb.ID); got != priyaAcct.ID {
		t.Fatalf("meeting host = %q, want %q", got, priyaAcct.ID)
	}
	if roles := h.liveRoles(); roles[identity] != types.RoleHost || roles["user_"+host.ID] != types.RolePanelist {
		t.Errorf("live roles = %v", roles)
	}
	// The lobby is the new host's now, and no longer the old host's.
	if res, raw := priya.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/lobby", nil); res.StatusCode != http.StatusOK {
		t.Errorf("new meeting host reads the lobby: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/lobby", nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("old meeting host reads the lobby: status %d body %s, want 404", res.StatusCode, raw)
	}
	if res, raw := priya.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: knocked.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("new meeting host rejoin: status %d body %s", res.StatusCode, raw)
	}
	if spec := h.rooms.lastSpec; spec.Role != types.RoleHost || spec.CoHost {
		t.Errorf("new meeting host rejoin spec = %+v, want host", spec)
	}
}

// Two hand-overs racing from the same host: exactly one wins.
func TestConcurrentTransfersOnlyOneWins(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Host Race", uniqueEmail("host"), true)
	a := h.signup("Co A", uniqueEmail("a"), false)
	b := h.signup("Co B", uniqueEmail("b"), false)
	h.login(host.Email)
	wb := h.newWebinar("Race", nil)
	h.addPanelist(wb.ID, a.Email)
	h.addPanelist(wb.ID, b.Email)
	h.makeCoHost(wb.ID, "user_"+a.ID)
	h.makeCoHost(wb.ID, "user_"+b.ID)
	h.startSession(wb.ID)
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_" + host.ID, Name: "Host", Role: types.RoleHost},
		types.LiveParticipant{Identity: "user_" + a.ID, Name: "Co A", Role: types.RolePanelist, CoHost: true},
		types.LiveParticipant{Identity: "user_" + b.ID, Name: "Co B", Role: types.RolePanelist, CoHost: true},
	)

	// Over HTTP, from the host's one session.
	targets := []string{"user_" + a.ID, "user_" + b.ID, "user_" + a.ID, "user_" + b.ID}
	codes := make([]int, len(targets))
	var wg sync.WaitGroup
	for i, id := range targets {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			body, _ := json.Marshal(types.TransferHostRequest{Identity: id})
			req, err := http.NewRequest(http.MethodPost, h.srv.URL+transferPath(wb.ID), bytes.NewReader(body))
			if err != nil {
				return
			}
			req.Header.Set("Content-Type", "application/json")
			res, err := h.client.Do(req)
			if err != nil {
				return
			}
			res.Body.Close()
			codes[i] = res.StatusCode
		}(i, id)
	}
	wg.Wait()
	won := 0
	for _, c := range codes {
		if c == http.StatusOK {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("concurrent transfers: codes %v, want exactly one 200", codes)
	}
	newHost, _ := h.store.HostIDFor(t.Context(), wb.ID)
	if newHost != a.ID && newHost != b.ID {
		t.Fatalf("host after the race = %q", newHost)
	}

	// At the store, many at once: one nil, every other ErrConflict.
	wb2 := h.newWebinarAs(t, host, a, b)
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			to := a
			if i%2 == 1 {
				to = b
			}
			errs[i] = h.store.TransferHost(t.Context(), wb2, host.ID, to.ID, "user_"+to.ID)
		}(i)
	}
	wg.Wait()
	ok, conflict := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, store.ErrConflict):
			conflict++
		default:
			t.Errorf("store transfer: unexpected error %v", err)
		}
	}
	if ok != 1 || conflict != len(errs)-1 {
		t.Fatalf("store transfers: %d won, %d conflicts, want 1 and %d", ok, conflict, len(errs)-1)
	}
}

// newWebinarAs is a fresh webinar of host's with a and b on its panel as co-hosts.
func (h *harness) newWebinarAs(t *testing.T, host types.Account, a, b types.Account) string {
	t.Helper()
	h.login(host.Email)
	wb := h.newWebinar("Store race", nil)
	h.addPanelist(wb.ID, a.Email)
	h.addPanelist(wb.ID, b.Email)
	h.makeCoHost(wb.ID, "user_"+a.ID)
	h.makeCoHost(wb.ID, "user_"+b.ID)
	return wb.ID
}
