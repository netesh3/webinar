package wa

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The two-step Resumable Upload: open a session on the app, post the bytes with an
// OAuth (not Bearer) header and file_offset 0, read the handle.
func TestUploadHeaderSample(t *testing.T) {
	var gotBytes, gotAuth, gotOffset, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/test-app/uploads":
			gotQuery = r.URL.RawQuery
			writeJSON(w, map[string]string{"id": "upload:SESSION"})
		case "/upload:SESSION":
			raw, _ := io.ReadAll(r.Body)
			gotBytes, gotAuth, gotOffset = string(raw), r.Header.Get("Authorization"), r.Header.Get("file_offset")
			writeJSON(w, map[string]string{"h": "4::aGFuZGxl"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := newTestClient(srv.URL)
	c.AppID = "test-app"
	h, err := c.UploadHeaderSample(context.Background(), "host-token", "deck.pdf", "application/pdf", []byte("%PDF-1"))
	if err != nil {
		t.Fatal(err)
	}
	if h != "4::aGFuZGxl" || gotBytes != "%PDF-1" || gotAuth != "OAuth host-token" || gotOffset != "0" {
		t.Fatalf("handle %q bytes %q auth %q offset %q", h, gotBytes, gotAuth, gotOffset)
	}
	if gotQuery != "file_length=6&file_name=deck.pdf&file_type=application%2Fpdf" {
		t.Errorf("session query = %q", gotQuery)
	}
}

// A media header is submitted with its sample handle, before the body.
func TestCreateTemplateWithMediaHeader(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		writeJSON(w, map[string]string{"id": "1", "status": "PENDING"})
	}))
	defer srv.Close()
	if _, err := newTestClient(srv.URL).CreateTemplate(context.Background(), "tok", "waba-1", NewTemplate{
		Name: "wl_own_1", Language: "en", Category: "MARKETING", Body: "Here is the deck.",
		Header: &NewHeader{Format: "DOCUMENT", Handle: "4::h"},
	}); err != nil {
		t.Fatal(err)
	}
	comps := body["components"].([]any)
	h := comps[0].(map[string]any)
	handle := h["example"].(map[string]any)["header_handle"].([]any)[0]
	if h["type"] != "HEADER" || h["format"] != "DOCUMENT" || handle != "4::h" {
		t.Fatalf("header = %v", h)
	}
	if comps[1].(map[string]any)["type"] != "BODY" {
		t.Errorf("body not second: %v", comps)
	}
	// No handle, no submit: Meta refuses a media header without a sample.
	if _, err := newTestClient(srv.URL).CreateTemplate(context.Background(), "tok", "waba-1", NewTemplate{
		Name: "x", Language: "en", Category: "UTILITY", Body: "b",
		Header: &NewHeader{Format: "VIDEO"},
	}); err == nil {
		t.Error("video header without a handle was submitted")
	}
}

// Document and video headers go out by link; a document carries its filename.
func TestSendTemplateMediaHeaders(t *testing.T) {
	for _, tc := range []struct {
		media    HeaderMedia
		filename any
	}{
		{HeaderMedia{Type: "document", Link: "https://x.test/f/doc", Filename: "deck.pdf"}, "deck.pdf"},
		{HeaderMedia{Type: "video", Link: "https://x.test/f/vid", Filename: "ignored.mp4"}, nil},
	} {
		var body map[string]any
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			writeJSON(w, map[string]any{"messages": []map[string]string{{"id": "wamid.M"}}})
		}))
		m := tc.media
		if _, err := newTestClient(srv.URL).SendTemplate(context.Background(), "tok", "p1", OutgoingTemplate{
			To: "+27831112222", Name: "t", Language: "en", HeaderMedia: &m,
		}); err != nil {
			t.Fatal(err)
		}
		srv.Close()
		comps := body["template"].(map[string]any)["components"].([]any)
		p := comps[0].(map[string]any)["parameters"].([]any)[0].(map[string]any)
		obj := p[m.Type].(map[string]any)
		if p["type"] != m.Type || obj["link"] != m.Link || obj["filename"] != tc.filename {
			t.Errorf("%s header param = %v", m.Type, p)
		}
	}
}
