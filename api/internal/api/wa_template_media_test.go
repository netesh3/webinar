package api_test

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

var fakePDF = []byte("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n")

// uploadMedia posts a header file the way the editor does: raw body, type, name.
func uploadMedia(t *testing.T, h *harness, mime, filename string, body []byte) (int, types.CRMMediaFile, []byte) {
	t.Helper()
	res, raw := h.doRaw(http.MethodPost, "/api/host/crm/media?filename="+url.QueryEscape(filename), mime, body, nil)
	var f types.CRMMediaFile
	if res.StatusCode == http.StatusCreated {
		h.decode(raw, &f)
	}
	return res.StatusCode, f, raw
}

// publicPath is the path part of a file's public link, for fetching it from the test server.
func publicPath(t *testing.T, link string) string {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	return u.Path
}

func headerParam(t *testing.T, send map[string]any) map[string]any {
	t.Helper()
	comps, _ := send["template"].(map[string]any)["components"].([]any)
	for _, c := range comps {
		m := c.(map[string]any)
		if m["type"] == "header" {
			return m["parameters"].([]any)[0].(map[string]any)
		}
	}
	t.Fatalf("no header in %v", comps)
	return nil
}

func templateNamed2(t *testing.T, h *harness, name string) types.CRMTemplate {
	t.Helper()
	for _, tp := range crmTemplates(t, h, "").Templates {
		if tp.Name == name {
			return tp
		}
	}
	t.Fatalf("no template %q", name)
	return types.CRMTemplate{}
}

/* Upload is checked before anything is stored: only Meta's formats, bytes that match
 * the declared type, within Meta's size for that kind. The stored file is served from an
 * unguessable public link, without a session, defensively. */
func TestTemplateHeaderUploadIsCheckedAndServed(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	if code, _, raw := uploadMedia(t, h, "text/html", "x.html", []byte("<script>1</script>")); code != http.StatusUnsupportedMediaType {
		t.Errorf("html upload: %d %s, want 415", code, raw)
	}
	if code, _, raw := uploadMedia(t, h, "image/png", "fake.png", []byte("<html><script>alert(1)</script></html>")); code != http.StatusUnprocessableEntity {
		t.Errorf("html posing as png: %d %s, want 422", code, raw)
	}
	big := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 5<<20)...)
	if code, _, raw := uploadMedia(t, h, "image/png", "big.png", big); code != http.StatusRequestEntityTooLarge {
		t.Errorf("6 MB image: %d %s, want 413", code, raw)
	}

	code, file, raw := uploadMedia(t, h, "application/pdf", "Course deck.pdf", fakePDF)
	if code != http.StatusCreated || file.Kind != "document" || file.Filename != "Course deck.pdf" ||
		!strings.Contains(file.URL, "/api/wa/files/") {
		t.Fatalf("pdf upload: %d %+v %s", code, file, raw)
	}

	h.logout()
	res, body := h.doRaw(http.MethodGet, publicPath(t, file.URL), "", nil, nil)
	if res.StatusCode != http.StatusOK || !bytes.Equal(body, fakePDF) {
		t.Fatalf("public file: %d, %d bytes", res.StatusCode, len(body))
	}
	if res.Header.Get("Content-Type") != "application/pdf" || res.Header.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.HasPrefix(res.Header.Get("Content-Disposition"), "attachment") ||
		!strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("public file headers = %v", res.Header)
	}
	if res, _ := h.doRaw(http.MethodGet, "/api/wa/files/not-a-real-token", "", nil, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown token: %d, want 404", res.StatusCode)
	}
}

/* Wording with a document header: the file goes to Meta as the review sample, the
 * template is submitted with its handle, and the file becomes the template's default. */
