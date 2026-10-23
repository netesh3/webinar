package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Spam detection on a live session's chat and Q&A, for the host and co-hosts. The audience
 * never sees a flag: the flags are read from a host endpoint, and the "spam-flags" nudge goes
 * to the host team alone.
 *
 *   rules     every attendee chat message and question is scored as it is sent, for free
 *             (spam_rules.go). A high score is flagged at once; a middling one is recorded as
 *             pending for the AI pass, but only while the session may use AI.
 *   AI pass   batched, never a call per message (feature chat_spam): due when spamBatch are
 *             pending or the oldest has waited spamEvery. It sends the pending messages and a
 *             small sample of the recent chat since the last pass, scrubbed of email addresses
 *             and phone numbers and without names, and gets a verdict per message. No call
 *             when nothing is pending. Only while sessionAIAllowed (the account's ai feature
 *             and the room's AI switch; nothing said while AI was paused is sent), and through
 *             aiComplete, so the monthly caps apply; at a cap the pass stops for
 *             spamLimitedPause. One pass at a time per session: in this process and across
 *             instances (a lease).
 *             When it runs: on the host team's read of GET /spam (their panel polls it while
 *             the room is open) and in the tick's spam lane — both inside a request, which is
 *             what has the CPU on Cloud Run. Never from a goroutine of its own.
 *   actions   the host team's one-click Delete, Hide, Remove person, Mute chat, Not spam.
 *             Nothing is ever removed by itself unless the host turns on Auto-hide, which
 *             hides spam flagged at spamAutoHideAt or more (off by default).
 */

var (
	// spamEvery is the longest a pending message waits for a pass. A var for tests.
	spamEvery = 15 * time.Second
)

const (
	// spamBatch pending messages make a pass due at once.
	spamBatch = 8
	// spamWindow bounds one pass's pending messages, oldest first.
	spamWindow = 40
	// spamSampleN is how many recent chat lines go with them.
	spamSampleN = 12
	// spamSampleSince bounds the sample when no pass has run yet.
	spamSampleSince = 10 * time.Minute
	// spamAIFlagAt is the confidence a pending message is flagged at.
	spamAIFlagAt = 0.6
	// spamSampleFlagAt is the confidence a sampled message (no rule matched) is flagged at.
	spamSampleFlagAt = 0.8
	// spamAutoHideAt is the confidence Auto-hide acts on.
	spamAutoHideAt = 0.9
	// spamLimitedPause is how long a cap stops passes.
	spamLimitedPause = 10 * time.Minute
	// spamFailBackoff is how long after a failed call the next pass may run.
	spamFailBackoff = time.Minute
	spamPassTimeout = 25 * time.Second
	spamLease       = 60 * time.Second
	// spamListLimit bounds the host's read.
	spamListLimit = 200
	// spamLaneBudget bounds the tick's spam lane; spamLaneSessions how many sessions it visits.
	spamLaneBudget   = 45 * time.Second
	spamLaneSessions = 20
	// spamBodyRunes bounds what is stored of one message.
	spamBodyRunes = 600
)

// spamFlagsChangedKind tells the host team to re-read the flags. Server-only, addressed to
// the host and co-hosts alone.
const spamFlagsChangedKind = "spam-flags"

// spamSession is one session's spam state in this process.
type spamSession struct {
	history spamHistory
	mu      sync.Mutex
	running bool
	retryAt time.Time
}

func (s *Server) spamSession(slug string) *spamSession {
	v, _ := s.spamSessions.LoadOrStore(slug, &spamSession{})
	return v.(*spamSession)
}

// spamDue is the batching rule: enough pending, or the oldest waiting long enough.
func spamDue(pending int, oldest, now time.Time) bool {
	if pending <= 0 {
		return false
	}
	return pending >= spamBatch || now.Sub(oldest) >= spamEvery
}

// spamAIOn is whether the session's AI may take a pending message, as the say path can tell
// from the webinar alone: controls.aiEnabled already reads false without the account feature.
func (s *Server) spamAIOn(wb types.Webinar) bool {
	return s.ai.Enabled() && wb.Controls.AIEnabled && !wb.Controls.AIOffThisSession
}

