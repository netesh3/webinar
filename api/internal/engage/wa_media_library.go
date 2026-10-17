package engage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The media library: every file a host uploaded for templates, listed back in a
 * gallery so it can be picked again instead of uploaded again.
 *
 * The grid shows thumbnails, not the files: a small JPEG made next to each image
 * (storage key + ".thumb.jpg") when it is uploaded, or the first time the gallery
 * lists an image uploaded before thumbnails existed. When the media store can sign
 * links (Cloudflare R2 / S3 in production) the browser is given short-lived signed
 * URLs straight to the bucket; otherwise (disk, in development) it reads through the
 * file's existing public token link.
 *
 * Deleting is refused while a file is still used — a template's default header, a
 * carousel card, or a broadcast that has not gone out — and the refusal says where,
 * so the coach knows what to change. A deleted file is gone from the store first and
 * from the database second: if the store refuses, the row stays and the coach is told,
 * rather than a row left pointing at nothing or bytes left that nobody can see. */

// thumbSide is the longest side of a gallery thumbnail.
const thumbSide = 320

// thumbBackfillPerPage bounds how many old images one gallery page thumbnails.
const thumbBackfillPerPage = 12

// libraryLinkTTL is how long a signed gallery link works.
const libraryLinkTTL = 30 * time.Minute

// mediaQuota is the deployment's library limit in bytes; an account may override it.
func (s *Module) mediaQuota() int64 { return s.cfg.MediaQuotaDefaultBytes() }

// mbText is a size for a coach: "12.4 MB".
func mbText(n int64) string {
	return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
}

/* quotaMessage says why an upload does not fit. A library already over its limit (a
 * limit lowered, or files from before there was one) keeps every file; it just takes
 * no more until enough are deleted. */
func quotaMessage(space crmstore.MediaSpace, file int64) string {
	if space.Used >= space.Limit {
		return "Your media library holds " + mbText(space.Used) + " and the limit is " + mbText(space.Limit) +
			". Your files are kept, but nothing more can be uploaded until you delete some to get under the limit."
	}
	return "This file is " + mbText(file) + " but only " + mbText(space.Remaining()) + " of your " +
		mbText(space.Limit) + " media library is left. Delete files you no longer use to make room."
}

/* refuseQuota answers an upload that does not fit: 413 media_quota_exceeded, with the
 * numbers, so the gallery can say how much is left. */
func refuseQuota(w http.ResponseWriter, space crmstore.MediaSpace, file int64) {
	httpx.JSON(w, http.StatusRequestEntityTooLarge, types.CRMMediaQuotaError{
		Error:     "media_quota_exceeded",
		Message:   quotaMessage(space, file),
		UsedBytes: space.Used, LimitBytes: space.Limit, FileBytes: file,
	})
}

/* mediaSigner is a media store that can hand out signed links (media.S3). Declared
 * here, not imported, to keep the CRM off internal/media (see boundary_test.go). */
type mediaSigner interface {
	PresignedGetURL(ctx context.Context, key, filename, contentType string, inline bool, expires time.Duration) (string, error)
}

// makeThumb is a small JPEG of a stored image, and the image's own size.
func makeThumb(data []byte) ([]byte, int, int, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	b := img.Bounds()
	small := flatten(scaleDown(img, thumbSide))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, small, &jpeg.Options{Quality: 75}); err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), b.Dx(), b.Dy(), nil
}

func thumbKeyFor(storageKey string) string { return storageKey + ".thumb.jpg" }

// storeThumb writes a thumbnail for an image already in the store. Best effort.
func (s *Module) storeThumb(ctx context.Context, storageKey string, data []byte) (string, int, int) {
	thumb, w, h, err := makeThumb(data)
	if err != nil {
		s.log.Warn("crm media: thumbnail", "error", err, "key", storageKey)
		return "", w, h
	}
	key := thumbKeyFor(storageKey)
	if _, err := s.blobs.Append(ctx, key, bytes.NewReader(thumb)); err == nil {
		err = s.blobs.Finalize(ctx, key)
		if err == nil {
			return key, w, h
		}
	} else {
		s.log.Warn("crm media: store thumbnail", "error", err, "key", key)
	}
	_ = s.blobs.Delete(context.Background(), key)
	return "", w, h
}

