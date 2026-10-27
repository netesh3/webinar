package api_test

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/types"
)

/* The captions language per webinar (types.CaptionLanguages): defaulted to en-IN, validated,
 * carried to the caption agent in its dispatch metadata, and changed live through the controls
 * PATCH, which the agent hears as room metadata. Malayalam is stored but not Live: the worker
 * starts no Deepgram stream for it (deploy/captions). */

func (h *harness) dispatchLanguage(slug string) string {
	h.t.Helper()
	h.rooms.mu.Lock()
	raw := h.rooms.dispatchMeta["webinar_"+slug]
	h.rooms.mu.Unlock()
	var md map[string]string
	if err := json.Unmarshal([]byte(raw), &md); err != nil {
		h.t.Fatalf("dispatch meta %q: %v", raw, err)
	}
	return md["language"]
}

func TestCaptionsLanguageDefaultsAndIsValidated(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Lang Host", "caplang-default@test.dev", true)

	wb := h.newWebinar("No language chosen", nil)
	if got := h.hostWebinar(wb.ID); got.Options.CaptionsLanguage != "en-IN" || got.Controls.CaptionsLanguage != "en-IN" {
		t.Fatalf("new webinar language = %q / %q, want en-IN", got.Options.CaptionsLanguage, got.Controls.CaptionsLanguage)
	}

	ta := h.newWebinar("Tamil session", func(in *types.WebinarInput) { in.Options.CaptionsLanguage = "ta" })
	if got := h.hostWebinar(ta.ID).Controls.CaptionsLanguage; got != "ta" {
		t.Fatalf("tamil webinar controls language = %q", got)
	}

	// An edit that does not name one (an older client) keeps it; a bad code is refused.
	in := captionsInput(h.hostWebinar(ta.ID))
	in.Options.CaptionsLanguage = ""
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+ta.ID, in); res.StatusCode != http.StatusOK {
		t.Fatalf("edit without language: %d %s", res.StatusCode, raw)
	}
	if got := h.hostWebinar(ta.ID).Options.CaptionsLanguage; got != "ta" {
		t.Fatalf("after an edit without a language = %q, want ta kept", got)
	}
	in.Options.CaptionsLanguage = "ar"
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+ta.ID, in); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("edit with ar: %d %s, want 422", res.StatusCode, raw)
	}
	bad := types.WebinarInput{Topic: "Bad", StartsAt: in.StartsAt, Duration: 30, TimeZone: "Asia/Kolkata",
		Options: types.WebinarOptions{CaptionsLanguage: "klingon"}}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars", bad); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("create with klingon: %d %s, want 422", res.StatusCode, raw)
	}

	// The web gets the list and the default.
	res, raw := h.do(http.MethodGet, "/api/config", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("config: %d", res.StatusCode)
	}
	var cfg types.AppConfig
	h.decode(raw, &cfg)
	if cfg.DefaultCaptionsLanguage != "en-IN" || len(cfg.CaptionLanguages) != len(types.CaptionLanguages) {
		t.Fatalf("config captions languages = %q %d", cfg.DefaultCaptionsLanguage, len(cfg.CaptionLanguages))
	}
}

func TestCaptionsLanguageReachesTheAgentAndChangesLive(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Lang Live Host", "caplang-live@test.dev", true)
	wb := h.liveWebinar("Hindi session", func(in *types.WebinarInput) {
		in.Options.Captions = true
		in.Options.CaptionsLanguage = "hi"
	})
	room := "webinar_" + wb.ID
	if _, ok := h.rooms.dispatched(room); !ok {
		t.Fatal("caption agent not dispatched")
	}
	if got := h.dispatchLanguage(wb.ID); got != "hi" {
		t.Fatalf("dispatch language = %q, want hi", got)
	}
	if got := h.rooms.roomMeta(t, room).Controls.CaptionsLanguage; got != "hi" {
		t.Fatalf("room metadata language = %q, want hi", got)
	}

	// The host changes it in the room: room metadata carries it, and the edit form sees it.
	ml := "ml"
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", types.ControlsPatch{CaptionsLanguage: &ml}); res.StatusCode != http.StatusOK {
		t.Fatalf("patch ml: %d %s", res.StatusCode, raw)
	}
	if got := h.rooms.roomMeta(t, room).Controls.CaptionsLanguage; got != "ml" {
		t.Fatalf("room metadata after the change = %q, want ml", got)
	}
	got := h.hostWebinar(wb.ID)
	if got.Options.CaptionsLanguage != "ml" || got.Controls.CaptionsLanguage != "ml" {
		t.Fatalf("after the change = %q / %q, want ml", got.Options.CaptionsLanguage, got.Controls.CaptionsLanguage)
	}
	// Other controls were left alone by the language patch.
	if !got.Controls.CaptionsEnabled {
		t.Fatal("captions switched off by a language change")
	}
	bad := "ar"
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", types.ControlsPatch{CaptionsLanguage: &bad}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("patch ar: %d %s, want 422", res.StatusCode, raw)
	}
}

func TestTranscriptStoresItsLanguage(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Lang Transcript Host", "caplang-transcript@test.dev", true)
	wb := h.liveWebinar("Telugu session", func(in *types.WebinarInput) { in.Options.CaptionsLanguage = "te" })
	room := "webinar_" + wb.ID
	post := func(body map[string]any) {
		t.Helper()
		if res, raw := h.agentPost("/api/internal/transcripts", testCaptionsSecret, body); res.StatusCode != http.StatusCreated {
			t.Fatalf("transcript %v: %d %s", body, res.StatusCode, raw)
		}
	}
	// The worker says what it streamed in; an older worker says nothing and gets the webinar's.
	post(map[string]any{"room": room, "model": "deepgram/nova-3", "language": "hi", "segments": []any{}})
	post(map[string]any{"room": room, "model": "deepgram/nova-3", "segments": []any{}})
	post(map[string]any{"room": room, "model": "deepgram/nova-3", "language": "zz", "segments": []any{}})

	pool, err := pgxpool.New(t.Context(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	rows, err := pool.Query(t.Context(), `SELECT t.language FROM session_transcripts t JOIN webinars w ON w.id = t.webinar_id
		WHERE w.slug = $1 ORDER BY t.id`, wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			t.Fatal(err)
		}
		got = append(got, l)
	}
	if len(got) != 3 || got[0] != "hi" || got[1] != "te" || got[2] != "te" {
		t.Fatalf("transcript languages = %v, want [hi te te]", got)
	}
}
