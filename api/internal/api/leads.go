package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/leads"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Hot leads, in the host's Results tab: everybody who registered or came, ranked by what
 * they did, with a one-line AI reason beside the top ones.
 *
 *   rank      counted in Go (internal/leads) on every request, from the session's own rows:
 *             cheap, always current, and the same with AI on or off.
 *   reasons   one gpt-5-nano call (feature "leads", through aiComplete and its caps) for the
 *             top leadsForReasons people, made lazily on the first GET after the session
 *             ends and cached in session_ai_outputs (migration 0130). Opening Results again
 *             reads the cache; a session run again and ended again gets new reasons once.
 *             There is no regenerate.
 *
 * Gated by sessionAIAllowed: with it off the ranking is returned and no model is called. The
 * words asked or chatted while AI was paused are left out of the reasons (store.LeadRows);
 * the counts behind the ranking keep them.
 * Under requireOwnership, so the host and co-hosts only, exactly as the rest of Results.
 */

const (
	// leadsForReasons is how many of the top leads get an AI reason.
	leadsForReasons = aiwrite.MaxLeads
	// aiOutputClaimFor outlives one inline model call.
	aiOutputClaimFor = 2 * time.Minute
	// aiOutputRetryAfter is how long a failed write waits before a page load tries again.
	aiOutputRetryAfter = time.Minute
	// aiOutputInlineBudget bounds a model call made inside a GET.
	aiOutputInlineBudget = 45 * time.Second
)

// AI status words for the two features (LeadsResponse.AIStatus, FollowupsResponse.Status).
const (
	aiStatusOff         = types.RecapReasonAIOff
	aiStatusSessionOff  = types.RecapReasonAISessionOff
	aiStatusLimit       = types.RecapReasonAILimit
	aiStatusUnavailable = types.RecapReasonAIUnavailable
	aiStatusNotEnded    = types.RecapReasonNotEnded
	aiStatusProcessing  = types.RecapReasonProcessing
	aiStatusFailed      = types.RecapReasonFailed
	aiStatusEmpty       = types.RecapReasonEmpty
)

// sessionWindow is when the live session ran; ended is zero while it is still live.
func sessionWindow(wb types.Webinar) (started, ended time.Time, sessionSec int) {
	if wb.StartedAt != "" {
		started, _ = time.Parse(time.RFC3339, wb.StartedAt)
	}
	if wb.EndedAt != "" {
		ended, _ = time.Parse(time.RFC3339, wb.EndedAt)
	}
	switch {
	case started.IsZero():
	case !ended.IsZero() && ended.After(started):
		sessionSec = int(ended.Sub(started).Seconds())
	case ended.IsZero():
		sessionSec = int(time.Since(started).Seconds())
	}
	return started, ended, max(sessionSec, 0)
}

// rankedLead is one ranked person with what the reason call needs about them.
type rankedLead struct {
	leads.Ranked
	row store.LeadRow
}

// rankSession reads and ranks everybody in the session behind slug.
func (s *Server) rankSession(ctx context.Context, wb types.Webinar) ([]rankedLead, int, error) {
	rows, err := s.store.LeadRows(ctx, wb.ID)
	if err != nil {
		return nil, 0, err
	}
	_, _, sessionSec := sessionWindow(wb)
	people := make([]leads.Person, 0, len(rows))
	byKey := make(map[string]store.LeadRow, len(rows))
	for _, r := range rows {
		byKey[r.Key] = r
		people = append(people, leads.Person{
			Key: r.Key, Name: r.Name, Email: r.Email, Phone: r.Phone,
			Signals: leads.Signals{
				WatchSec: r.WatchSec, SessionSec: sessionSec, Joined: r.Joined,
				Questions: r.Questions, Upvotes: r.Upvotes, Chats: r.Chats, PollAnswers: r.PollAnswers,
				RaisedHand: r.RaisedHand, OnStage: r.OnStage,
			},
		})
	}
	ranked := leads.Rank(people)
	out := make([]rankedLead, len(ranked))
	for i, r := range ranked {
		out[i] = rankedLead{Ranked: r, row: byKey[r.Key]}
	}
	return out, sessionSec, nil
}

func leadSignals(s leads.Signals) types.LeadSignals {
	return types.LeadSignals{
		WatchMin: (s.WatchSec + 30) / 60, WatchPct: int(s.WatchShare()*100 + 0.5), Joined: s.Joined,
		ReplayMin: (s.ReplaySec + 30) / 60, ReplayOpened: s.ReplayOpened,
		Questions: s.Questions, Upvotes: s.Upvotes, Chats: s.Chats, PollAnswers: s.PollAnswers,
		RaisedHand: s.RaisedHand, OnStage: s.OnStage, OfferClicks: s.OfferClicks,
	}
}