// backfillThumb makes the thumbnail an image uploaded before 0113 is missing.
func (s *Module) backfillThumb(ctx context.Context, f *crmstore.LibraryFile) {
	rc, _, err := s.blobs.Open(ctx, f.StorageKey)
	if err != nil {
		s.log.Warn("crm media: open for thumbnail", "error", err, "file", f.ID)
		return
	}
	data, err := io.ReadAll(io.LimitReader(rc, maxImageInput))
	rc.Close()
	if err != nil {
		return
	}
	key, w, h := s.storeThumb(ctx, f.StorageKey, data)
	if key == "" {
		return
	}
	if err := s.store.SetMediaThumb(ctx, f.ID, key, w, h); err != nil {
		s.log.Warn("crm media: record thumbnail", "error", err, "file", f.ID)
		return
	}
	f.ThumbKey, f.Width, f.Height = key, w, h
}

// libraryLinks are the browser's links to a file and its thumbnail.
func (s *Module) libraryLinks(ctx context.Context, f crmstore.LibraryFile) (thumb, view string) {
	if signer, ok := s.blobs.(mediaSigner); ok {
		if u, err := signer.PresignedGetURL(ctx, f.StorageKey, f.Filename, f.Mime, true, libraryLinkTTL); err == nil {
			view = u
		}
		if f.ThumbKey != "" {
			if u, err := signer.PresignedGetURL(ctx, f.ThumbKey, "", "image/jpeg", true, libraryLinkTTL); err == nil {
				thumb = u
			}
		}
	}
	if view == "" {
		view = s.fileURL(f.MediaFile)
	}
	if thumb == "" && f.ThumbKey != "" {
		thumb = s.fileURL(f.MediaFile) + "/thumb"
	}
	return thumb, view
}

func usagesJSON(us []crmstore.MediaUsage) []types.CRMMediaUsage {
	if len(us) == 0 {
		return nil
	}
	out := make([]types.CRMMediaUsage, 0, len(us))
	for _, u := range us {
		j := types.CRMMediaUsage{Kind: u.Kind, Name: u.Name, Language: u.Language}
		if u.ScheduledAt != nil {
			j.ScheduledAt = u.ScheduledAt.UTC().Format(time.RFC3339)
		}
		out = append(out, j)
	}
	return out
}

func (s *Module) libraryJSON(ctx context.Context, f crmstore.LibraryFile, us []crmstore.MediaUsage) types.CRMMediaFile {
	out := *s.fileJSON(&f.MediaFile)
	out.Width, out.Height = f.Width, f.Height
	out.ThumbURL, out.ViewURL = s.libraryLinks(ctx, f)
	out.CreatedAt = f.CreatedAt.UTC().Format(time.RFC3339)
	out.Usages = usagesJSON(us)
	out.InUse = len(us) > 0
	return out
}

// mimesOfKind are the stored types of one header kind, for filtering the gallery.
func mimesOfKind(kind string) []string {
	var out []string
	for m, k := range headerMediaTypes {
		if k.kind == kind {
			out = append(out, m)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Module) mediaUnset(w http.ResponseWriter) bool {
	if s.blobs == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "media_unset",
			"File uploads are not set up on this instance.")
		return true
	}
	return false
}

/* handleCRMMediaLibrary is GET /crm/media: the host's files, newest first, one page at
 * a time. ?type=image|video|document narrows it, ?q= searches names, ?cursor= is the
 * previous page's nextCursor. */
