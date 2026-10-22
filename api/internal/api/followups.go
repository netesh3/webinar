package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/leads"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The follow-up writer, in the host's Results tab beside Hot leads: a draft email and a
 * draft WhatsApp message for each group (hot leads, attended, left early, no-show).
 *
 * Written once, lazily, on the first GET after the session ends: one gpt-5-nano call for
 * every group with anybody in it (feature "followups", through aiComplete and its caps),
 * from the topic, the AI recap when it is ready, and the replay link. Cached in
 * session_ai_outputs per language ("followups:en", "followups:hinglish"); the language is
 * detected from what was said, and the host may pick the other one, which is written once
 * too. No regenerate. The host's edits are saved beside what the model wrote (PUT).
 *
 * Nothing here sends: the web copies, exports the group, opens the CRM's own composer, or
 * opens the review screen whose Send is followup_send.go.
 */

// Bounds on a host's edit.
const (
	maxFollowupSubjectRunes  = 200
	maxFollowupBodyRunes     = 5000
	maxFollowupWhatsAppRunes = 1024 // Meta's limit on a template body
	followupCaptionLines     = 2000
)

func followupKind(lang string) string {
	if lang == aiwrite.LangHinglish {
		return store.AIOutputFollowupsHinglish
	}
	return store.AIOutputFollowupsEnglish
}

// followupsBody is the cached drafts: group → draft.
type followupsBody struct {
	Drafts map[string]aiwrite.FollowupDraft `json:"drafts"`
}

// replayLink is the latest public, ready recording's page, or "".
func (s *Server) replayLink(ctx context.Context, slug string) string {
	recs, err := s.store.Recordings(ctx, slug)
	if err != nil {
		return ""
	}
	link := ""
	for _, r := range recs {
		if r.Status == types.RecordingReady && r.IsPublic {
			link = s.replayURL(slug, r.ID)
		}
	}
	return link
}

// sessionLanguage detects the session's language from what was said: the after-session
// transcript, else the live captions. English when nothing was said with captions on.
func (s *Server) sessionLanguage(ctx context.Context, wb types.Webinar) string {
	started, _, _ := sessionWindow(wb)
	var b strings.Builder
	if _, segs, found, err := s.store.TranscriptSince(ctx, wb.ID, started); err == nil && found && len(segs) > 0 {
		for _, sg := range segs {
			b.WriteString(sg.Text + " ")
		}
	} else if lines, err := s.store.RecapCaptions(ctx, wb.ID, started, followupCaptionLines); err == nil {
		for _, l := range lines {
			b.WriteString(l.Text + " ")
		}
	}
	return aiwrite.DetectLanguage(b.String())
}

/* followupLanguage is what the drafts are in: the host's pick when valid; else the language
 * of drafts already written for this end (the first ones, which were detected); else
 * detected now. */
func (s *Server) followupLanguage(ctx context.Context, wb types.Webinar, asked string) string {
	if asked == aiwrite.LangEnglish || asked == aiwrite.LangHinglish {
		return asked
	}
	var first string
	var firstAt time.Time
	for _, lang := range []string{aiwrite.LangEnglish, aiwrite.LangHinglish} {
		row, err := s.store.AIOutput(ctx, wb.ID, followupKind(lang))
		if err != nil || !row.Current || row.Status != store.AIOutputReady {
			continue
		}
		if first == "" || row.CreatedAt.Before(firstAt) {
			first, firstAt = lang, row.CreatedAt
		}
	}
	if first != "" {
		return first
	}
	return s.sessionLanguage(ctx, wb)
}

// writeFollowups is the one model call for every group with anybody in it.
func (s *Server) writeFollowups(ctx context.Context, wb types.Webinar, lang string, counts map[string]int, replay string) (any, string, error) {
	in := aiwrite.FollowupsInput{
		Topic: wb.Topic, Meeting: wb.Kind == types.KindMeeting, HostName: wb.Host.Name,
		Language: lang, HasReplay: replay != "",
	}
	if row, err := s.store.SessionRecap(ctx, wb.ID); err == nil && row.Status == types.RecapReady && row.Recap != nil {
		in.RecapSummary, in.KeyPoints = row.Recap.Summary, row.Recap.KeyPoints
	}
	for _, g := range leads.Groups {
		if counts[g] > 0 {
			in.Groups = append(in.Groups, aiwrite.FollowupGroupIn{Key: g, Count: counts[g]})
		}
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureFollowups, wb.Host.ID, ai.Request{
		Messages:        aiwrite.FollowupsMessages(in),
		Schema:          aiwrite.FollowupsSchema,
		MaxTokens:       aiwrite.FollowupsMaxTokens,
		ReasoningEffort: "low",
		AttemptTimeout:  40 * time.Second,
	})
	if err != nil {
		return nil, "", err
	}
	drafts, err := aiwrite.ParseFollowups(reply.Text, in)
	if err != nil {
		return nil, "", err
	}
	return followupsBody{Drafts: drafts}, reply.Model, nil
}

/* followups builds the response. With write false it only reads (the PUT's answer); with
 * write true it may make the one call. errAILimit and ai.ErrUnavailable come back as errors
 * so the GET can answer 429 / 503. */
