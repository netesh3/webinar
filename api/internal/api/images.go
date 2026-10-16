package api

import (
	"bytes"
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/store"
)

/* Cover images and profile photos live in the media store when there is one
 * (migrations/0098), under keys owned by one row each: covers are not copied
 * between webinars, so deleting a cover's file never takes another row's image.
 * With recording storage off (s.recordings nil) they stay in their bytea column
 * as before. */

func coverKey(webinarID, mime string) string {
	return "covers/" + webinarID + "/" + uuid.NewString() + imageTypes[mime]
}

func avatarKey(userID, mime string) string {
	return "avatars/" + userID + "/" + uuid.NewString() + imageTypes[mime]
}

// putImage writes a whole image under a fresh key.
func (s *Server) putImage(ctx context.Context, key string, data []byte) error {
	if _, err := s.recordings.Append(ctx, key, bytes.NewReader(data)); err != nil {
		return err
	}
	return s.recordings.Finalize(ctx, key)
}

// dropImage deletes a file a row no longer points at. Best-effort: the row is
// already right, and a leftover file costs storage, not correctness.
func (s *Server) dropImage(ctx context.Context, key string) {
	if key == "" || s.recordings == nil {
		return
	}
	if err := s.recordings.Delete(ctx, key); err != nil {
		s.log.Warn("image: could not delete replaced file", "key", key, "error", err)
	}
}

/* serveImage streams a stored image, or the bytes still in its row. False means
 * neither could be served and the caller answers 404: a key with no store
 * configured, or a file that has gone missing with no bytes left to fall back to. */
func (s *Server) serveImage(w http.ResponseWriter, r *http.Request, data []byte, storageKey string) bool {
	if storageKey != "" && s.recordings != nil {
		file, _, err := s.recordings.Open(r.Context(), storageKey)
		if err == nil {
			defer file.Close()
			http.ServeContent(w, r, "", zeroTime, file)
			return true
		}
		s.log.Warn("image: stored file missing", "key", storageKey, "error", err)
	}
	if len(data) == 0 {
		return false
	}
	http.ServeContent(w, r, "", zeroTime, bytes.NewReader(data))
	return true
}

// imageBackfillBatch is how many rows of each kind one pass moves.
const imageBackfillBatch = 50

/* backfillImages moves cover images and profile photos uploaded before 0098 out
 * of their bytea columns. Idempotent: a row is only marked moved if it still has
 * the version that was read, and a file written for a row that changed meanwhile
 * is deleted. Once nothing is left, each pass is one empty index scan per kind. */
func (s *Server) backfillImages(ctx context.Context) {
	if s.recordings == nil {
		return
	}
	s.backfillImageKind(ctx, "cover", s.store.WebinarImagesToMove, coverKey, s.store.MarkWebinarImageMoved)
	s.backfillImageKind(ctx, "avatar", s.store.UserAvatarsToMove, avatarKey, s.store.MarkUserAvatarMoved)
}

func (s *Server) backfillImageKind(
	ctx context.Context, kind string,
	list func(context.Context, int) ([]store.ImageToMove, error),
	keyFor func(id, mime string) string,
	mark func(ctx context.Context, id, version, key string) (bool, error),
) {
	due, err := list(ctx, imageBackfillBatch)
	if err != nil {
		s.log.Error("image backfill: could not list", "kind", kind, "error", err)
		return
	}
	moved := 0
	for _, m := range due {
		if ctx.Err() != nil {
			break
		}
		key := keyFor(m.ID, m.Mime)
		if err := s.putImage(ctx, key, m.Data); err != nil {
			s.log.Error("image backfill: could not store", "kind", kind, "id", m.ID, "error", err)
			s.dropImage(ctx, key)
			continue
		}
		ok, err := mark(ctx, m.ID, m.Version, key)
		if err != nil || !ok {
			if err != nil {
				s.log.Error("image backfill: could not record", "kind", kind, "id", m.ID, "error", err)
			}
			s.dropImage(ctx, key)
			continue
		}
		moved++
	}
	if moved > 0 {
		s.log.Info("image backfill: moved to object storage", "kind", kind, "rows", moved)
	}
}
