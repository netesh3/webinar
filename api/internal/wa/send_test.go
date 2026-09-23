package wa

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/* What is worth pinning about sending is the shape of the body Meta is strict
 * about — messaging_product, the language code, and body parameters in order —
 * plus the two things a caller cannot recover from if this package gets them
 * wrong: the returned message id, without which no delivery status can ever be
 * matched, and the reading of a template's components, which decides what the
 * product offers a host as sendable. */

func TestSendTemplateBody(t *testing.T) {
	var (
		gotPath string
		gotAuth string
		body    map[string]any
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		writeJSON(w, map[string]any{
			"messaging_product": "whatsapp",
			"messages":          []map[string]string{{"id": "wamid.ABC"}},
		})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	wamid, err := c.SendTemplate(context.Background(), "host-token", "phone-1", OutgoingTemplate{
		// Stored E.164; Meta wants the same number with no plus.
		To:         "+27 83 111 2222",
		Name:       "webinar_reminder",
		Language:   "en_US",
		BodyParams: []string{"Thandi", "14:00"},
	})
	if err != nil {
		t.Fatalf("SendTemplate: %v", err)
	}
	if wamid != "wamid.ABC" {
		t.Errorf("wamid = %q, want wamid.ABC: every later delivery status is keyed by it", wamid)
	}
	if gotPath != "/phone-1/messages" {
		t.Errorf("path = %q, want /phone-1/messages", gotPath)
	}
	if gotAuth != "Bearer host-token" {
		t.Errorf("Authorization = %q: the send must be charged to the host's own WABA", gotAuth)
	}
	if body["messaging_product"] != "whatsapp" || body["type"] != "template" {
		t.Errorf("body = %v, want messaging_product whatsapp and type template", body)
	}
	if body["to"] != "27831112222" {
		t.Errorf("to = %v, want digits only", body["to"])
	}

	tmpl, _ := body["template"].(map[string]any)
	lang, _ := tmpl["language"].(map[string]any)
	if tmpl["name"] != "webinar_reminder" || lang["code"] != "en_US" {
		t.Fatalf("template = %v, want the name and the exact language code", tmpl)
	}
	comps, _ := tmpl["components"].([]any)
	if len(comps) != 1 {
		t.Fatalf("components = %v, want one body component", comps)
	}
	comp, _ := comps[0].(map[string]any)
	params, _ := comp["parameters"].([]any)
	if comp["type"] != "body" || len(params) != 2 {
		t.Fatalf("component = %v, want a body component with two parameters", comp)
	}
	// Order is the whole contract: Meta fills {{1}} from the first one.
	first, _ := params[0].(map[string]any)
	second, _ := params[1].(map[string]any)
	if first["text"] != "Thandi" || second["text"] != "14:00" {
		t.Errorf("parameters = %v, want Thandi then 14:00 in that order", params)
	}
}

func TestSendTemplateRefusesIncompleteSends(t *testing.T) {
	// No server: none of these may reach Graph, and a test that would notice a
	// request is the only way to prove it.
	c := newTestClient("http://127.0.0.1:1")
	ctx := context.Background()

	if _, err := c.SendTemplate(ctx, "t", "p", OutgoingTemplate{Name: "x", Language: "en"}); !errors.Is(err, ErrNoRecipient) {
		t.Errorf("no recipient: err = %v, want ErrNoRecipient", err)
	}
	if _, err := c.SendTemplate(ctx, "t", "p", OutgoingTemplate{To: "+27831112222", Language: "en"}); !errors.Is(err, ErrNoTemplate) {
		t.Errorf("no template: err = %v, want ErrNoTemplate", err)
	}
	// A template with no language is not a template: the same name is approved
	// once per translation, and guessing sends somebody the wrong one.
	if _, err := c.SendTemplate(ctx, "t", "p", OutgoingTemplate{To: "+27831112222", Name: "x"}); err == nil {
		t.Error("no language: err = nil, want a refusal rather than a guessed language")
	}
	if _, err := c.SendText(ctx, "", "p", "+27831112222", "hi"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("no token: err = %v, want ErrNotConnected", err)
	}
	if _, err := c.SendText(ctx, "t", "p", "+27831112222", "   "); !errors.Is(err, ErrEmptyMessage) {
		t.Errorf("empty text: err = %v, want ErrEmptyMessage", err)
	}
}

func TestSendTextShape(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		writeJSON(w, map[string]any{"messages": []map[string]string{{"id": "wamid.TXT"}}})
	}))
	defer srv.Close()

	wamid, err := newTestClient(srv.URL).SendText(context.Background(), "host-token", "phone-1",
		"+27831112222", "  Thanks, see you at 2.  ")
	if err != nil {
		t.Fatalf("SendText: %v", err)
	}
	if wamid != "wamid.TXT" {
		t.Errorf("wamid = %q, want wamid.TXT", wamid)
	}
	text, _ := body["text"].(map[string]any)
	if body["type"] != "text" || text["body"] != "Thanks, see you at 2." {
		t.Errorf("body = %v, want type text and the trimmed message", body)
	}
	/* preview_url must stay false. Meta fetches the link to build a preview, which
	 * would turn a join link — a bearer credential — into a request from Meta's
	 * crawlers. */
	if text["preview_url"] != false {
		t.Errorf("preview_url = %v, want false: join links must not be fetched by Meta", text["preview_url"])
	}
}

