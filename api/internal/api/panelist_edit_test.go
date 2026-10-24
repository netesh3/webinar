package api_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Editing a webinar and its panel (PR #705, items 16 and 17).
 *
 * An edit that does not send the panel keeps it: saving a new title used to take every
 * panelist off the stage, because the form's panelist box started empty and the save
 * replaced the panel with it. An empty list is still the way to remove them all. An address
 * with no account is refused by name, where it used to be dropped without a word. */
func TestEditingAWebinarKeepsItsPanel(t *testing.T) {
	h := newHarness(t)
	pam := h.signup("Pam Panel", "pam.edit@test.dev", false)
	pia := h.signup("Pia Panel", "pia.edit@test.dev", false)
	host := h.signup("Edit Host", "edit-host@test.dev", true)
	h.login(host.Email)

	wb := h.newWebinar("Panel Edit", func(in *types.WebinarInput) {
		in.PanelistEmails = ptr([]string{pam.Email, pia.Email})
	})
	path := "/api/host/webinars/" + wb.ID + "/"

	update := func(topic string, panel *[]string) (*http.Response, []byte) {
		t.Helper()
		return h.do(http.MethodPatch, path, types.WebinarInput{
			Topic: topic, StartsAt: wb.StartsAt, Duration: 60, TimeZone: "UTC",
			Kind: types.KindLive, Status: types.StatusScheduled, RegistrationRequired: true,
			Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
			PanelistEmails: panel,
		})
	}
	panel := func() []string {
		t.Helper()
		res, raw := h.do(http.MethodGet, path, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("host webinar: %d %s", res.StatusCode, raw)
		}
		var got types.Webinar
		h.decode(raw, &got)
		ids := []string{}
		for _, p := range got.Panelists {
			ids = append(ids, p.ID)
		}
		if len(got.PanelistEmails) != len(got.Panelists) {
			t.Errorf("host view: %d panelist addresses for %d panelists", len(got.PanelistEmails), len(got.Panelists))
		}
		return ids
	}

	// The host's view carries the panel's addresses, for the edit form to save back.
	res, raw := h.do(http.MethodGet, path, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host webinar: %d %s", res.StatusCode, raw)
	}
	var hostView types.Webinar
	h.decode(raw, &hostView)
	if !slices.Equal(hostView.PanelistEmails, []string{pam.Email, pia.Email}) {
		t.Errorf("host view panelistEmails = %v", hostView.PanelistEmails)
	}
	// The public read never does.
	h.logout()
	res, raw = h.do(http.MethodGet, "/api/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public webinar: %d %s", res.StatusCode, raw)
	}
	if strings.Contains(string(raw), pam.Email) || strings.Contains(string(raw), "panelistEmails") {
		t.Errorf("the public webinar carries panelist addresses: %s", raw)
	}
	h.login(host.Email)

	// A title edit that leaves the panel out keeps both panelists.
	if res, raw := update("Panel Edit, renamed", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("title edit: %d %s", res.StatusCode, raw)
	}
	if got := panel(); !slices.Equal(got, []string{pam.ID, pia.ID}) {
		t.Fatalf("after an edit that did not send the panel, panelists = %v, want both", got)
	}

	// The panel sent back as it is changes nothing.
	if res, raw := update("Panel Edit", ptr([]string{pam.Email, pia.Email})); res.StatusCode != http.StatusOK {
		t.Fatalf("same panel: %d %s", res.StatusCode, raw)
	}
	if got := panel(); !slices.Equal(got, []string{pam.ID, pia.ID}) {
		t.Fatalf("after sending the same panel, panelists = %v", got)
	}

	// An address with no account is refused by name, and nothing is saved.
	res, raw = update("Panel Edit", ptr([]string{pam.Email, "nobody-yet@test.dev", "Also.Nobody@test.dev"}))
	h.wantError(res, raw, http.StatusUnprocessableEntity, "validation_failed")
	if !strings.Contains(string(raw), "nobody-yet@test.dev") || !strings.Contains(string(raw), "also.nobody@test.dev") ||
		strings.Contains(string(raw), pam.Email) {
		t.Errorf("the refusal does not name exactly the addresses without an account: %s", raw)
	}
	if got := panel(); !slices.Equal(got, []string{pam.ID, pia.ID}) {
		t.Fatalf("a refused save changed the panel: %v", got)
	}

	// Taking one off works, and an explicit empty list removes everybody.
	if res, raw := update("Panel Edit", ptr([]string{pia.Email})); res.StatusCode != http.StatusOK {
		t.Fatalf("drop pam: %d %s", res.StatusCode, raw)
	}
	if got := panel(); !slices.Equal(got, []string{pia.ID}) {
		t.Fatalf("after dropping pam, panelists = %v", got)
	}
	if res, raw := update("Panel Edit", ptr([]string{})); res.StatusCode != http.StatusOK {
		t.Fatalf("clear panel: %d %s", res.StatusCode, raw)
	}
	if got := panel(); len(got) != 0 {
		t.Fatalf("after clearing, panelists = %v", got)
	}
}