/* spamCheck is the say path's hook: the rules over one attendee message, after it has been
 * recorded and delivered. Cheap — no model, one insert only when a rule matched. */
func (s *Server) spamCheck(ctx context.Context, wb types.Webinar, from wireSender, kind, id, text string, st store.SpamSenderState) {
	if from.Role != types.RoleAttendee || id == "" || text == "" {
		return
	}
	prior := s.spamSession(wb.ID).history.observe(from.Identity, text, time.Now())
	res := spamScore(text, st.AllowLinks, prior)
	if res.Score < spamSuspectAt {
		return
	}
	flag := store.SpamFlag{
		Kind: kind, ID: id, Identity: from.Identity, Name: from.Name,
		Body: clipRunes(text, spamBodyRunes), RuleScore: res.Score, Reasons: res.Reasons,
		Status: store.SpamPending, Source: "rules",
	}
	if res.Score >= spamFlagAt {
		flag.Status, flag.Category, flag.Confidence = store.SpamFlagged, spamCategoryFor(res.Reasons), res.Score
		if st.AutoHide && res.Score >= spamAutoHideAt {
			flag.Status = store.SpamAutoHidden
		}
	} else if !s.spamAIOn(wb) {
		// Only the AI could decide this one, and the session may not use it.
		return
	}
	bg := context.WithoutCancel(ctx)
	added, err := s.store.AddSpamFlag(bg, wb.ID, flag)
	if err != nil {
		s.log.Warn("spam: record", "slug", wb.ID, "kind", kind, "id", id, "error", err)
		return
	}
	if !added || flag.Status == store.SpamPending {
		return
	}
	if flag.Status == store.SpamAutoHidden {
		s.spamHide(bg, wb, kind, id)
	}
	s.announceSpam(bg, wb)
}

/* spamMaybePass runs a pass if one is due. Reports whether it flagged anything. */
func (s *Server) spamMaybePass(ctx context.Context, wb types.Webinar) bool {
	if wb.Status != types.StatusLive || !s.ai.Enabled() || !s.sessionAIAllowed(ctx, wb) {
		return false
	}
	slug := wb.ID
	now := time.Now()
	sess := s.spamSession(slug)
	sess.mu.Lock()
	busy, backoff := sess.running, now.Before(sess.retryAt)
	sess.mu.Unlock()
	if busy || backoff {
		return false
	}
	if limited, _, err := s.store.SpamPassState(ctx, slug); err == nil && !limited.IsZero() && now.Sub(limited) < spamLimitedPause {
		return false
	}
	pending, err := s.store.SpamPending(ctx, slug, spamWindow)
	if err != nil {
		s.log.Warn("spam: pending", "slug", slug, "error", err)
		return false
	}
	if len(pending) == 0 || !spamDue(len(pending), pending[0].CreatedAt, now) {
		return false
	}
	flagged, err := s.runSpamPass(ctx, wb)
	if err != nil && !errors.Is(err, errAILimit) {
		s.log.Warn("spam: pass", "slug", slug, "error", err)
	}
	return flagged
}

