package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

type pendingStage struct {
	audioOnly bool
	timer     *time.Timer
}

func inviteKey(slug, identity string) string { return slug + "\x00" + identity }

func (s *Server) putInvite(slug, identity string, audioOnly bool) {
	s.invitesMu.Lock()
	defer s.invitesMu.Unlock()
	if s.invites == nil {
		s.invites = map[string]pendingStage{}
	}
	key := inviteKey(slug, identity)
	if prev, ok := s.invites[key]; ok && prev.timer != nil {
		prev.timer.Stop()
	}
	t := time.AfterFunc(60*time.Second, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = s.finishInvite(ctx, slug, identity, false)
	})
	s.invites[key] = pendingStage{audioOnly: audioOnly, timer: t}
}

func (s *Server) takeInvite(slug, identity string) (pendingStage, bool) {
	s.invitesMu.Lock()
	defer s.invitesMu.Unlock()
	key := inviteKey(slug, identity)
	inv, ok := s.invites[key]
	if !ok {
		return pendingStage{}, false
	}
	if inv.timer != nil {
		inv.timer.Stop()
	}
	delete(s.invites, key)
	return inv, true
}

func (s *Server) sendRoomPacket(ctx context.Context, sfu RoomManager, slug string, to []string, packet map[string]any) error {
	body, err := json.Marshal(packet)
	if err != nil {
		return err
	}
	return sfu.SendData(ctx, lk.RoomName(slug), dataTopic, body, to)
}

func (s *Server) finishInvite(ctx context.Context, slug, identity string, accept bool) error {
	inv, ok := s.takeInvite(slug, identity)
	if !ok {
		return errNoInvite
	}

	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return err
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return err
	}

	_ = s.sendRoomPacket(ctx, sfu, slug, []string{identity}, map[string]any{
		"kind":     "stage-invite-clear",
		"identity": identity,
		"at":       time.Now().UnixMilli(),
	})

	if !accept {
		return nil
	}
	return s.applyStageGrant(ctx, sfu, wb, identity, true, inv.audioOnly)
}

var errNoInvite = errors.New("no pending stage invite")

func (s *Server) handleStageInviteRespond(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req struct {
		JoinKey string `json:"joinKey"`
		Accept  bool   `json:"accept"`
	}
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	from, ok := s.resolveSender(w, r, slug, req.JoinKey)
	if !ok {
		return
	}
	if err := s.finishInvite(r.Context(), slug, from.Identity, req.Accept); err != nil {
		if errors.Is(err, errNoInvite) {
			httpx.Error(w, http.StatusConflict, "no_invite", "That invite is no longer open.")
			return
		}
		s.fail(w, r, "stage invite", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}