// Creating a webinar with a panelist address nobody has signed up with is refused by name.
func TestCreatingWithAnUnknownPanelistIsRefused(t *testing.T) {
	h := newHarness(t)
	pam := h.signup("Pam Panel", "pam.create@test.dev", false)
	host := h.signup("Create Host", "create-host@test.dev", true)
	h.login(host.Email)

	in := types.WebinarInput{
		Topic: "Unknown panelist", StartsAt: "2099-01-01T10:00:00Z", Duration: 60, TimeZone: "UTC",
		Kind: types.KindLive, Status: types.StatusDraft, RegistrationRequired: true,
		Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
		PanelistEmails: ptr([]string{pam.Email, "ghost@test.dev"}),
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
	h.wantError(res, raw, http.StatusUnprocessableEntity, "validation_failed")
	if !strings.Contains(string(raw), "ghost@test.dev") || !strings.Contains(string(raw), "panelistEmails") {
		t.Errorf("the refusal does not name the address on the panelist field: %s", raw)
	}
	if strings.Contains(string(raw), "they can't be panelists") {
		t.Errorf("one address read as several: %s", raw)
	}
}

/* Taking a co-host off the panel from the edit form ends their co-host standing too, as the
 * bin in Setup does. It used to leave the grant behind, so somebody no longer on the panel
 * could keep running the webinar's host routes. */
func TestDroppingACoHostFromTheFormEndsTheirCoHost(t *testing.T) {
	h := newHarness(t)
	guest := h.signup("Guest Cora", "guest-cora@test.dev", false)
	host := h.signup("Owner Omar", "owner-omar@test.dev", true)
	h.login(host.Email)
	wb := h.newWebinar("Co-host dropped", func(in *types.WebinarInput) {
		in.PanelistEmails = ptr([]string{guest.Email})
	})
	path := "/api/host/webinars/" + wb.ID + "/"
	if res, raw := h.do(http.MethodPatch, path+"panelists/"+guest.ID+"/co-host", types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host: %d %s", res.StatusCode, raw)
	}
	h.login(guest.Email)
	if res, raw := h.do(http.MethodGet, path+"participants", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("co-host reads participants: %d %s", res.StatusCode, raw)
	}

	h.login(host.Email)
	res, raw := h.do(http.MethodPatch, path, types.WebinarInput{
		Topic: wb.Topic, StartsAt: wb.StartsAt, Duration: 60, TimeZone: "UTC",
		Kind: types.KindLive, Status: types.StatusScheduled, RegistrationRequired: true,
		Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
		PanelistEmails: ptr([]string{}),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("clear panel: %d %s", res.StatusCode, raw)
	}

	h.login(guest.Email)
	if res, _ := h.do(http.MethodGet, path+"participants", nil); res.StatusCode == http.StatusOK {
		t.Errorf("somebody taken off the panel still reads the host routes as co-host")
	}
}

/* A series edit of this and following sessions that leaves the panel out gives every session
 * it writes, including ones it adds, this session's panel rather than none. */
func TestSeriesEditWithoutThePanelKeepsIt(t *testing.T) {
	h := newHarness(t)
	pam := h.signup("Pam Panel", "pam.series@test.dev", false)
	host := h.signup("Series Panel Host", "series-panel-host@test.dev", true)
	h.login(host.Email)
	body := seriesBody("Panel series", seriesStart(t), 3)
	body.PanelistEmails = ptr([]string{pam.Email})
	res, raw := h.do(http.MethodPost, "/api/host/webinars", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var first types.Webinar
	h.decode(raw, &first)

	if first.SeriesID == "" {
		t.Fatalf("create made no series: %s", raw)
	}
	grow := inputFromWebinar(first, 4)
	grow.SeriesScope = "following"
	grow.PanelistEmails = nil
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+first.ID+"/", grow); res.StatusCode != http.StatusOK {
		t.Fatalf("grow: %d %s", res.StatusCode, raw)
	}
	rows := h.seriesRows(first.SeriesID)
	if len(rows) != 4 {
		t.Fatalf("after grow: %d sessions, want 4", len(rows))
	}
	for _, row := range rows {
		wb := h.mustWebinar(row.slug)
		if len(wb.Panelists) != 1 || wb.Panelists[0].ID != pam.ID {
			t.Errorf("session %s panel = %+v, want pam", row.slug, wb.Panelists)
		}
	}
}