// runSpamPass is one AI pass. errAILimit when a cap stopped it.
func (s *Server) runSpamPass(ctx context.Context, wb types.Webinar) (bool, error) {
	slug := wb.ID
	sess := s.spamSession(slug)
	sess.mu.Lock()
	if sess.running {
		sess.mu.Unlock()
		return false, nil
	}
	sess.running = true
	sess.mu.Unlock()
	defer func() {
		sess.mu.Lock()
		sess.running = false
		sess.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(ctx, spamPassTimeout)
	defer cancel()
	release, ok, err := s.store.TryLease(ctx, "chat_spam:"+slug, spamLease)
	if err != nil || !ok {
		return false, err
	}
	defer release()
	bg := context.WithoutCancel(ctx)

	pending, err := s.store.SpamPending(ctx, slug, spamWindow)
	if err != nil {
		return false, err
	}
	// Nothing said while AI was paused goes to a model (ai_session.go). Those the rules did
	// not flag are let go: only the AI could have flagged them.
	paused, err := s.store.AIOffWindows(ctx, slug)
	if err != nil {
		return false, err
	}
	var check []store.SpamFlag
	for _, p := range pending {
		if paused.Contains(p.CreatedAt) {
			_ = s.store.SetSpamVerdict(bg, slug, p.Kind, p.ID, store.SpamClear, "", "", 0)
			continue
		}
		check = append(check, p)
	}
	if len(check) == 0 {
		return false, nil
	}

	passAt := time.Now()
	_, lastPass, err := s.store.SpamPassState(ctx, slug)
	if err != nil {
		return false, err
	}
	since := passAt.Add(-spamSampleSince)
	if lastPass.After(since) {
		since = lastPass
	}
	rawSample, err := s.store.SpamSample(ctx, slug, since, spamSampleN)
	if err != nil {
		return false, err
	}
	var sample []store.SpamSampleMessage
	for _, m := range rawSample {
		if !paused.Contains(m.CreatedAt) {
			sample = append(sample, m)
		}
	}

	items := make([]aiwrite.SpamItem, 0, len(check)+len(sample))
	for _, p := range check {
		items = append(items, aiwrite.SpamItem{Text: knowledge.ScrubPII(p.Body), Reasons: p.Reasons})
	}
	for _, m := range sample {
		items = append(items, aiwrite.SpamItem{Text: knowledge.ScrubPII(clipRunes(m.Body, spamBodyRunes))})
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureChatSpam, wb.Host.ID, ai.Request{
		Messages:       aiwrite.SpamMessages(wb.Topic, items),
		Schema:         aiwrite.SpamSchema,
		MaxTokens:      1500,
		Temperature:    0,
		AttemptTimeout: 15 * time.Second,
	})
	if errors.Is(err, errAILimit) {
		now := time.Now()
		_ = s.store.SetSpamLimited(bg, slug, &now)
		s.announceSpam(bg, wb)
		return false, err
	}
	if err != nil {
		sess.mu.Lock()
		sess.retryAt = time.Now().Add(spamFailBackoff)
		sess.mu.Unlock()
		return false, err
	}
	verdicts, err := aiwrite.ParseSpam(reply.Text, len(items))
	if err != nil {
		sess.mu.Lock()
		sess.retryAt = time.Now().Add(spamFailBackoff)
		sess.mu.Unlock()
		return false, err
	}
	_, autoHide, _ := s.store.SpamSettings(bg, slug)
	byIndex := map[int]aiwrite.SpamVerdict{}
	for _, v := range verdicts {
		byIndex[v.Index] = v
	}

	flagged := false
	status := func(conf float64) string {
		if autoHide && conf >= spamAutoHideAt {
			return store.SpamAutoHidden
		}
		return store.SpamFlagged
	}
	for i, p := range check {
		v, ok := byIndex[i]
		if !ok || !v.Spam || v.Confidence < spamAIFlagAt {
			// A message the reply left out is let go rather than asked about again: the rules
			// did not think it spam enough to flag on their own.
			cat, conf := "", 0.0
			if ok {
				cat, conf = v.Category, v.Confidence
			}
			src := ""
			if ok {
				src = "ai"
			}
			_ = s.store.SetSpamVerdict(bg, slug, p.Kind, p.ID, store.SpamClear, src, cat, conf)
			continue
		}
		st := status(v.Confidence)
		if err := s.store.SetSpamVerdict(bg, slug, p.Kind, p.ID, st, "ai", v.Category, v.Confidence); err != nil {
			s.log.Warn("spam: verdict", "slug", slug, "id", p.ID, "error", err)
			continue
		}
		if st == store.SpamAutoHidden {
			s.spamHide(bg, wb, p.Kind, p.ID)
		}
		flagged = true
	}
	for j, m := range sample {
		v, ok := byIndex[len(check)+j]
		if !ok || !v.Spam || v.Confidence < spamSampleFlagAt {
			continue
		}
		st := status(v.Confidence)
		added, err := s.store.AddSpamFlag(bg, slug, store.SpamFlag{
			Kind: "chat", ID: m.ID, Identity: m.Identity, Name: m.Name,
			Body: clipRunes(m.Body, spamBodyRunes), Status: st, Source: "ai",
			Category: v.Category, Confidence: v.Confidence,
		})
		if err != nil || !added {
			continue
		}
		if st == store.SpamAutoHidden {
			s.spamHide(bg, wb, "chat", m.ID)
		}
		flagged = true
	}
	_ = s.store.SetSpamPassAt(bg, slug, passAt)
	if limited, _, err := s.store.SpamPassState(bg, slug); err == nil && !limited.IsZero() {
		_ = s.store.SetSpamLimited(bg, slug, nil)
	}
	if flagged {
		s.announceSpam(bg, wb)
	}
	return flagged, nil
}

// runSpamLane is the tick's spam lane: a due pass for each live session with messages
// waiting, so a room whose host has no panel open is still checked.
func (s *Server) runSpamLane(ctx context.Context) {
	if !s.ai.Enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, spamLaneBudget)
	defer cancel()
	release, ok, err := s.store.TryLease(ctx, "spam_sweep", tickLease)
	if err != nil || !ok {
		return
	}
	defer release()
	slugs, err := s.store.LiveSlugsWithPendingSpam(ctx, spamLaneSessions)
	if err != nil {
		s.log.Warn("spam lane: list", "error", err)
		return
	}
	for _, slug := range slugs {
		if ctx.Err() != nil {
			return
		}
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if err != nil {
			continue
		}
		s.spamMaybePass(ctx, wb)
	}
}

