package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The AI recap: written automatically after every webinar and meeting ends, and emailed
 * to the host — only the host — once.
 *
 *   end         endWebinarSession calls scheduleRecap, which writes the pending row
 *               (session_recaps, migration 0128). A second end meets the same row.
 *   wait        when server captions ran, the after-session transcript (the large-model
 *               pass) arrives some minutes later; the row waits up to recapTranscriptWait
 *               for it. Its arrival (POST /api/internal/transcripts) makes the row due at
 *               once, so nothing polls.
 *   write       the recap lane of RunTick claims due rows and writes each from the best
 *               source there is — the transcript, else the live caption lines, else the Q&A,
 *               polls and chat alone (engagement_only, with a note to turn captions on).
 *               gpt-5-nano through aiComplete (feature "recap"), so the monthly caps hold.
 *   email       the host's "Your AI recap" email and an in-app alert, queued in the same
 *               transaction that sets emailed_at: once per session, whatever retries.
 *
 * Off when the host's "ai" switch is off (no model call, row skipped ai_off), and skipped
 * rather than retried when a cap is reached. A session with nothing at all to recap
 * (nobody spoke with captions on, no questions, polls or chat) is skipped without a call.
 */

var (
	// recapDelay is how long after the end a recap is first looked at: the last caption
	// lines and the visit closes settle in the meantime. A var so tests can make it zero.
	recapDelay = time.Minute
	// recapTranscriptWait is the longest a recap waits for the after-session transcript.
	recapTranscriptWait = 30 * time.Minute
)

const (
	// recapClaimFor outlives one recap's model calls.
	recapClaimFor = 5 * time.Minute
	// recapLaneBudget bounds the recap lane of one tick; inside tickBudget.
	recapLaneBudget = 85 * time.Second
	// recapPerTick is how many recaps one tick writes at most.
	recapPerTick = 3
	// recapMaxAttempts is how often a recap no provider answered is tried again.
	recapMaxAttempts = 4
	// recapMaxCaptionLines bounds the live captions read for one recap.
	recapMaxCaptionLines = 20000
)

// scheduleRecap writes the pending recap for a session that has just ended.
func (s *Server) scheduleRecap(ctx context.Context, slug string, serverCaptions bool) {
	wait := time.Duration(0)
	if serverCaptions {
		wait = recapTranscriptWait
	}
	if _, err := s.store.ScheduleRecap(ctx, slug, recapDelay, wait); err != nil {
		s.log.Warn("end webinar: could not schedule the AI recap", "slug", slug, "error", err)
	}
}

// runRecaps is the recap lane of RunTick: a few due recaps, one at a time.
func (s *Server) runRecaps(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, recapLaneBudget)
	defer cancel()
	release, ok, err := s.store.TryLease(ctx, "recaps", tickLease)
	if err != nil {
		s.log.Error("recaps: could not take lease", "error", err)
		return
	}
	if !ok {
		return
	}
	defer release()
	for i := 0; i < recapPerTick && ctx.Err() == nil; i++ {
		job, ok, err := s.store.ClaimDueRecap(ctx, recapClaimFor)
		if err != nil {
			s.log.Error("recaps: claim", "error", err)
			return
		}
		if !ok {
			return
		}
		s.processRecap(ctx, job)
	}
}

// recapOutcome is why a recap was not written, as the row records it.
type recapOutcome struct {
	status, reason string
	// retry is set for a failure worth trying again.
	retry bool
}

