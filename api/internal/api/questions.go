package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* handleRoomQuestions is the Q&A panel's history, for joining and reconnecting.
 *
 * The same credential as /say and /chat (resolveSender), so the caller's identity is
 * the one their votes were recorded under and "you upvoted this" survives a reload.
 * Not gated on qaEnabled: the panel keeps existing questions visible when the host
 * turns Q&A off, and a reload should not be what makes them disappear.
 */
func (s *Server) handleRoomQuestions(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	from, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey"))
	if !ok {
		return
	}
	onStage := from.Role == types.RoleHost || from.Role == types.RolePanelist

	list, err := s.store.RoomQuestions(r.Context(), slug, from.Identity, onStage)
	if err != nil {
		s.fail(w, r, "room questions", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}
