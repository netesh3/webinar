package api

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
)

// maxAvatarBytes caps one profile-photo upload. The client crops to a square
// and re-encodes before it gets here; this is the backstop, same role as
// maxWebinarImageBytes for a cover.
const maxAvatarBytes = 2 << 20

/* handleAvatar streams the signed-in account's uploaded profile photo.
 *
 * Cookie-authenticated, like GET /auth/me: the <img> in the top nav is on
 * this origin and sends the session. A Google photo is not served from here
 * — that URL is already on the account payload.
 */
func (s *Server) handleAvatar(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	data, mime, err := s.store.UserAvatarMedia(r.Context(), user.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No profile photo has been uploaded.")
		return
	}
	if err != nil {
		s.fail(w, r, "avatar: lookup", err)
		return
	}

	w.Header().Set("Content-Type", mime)
	// Private: the bytes are behind the session cookie. immutable is safe
	// because a replacement mints a new ?v= (see store.SetUserAvatar).
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, "", zeroTime, bytes.NewReader(data))
}

/* handleUploadAvatar stores a profile photo on the account.
 *
 * The body is the raw image, same convention as a webinar cover: one part,
 * sniffed rather than trusted from Content-Type. JPEG, PNG and WebP only.
 * Replaces any previous upload. The Google URL is left in place so deleting
 * this upload falls back to it.
 */
func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAvatarBytes+1))
	if err != nil || len(body) > maxAvatarBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_large",
			fmt.Sprintf("Profile photos must be under %dMB.", maxAvatarBytes>>20))
		return
	}
	if len(body) == 0 {
		httpx.Error(w, http.StatusBadRequest, "empty", "That upload was empty.")
		return
	}

	mime, sniffed := sniffImage(body)
	if !sniffed {
		httpx.Error(w, http.StatusUnsupportedMediaType, "bad_image",
			"Images must be PNG, JPEG or WebP.")
		return
	}

	updated, err := s.store.SetUserAvatar(r.Context(), user.ID, mime, body)
	if err != nil {
		s.fail(w, r, "avatar: store", err)
		return
	}
	httpx.JSON(w, http.StatusOK, updated.Public())
}

// handleDeleteAvatar removes the upload. The account falls back to its Google
// photo when one was stored at sign-in, and to initials otherwise.
func (s *Server) handleDeleteAvatar(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	updated, err := s.store.ClearUserAvatar(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "avatar: clear", err)
		return
	}
	httpx.JSON(w, http.StatusOK, updated.Public())
}
