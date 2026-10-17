package engage

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

/* Files in WhatsApp template headers: an image, a video or a document above the text.
 *
 * Upload (POST /crm/media) stores the file in the media store and gives it an
 * unguessable public link. That link is what goes out at send time — Meta fetches the
 * header by link and has no session, so the token in the path is the only key — and
 * it is why the file has to be checked here rather than trusted: it is served from
 * this app's own domain. Only the formats Meta takes are accepted, and the bytes have
 * to agree with the declared type.
 *
 * Meta's limits (developers.facebook.com/docs/whatsapp/cloud-api/reference/media):
 * images JPEG/PNG 5 MB, video MP4/3GPP (H.264 + AAC) 16 MB, documents 100 MB. The video
 * codecs are not checked here; Meta refuses a send whose video it cannot play. */

type mediaKind struct {
	kind  string // image | video | document
	limit int64
}

var headerMediaTypes = map[string]mediaKind{
	"image/jpeg":      {"image", 5 << 20},
	"image/png":       {"image", 5 << 20},
	"video/mp4":       {"video", 16 << 20},
	"video/3gpp":      {"video", 16 << 20},
	"application/pdf": {"document", 100 << 20},
	"text/plain":      {"document", 100 << 20},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   {"document", 100 << 20},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         {"document", 100 << 20},
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": {"document", 100 << 20},
}

// sniffAgrees reports whether the first bytes are what the declared type says.
func sniffAgrees(declared string, head []byte) bool {
	got := http.DetectContentType(head)
	switch {
	case declared == "image/jpeg", declared == "image/png", declared == "application/pdf":
		return got == declared
	case declared == "video/mp4", declared == "video/3gpp":
		// The sniffer reports either container for an ISO-BMFF file.
		return got == "video/mp4" || got == "video/3gpp" || got == "application/octet-stream" && isoBMFF(head)
	case strings.HasPrefix(declared, "application/vnd.openxmlformats-officedocument."):
		return got == "application/zip"
	case declared == "text/plain":
		return strings.HasPrefix(got, "text/plain") && utf8.Valid(head)
	}
	return false
}

// isoBMFF is an MP4/3GP file: an `ftyp` box at offset 4.
func isoBMFF(head []byte) bool {
	return len(head) >= 8 && string(head[4:8]) == "ftyp"
}

func mediaToken() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// fileURL is a stored file's public link — the one Meta fetches.
func (s *Module) fileURL(m crmstore.MediaFile) string {
	return s.publicBase() + "/api/wa/files/" + m.Token
}

func (s *Module) fileJSON(m *crmstore.MediaFile) *types.CRMMediaFile {
	if m == nil {
		return nil
	}
	return &types.CRMMediaFile{
		ID: m.ID, Kind: headerMediaTypes[m.Mime].kind, MimeType: m.Mime,
		Filename: m.Filename, Bytes: m.Bytes, URL: s.fileURL(*m),
	}
}

/* handleUploadCRMMedia is POST /crm/media: the raw file as the body, its type in
 * Content-Type and its name in ?filename=. Streamed into the media store, never held in
 * memory whole, with the size limit enforced while it is written. */
