package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

// stageInviteTTL is how long an attendee has to answer "come on stage".
const stageInviteTTL = 60 * time.Second

/* putInvite records a stage invite and arranges for it to expire.
 *
 * The invite is in the database (store.PutStageInvite), not in this process: the host's
 * click and the attendee's answer are two requests, and Cloud Run sends them to whichever
 * instance is free. It used to be a map here, which worked while a webinar fitted on one
 * instance and failed — "That invite is no longer open" — as soon as it needed two.
 *
 * The expiry still runs here, on the instance that made the invite, because its job is
 * to tell the attendee the offer has gone (stage-invite-clear). It removes only this
 * invite, by its token: one already answered on another instance, or replaced by a
 * newer invite, is left alone and nothing is sent. If this instance goes away first, the
 * stored expires_at still closes the invite on time. */
func (s *Server) putInvite(ctx context.Context, slug, identity string, audioOnly bool) error {
	token, err := inviteToken()
	if err != nil {
		return err
	}
	if err := s.store.PutStageInvite(ctx, slug, identity, token, audioOnly, stageInviteTTL); err != nil {
		return err
	}
	time.AfterFunc(stageInviteTTL, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		s.expireInvite(ctx, slug, identity, token)
	})
	return nil
}

func inviteToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// expireInvite withdraws one invite that nobody answered in time and tells its attendee.
func (s *Server) expireInvite(ctx context.Context, slug, identity, token string) {
	removed, err := s.store.WithdrawStageInvite(ctx, slug, identity, token)
	if err != nil {
		s.log.Warn("stage invite: could not expire", "slug", slug, "identity", identity, "error", err)
		return
	}
	if !removed {
		return
	}
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	_ = s.sendRoomPacket(ctx, sfu, slug, []string{identity}, map[string]any{
		"kind":     "stage-invite-clear",
		"identity": identity,
		"at":       time.Now().UnixMilli(),
	})
}

func (s *Server) sendRoomPacket(ctx context.Context, sfu RoomManager, slug string, to []string, packet map[string]any) error {
	body, err := json.Marshal(packet)
	if err != nil {
		return err
	}
	return sfu.SendData(ctx, lk.RoomName(slug), dataTopic, body, to)
}

func (s *Server) finishInvite(ctx context.Context, slug, identity string, accept bool) error {
	inv, open, err := s.store.TakeStageInvite(ctx, slug, identity)
	if err != nil {
		return err
	}
	if !open {
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
	return s.applyStageGrant(ctx, sfu, wb, identity, true, inv.AudioOnly)
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