// ---------------------------------------------------------------- taking a message out

/* spamHide takes one message out of the room: a chat message is deleted (soft, as a host's
 * delete is) and the room told; a question is hidden (dismissed), which the audience's reads
 * leave out, and the room told with the same qmod packet a host's Hide sends. */
func (s *Server) spamHide(ctx context.Context, wb types.Webinar, kind, id string) {
	switch kind {
	case "chat":
		if err := s.store.DeleteChat(ctx, wb.ID, id); err != nil && !errors.Is(err, store.ErrNotFound) {
			s.log.Warn("spam: delete chat", "slug", wb.ID, "id", id, "error", err)
			return
		}
		if wb.SFUProject == "" {
			return
		}
		if sfu, err := s.sfuFor(ctx, wb); err == nil {
			_ = s.sendRoomPacket(ctx, sfu, wb.ID, nil, map[string]any{"kind": string(chatDeletedKind), "id": id})
		}
	case "question":
		dismissed := true
		if err := s.store.UpdateSessionQuestion(ctx, wb.ID, id, types.QuestionPatch{Dismissed: &dismissed}); err != nil {
			s.log.Warn("spam: hide question", "slug", wb.ID, "id", id, "error", err)
			return
		}
		s.broadcastQMod(ctx, wb, map[string]any{"kind": "qmod", "questionId": id, "dismissed": true})
	}
}