func TestSendRejectsAnAcceptedSendWithNoMessageID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 200, and nothing to key a status by. Treating this as success would file a
		// message no delivery report could ever reach.
		writeJSON(w, map[string]any{"messaging_product": "whatsapp", "messages": []any{}})
	}))
	defer srv.Close()

	if _, err := newTestClient(srv.URL).SendText(context.Background(), "t", "p", "+27831112222", "hi"); err == nil {
		t.Error("err = nil, want a failure: a send with no message id cannot be tracked")
	}
}

func TestSendReportsMetaError(t *testing.T) {
	t.Run("a rejected token is named", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			writeJSON(w, map[string]any{"error": map[string]any{"code": 190, "message": "Error validating access token"}})
		}))
		defer srv.Close()
		if _, err := newTestClient(srv.URL).SendText(context.Background(), "t", "p", "+27831112222", "hi"); !errors.Is(err, ErrTokenRejected) {
			t.Errorf("err = %v, want ErrTokenRejected", err)
		}
	})
	t.Run("anything else keeps Meta's words", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			writeJSON(w, map[string]any{"error": map[string]any{
				"code": 131047, "message": "Message failed to send because more than 24 hours have passed",
				"fbtrace_id": "Axyz",
			}})
		}))
		defer srv.Close()
		_, err := newTestClient(srv.URL).SendText(context.Background(), "t", "p", "+27831112222", "hi")
		// The host can act on Meta's sentence and cannot act on "sending failed".
		if err == nil || !strings.Contains(err.Error(), "more than 24 hours") {
			t.Errorf("err = %v, want Meta's own message carried through", err)
		}
		if err == nil || !strings.Contains(err.Error(), "Axyz") {
			t.Errorf("err = %v, want the fbtrace id Meta support asks for", err)
		}
	})
}

func TestTemplatesReadsComponents(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/waba-1/message_templates" {
			t.Errorf("path = %q: templates belong to the WABA, not the phone number", r.URL.Path)
		}
		writeJSON(w, map[string]any{"data": []map[string]any{
			{
				"name": "webinar_reminder", "language": "en_US", "status": "APPROVED",
				"category": "UTILITY",
				"components": []map[string]any{
					{"type": "HEADER", "format": "TEXT", "text": "Starting soon"},
					{"type": "BODY", "text": "Hi {{1}}, {{2}} starts in an hour."},
					{"type": "FOOTER", "text": "Reply STOP to unsubscribe"},
				},
			},
			{
				"name": "promo_image", "language": "en", "status": "APPROVED", "category": "MARKETING",
				"components": []map[string]any{
					{"type": "HEADER", "format": "IMAGE"},
					{"type": "BODY", "text": "Our new course is live."},
				},
			},
			{
				"name": "pending_one", "language": "en", "status": "PENDING", "category": "MARKETING",
				"components": []map[string]any{{"type": "BODY", "text": "Hello."}},
			},
		}})
	}))
	defer srv.Close()

	got, err := newTestClient(srv.URL).Templates(context.Background(), "host-token", "waba-1")
	if err != nil {
		t.Fatalf("Templates: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d templates, want 3", len(got))
	}

	first := got[0]
	if first.Header != "Starting soon" || first.Footer != "Reply STOP to unsubscribe" {
		t.Errorf("header/footer = %q/%q, want the fixed text around the body", first.Header, first.Footer)
	}
	// The count is what a send has to match exactly; Meta rejects a mismatch.
	if first.Variables != 2 {
		t.Errorf("Variables = %d, want 2 for a body with {{1}} and {{2}}", first.Variables)
	}
	if first.Unsupported != "" {
		t.Errorf("Unsupported = %q, want sendable", first.Unsupported)
	}

	/* An image header needs a media upload before the send, which a text compose box
	 * cannot supply — so it is listed with a reason rather than silently offered and
	 * then rejected by Meta. */
	if !strings.Contains(got[1].Unsupported, "image") {
		t.Errorf("promo_image Unsupported = %q, want it to say the header is an image", got[1].Unsupported)
	}
	// Status is Meta's and is kept as-is: a host needs to see that the template
	// they submitted is still waiting rather than missing.
	if got[2].Status != "PENDING" {
		t.Errorf("status = %q, want PENDING kept verbatim", got[2].Status)
	}
}