// signalWords is a lead's activity in words, for the reason call.
func signalWords(s leads.Signals) []string {
	var out []string
	if s.Joined {
		out = append(out, "watched "+strconv.Itoa((s.WatchSec+30)/60)+" of "+strconv.Itoa((s.SessionSec+30)/60)+
			" min live ("+strconv.Itoa(int(s.WatchShare()*100+0.5))+"%)")
	} else {
		out = append(out, "registered but did not join live")
	}
	if s.Questions > 0 {
		q := "asked " + plural(s.Questions, "question")
		if s.Upvotes > 0 {
			q += " (" + plural(s.Upvotes, "upvote") + " from others)"
		}
		out = append(out, q)
	}
	if s.Chats > 0 {
		out = append(out, "sent "+plural(s.Chats, "chat message"))
	}
	if s.PollAnswers > 0 {
		out = append(out, "answered "+plural(s.PollAnswers, "poll"))
	}
	if s.RaisedHand {
		out = append(out, "raised a hand")
	}
	if s.OnStage {
		out = append(out, "came on stage")
	}
	if s.OfferClicks > 0 {
		out = append(out, "clicked the offer")
	}
	return out
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

/* aiOutputGate says whether a session's AI output may be written now, and if not, why.
 * The order is the order a host can do something about it. */
func (s *Server) aiOutputGate(ctx context.Context, wb types.Webinar) string {
	if wb.Status != types.StatusEnded {
		return aiStatusNotEnded
	}
	// ai_off (the account) or ai_session_off (this session's switch): told apart.
	if block := s.sessionAIBlock(ctx, wb); block != "" {
		return block
	}
	switch {
	case !s.ai.Enabled():
		return aiStatusUnavailable
	}
	return ""
}

/* claimAndWrite is the shared cache-or-write step: a current ready row is returned as it is;
 * otherwise the caller's write runs once, under a claim, and its outcome is stored. Reports
 * the row (when ready) and a status word when there is none. */
func (s *Server) claimAndWrite(ctx context.Context, slug, kind string, write func(ctx context.Context) (any, string, error)) (store.AIOutputRow, string, error) {
	row, err := s.store.AIOutput(ctx, slug, kind)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return row, "", err
	}
	if err == nil && row.Current && row.Status == store.AIOutputReady {
		return row, types.AIStatusReady, nil
	}
	ok, err := s.store.ClaimAIOutput(ctx, slug, kind, aiOutputClaimFor)
	if err != nil {
		return row, "", err
	}
	if !ok {
		if row.Status == store.AIOutputFailed && row.Current {
			return row, aiStatusFailed, nil
		}
		return row, aiStatusProcessing, nil
	}
	bg := context.WithoutCancel(ctx)
	wctx, cancel := context.WithTimeout(ctx, aiOutputInlineBudget)
	defer cancel()
	body, model, werr := write(wctx)
	switch {
	case errors.Is(werr, errAILimit):
		// Not held: the next month (or a raised cap) should be able to try at once.
		_ = s.store.FailAIOutput(bg, slug, kind, 0)
		return row, aiStatusLimit, nil
	case errors.Is(werr, ai.ErrUnavailable):
		_ = s.store.FailAIOutput(bg, slug, kind, aiOutputRetryAfter)
		return row, aiStatusUnavailable, nil
	case werr != nil:
		s.log.Warn("ai output: write", "slug", slug, "kind", kind, "error", werr)
		_ = s.store.FailAIOutput(bg, slug, kind, aiOutputRetryAfter)
		return row, aiStatusFailed, nil
	}
	if err := s.store.SaveAIOutput(bg, slug, kind, body, model); err != nil {
		_ = s.store.FailAIOutput(bg, slug, kind, aiOutputRetryAfter)
		return row, "", err
	}
	row, err = s.store.AIOutput(bg, slug, kind)
	if err != nil {
		return row, "", err
	}
	return row, types.AIStatusReady, nil
}

// leadReasonsBody is the cached reasons: lead key → one line.
type leadReasonsBody struct {
	Reasons map[string]string `json:"reasons"`
}

