package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// Handing the session to a panelist must move ownership and LiveKit roles so the
// new host can end the webinar and everyone else sees the right labels.
func TestTransferHostAndEnd(t *testing.T) {
	h := newHarness(t)

	owner := h.signup("Owner", "transfer-owner@test.dev", true)
	panelist := h.signup("Panelist", "transfer-panelist@test.dev", false)

	wb := h.newWebinar("Transfer host", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "transfer-panelist@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}

	hostIdentity := "user_" + owner.ID
	panelIdentity := "user_" + panelist.ID
	h.rooms.setRoster(
		types.LiveParticipant{Identity: hostIdentity, Name: "Owner", Role: types.RoleHost, CanPublish: true, CanSpeak: true},
		types.LiveParticipant{Identity: panelIdentity, Name: "Panelist", Role: types.RolePanelist, CanPublish: true, CanSpeak: true},
		types.LiveParticipant{Identity: "att_guest", Name: "Guest", Role: types.RoleAttendee},
	)

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/transfer-host",
		types.TransferHostRequest{Identity: panelIdentity})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("transfer-host: status %d body %s", res.StatusCode, raw)
	}
	var transferred types.Webinar
	h.decode(raw, &transferred)
	if transferred.Host.ID != panelist.ID {
		t.Fatalf("host after transfer = %q, want %q", transferred.Host.ID, panelist.ID)
	}

	h.rooms.mu.Lock()
	roles := map[string]types.Role{}
	for _, spec := range h.rooms.roleChanges {
		roles[spec.Identity] = spec.Role
	}
	h.rooms.mu.Unlock()
	if roles[panelIdentity] != types.RoleHost {
		t.Errorf("new host role = %q, want host", roles[panelIdentity])
	}
	if roles[hostIdentity] != types.RolePanelist {
		t.Errorf("previous host role = %q, want panelist", roles[hostIdentity])
	}

	// The previous owner can no longer end the session.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("previous host ending after transfer: status %d body %s", res.StatusCode, raw)
	}

	// The new host can — including when they were invited without can_host.
	h.login("transfer-panelist@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("new host ending: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	deleted := len(h.rooms.deleted) > 0
	h.rooms.mu.Unlock()
	if !deleted {
		t.Error("end did not delete the SFU room")
	}
}

func TestTransferHostRejectsAudienceAndMissingPanelist(t *testing.T) {
	h := newHarness(t)

	owner := h.signup("Owner", "transfer-reject-owner@test.dev", true)
	_ = h.signup("Panelist", "transfer-reject-panelist@test.dev", false)

	wb := h.newWebinar("Transfer rejects", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "transfer-reject-panelist@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}

	hostIdentity := "user_" + owner.ID
	h.rooms.setRoster(
		types.LiveParticipant{Identity: hostIdentity, Name: "Owner", Role: types.RoleHost, CanPublish: true},
		types.LiveParticipant{Identity: "att_only", Name: "Audience", Role: types.RoleAttendee, CanPublish: false},
	)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/transfer-host",
		types.TransferHostRequest{Identity: "att_only"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("transfer to audience: status %d body %s", res.StatusCode, raw)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/transfer-host",
		types.TransferHostRequest{Identity: "user_missing"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("transfer to missing participant: status %d body %s", res.StatusCode, raw)
	}
}