func TestTemplatesFollowsPaging(t *testing.T) {
	var afters []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		after := r.URL.Query().Get("after")
		afters = append(afters, after)
		if after == "" {
			writeJSON(w, map[string]any{
				"data": []map[string]any{{"name": "one", "language": "en", "status": "APPROVED",
					"components": []map[string]any{{"type": "BODY", "text": "a"}}}},
				"paging": map[string]any{
					// Only its presence is read; the cursor is what is followed.
					"next":    "https://graph.facebook.com/v23.0/waba-1/message_templates?after=cursor-2",
					"cursors": map[string]string{"after": "cursor-2"},
				},
			})
			return
		}
		// Last page: Meta still sends a cursor, and only the absent `next` says stop.
		writeJSON(w, map[string]any{
			"data": []map[string]any{{"name": "two", "language": "en", "status": "APPROVED",
				"components": []map[string]any{{"type": "BODY", "text": "b"}}}},
			"paging": map[string]any{"cursors": map[string]string{"after": "cursor-3"}},
		})
	}))
	defer srv.Close()

	got, err := newTestClient(srv.URL).Templates(context.Background(), "host-token", "waba-1")
	if err != nil {
		t.Fatalf("Templates: %v", err)
	}
	// A truncated list is a template a host cannot find, and a cursor that is
	// always present is how a loop that trusts it never ends.
	if len(got) != 2 || got[0].Name != "one" || got[1].Name != "two" {
		t.Fatalf("got %v, want both pages", got)
	}
	if len(afters) != 2 || afters[0] != "" || afters[1] != "cursor-2" {
		t.Errorf("after params = %v, want the first page then cursor-2", afters)
	}
}

func TestTemplatesNeedsTokenAndWABA(t *testing.T) {
	c := newTestClient("http://127.0.0.1:1")
	if _, err := c.Templates(context.Background(), "", "waba-1"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("err = %v, want ErrNotConnected", err)
	}
	if _, err := c.Templates(context.Background(), "token", " "); err == nil {
		t.Error("err = nil, want a refusal: there is no WABA to read templates from")
	}
}

func TestRenderFillsPlaceholdersInOrder(t *testing.T) {
	got := Render("Hi {{1}}, {{2}} starts at {{3}}.", []string{"Thandi", "Scaling Postgres", "14:00"})
	want := "Hi Thandi, Scaling Postgres starts at 14:00."
	if got != want {
		t.Errorf("Render = %q, want %q", got, want)
	}
	// Short of values, the placeholder stays. The count is checked before the send,
	// so a gap here means the two sides disagree — which is worth seeing in the
	// thread rather than hiding behind a blank.
	if got := Render("Hi {{1}}, {{2}}!", []string{"Thandi"}); got != "Hi Thandi, {{2}}!" {
		t.Errorf("Render with a missing value = %q", got)
	}
	if got := Render("No variables here.", []string{"unused"}); got != "No variables here." {
		t.Errorf("Render with no placeholders = %q", got)
	}
}