func (s *Server) processRecap(ctx context.Context, job store.RecapJob) {
	// Writes outlive the lane's deadline: a recap the model has answered must be saved.
	bg := context.WithoutCancel(ctx)
	wb, err := s.store.WebinarBySlug(ctx, job.Slug)
	if err != nil {
		s.log.Warn("recap: webinar", "slug", job.Slug, "error", err)
		_ = s.store.SettleRecap(bg, job.WebinarID, types.RecapFailed, types.RecapReasonFailed)
		return
	}
	in, source, waitUntil, err := s.recapInput(ctx, wb, job.WaitUntil, false)
	if err != nil {
		s.log.Warn("recap: read the session", "slug", job.Slug, "error", err)
		s.retryRecap(bg, job, types.RecapReasonFailed)
		return
	}
	if !waitUntil.IsZero() {
		_ = s.store.DeferRecap(bg, job.WebinarID, waitUntil, job.Attempts, types.RecapReasonWaitingTranscript)
		return
	}
	_, out := s.writeAndSaveRecap(ctx, wb, in, source)
	switch {
	case out == nil:
		s.emailRecap(bg, wb)
	case out.retry:
		s.retryRecap(bg, job, out.reason)
	default:
		_ = s.store.SettleRecap(bg, job.WebinarID, out.status, out.reason)
	}
}

// retryRecap puts a recap back for later, or gives up after recapMaxAttempts.
func (s *Server) retryRecap(ctx context.Context, job store.RecapJob, reason string) {
	attempts := job.Attempts + 1
	if attempts >= recapMaxAttempts {
		_ = s.store.SettleRecap(ctx, job.WebinarID, types.RecapFailed, reason)
		return
	}
	due := time.Now().Add(time.Duration(attempts) * 10 * time.Minute)
	_ = s.store.DeferRecap(ctx, job.WebinarID, due, attempts, reason)
}

/* writeAndSaveRecap is the part shared by the automatic recap and Regenerate: the
 * checks, the model, the attendance numbers, and the save. A nil outcome is success. */
func (s *Server) writeAndSaveRecap(ctx context.Context, wb types.Webinar, in aiwrite.RecapInput, source string) (types.SessionRecap, *recapOutcome) {
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil {
		return types.SessionRecap{}, &recapOutcome{status: types.RecapFailed, reason: types.RecapReasonFailed, retry: true}
	}
	if !host.HasFeature(types.FeatureAI) {
		return types.SessionRecap{}, &recapOutcome{status: types.RecapSkipped, reason: types.RecapReasonAIOff}
	}
	if !s.ai.Enabled() {
		return types.SessionRecap{}, &recapOutcome{status: types.RecapSkipped, reason: types.RecapReasonAIUnavailable}
	}
	if !in.HasSpeech() && !in.HasEngagement() {
		return types.SessionRecap{}, &recapOutcome{status: types.RecapSkipped, reason: types.RecapReasonEmpty}
	}
	recap, model, err := s.writeRecap(ctx, host.ID, in)
	switch {
	case errors.Is(err, errAILimit):
		return recap, &recapOutcome{status: types.RecapSkipped, reason: types.RecapReasonAILimit}
	case errors.Is(err, ai.ErrUnavailable):
		return recap, &recapOutcome{status: types.RecapFailed, reason: types.RecapReasonAIUnavailable, retry: true}
	case err != nil:
		s.log.Warn("recap: write", "slug", wb.ID, "error", err)
		return recap, &recapOutcome{status: types.RecapFailed, reason: types.RecapReasonFailed, retry: true}
	}
	recap.Attendance = s.recapAttendance(ctx, wb.ID)
	if err := s.store.SaveRecap(context.WithoutCancel(ctx), wb.ID, recap, source, model); err != nil {
		s.log.Error("recap: save", "slug", wb.ID, "error", err)
		return recap, &recapOutcome{status: types.RecapFailed, reason: types.RecapReasonFailed, retry: true}
	}
	s.log.Info("ai recap written", "slug", wb.ID, "source", source, "model", model)
	return recap, nil
}

/* writeRecap asks the model. A transcript too long for one call is summarised a chunk at a
 * time (side by side, so a long session is not many calls end to end) and the notes merged.
 * Every call goes through aiComplete, so each is counted and capped. */