func (s *Module) handleCRMMediaLibrary(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.mediaUnset(w) {
		return
	}
	q := crmstore.LibraryQuery{
		Search: r.URL.Query().Get("q"),
		Cursor: r.URL.Query().Get("cursor"),
	}
	switch kind := strings.TrimSpace(r.URL.Query().Get("type")); kind {
	case "":
	case "image", "video", "document":
		q.Mimes = mimesOfKind(kind)
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "media_type", "The type is image, video or document.")
		return
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_limit", "The limit is a positive number.")
			return
		}
		q.Limit = n
	}
	page, err := s.store.ListLibrary(r.Context(), user.ID, q)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_cursor", "That page link is not valid any more.")
		return
	}
	if err != nil {
		s.fail(w, r, "crm media library", err)
		return
	}
	ids := make([]string, len(page.Files))
	backfilled := 0
	for i := range page.Files {
		f := &page.Files[i]
		ids[i] = f.ID
		if f.ThumbKey == "" && headerMediaTypes[f.Mime].kind == "image" && backfilled < thumbBackfillPerPage {
			backfilled++
			s.backfillThumb(r.Context(), f)
		}
	}
	usages, err := s.store.MediaUsages(r.Context(), user.ID, ids)
	if err != nil {
		s.fail(w, r, "crm media library: usages", err)
		return
	}
	space, err := s.store.MediaSpace(r.Context(), user.ID, s.mediaQuota())
	if err != nil {
		s.fail(w, r, "crm media library: space", err)
		return
	}
	out := types.CRMMediaLibrary{
		Files: make([]types.CRMMediaFile, 0, len(page.Files)), NextCursor: page.NextCursor,
		UsedBytes: space.Used, LimitBytes: space.Limit,
	}
	for _, f := range page.Files {
		out.Files = append(out.Files, s.libraryJSON(r.Context(), f, usages[f.ID]))
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* handleCRMPublicThumb is GET /wa/files/{token}/thumb: an image's gallery thumbnail
 * through the file's public link, for a store that cannot sign links. Same
 * defensive serving as the file itself. */
func (s *Module) handleCRMPublicThumb(w http.ResponseWriter, r *http.Request) {
	if s.blobs == nil {
		http.NotFound(w, r)
		return
	}
	key, err := s.store.ThumbKeyByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil || key == "" {
		http.NotFound(w, r)
		return
	}
	rc, _, err := s.blobs.Open(r.Context(), key)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, "", time.Time{}, rc)
}

/* OpenMediaForHost implements api.Engage: a library file's bytes for the webinar side
 * (a cover picked from the gallery). Another host's file, or none, is ErrNotFound. */
func (s *Module) OpenMediaForHost(ctx context.Context, hostID, mediaID string) (io.ReadCloser, string, error) {
	if s.blobs == nil {
		return nil, "", store.ErrNotFound
	}
	f, err := s.store.LibraryFileForHost(ctx, hostID, mediaID)
	if err != nil {
		return nil, "", err
	}
	rc, _, err := s.blobs.Open(ctx, f.StorageKey)
	if err != nil {
		return nil, "", err
	}
	return rc, f.Mime, nil
}

// handleRenameCRMMedia is PATCH /crm/media/{id}: the name the gallery shows.
func (s *Module) handleRenameCRMMedia(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	var body types.CRMMediaRenameRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	name := path.Base(strings.TrimSpace(body.Filename))
	if name == "" || name == "." || name == "/" {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_filename", "Give the file a name.")
		return
	}
	if utf8.RuneCountInString(name) > 200 {
		name = string([]rune(name)[:200])
	}
	id := chi.URLParam(r, "id")
	if err := s.store.RenameMediaFile(r.Context(), user.ID, id, name); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such file.")
		return
	} else if err != nil {
		s.fail(w, r, "crm media rename", err)
		return
	}
	f, err := s.store.LibraryFileForHost(r.Context(), user.ID, id)
	if err != nil {
		s.fail(w, r, "crm media rename: reload", err)
		return
	}
	usages, err := s.store.MediaUsages(r.Context(), user.ID, []string{id})
	if err != nil {
		s.fail(w, r, "crm media rename: usages", err)
		return
	}
	httpx.JSON(w, http.StatusOK, s.libraryJSON(r.Context(), f, usages[id]))
}

// usageText is one usage in words, for a refusal the coach reads.
func usageText(u crmstore.MediaUsage) string {
	lang := ""
	if u.Language != "" {
		lang = " (" + u.Language + ")"
	}
	switch u.Kind {
	case "template":
		return "the header of template " + u.Name + lang
	case "carousel":
		return "a carousel card of template " + u.Name + lang
	case "broadcast":
		when := ""
		if u.ScheduledAt != nil {
			when = ", sending " + u.ScheduledAt.UTC().Format("2 Jan 2006 15:04 UTC")
		}
		return "broadcast \"" + u.Name + "\"" + when
	}
	return u.Name
}

func inUseMessage(us []crmstore.MediaUsage) string {
	parts := make([]string, 0, len(us))
	for _, u := range us {
		parts = append(parts, usageText(u))
	}
	return "Still used by " + strings.Join(parts, "; ") + ". Change those first."
}

