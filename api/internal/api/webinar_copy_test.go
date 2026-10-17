package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Copying a webinar makes a draft written the same way: the form, the cover (as
 * its own file), the polls and survey as drafts, the panelists without an invite,
 * and the message setup. What the session produced stays behind. */
func TestCopyWebinarMakesADraft(t *testing.T) {
	h := newHarness(t)
	h.signup("Copy Panelist", "copy-panelist@test.dev", false)
	host := h.signup("Copy Host", "copy-host@test.dev", true)
	h.login("copy-host@test.dev")
	ctx := t.Context()
	db := h.store.Pool()

	src := h.newWebinar("Pricing for creators", func(in *types.WebinarInput) {
		in.Descript = "How to price a course."
		in.AttendeeLimit = 150
		in.CustomQuestions = []types.CustomQuestion{{Label: "Your niche?", Type: "short", Required: true}}
		in.PanelistEmails = []string{"copy-panelist@test.dev"}
		in.Agenda = []types.AgendaItem{{At: "10:00", Title: "Intro"}}
	})
	if res, raw := h.doRaw(http.MethodPost, "/api/host/webinars/"+src.ID+"/image", "application/octet-stream", onePixelPNG, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("cover: %d %s", res.StatusCode, raw)
	}
	reg := h.registerAs(src.ID, "copy-attendee@test.dev")
	if _, err := db.Exec(ctx, `UPDATE webinars SET passcode = '1234' WHERE slug = $1`, src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO polls (webinar_id, question, kind, options, state)
		SELECT id, 'Best price?', 'poll', '["Low","High"]', 'closed' FROM webinars WHERE slug = $1`, src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO surveys (webinar_id, mode, title, ask_rating, status, send_at)
		SELECT id, 'builtin', 'How was it?', true, 'closed', 'on_end' FROM webinars WHERE slug = $1`, src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_questions (survey_id, position, kind, prompt, required)
		SELECT s.id, 0, 'text', 'Anything else?', false
		  FROM surveys s JOIN webinars w ON w.id = s.webinar_id WHERE w.slug = $1`, src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO webinar_message_settings (webinar_id, kind, channels, template, enabled)
		SELECT id, 'reminder', '{whatsapp}', 'webinar_today', true FROM webinars WHERE slug = $1`, src.ID); err != nil {
		t.Fatal(err)
	}

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+src.ID+"/copy", nil)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("copy: %d %s", res.StatusCode, raw)
	}
	var cp types.Webinar
	h.decode(raw, &cp)

	if cp.ID == src.ID || cp.Status != types.StatusDraft || cp.Topic != "Copy of Pricing for creators" {
		t.Fatalf("copy = slug %q status %q topic %q", cp.ID, cp.Status, cp.Topic)
	}
	if cp.Descript != src.Descript || cp.Passcode != "1234" || cp.AttendeeLimit != 150 ||
		len(cp.CustomQuestions) != 1 || cp.CustomQuestions[0].Label != "Your niche?" ||
		len(cp.Agenda) != 1 || cp.Host.ID != host.ID || cp.RegistrantCount != 0 {
		t.Fatalf("copied fields = %+v", cp)
	}
	if len(cp.Panelists) != 1 {
		t.Fatalf("panelists = %+v, want the one panelist", cp.Panelists)
	}

	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := db.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM notifications n JOIN webinars w ON w.id = n.webinar_id
	                WHERE w.slug = $1 AND n.kind = 'panelist_invited'`, cp.ID); n != 0 {
		t.Errorf("panelist invites queued for a draft: %d", n)
	}
	if n := count(`SELECT count(*) FROM registrations r JOIN webinars w ON w.id = r.webinar_id WHERE w.slug = $1`, cp.ID); n != 0 {
		t.Errorf("registrations copied: %d (source had %s)", n, reg.ID)
	}
	if n := count(`SELECT count(*) FROM polls p JOIN webinars w ON w.id = p.webinar_id
	                WHERE w.slug = $1 AND p.state = 'draft' AND p.question = 'Best price?'`, cp.ID); n != 1 {
		t.Errorf("draft polls on the copy = %d, want 1", n)
	}
	if n := count(`SELECT count(*) FROM surveys s JOIN webinars w ON w.id = s.webinar_id
	                JOIN survey_questions q ON q.survey_id = s.id
	                WHERE w.slug = $1 AND s.status = 'draft'`, cp.ID); n != 1 {
		t.Errorf("draft survey questions on the copy = %d, want 1", n)
	}
	if n := count(`SELECT count(*) FROM webinar_message_settings m JOIN webinars w ON w.id = m.webinar_id
	                WHERE w.slug = $1 AND m.template = 'webinar_today'`, cp.ID); n != 1 {
		t.Errorf("message setup on the copy = %d, want 1", n)
	}

	var srcKey, cpKey string
	if err := db.QueryRow(ctx, `SELECT image_storage_key FROM webinars WHERE slug = $1`, src.ID).Scan(&srcKey); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT image_storage_key FROM webinars WHERE slug = $1`, cp.ID).Scan(&cpKey); err != nil {
		t.Fatal(err)
	}
	if srcKey == "" || cpKey == "" || srcKey == cpKey {
		t.Fatalf("cover keys: source %q copy %q, want two different files", srcKey, cpKey)
	}
	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+src.ID+"/image", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("drop source cover: %d %s", res.StatusCode, raw)
	}
	if err := db.QueryRow(ctx, `SELECT image_storage_key FROM webinars WHERE slug = $1`, cp.ID).Scan(&cpKey); err != nil || cpKey == "" {
		t.Fatalf("copy lost its cover when the source's was removed: %q %v", cpKey, err)
	}
}

// Only the host may copy, and the copy is held to the host's plan today.
func TestCopyWebinarIsTheHostsAndRespectsThePlan(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Plan Copier", "plan-copier@test.dev", true)
	if _, err := h.store.SetUserPlan(t.Context(), host.ID, types.PlanEnterprise); err != nil {
		t.Fatal(err)
	}
	src := h.newWebinar("Big room", func(in *types.WebinarInput) { in.AttendeeLimit = 500 })
	if src.AttendeeLimit != 500 {
		t.Fatalf("source limit = %d", src.AttendeeLimit)
	}
	if _, err := h.store.SetUserPlan(t.Context(), host.ID, ""); err != nil {
		t.Fatal(err)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+src.ID+"/copy", nil)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("copy: %d %s", res.StatusCode, raw)
	}
	var cp types.Webinar
	h.decode(raw, &cp)
	if cp.AttendeeLimit != types.PlanLaunchAttendees {
		t.Errorf("copy limit = %d, want the launch cap %d", cp.AttendeeLimit, types.PlanLaunchAttendees)
	}

	h.signup("Other Host", "other-copier@test.dev", true)
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+src.ID+"/copy", nil); res.StatusCode != http.StatusForbidden && res.StatusCode != http.StatusNotFound {
		t.Errorf("another host copied it: %d", res.StatusCode)
	}
}