func (s *Server) followups(ctx context.Context, wb types.Webinar, asked string, write bool) (types.FollowupsResponse, error) {
	out := types.FollowupsResponse{Groups: []types.FollowupGroup{}}
	ranked, _, err := s.rankSession(ctx, wb)
	if err != nil {
		return out, err
	}
	rs := make([]leads.Ranked, len(ranked))
	for i, r := range ranked {
		rs[i] = r.Ranked
	}
	counts := leads.GroupCounts(rs)
	for _, g := range leads.Groups {
		out.Groups = append(out.Groups, types.FollowupGroup{Group: g, Count: counts[g]})
	}
	out.ReplayLink = s.replayLink(ctx, wb.ID)

	if out.Status = s.aiOutputGate(ctx, wb); out.Status != "" {
		if out.Status == aiStatusUnavailable && write {
			return out, ai.ErrUnavailable
		}
		out.Language = aiwrite.LangEnglish
		return out, nil
	}
	if len(rs) == 0 {
		out.Status, out.Language = aiStatusEmpty, aiwrite.LangEnglish
		return out, nil
	}
	out.Language = s.followupLanguage(ctx, wb, asked)
	kind := followupKind(out.Language)

	var row store.AIOutputRow
	if write {
		var status string
		row, status, err = s.claimAndWrite(ctx, wb.ID, kind, func(ctx context.Context) (any, string, error) {
			return s.writeFollowups(ctx, wb, out.Language, counts, out.ReplayLink)
		})
		if err != nil {
			return out, err
		}
		switch status {
		case aiStatusLimit:
			return out, errAILimit
		case aiStatusUnavailable:
			return out, ai.ErrUnavailable
		}
		out.Status = status
	} else {
		row, err = s.store.AIOutput(ctx, wb.ID, kind)
		switch {
		case errors.Is(err, store.ErrNotFound):
			out.Status = aiStatusProcessing
		case err != nil:
			return out, err
		case row.Current && row.Status == store.AIOutputReady:
			out.Status = types.AIStatusReady
		default:
			out.Status = aiStatusProcessing
		}
	}
	if out.Status != types.AIStatusReady {
		return out, nil
	}
	var body followupsBody
	_ = json.Unmarshal(row.Body, &body)
	var edits map[string]types.FollowupDraft
	_ = json.Unmarshal(row.Edits, &edits)
	for i, g := range out.Groups {
		if e, ok := edits[g.Group]; ok {
			d := e
			out.Groups[i].Draft, out.Groups[i].Edited = &d, true
			continue
		}
		if d, ok := body.Drafts[g.Group]; ok && g.Count > 0 {
			out.Groups[i].Draft = &types.FollowupDraft{EmailSubject: d.EmailSubject, EmailBody: d.EmailBody, WhatsApp: d.WhatsApp}
		}
	}
	if row.GeneratedAt != nil {
		out.GeneratedAt = row.GeneratedAt.UTC().Format(time.RFC3339)
	}
	return out, nil
}

// handleGetFollowups is GET /api/host/webinars/{slug}/followups[?lang=en|hinglish].
func (s *Server) handleGetFollowups(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	wb, err := s.store.WebinarBySlug(ctx, slugFromContext(ctx))
	if err != nil {
		s.fail(w, r, "followups: webinar", err)
		return
	}
	out, err := s.followups(ctx, wb, r.URL.Query().Get("lang"), true)
	switch {
	case errors.Is(err, errAILimit):
		httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
		return
	case errors.Is(err, ai.ErrUnavailable):
		httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
			"AI follow-ups aren't available right now. Try again in a minute.")
		return
	case err != nil:
		s.fail(w, r, "followups", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

// handlePutFollowup is PUT /api/host/webinars/{slug}/followups/{group}[?lang=]: the host's edit.
func (s *Server) handlePutFollowup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	group := chi.URLParam(r, "group")
	if !leads.ValidGroup(group) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such group.")
		return
	}
	var req types.FollowupEditRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Send the draft as JSON.")
		return
	}
	d := types.FollowupDraft{
		EmailSubject: strings.TrimSpace(req.Draft.EmailSubject),
		EmailBody:    strings.TrimSpace(strings.ReplaceAll(req.Draft.EmailBody, "\r\n", "\n")),
		WhatsApp:     strings.TrimSpace(strings.ReplaceAll(req.Draft.WhatsApp, "\r\n", "\n")),
	}
	if utf8.RuneCountInString(d.EmailSubject) > maxFollowupSubjectRunes ||
		utf8.RuneCountInString(d.EmailBody) > maxFollowupBodyRunes ||
		utf8.RuneCountInString(d.WhatsApp) > maxFollowupWhatsAppRunes {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_long",
			"That draft is too long: keep the subject under 200 characters and the WhatsApp message under 1,024.")
		return
	}
	wb, err := s.store.WebinarBySlug(ctx, slugFromContext(ctx))
	if err != nil {
		s.fail(w, r, "followups: webinar", err)
		return
	}
	lang := s.followupLanguage(ctx, wb, r.URL.Query().Get("lang"))
	err = s.store.SaveAIOutputEdit(ctx, wb.ID, followupKind(lang), group, d)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusConflict, "no_drafts", "There are no drafts to edit yet.")
		return
	}
	if err != nil {
		s.fail(w, r, "followups: save edit", err)
		return
	}
	out, err := s.followups(ctx, wb, lang, false)
	if err != nil {
		s.fail(w, r, "followups: read back", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}