func (s *Module) handleUploadCRMMedia(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "media_unset",
			"File uploads are not set up on this instance, so templates can only use the webinar cover.")
		return
	}
	mime := strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]))
	kind, ok := headerMediaTypes[mime]
	if !ok {
		httpx.Error(w, http.StatusUnsupportedMediaType, "media_type",
			"Use a JPG or PNG image, an MP4 video, or a PDF, Word, Excel, PowerPoint or text document.")
		return
	}
	filename := path.Base(strings.TrimSpace(r.URL.Query().Get("filename")))
	if filename == "." || filename == "/" {
		filename = ""
	}
	if utf8.RuneCountInString(filename) > 200 {
		filename = string([]rune(filename)[:200])
	}

	head := make([]byte, 512)
	n, err := io.ReadFull(r.Body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		httpx.Error(w, http.StatusBadRequest, "bad_body", "Could not read that file.")
		return
	}
	head = head[:n]
	if n == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "media_empty", "That file is empty.")
		return
	}
	if !sniffAgrees(mime, head) {
		httpx.Error(w, http.StatusUnprocessableEntity, "media_mismatch",
			"That file isn't really a "+mime+". Export it again in that format.")
		return
	}

	token, err := mediaToken()
	if err != nil {
		s.fail(w, r, "crm media: token", err)
		return
	}
	id := uuid.NewString()
	key := "wa/" + user.ID + "/files/" + id
	body := io.LimitReader(io.MultiReader(bytes.NewReader(head), r.Body), kind.limit+1)
	size, err := s.blobs.Append(r.Context(), key, body)
	if err != nil {
		_ = s.blobs.Delete(context.Background(), key)
		s.fail(w, r, "crm media: store", err)
		return
	}
	if size > kind.limit {
		_ = s.blobs.Delete(context.Background(), key)
		httpx.Error(w, http.StatusRequestEntityTooLarge, "media_too_large",
			"WhatsApp takes "+kind.kind+"s up to "+formatMB(kind.limit)+".")
		return
	}
	if err := s.blobs.Finalize(r.Context(), key); err != nil {
		_ = s.blobs.Delete(context.Background(), key)
		s.fail(w, r, "crm media: finalize", err)
		return
	}
	file, err := s.store.CreateMediaFile(r.Context(), crmstore.MediaFile{
		ID: id, HostID: user.ID, StorageKey: key, Mime: mime, Filename: filename, Bytes: size, Token: token,
	})
	if err != nil {
		_ = s.blobs.Delete(context.Background(), key)
		s.fail(w, r, "crm media: record", err)
		return
	}
	httpx.JSON(w, http.StatusCreated, s.fileJSON(&file))
}

func formatMB(n int64) string { return fmt.Sprintf("%d MB", n>>20) }

/* handleCRMPublicFile is GET /wa/files/{token}: the public link Meta fetches a header
 * from. No session — the token is the key — so it is served defensively: the stored
 * (allow-listed) type only, no sniffing, sandboxed, and documents as downloads. */
func (s *Module) handleCRMPublicFile(w http.ResponseWriter, r *http.Request) {
	if s.blobs == nil {
		http.NotFound(w, r)
		return
	}
	file, err := s.store.MediaFileByToken(r.Context(), chi.URLParam(r, "token"))
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.fail(w, r, "crm public file", err)
		return
	}
	kind, ok := headerMediaTypes[file.Mime]
	if !ok {
		http.NotFound(w, r)
		return
	}
	rc, _, err := s.blobs.Open(r.Context(), file.StorageKey)
	if err != nil {
		s.log.Warn("crm public file: open", "error", err, "file", file.ID)
		http.NotFound(w, r)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", file.Mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Disposition", contentDisposition(file.Filename, kind.kind == "document"))
	http.ServeContent(w, r, "", time.Time{}, rc)
}

/* handleSetCRMTemplateMedia is PUT /crm/templates/{name}/{language}/media: the default
 * header file for a template with a media header, including ones written in WhatsApp
 * Manager. An empty fileId clears it (an image header then sends the webinar cover). */