// announceSpam tells the host team to re-read the flags. Best effort: their panels poll too.
func (s *Server) announceSpam(ctx context.Context, wb types.Webinar) {
	if wb.SFUProject == "" {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	if err := s.sendRoomPacket(ctx, sfu, wb.ID, s.hostTeam(ctx, sfu, wb), map[string]any{
		"kind": spamFlagsChangedKind,
		"at":   time.Now().UnixMilli(),
	}); err != nil {
		s.log.Warn("spam: announce", "slug", wb.ID, "error", err)
	}
}

// ---------------------------------------------------------------- handlers

func spamFlagOut(f store.SpamFlag) types.SpamFlag {
	reasons := f.Reasons
	if reasons == nil {
		reasons = []string{}
	}
	return types.SpamFlag{
		Kind: f.Kind, ID: f.ID, Identity: f.Identity, Name: f.Name, Text: f.Body,
		Category: f.Category, Confidence: f.Confidence, Source: f.Source, Reasons: reasons,
		Status: f.Status, At: f.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// handleSpamFlags is GET /api/host/webinars/{slug}/spam: the host team's Flagged filter.
func (s *Server) handleSpamFlags(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "spam: webinar", err)
		return
	}
	out := types.SpamFlagsResponse{Flags: []types.SpamFlag{}, Muted: []string{}}
	out.AI = s.ai.Enabled() && s.sessionAIAllowed(r.Context(), wb)
	if out.AI {
		// The panel's read is also a trigger: on Cloud Run, a request is what has the CPU.
		s.spamMaybePass(r.Context(), wb)
	}
	out.Settings.AllowLinks, out.Settings.AutoHide, err = s.store.SpamSettings(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "spam: settings", err)
		return
	}
	flags, err := s.store.SpamOpen(r.Context(), slug, spamListLimit)
	if err != nil {
		s.fail(w, r, "spam: flags", err)
		return
	}
	for _, f := range flags {
		out.Flags = append(out.Flags, spamFlagOut(f))
	}
	if muted, err := s.store.ChatMutedIdentities(r.Context(), slug); err == nil {
		out.Muted = muted
	}
	if limited, _, err := s.store.SpamPassState(r.Context(), slug); err == nil && !limited.IsZero() &&
		time.Since(limited) < spamLimitedPause {
		out.Limited = true
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handlePatchSpamSettings is PATCH /api/host/webinars/{slug}/spam/settings.
func (s *Server) handlePatchSpamSettings(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	var patch types.SpamSettingsPatch
	if err := httpx.DecodeJSON(w, r, &patch); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if err := s.store.SetSpamSettings(r.Context(), slug, patch.AllowLinks, patch.AutoHide); err != nil {
		s.fail(w, r, "spam: save settings", err)
		return
	}
	var out types.SpamSettings
	var err error
	out.AllowLinks, out.AutoHide, err = s.store.SpamSettings(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "spam: settings", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* handleSpamAction is POST /api/host/webinars/{slug}/spam/{kind}/{id}: one host action on a
 * flagged message. delete and hide take it out of the room (for chat both are a delete; for a
 * question both hide it), remove takes its sender out of the session, mute refuses their chat
 * and questions from now on (unmute undoes it), not_spam clears the flag. */
func (s *Server) handleSpamAction(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	kind, id := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	var req types.SpamActionRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	flag, err := s.store.SpamFlagByID(r.Context(), slug, kind, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That message isn't flagged.")
		return
	}
	if err != nil {
		s.fail(w, r, "spam action: flag", err)
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "spam action: webinar", err)
		return
	}
	status := ""
	switch req.Action {
	case "delete", "hide":
		s.spamHide(r.Context(), wb, kind, id)
		status = store.SpamDeleted
		if req.Action == "hide" {
			status = store.SpamHidden
		}
	case "remove":
		sfu, err := s.sfuFor(r.Context(), wb)
		if err != nil {
			s.failSFU(w, r, wb, err)
			return
		}
		if err := s.removeParticipant(r.Context(), sfu, slug, flag.Identity); err != nil {
			s.fail(w, r, "spam action: remove", err)
			return
		}
		status = store.SpamRemoved
	case "mute", "unmute":
		if err := s.store.SetChatMuted(r.Context(), slug, flag.Identity, req.Action == "mute"); err != nil {
			s.fail(w, r, "spam action: mute", err)
			return
		}
		if req.Action == "mute" {
			status = store.SpamMuted
		}
	case "not_spam":
		status = store.SpamNotSpam
	default:
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Unknown action.")
		return
	}
	if status != "" {
		if err := s.store.SetSpamVerdict(r.Context(), slug, kind, id, status, "", "", 0); err != nil {
			s.fail(w, r, "spam action: save", err)
			return
		}
	}
	s.announceSpam(context.WithoutCancel(r.Context()), wb)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// spamCounts is the session's flagged and removed counts for the Results page; zeros when
// they cannot be read.
func (s *Server) spamCounts(ctx context.Context, slug string) (flagged, removed int) {
	flagged, removed, err := s.store.SpamCounts(ctx, slug)
	if err != nil {
		return 0, 0
	}
	return flagged, removed
}
