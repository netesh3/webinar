package api_test

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* A template written here is named from the title the host typed. A name the host
 * already has, here or in WhatsApp Manager, comes back as 409 name_taken with the
 * next free one. Which templates take translations is recorded, not read from a
 * prefix: new names and the legacy wl_own_ ones (backfilled by 0117) both do. */
func TestTemplateNamesFromTitles(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	ctx := context.Background()
	db := h.store.Pool()
	var hostID string
	if err := db.QueryRow(ctx, `SELECT id::text FROM users WHERE email = 'neeraj@acme.dev'`).Scan(&hostID); err != nil {
		t.Fatal(err)
	}

	// Already on the account: one made in WhatsApp Manager, and one written here before
	// templates had names.
	g.addTemplate(map[string]any{"name": "promo_from_manager", "language": "en", "status": "APPROVED",
		"category": "MARKETING", "components": []any{map[string]any{"type": "BODY", "text": "Hi"}}})
	g.addTemplate(map[string]any{"name": "wl_own_abcd1234", "language": "en", "status": "APPROVED",
		"category": "UTILITY", "components": []any{map[string]any{"type": "BODY", "text": "Hi"}}})

	submit := func(req types.CRMWordingRequest) (int, types.APIError, string) {
		t.Helper()
		if req.Body == "" {
			req.Body = "Hi {{1}}, see you soon."
		}
		if req.Category == "" {
			req.Category = "UTILITY"
		}
		res, raw := h.do(http.MethodPost, "/api/host/crm/templates", req)
		var out struct{ Name string }
		var e types.APIError
		if res.StatusCode == http.StatusOK {
			h.decode(raw, &out)
		} else {
			h.decode(raw, &e)
		}
		return res.StatusCode, e, out.Name
	}

	code, e, name := submit(types.CRMWordingRequest{Title: "  Webinar Reminder – 1 hour 🎉 "})
	if code != http.StatusOK || name != "webinar_reminder_1_hour" {
		t.Fatalf("new: %d %+v %q", code, e, name)
	}
	if got := lastCreated(t, g)["name"]; got != "webinar_reminder_1_hour" {
		t.Errorf("Meta was sent %v", got)
	}
	var title string
	if err := db.QueryRow(ctx, `SELECT title FROM crm_own_templates WHERE host_id = $1 AND name = $2`,
		hostID, name).Scan(&title); err != nil || title != "Webinar Reminder – 1 hour 🎉" {
		t.Errorf("own record: %q %v", title, err)
	}

	// Nothing usable in the title.
	if code, e, _ := submit(types.CRMWordingRequest{Title: "🎉🎉"}); code != http.StatusUnprocessableEntity || e.Error != "name_required" {
		t.Errorf("emoji title: %d %+v", code, e)
	}

	// Taken, in any language: by one written here, or one from WhatsApp Manager.
	n := len(g.createdTemplates())
	for _, c := range []struct{ title, lang, want string }{
		{"webinar reminder 1 hour", "hi", "webinar_reminder_1_hour_2"},
		{"Promo from manager", "en", "promo_from_manager_2"},
	} {
		code, e, _ := submit(types.CRMWordingRequest{Title: c.title, Language: c.lang})
		if code != http.StatusConflict || e.Error != "name_taken" || e.Fields["suggestion"] != c.want {
			t.Errorf("%q: %d %+v, want suggestion %s", c.title, code, e, c.want)
		}
	}
	if len(g.createdTemplates()) != n {
		t.Errorf("a taken name reached Meta")
	}
	// The suggestion skips the ones taken too.
	if code, e, _ := submit(types.CRMWordingRequest{Title: "webinar_reminder_1_hour_2"}); code != http.StatusOK {
		t.Fatalf("suggestion: %d %+v", code, e)
	}
	if _, e, _ := submit(types.CRMWordingRequest{Title: "Webinar reminder 1 hour"}); e.Fields["suggestion"] != "webinar_reminder_1_hour_3" {
		t.Errorf("next suggestion = %+v", e)
	}

	// Meta's own refusal, for a name this list did not know yet, is the same answer.
	g.addTemplate(map[string]any{"name": "made_just_now", "language": "en", "status": "PENDING",
		"category": "UTILITY", "components": []any{map[string]any{"type": "BODY", "text": "Hi"}}})
	if code, e, _ := submit(types.CRMWordingRequest{Title: "Made just now"}); code != http.StatusConflict ||
		e.Error != "name_taken" || e.Fields["suggestion"] != "made_just_now_2" {
		t.Errorf("Meta's refusal: %d %+v", code, e)
	}

	// Translations: of a new name, yes; of one from WhatsApp Manager, no.
	if code, e, name := submit(types.CRMWordingRequest{Name: "webinar_reminder_1_hour", Language: "hi",
		Body: "नमस्ते {{1}}"}); code != http.StatusOK || name != "webinar_reminder_1_hour" {
		t.Errorf("translation of a new name: %d %+v %q", code, e, name)
	}
	if code, e, _ := submit(types.CRMWordingRequest{Name: "promo_from_manager", Language: "hi"}); code != http.StatusUnprocessableEntity || e.Error != "invalid_name" {
		t.Errorf("translation of a Manager template: %d %+v", code, e)
	}
	// The same language again is Meta's refusal, not a taken name.
	if code, e, _ := submit(types.CRMWordingRequest{Name: "webinar_reminder_1_hour", Language: "hi"}); code != http.StatusConflict || e.Error != "translation_exists" {
		t.Errorf("translation twice: %d %+v", code, e)
	}

	// A legacy wl_own_ template takes translations once 0117's backfill has run (this
	// one arrived by sync after the migration did, so it is run again here).
	if code, _, _ := submit(types.CRMWordingRequest{Name: "wl_own_abcd1234", Language: "ta"}); code != http.StatusUnprocessableEntity {
		t.Errorf("legacy before backfill: %d", code)
	}
	if _, err := db.Exec(ctx, ownTemplatesBackfill(t)); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if code, e, name := submit(types.CRMWordingRequest{Name: "wl_own_abcd1234", Language: "ta"}); code != http.StatusOK || name != "wl_own_abcd1234" {
		t.Errorf("legacy translation: %d %+v %q", code, e, name)
	}
	var own []string
	rows, err := db.Query(ctx, `SELECT name FROM crm_own_templates WHERE host_id = $1 ORDER BY name`, hostID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		own = append(own, s)
	}
	rows.Close()
	if got := strings.Join(own, ","); got != "webinar_reminder_1_hour,webinar_reminder_1_hour_2,wl_own_abcd1234" {
		t.Errorf("own templates = %s", got)
	}

	// The list says which are the host's own, with the title they typed.
	res, raw := h.do(http.MethodGet, "/api/host/crm/templates", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: %d %s", res.StatusCode, raw)
	}
	var list types.CRMTemplatesResponse
	h.decode(raw, &list)
	seen := map[string]types.CRMTemplate{}
	for _, tpl := range list.Templates {
		seen[tpl.Name+"/"+tpl.Language] = tpl
	}
	if tpl := seen["webinar_reminder_1_hour/hi"]; !tpl.Own || tpl.Title != "Webinar Reminder – 1 hour 🎉" {
		t.Errorf("own translation listed as %+v", tpl)
	}
	if tpl := seen["wl_own_abcd1234/en"]; !tpl.Own || tpl.Title != "" {
		t.Errorf("legacy listed as own=%v title=%q", tpl.Own, tpl.Title)
	}
	if tpl := seen["promo_from_manager/en"]; tpl.Own {
		t.Errorf("Manager template listed as own")
	}
}

// ownTemplatesBackfill is 0117's INSERT, so the test runs the migration's own SQL.
func ownTemplatesBackfill(t *testing.T) string {
	t.Helper()
	body, err := os.ReadFile("../store/migrations/0117_own_templates.sql")
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	i := strings.Index(s, "INSERT INTO crm_own_templates")
	if i < 0 {
		t.Fatal("0117 has no backfill")
	}
	return s[i:]
}