func (s *Module) handleSetCRMTemplateMedia(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body types.CRMTemplateMediaRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	name, lang := chi.URLParam(r, "name"), chi.URLParam(r, "language")
	tmpl, err := s.store.Template(r.Context(), user.ID, name, lang)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such template.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm template media", err)
		return
	}
	format := tmpl.HeaderFormat
	if format != "IMAGE" && format != "VIDEO" && format != "DOCUMENT" {
		httpx.Error(w, http.StatusUnprocessableEntity, "crm_no_media_header",
			"That template has no image, video or document header.")
		return
	}
	fileID := strings.TrimSpace(body.FileID)
	if fileID != "" {
		file, err := s.store.MediaFileForHost(r.Context(), user.ID, fileID)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusUnprocessableEntity, "media_not_found", "Upload the file again.")
			return
		}
		if err != nil {
			s.fail(w, r, "crm template media: file", err)
			return
		}
		if !strings.EqualFold(headerMediaTypes[file.Mime].kind, format) {
			httpx.Error(w, http.StatusUnprocessableEntity, "media_wrong_kind",
				"This template's header is "+strings.ToLower(format)+"; that file is "+headerMediaTypes[file.Mime].kind+".")
			return
		}
	}
	if err := s.store.SetTemplateMedia(r.Context(), user.ID, name, lang, fileID); err != nil {
		s.fail(w, r, "crm template media: save", err)
		return
	}
	full, err := s.store.TemplateWithFile(r.Context(), user.ID, name, lang)
	if err != nil {
		s.fail(w, r, "crm template media: reload", err)
		return
	}
	httpx.JSON(w, http.StatusOK, s.templateJSON(full))
}

// templateJSON is a template for the wire, with its default header file's link.
func (s *Module) templateJSON(t crmstore.TemplateWithFile) types.CRMTemplate {
	out := t.CRMTemplate
	out.HeaderFile = s.fileJSON(t.File)
	return out
}

/* headerSample uploads a file to Meta as a template's header sample and returns the
 * handle. The host's own token, this app's Meta app. */
func (s *Module) headerSample(ctx context.Context, user store.User, file crmstore.MediaFile) (string, error) {
	if s.blobs == nil {
		return "", errors.New("file uploads are not set up on this instance")
	}
	rc, _, err := s.blobs.Open(ctx, file.StorageKey)
	if err != nil {
		return "", err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, headerMediaTypes[file.Mime].limit+1))
	if err != nil {
		return "", err
	}
	name := file.Filename
	if name == "" {
		name = "header"
	}
	return s.whatsapp.UploadHeaderSample(ctx, user.WhatsAppToken, name, file.Mime, data)
}

/* headerFor is what fills a media header on one send: a broadcast's own choice, then
 * the template's default file, then — for an image only — the webinar's cover. A video
 * or document header with no file is a reason to skip the send, not a blank header. */
func (s *Module) headerFor(ctx context.Context, tmpl types.CRMTemplate, hostID string,
	m crmstore.WhatsAppOutbound, wb *types.Webinar) (*wa.HeaderMedia, string) {
	format := tmpl.HeaderFormat
	if format != "IMAGE" && format != "VIDEO" && format != "DOCUMENT" {
		return nil, ""
	}
	var file *crmstore.MediaFile
	useCover := false
	if m.BroadcastID != "" {
		h, err := s.store.BroadcastHeaderFor(ctx, m.BroadcastID)
		if err != nil {
			s.log.Warn("whatsapp header: broadcast choice", "broadcast", m.BroadcastID, "error", err)
		}
		file, useCover = h.File, h.UseCover
	}
	if file == nil && !useCover && hostID != "" {
		full, err := s.store.TemplateWithFile(ctx, hostID, tmpl.Name, tmpl.Language)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.log.Warn("whatsapp header: template file", "template", tmpl.Name, "error", err)
		}
		file = full.File
	}
	kind := strings.ToLower(format)
	if file != nil && headerMediaTypes[file.Mime].kind == kind {
		return &wa.HeaderMedia{Type: kind, Link: s.fileURL(*file), Filename: file.Filename}, ""
	}
	if format == "IMAGE" {
		return &wa.HeaderMedia{Type: "image", Link: s.coverURL(wb)}, ""
	}
	return nil, "template " + tmpl.Name + " has a " + kind + " header and no file for it — add one on the WhatsApp templates page"
}

// headerAttachment is the header a template went out with, as the thread keeps it.
func headerAttachment(h *wa.HeaderMedia) *types.CRMAttachment {
	if h == nil || h.Link == "" {
		return nil
	}
	return &types.CRMAttachment{Header: h.Type, URL: h.Link, Filename: h.Filename}
}