/* deleteMedia removes the files it can and says why it kept the rest. For each: still
 * used → kept, with where; otherwise the bytes and thumbnail leave the store, then the
 * row. A store failure keeps the row, so the coach can try again. */
func (s *Module) deleteMedia(ctx context.Context, hostID string, ids []string) (types.CRMMediaDeleteResult, error) {
	res := types.CRMMediaDeleteResult{Deleted: []string{}, Skipped: []types.CRMMediaSkipped{}}
	seen := map[string]bool{}
	var want []string
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			want = append(want, id)
		}
	}
	files, err := s.store.LibraryFilesForHost(ctx, hostID, want)
	if err != nil {
		return res, err
	}
	byID := map[string]crmstore.LibraryFile{}
	for _, f := range files {
		byID[f.ID] = f
	}
	usages, err := s.store.MediaUsages(ctx, hostID, keysOf(byID))
	if err != nil {
		return res, err
	}
	for _, id := range want {
		f, ok := byID[id]
		if !ok {
			res.Skipped = append(res.Skipped, types.CRMMediaSkipped{
				ID: id, Reason: "not_found", Message: "That file is not in your library any more.",
			})
			continue
		}
		if us := usages[id]; len(us) > 0 {
			res.Skipped = append(res.Skipped, types.CRMMediaSkipped{
				ID: id, Filename: f.Filename, Reason: "in_use", Message: inUseMessage(us), Usages: usagesJSON(us),
			})
			continue
		}
		if err := s.blobs.Delete(ctx, f.StorageKey); err != nil {
			s.log.Warn("crm media delete: store", "error", err, "file", id)
			res.Skipped = append(res.Skipped, types.CRMMediaSkipped{
				ID: id, Filename: f.Filename, Reason: "storage",
				Message: "The file could not be removed from storage. Try again in a minute.",
			})
			continue
		}
		if f.ThumbKey != "" {
			if err := s.blobs.Delete(ctx, f.ThumbKey); err != nil {
				s.log.Warn("crm media delete: thumbnail", "error", err, "file", id)
			}
		}
		if err := s.store.DeleteMediaRow(ctx, hostID, id); err != nil {
			return res, err
		}
		res.Deleted = append(res.Deleted, id)
	}
	space, err := s.store.MediaSpace(ctx, hostID, s.mediaQuota())
	if err != nil {
		return res, err
	}
	res.UsedBytes, res.LimitBytes = space.Used, space.Limit
	return res, nil
}

func keysOf(m map[string]crmstore.LibraryFile) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

/* handleDeleteCRMMedia is DELETE /crm/media/{id}. 200 with the result when it went;
 * 409 in_use (with where it is used), 404, or 502 storage otherwise — the body is the
 * same result either way. */
func (s *Module) handleDeleteCRMMedia(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.mediaUnset(w) {
		return
	}
	res, err := s.deleteMedia(r.Context(), user.ID, []string{chi.URLParam(r, "id")})
	if err != nil {
		s.fail(w, r, "crm media delete", err)
		return
	}
	status := http.StatusOK
	if len(res.Skipped) > 0 {
		switch res.Skipped[0].Reason {
		case "in_use":
			status = http.StatusConflict
		case "not_found":
			status = http.StatusNotFound
		default:
			status = http.StatusBadGateway
		}
	}
	httpx.JSON(w, status, res)
}

// maxDeleteBatch bounds one multi-delete.
const maxDeleteBatch = 200

// handleDeleteCRMMediaBatch is POST /crm/media/delete: several files, partial success.
func (s *Module) handleDeleteCRMMediaBatch(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	if s.mediaUnset(w) {
		return
	}
	var body types.CRMMediaDeleteRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if len(body.IDs) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "no_files", "Choose the files to delete.")
		return
	}
	if len(body.IDs) > maxDeleteBatch {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_many",
			fmt.Sprintf("Delete up to %d files at a time.", maxDeleteBatch))
		return
	}
	res, err := s.deleteMedia(r.Context(), user.ID, body.IDs)
	if err != nil {
		s.fail(w, r, "crm media delete batch", err)
		return
	}
	httpx.JSON(w, http.StatusOK, res)
}