func TestWordingWithDocumentHeaderIsSubmittedWithItsSample(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	_, file, _ := uploadMedia(t, h, "application/pdf", "deck.pdf", fakePDF)

	// The wrong kind for the header is refused before anything reaches Meta.
	res, raw := h.do(http.MethodPost, "/api/host/crm/templates", types.CRMWordingRequest{
		Body: "Here is the deck.", Category: "MARKETING",
		Header: &types.CRMTemplateHeaderInput{Format: "VIDEO", FileID: file.ID},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || len(g.uploaded()) != 0 {
		t.Fatalf("pdf as video: %d %s, uploads %d", res.StatusCode, raw, len(g.uploaded()))
	}

	res, raw = h.do(http.MethodPost, "/api/host/crm/templates", types.CRMWordingRequest{
		Body: "Hi {{1}}, here is the deck.", Category: "MARKETING",
		Header: &types.CRMTemplateHeaderInput{Format: "DOCUMENT", FileID: file.ID},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("submit: %d %s", res.StatusCode, raw)
	}
	var saved struct{ Name string }
	h.decode(raw, &saved)

	ups := g.uploaded()
	if len(ups) != 1 || ups[0].Auth != "OAuth "+testMetaHostToken || !bytes.Equal(ups[0].Body, fakePDF) ||
		!strings.Contains(ups[0].Query, "file_type=application%2Fpdf") {
		t.Fatalf("uploads = %+v", ups)
	}
	created := g.createdTemplates()
	comps := created[len(created)-1]["components"].([]any)
	head := comps[0].(map[string]any)
	if head["type"] != "HEADER" || head["format"] != "DOCUMENT" ||
		head["example"].(map[string]any)["header_handle"].([]any)[0] != "4::handle-1" {
		t.Fatalf("submitted header = %v", head)
	}

	tp := templateNamed2(t, h, saved.Name)
	if tp.HeaderFormat != "DOCUMENT" || tp.HeaderFile == nil || tp.HeaderFile.ID != file.ID {
		t.Errorf("template = %+v, want the deck as its default header", tp)
	}
}

/* A video or document template written in WhatsApp Manager is not sendable until it
 * has a file; then broadcasts send it by link, a document with its name, and a
 * broadcast can bring its own file instead. */
func TestMediaHeaderTemplatesSendTheirFile(t *testing.T) {
	g := newFakeGraph(t)
	g.addTemplate(map[string]any{
		"name": "promo_doc", "language": "en", "status": "APPROVED", "category": "UTILITY",
		"components": []map[string]any{
			{"type": "HEADER", "format": "DOCUMENT"},
			{"type": "BODY", "text": "Hi {{1}}, your notes are attached."},
		},
	})
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	crmTemplates(t, h, "?refresh=1")

	tp := templateNamed2(t, h, "promo_doc")
	if tp.Sendable || !tp.NeedsHeaderFile {
		t.Fatalf("promo_doc before a file = %+v, want not sendable for want of a file", tp)
	}

	wb := autoWebinar(t, h, "Notes webinar")
	contact := registerOptedIn(t, h, wb.ID)
	req := types.CRMBroadcastRequest{
		Name: "notes", Template: "promo_doc", Language: "en",
		Params:   []types.CRMParam{{Field: "first_name"}},
		Audience: types.AudienceWebinar, WebinarID: wb.ID,
	}
	if res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", req); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("broadcast with no file: %d %s, want 422", res.StatusCode, raw)
	}

	_, notes, _ := uploadMedia(t, h, "application/pdf", "notes.pdf", fakePDF)
	res, raw := h.do(http.MethodPut, "/api/host/crm/templates/promo_doc/en/media", types.CRMTemplateMediaRequest{FileID: notes.ID})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("set default: %d %s", res.StatusCode, raw)
	}
	if tp = templateNamed2(t, h, "promo_doc"); !tp.Sendable || tp.HeaderFile == nil {
		t.Fatalf("promo_doc with a file = %+v", tp)
	}

	// The cover only belongs on an image header.
	bad := req
	bad.HeaderUseCover = true
	if res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", bad); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("cover on a document header: %d %s, want 422", res.StatusCode, raw)
	}

	createBroadcast(t, h, req)
	drainWhatsAppOutbox(t, h, wb.ID)
	sends := g.sent()
	if len(sends) == 0 {
		t.Fatal("nothing sent")
	}
	p := headerParam(t, sends[len(sends)-1])
	doc := p["document"].(map[string]any)
	if p["type"] != "document" || doc["link"] != notes.URL || doc["filename"] != "notes.pdf" {
		t.Fatalf("default header = %v, want the notes by link", p)
	}
	// The thread keeps the header it went out with.
	thread := crmThread(t, h, contact.ID)
	last := thread.Messages[len(thread.Messages)-1]
	if last.Media == nil || last.Media.Header != "document" || last.Media.URL != notes.URL {
		t.Errorf("thread media = %+v, want the notes", last.Media)
	}

	// A broadcast's own file wins over the default, and reads back on the broadcast.
	_, handout, _ := uploadMedia(t, h, "application/pdf", "handout.pdf", fakePDF)
	own := req
	own.Name = "handout"
	own.HeaderFileID = handout.ID
	b := createBroadcast(t, h, own)
	if b.HeaderFile == nil || b.HeaderFile.ID != handout.ID {
		t.Errorf("broadcast header = %+v, want the handout", b.HeaderFile)
	}
	drainWhatsAppOutbox(t, h, wb.ID)
	sends = g.sent()
	p = headerParam(t, sends[len(sends)-1])
	if p["document"].(map[string]any)["link"] != handout.URL {
		t.Errorf("override header = %v, want the handout", p)
	}
}

/* webinar_link is the webinar's page; join_link is the person's own room link when
 * they registered, and the page when they did not. */
func TestLinkMergeFields(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Links webinar")
	registerOptedIn(t, h, wb.ID)

	var sample types.CRMAudienceResponse
	res, raw := h.do(http.MethodPost, "/api/host/crm/audience", types.CRMBroadcastRequest{
		Audience: types.AudienceWebinar, WebinarID: wb.ID,
		Params: []types.CRMParam{{Field: "webinar_link"}, {Field: "join_link"}},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("audience: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &sample)
	if len(sample.Samples) != 1 {
		t.Fatalf("samples = %+v", sample.Samples)
	}
	got := sample.Samples[0].Params
	if !strings.HasSuffix(got[0], "/webinars/"+wb.ID) {
		t.Errorf("webinar_link = %q", got[0])
	}
	if !strings.HasPrefix(got[1], got[0]+"/room?k=") || len(got[1]) <= len(got[0]+"/room?k=") {
		t.Errorf("join_link = %q, want this registrant's own room link", got[1])
	}

	// Without a webinar there is nothing to link to, and it is refused up front.
	res, raw = h.do(http.MethodPost, "/api/host/crm/broadcasts", types.CRMBroadcastRequest{
		Name: "x", Template: testTemplateUtility, Language: "en_US",
		Params: []types.CRMParam{{Field: "join_link"}}, Audience: types.AudienceOptedIn,
	})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "crm_no_webinar") {
		t.Errorf("join_link with no webinar: %d %s", res.StatusCode, raw)
	}
}