func (s *Server) writeRecap(ctx context.Context, hostID string, in aiwrite.RecapInput) (types.SessionRecap, string, error) {
	msgs := aiwrite.RecapMessages(in)
	if in.NeedsChunking() {
		chunks := aiwrite.Chunk(in.Lines, aiwrite.ChunkRunes)
		notes := make([]string, len(chunks))
		errs := make([]error, len(chunks))
		var wg sync.WaitGroup
		for i, c := range chunks {
			wg.Add(1)
			go func(i int, c []aiwrite.RecapLine) {
				defer wg.Done()
				reply, err := s.aiComplete(ctx, types.AIFeatureRecap, hostID, ai.Request{
					Messages:        aiwrite.NotesMessages(in, c, i+1, len(chunks)),
					Schema:          aiwrite.NotesSchema,
					MaxTokens:       3000,
					ReasoningEffort: "low",
					AttemptTimeout:  40 * time.Second,
				})
				notes[i], errs[i] = reply.Text, err
			}(i, c)
		}
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				return types.SessionRecap{}, "", err
			}
		}
		msgs = aiwrite.MergeMessages(in, notes)
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureRecap, hostID, ai.Request{
		Messages:        msgs,
		Schema:          aiwrite.RecapSchema,
		MaxTokens:       5000,
		ReasoningEffort: "low",
		AttemptTimeout:  60 * time.Second,
	})
	if err != nil {
		return types.SessionRecap{}, "", err
	}
	recap, err := aiwrite.ParseRecap(reply.Text, in)
	return recap, reply.Model, err
}

/* recapInput reads everything a recap is written from, and which source it is. waitUntil
 * comes back non-zero when the after-session transcript is still expected (and force is
 * false): the caller defers to then rather than settling for the caption lines. */
func (s *Server) recapInput(ctx context.Context, wb types.Webinar, wait *time.Time, force bool) (in aiwrite.RecapInput, source string, waitUntil time.Time, err error) {
	slug := wb.ID
	var started, ended time.Time
	if wb.StartedAt != "" {
		started, _ = time.Parse(time.RFC3339, wb.StartedAt)
	}
	if wb.EndedAt != "" {
		ended, _ = time.Parse(time.RFC3339, wb.EndedAt)
	}
	in = aiwrite.RecapInput{Topic: wb.Topic, Meeting: wb.Kind == types.KindMeeting, HostName: wb.Host.Name}
	if !started.IsZero() && ended.After(started) {
		in.DurationSec = int(ended.Sub(started).Seconds())
	}
	sinceStart := func(t time.Time) int {
		if started.IsZero() {
			return 0
		}
		return max(0, int(t.Sub(started).Seconds()))
	}

	_, segs, found, err := s.store.TranscriptSince(ctx, slug, started)
	if err != nil {
		return in, "", time.Time{}, err
	}
	switch {
	case found && len(segs) > 0:
		source = types.RecapSourceServerTranscript
		for _, sg := range segs {
			name := sg.Name
			if name == "" {
				name = speakerLabel(sg.Identity, wb)
			}
			in.Lines = append(in.Lines, aiwrite.RecapLine{AtSec: sinceStart(time.UnixMilli(sg.Start)), Speaker: name, Text: sg.Text})
		}
	case !force && wait != nil && time.Now().Before(*wait):
		return in, "", *wait, nil
	default:
		lines, err := s.store.RecapCaptions(ctx, slug, started, recapMaxCaptionLines)
		if err != nil {
			return in, "", time.Time{}, err
		}
		for _, l := range lines {
			name := l.Name
			if name == "" {
				name = speakerLabel(l.Identity, wb)
			}
			in.Lines = append(in.Lines, aiwrite.RecapLine{AtSec: sinceStart(l.At), Speaker: name, Text: l.Text})
		}
		source = types.RecapSourceCaptions
		if len(in.Lines) == 0 {
			source = types.RecapSourceEngagementOnly
		}
	}

	questions, err := s.store.SessionQuestions(ctx, slug)
	if err != nil {
		return in, "", time.Time{}, err
	}
	for _, q := range questions {
		if q.Dismissed {
			continue
		}
		in.Questions = append(in.Questions, aiwrite.RecapQuestionIn{Text: q.Text, Upvotes: q.Upvotes, Answered: q.Answered, Answer: q.Answer})
	}
	polls, err := s.store.Polls(ctx, slug, "", true)
	if err != nil {
		return in, "", time.Time{}, err
	}
	for _, p := range polls {
		if p.TotalVotes == 0 {
			continue
		}
		in.Polls = append(in.Polls, aiwrite.RecapPollIn{Question: p.Question, Options: p.Options, Votes: p.Votes, Total: p.TotalVotes, Correct: p.CorrectOption})
	}
	chat, err := s.store.ChatTranscript(ctx, slug)
	if err != nil {
		return in, "", time.Time{}, err
	}
	for _, m := range chat {
		if m.Type != types.ChatText || m.Destination == types.ChatToPanelists {
			continue
		}
		in.Chat = append(in.Chat, aiwrite.RecapChatIn{Name: m.SenderName, Text: m.Message})
	}
	return in, source, time.Time{}, nil
}