// writeLeadReasons is the one model call for the top leads.
func (s *Server) writeLeadReasons(ctx context.Context, wb types.Webinar, top []rankedLead) (any, string, error) {
	in := aiwrite.LeadsInput{Topic: wb.Topic, Meeting: wb.Kind == types.KindMeeting}
	keyOf := make(map[string]string, len(top))
	for i, l := range top {
		id := aiwrite.LeadID(i)
		keyOf[id] = l.Key
		in.Leads = append(in.Leads, aiwrite.LeadIn{
			ID: id, FirstName: firstName(l.Name), Signals: signalWords(l.Signals),
			Questions: l.row.QuestionTexts, Chat: l.row.ChatTexts,
		})
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureLeads, wb.Host.ID, ai.Request{
		Messages:        aiwrite.LeadsMessages(in),
		Schema:          aiwrite.LeadsSchema,
		MaxTokens:       aiwrite.LeadsMaxTokens,
		ReasoningEffort: "low",
		AttemptTimeout:  40 * time.Second,
	})
	if err != nil {
		return nil, "", err
	}
	byID, err := aiwrite.ParseLeads(reply.Text, in)
	if err != nil {
		return nil, "", err
	}
	body := leadReasonsBody{Reasons: make(map[string]string, len(byID))}
	for id, reason := range byID {
		body.Reasons[keyOf[id]] = reason
	}
	return body, reply.Model, nil
}

// handleGetLeads is GET /api/host/webinars/{slug}/leads.
func (s *Server) handleGetLeads(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	slug := slugFromContext(ctx)
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.fail(w, r, "leads: webinar", err)
		return
	}
	ranked, sessionSec, err := s.rankSession(ctx, wb)
	if err != nil {
		s.fail(w, r, "leads: rank", err)
		return
	}
	out := types.LeadsResponse{Leads: make([]types.Lead, 0, len(ranked)), SessionMin: (sessionSec + 30) / 60}
	for _, l := range ranked {
		out.Leads = append(out.Leads, types.Lead{
			Key: l.Key, RegistrationID: l.row.RegistrationID, Name: l.Name, Email: l.Email, Phone: l.Phone,
			Score: l.Score, Tag: l.Tag, Group: l.Group, Signals: leadSignals(l.Signals),
		})
	}
	s.attachLeadContacts(ctx, slug, out.Leads)

	top := make([]rankedLead, 0, leadsForReasons)
	for _, l := range ranked {
		if len(top) == leadsForReasons {
			break
		}
		if l.Score > 0 && l.Signals.Joined {
			top = append(top, l)
		}
	}
	out.AIStatus = s.aiOutputGate(ctx, wb)
	out.AIPausedMin = s.aiPausedMin(ctx, slug)
	if out.AIStatus == "" && len(top) == 0 {
		out.AIStatus = aiStatusEmpty
	}
	if out.AIStatus == "" {
		row, status, err := s.claimAndWrite(ctx, slug, store.AIOutputLeads, func(ctx context.Context) (any, string, error) {
			return s.writeLeadReasons(ctx, wb, top)
		})
		if err != nil {
			s.fail(w, r, "leads: reasons", err)
			return
		}
		out.AIStatus = status
		if status == types.AIStatusReady {
			var body leadReasonsBody
			if err := json.Unmarshal(row.Body, &body); err == nil {
				for i := range out.Leads {
					out.Leads[i].Reason = body.Reasons[out.Leads[i].Key]
				}
			}
			if row.GeneratedAt != nil {
				out.GeneratedAt = row.GeneratedAt.UTC().Format(time.RFC3339)
			}
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

/* attachLeadContacts fills ContactID and WhatsAppStatus from the CRM, the way the People
 * tab's roster gets them (DecorateRegistrants), for the caller's own CRM. Nothing for a host
 * without WhatsApp connected, or for somebody who never registered. */
func (s *Server) attachLeadContacts(ctx context.Context, slug string, ls []types.Lead) {
	rows := make([]types.RegistrantRow, 0, len(ls))
	at := make([]int, 0, len(ls))
	for i, l := range ls {
		if l.RegistrationID != "" {
			rows = append(rows, types.RegistrantRow{ID: l.RegistrationID})
			at = append(at, i)
		}
	}
	if len(rows) == 0 {
		return
	}
	s.engage.DecorateRegistrants(ctx, userFromContext(ctx), slug, rows)
	for j, row := range rows {
		ls[at[j]].ContactID = row.ContactID
		ls[at[j]].WhatsAppStatus = row.WhatsAppStatus
	}
}
