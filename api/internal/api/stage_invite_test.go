package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* Stage invites, across more than one API instance.
 *
 * The host's "Bring on stage" and the attendee's "Join stage" are two requests, and Cloud
 * Run gives each to whichever instance is free. Invites used to be a map in one
 * instance's memory, so once a webinar was big enough to need a second instance most
 * accepts landed where the invite was not and the attendee was told "That invite is no
 * longer open." These run a second server on the same database and fakes, which is what
 * that looks like from here. */

// secondInstance boots another API server against the same database and LiveKit fakes.
func (h *harness) secondInstance() *httptest.Server {
	h.t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	other := httptest.NewServer(api.NewServer(h.cfg, h.store, h.pool, h.recordings, log).Routes())
	h.t.Cleanup(other.Close)
	return other
}

// answerInvite is the attendee's answer, sent to the given instance.
func (h *harness) answerInvite(base, slug, joinKey string, accept bool) (int, []byte) {
	h.t.Helper()
	body, err := json.Marshal(map[string]any{"joinKey": joinKey, "accept": accept})
	if err != nil {
		h.t.Fatal(err)
	}
	res, err := http.Post(base+"/api/webinars/"+slug+"/stage-invite", "application/json",
		bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, raw
}

// invite has the host offer the stage and checks it went out as an invite.
func (h *harness) invite(slug, identity string, audioOnly bool) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+slug+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist, AudioOnly: audioOnly})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("invite: status %d body %s", res.StatusCode, raw)
	}
	var status types.StatusResponse
	h.decode(raw, &status)
	if status.Status != "invited" {
		h.t.Fatalf("invite: status %q, want invited", status.Status)
	}
}

func (h *harness) roleChanges() []lk.Spec {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	return append([]lk.Spec{}, h.rooms.roleChanges...)
}

func TestStageInviteAcceptedOnAnotherInstance(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage-two@test.dev", true)
	wb := h.newWebinar("Big Session", nil)
	reg := h.registerAsGuest(wb.ID, "asker-two@test.dev")
	identity := "att_" + reg.JoinKey

	h.invite(wb.ID, identity, true)

	other := h.secondInstance()
	if code, raw := h.answerInvite(other.URL, wb.ID, reg.JoinKey, true); code != http.StatusOK {
		t.Fatalf("accept on the second instance: status %d body %s", code, raw)
	}

	changes := h.roleChanges()
	if len(changes) != 1 || changes[0].Role != types.RolePanelist {
		t.Fatalf("role changes = %+v, want one promotion", changes)
	}
	if !changes[0].AudioOnly {
		t.Error("allow-to-talk became a full stage seat on the other instance")
	}

	// The grant is stored too, so a reconnect comes back on stage — whichever instance it
	// reaches.
	if grant, err := h.store.StageGrant(context.Background(), wb.ID, identity); err != nil || !grant.Granted {
		t.Errorf("stage grant after accept = %+v, %v; want granted", grant, err)
	}
}

func TestStageInviteIsAnsweredOnce(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage-once@test.dev", true)
	wb := h.newWebinar("Once Session", nil)
	reg := h.registerAsGuest(wb.ID, "asker-once@test.dev")
	identity := "att_" + reg.JoinKey

	h.invite(wb.ID, identity, false)
	other := h.secondInstance()

	if code, raw := h.answerInvite(other.URL, wb.ID, reg.JoinKey, true); code != http.StatusOK {
		t.Fatalf("first accept: status %d body %s", code, raw)
	}
	// A second answer, on either instance, finds nothing: the first one took it.
	if code, _ := h.answerInvite(h.srv.URL, wb.ID, reg.JoinKey, true); code != http.StatusConflict {
		t.Errorf("second accept on the first instance: status %d, want 409", code)
	}
	if code, _ := h.answerInvite(other.URL, wb.ID, reg.JoinKey, false); code != http.StatusConflict {
		t.Errorf("decline after accepting: status %d, want 409", code)
	}
	if n := len(h.roleChanges()); n != 1 {
		t.Errorf("role changes = %d, want exactly one", n)
	}
}

func TestStageInviteDeclineGrantsNothing(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage-decline@test.dev", true)
	wb := h.newWebinar("Decline Session", nil)
	reg := h.registerAsGuest(wb.ID, "asker-decline@test.dev")
	identity := "att_" + reg.JoinKey

	h.invite(wb.ID, identity, false)
	if code, raw := h.answerInvite(h.secondInstance().URL, wb.ID, reg.JoinKey, false); code != http.StatusOK {
		t.Fatalf("decline: status %d body %s", code, raw)
	}
	if n := len(h.roleChanges()); n != 0 {
		t.Errorf("a declined invite changed a role %d time(s)", n)
	}
	if code, _ := h.answerInvite(h.srv.URL, wb.ID, reg.JoinKey, true); code != http.StatusConflict {
		t.Errorf("accept after declining: status %d, want 409", code)
	}
}

func TestExpiredStageInviteIsClosed(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage-late@test.dev", true)
	wb := h.newWebinar("Late Session", nil)
	reg := h.registerAsGuest(wb.ID, "asker-late@test.dev")
	identity := "att_" + reg.JoinKey

	h.invite(wb.ID, identity, false)

	// As though the minute ran out on an instance that went away before its timer fired:
	// the stored expiry alone has to close it.
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx,
		`UPDATE webinar_stage_invites SET expires_at = now() - interval '1 second' WHERE identity = $1`,
		identity); err != nil {
		t.Fatal(err)
	}

	if code, _ := h.answerInvite(h.secondInstance().URL, wb.ID, reg.JoinKey, true); code != http.StatusConflict {
		t.Errorf("accepting an expired invite: status %d, want 409", code)
	}
	if n := len(h.roleChanges()); n != 0 {
		t.Errorf("an expired invite changed a role %d time(s)", n)
	}
}

// The expiry for an old invite must not take a newer one with it. Store-level, because the
// token that tells them apart never leaves the server.
func TestStageInviteExpiryLeavesANewerInvite(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage-again@test.dev", true)
	wb := h.newWebinar("Again Session", nil)
	ctx := context.Background()
	const identity = "att_again"

	if err := h.store.PutStageInvite(ctx, wb.ID, identity, "first", false, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := h.store.PutStageInvite(ctx, wb.ID, identity, "second", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	if removed, err := h.store.WithdrawStageInvite(ctx, wb.ID, identity, "first"); err != nil || removed {
		t.Fatalf("withdrawing the replaced invite: removed=%v err=%v, want nothing removed", removed, err)
	}
	inv, open, err := h.store.TakeStageInvite(ctx, wb.ID, identity)
	if err != nil || !open {
		t.Fatalf("the newer invite: open=%v err=%v, want open", open, err)
	}
	if !inv.AudioOnly {
		t.Error("the newer invite's scope was lost")
	}
	if removed, err := h.store.WithdrawStageInvite(ctx, wb.ID, identity, "second"); err != nil || removed {
		t.Errorf("withdrawing an answered invite: removed=%v err=%v, want nothing removed", removed, err)
	}

	if err := h.store.PutStageInvite(ctx, "no-such-webinar", identity, "x", false, time.Minute); err == nil {
		t.Error("an invite for a webinar that does not exist was accepted")
	}
}