// speakerLabel names a line with no name on it: the host, else by role.
func speakerLabel(identity string, wb types.Webinar) string {
	if wb.Host.ID != "" && identity == "user_"+wb.Host.ID {
		return wb.Host.Name
	}
	if strings.HasPrefix(identity, "att_") {
		return "Attendee"
	}
	return "Speaker"
}

// recapAttendance is counted, never written by the model.
func (s *Server) recapAttendance(ctx context.Context, slug string) types.RecapAttendance {
	var a types.RecapAttendance
	if rep, err := s.store.SessionReport(ctx, slug); err == nil {
		a.Registered, a.Attended, a.AvgWatchMin = rep.Registered, rep.Attended, rep.AvgWatchMin
		a.Questions, a.PollVoters = rep.Questions, rep.PollVoters
	} else {
		s.log.Warn("recap: report", "slug", slug, "error", err)
	}
	if peak, err := s.store.PeakViewers(ctx, slug); err == nil {
		a.Peak = peak
	}
	if st, err := s.store.ChatStats(ctx, slug); err == nil {
		a.ChatMessages = st.Messages
	}
	return a
}

/* emailRecap queues the host's recap email and in-app alert, once. To the account that
 * owns the session, never to a co-host, a panelist or anybody who registered. */
func (s *Server) emailRecap(ctx context.Context, wb types.Webinar) {
	row, err := s.store.SessionRecap(ctx, wb.ID)
	if err != nil || row.Recap == nil || row.EmailedAt != nil {
		return
	}
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil {
		s.log.Warn("recap email: host", "slug", wb.ID, "error", err)
		return
	}
	email := strings.ToLower(strings.TrimSpace(host.Email))
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	n := notify.RecapNotice{
		Product: s.cfg.AppName, HostName: host.Name, Topic: wb.Topic,
		Meeting: wb.Kind == types.KindMeeting, Recap: *row.Recap,
		ResultsURL: base + "/host/" + wb.ID + "?tab=results",
	}
	if recs, err := s.store.Recordings(ctx, wb.ID); err == nil {
		for _, r := range recs {
			if r.Status == types.RecordingReady {
				n.RecordingURL = base + "/host/" + wb.ID + "?tab=recording"
				break
			}
		}
	}
	subject, text, html := notify.RecapEmail(n)
	msgs := []store.Notification{{
		// The in-app alert: the bell says the recap is ready.
		UserID: host.ID, Kind: types.NotifySessionRecap, WebinarSlug: wb.ID,
		Subject: subject, Body: aiRecapAlert(row.Recap),
	}}
	if email != "" && !strings.HasSuffix(email, ".invalid") {
		msgs = append(msgs, store.Notification{
			Email: email, Kind: types.NotifySessionRecap, WebinarSlug: wb.ID,
			Subject: subject, Body: text, HTML: html,
		})
	}
	queued, err := s.store.QueueRecapEmail(ctx, row.WebinarID, msgs...)
	if err != nil {
		s.log.Error("recap email: queue", "slug", wb.ID, "error", err)
		return
	}
	if queued {
		s.flushMailSoon()
	}
}

// aiRecapAlert is the bell's line: the summary's first sentence.
func aiRecapAlert(r *types.SessionRecap) string {
	sum := strings.Join(strings.Fields(r.Summary), " ")
	if i := strings.Index(sum, ". "); i > 0 {
		sum = sum[:i+1]
	}
	return "Your AI recap is ready. " + sum
}

// ---------------------------------------------------------------- handlers

// handleGetRecap is GET /api/host/webinars/{slug}/recap.
func (s *Server) handleGetRecap(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	row, err := s.store.SessionRecap(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		out := types.SessionRecapResponse{Status: types.RecapNone}
		if wb, err := s.store.WebinarBySlug(r.Context(), slug); err == nil && wb.Status != types.StatusEnded {
			out.Reason = types.RecapReasonNotEnded
		}
		if host, ok := s.recapHost(r.Context(), slug); ok && !host.HasFeature(types.FeatureAI) {
			out.Reason = types.RecapReasonAIOff
		}
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	if err != nil {
		s.fail(w, r, "recap: read", err)
		return
	}
	httpx.JSON(w, http.StatusOK, recapResponse(row))
}

func (s *Server) recapHost(ctx context.Context, slug string) (store.User, bool) {
	id, err := s.store.HostIDFor(ctx, slug)
	if err != nil {
		return store.User{}, false
	}
	u, err := s.store.UserByID(ctx, id)
	return u, err == nil
}

func recapResponse(row store.RecapRow) types.SessionRecapResponse {
	out := types.SessionRecapResponse{Status: row.Status, Reason: row.Reason, Source: row.Source, Model: row.Model}
	if row.Status == types.RecapPending && out.Reason == "" {
		out.Reason = types.RecapReasonProcessing
	}
	if row.Status == types.RecapReady {
		out.Reason = ""
		out.Recap = row.Recap
	}
	if row.GeneratedAt != nil {
		out.GeneratedAt = row.GeneratedAt.UTC().Format(time.RFC3339)
	}
	if row.EmailedAt != nil {
		out.EmailedAt = row.EmailedAt.UTC().Format(time.RFC3339)
	}
	return out
}

/* handleRegenerateRecap is POST /api/host/webinars/{slug}/recap: write it again now, from
 * whatever there is (it does not wait for a transcript still on its way). Rate-limited per
 * host and counted against the caps. Never emails: the host is looking at it. */
func (s *Server) handleRegenerateRecap(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "recap: webinar", err)
		return
	}
	host, err := s.store.UserByID(r.Context(), wb.Host.ID)
	if err != nil {
		s.fail(w, r, "recap: host", err)
		return
	}
	// The webinar's host's switch decides, as it does for the automatic recap.
	if !s.featureAllowed(w, host, types.FeatureAI) {
		return
	}
	if wb.Status != types.StatusEnded {
		httpx.Error(w, http.StatusConflict, "not_ended", "The recap is written once the session ends.")
		return
	}
	user := userFromContext(r.Context())
	if ok, retry := s.recapLimit.Allow(user.ID); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "That's a few recaps in a row. Try again in a few minutes.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	in, source, _, err := s.recapInput(ctx, wb, nil, true)
	if err != nil {
		s.fail(w, r, "recap: read the session", err)
		return
	}
	if _, out := s.writeAndSaveRecap(ctx, wb, in, source); out != nil {
		switch out.reason {
		case types.RecapReasonAILimit:
			httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
		case types.RecapReasonAIUnavailable:
			httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
				"AI recaps aren't available right now. Try again in a minute.")
		case types.RecapReasonEmpty:
			httpx.Error(w, http.StatusUnprocessableEntity, "empty",
				"There's nothing to recap yet: no captions, questions, polls or chat from this session.")
		default:
			httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
				"The recap couldn't be written just now. Try again in a minute.")
		}
		return
	}
	row, err := s.store.SessionRecap(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "recap: read back", err)
		return
	}
	httpx.JSON(w, http.StatusOK, recapResponse(row))
}
