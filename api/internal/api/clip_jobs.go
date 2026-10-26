package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/clips"
	"github.com/netkumar/webcast/api/internal/highlights"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Clips and reels made from a session's recording (the "clips" switch).
 *
 *   create   POST …/recordings/{id}/clips: a clip (one stretch) or a reel (2-4), in one or more
 *            formats, a job per format. Everything the render needs is settled here: where
 *            each stretch lies in its take's file (clips.Segments) and the burned-in captions
 *            and hook title as an ASS script (clips.ASS) from the transcript's timings. Then
 *            the suggested post text, one AI call (AI_MODEL_HIGHLIGHTS, feature
 *            "clip_posts") inside the request, in the host's brand voice; a failure there
 *            leaves the clip queued and the text to "Write it again".
 *   render   on the video server, by the mix recorder (deploy/livekit-hetzner/mixrec): it
 *            claims a job over /api/internal/clip-jobs (MIXREC_SECRET), gets signed URLs to
 *            read the takes and write the MP4, and reports progress, which renews its lease.
 *            Never while a session is live or about to start on that server: the claim says
 *            "not now", and a session that starts mid-render sends the job back to the queue.
 *   wait     the on-demand video server (sfu_box.go) is not started for clips: a queued clip
 *            waits for the next time it is up for a session. A clip being made keeps it up
 *            (boxInputs.Clips), so it is never deleted mid-render. An admin's "Make it now"
 *            (POST /api/admin/clips/make-now) marks the queue rushed for clipRushFor, which
 *            makes the server wanted until the queue is made, then it goes again.
 *   keep     a clip's bytes count against its recording owner's storage, and it is deleted
 *            with its recording (the cascade; clip_blob_deletions and sweepClipBlobs take its
 *            file out of storage).
 *
 * Under requireOwnership, as the highlights: the host and co-hosts. */

const (
	// clipLease is how long a claim holds without a progress report (they come every 20 s).
	clipLease = 3 * time.Minute
	// clipMaxAttempts is how many times a job is tried before it fails.
	clipMaxAttempts = 3
	// clipMaxUnfinished bounds the clips of one recording waiting or being made at once.
	clipMaxUnfinished = 12
	// clipSourceURLFor is how long the signed read of a take lasts: a render's whole length.
	clipSourceURLFor = 3 * time.Hour
	// clipUploadWindow is how long the signed write of the result lasts.
	clipUploadWindow = time.Hour
	// clipRushFor is how long "Make it now" keeps the video server wanted for the queue.
	clipRushFor = 2 * time.Hour
	// clipPostsBudget bounds the post-text call inside the create request.
	clipPostsBudget = 35 * time.Second
	// clipMaxBytes is the largest result the video server may report.
	clipMaxBytes = 2 << 30
)

// clipGaveUp is what the host reads when every try ran out.
const clipGaveUp = "The video server couldn't finish this clip after several tries. Make it again, or contact support if it keeps happening."

// clipStorageKey is where a clip's MP4 is kept.
func clipStorageKey(id string) string { return "clips/" + id[:2] + "/" + id + ".mp4" }

// clipRec is the recording a clip request is about.
type clipRec struct {
	wb        types.Webinar
	parts     []store.RecordingFile
	sessionID string
}

/* clipRecording loads the recording session behind …/recordings/{id} and checks the host's
 * switch; false when it has answered. */
func (s *Server) clipRecording(w http.ResponseWriter, r *http.Request) (clipRec, bool) {
	ctx := r.Context()
	slug := slugFromContext(ctx)
	parts, err := s.store.SessionParts(ctx, slug, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
		return clipRec{}, false
	}
	if err != nil {
		s.fail(w, r, "clips: parts", err)
		return clipRec{}, false
	}
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.fail(w, r, "clips: webinar", err)
		return clipRec{}, false
	}
	if !s.requireHostFeature(w, r, wb.Host.ID, types.FeatureClips) {
		return clipRec{}, false
	}
	rc := clipRec{wb: wb, parts: parts, sessionID: parts[0].ID}
	for _, p := range parts {
		if p.ParentID == "" {
			rc.sessionID = p.ID
			break
		}
	}
	return rc, true
}

// clipsAvailable is whether this instance can make clips at all, and why not in plain words.
func (s *Server) clipsAvailable() (bool, string) {
	if s.cfg.MixRecSecret == "" {
		return false, "Clips are made on the video server, and it isn't set up to make them on this site yet."
	}
	_, put := s.recordings.(media.PutPresigner)
	_, get := s.recordings.(media.Presigner)
	if !put || !get {
		return false, "Clips need cloud storage for recordings, which this site doesn't use."
	}
	return true, ""
}

// ---------------------------------------------------------------- the host's endpoints

// handleListClips is GET /api/host/webinars/{slug}/recordings/{id}/clips.
func (s *Server) handleListClips(w http.ResponseWriter, r *http.Request) {
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	out, err := s.clipsResponse(r.Context(), rc.sessionID)
	if err != nil {
		s.fail(w, r, "clips: list", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) clipsResponse(ctx context.Context, sessionID string) (types.ClipsResponse, error) {
	rows, err := s.store.ClipJobs(ctx, sessionID)
	if err != nil {
		return types.ClipsResponse{}, err
	}
	out := types.ClipsResponse{Clips: make([]types.Clip, 0, len(rows))}
	out.Available, out.Reason = s.clipsAvailable()
	queued := false
	for _, j := range rows {
		out.Clips = append(out.Clips, clipOut(j))
		queued = queued || j.Status == store.ClipQueued
	}
	out.Server = s.clipServer(ctx)
	user := userFromContext(ctx)
	out.CanMakeNow = user.IsAdmin && queued && s.box != nil &&
		(out.Server.State == types.ClipServerWaiting || out.Server.State == types.ClipServerStarting)
	return out, nil
}

func clipOut(j store.ClipJobRow) types.Clip {
	c := types.Clip{
		ID: j.ID, Kind: j.Kind, SourceID: j.SourceID, Title: j.Title, Format: j.Format, Framing: j.Framing,
		Captions: j.Captions, Hook: j.Hook, DurationSec: j.DurationSec, Status: j.Status, Error: j.Error,
		Progress: j.Progress, SizeBytes: j.SizeBytes, PostStatus: j.PostStatus, Posts: []types.ClipPost{},
		Ranges:    []types.ClipRange{},
		CreatedAt: j.CreatedAt.UTC().Format(time.RFC3339),
	}
	if j.FinishedAt != nil {
		c.FinishedAt = j.FinishedAt.UTC().Format(time.RFC3339)
	}
	var segs []clips.Segment
	if json.Unmarshal(j.Segments, &segs) == nil {
		for _, sg := range segs {
			c.Ranges = append(c.Ranges, types.ClipRange{StartSec: sg.PlayerStart, EndSec: sg.PlayerEnd})
		}
	}
	if len(j.Posts) > 0 {
		_ = json.Unmarshal(j.Posts, &c.Posts)
	}
	if c.Status == store.ClipFailed && c.Error == "" {
		c.Error = "This clip couldn't be made."
	}
	return c
}

/* clipServer is where the video server stands for clips, in the host's words. A static video
 * server (not the on-demand box) is always up: only a live session holds clips back there. */
func (s *Server) clipServer(ctx context.Context) types.ClipServer {
	busy := types.ClipServer{State: types.ClipServerBusy,
		Text: "Waiting for the live session on the video server to finish, so making clips can't slow it down. They'll start on their own after it."}
	ready := types.ClipServer{State: types.ClipServerReady,
		Text: "The video server is making your clips, one at a time. A minute of video takes a few minutes."}
	if s.box == nil {
		if live, _ := s.clipsHeldBack(ctx); live {
			return busy
		}
		return ready
	}
	st, err := s.boxState(ctx, s.box) // clips are made on the primary box
	if err != nil {
		return types.ClipServer{State: types.ClipServerWaiting, Text: "Waiting for the video server."}
	}
	switch st.Actual {
	case store.BoxReady, store.BoxDraining:
		if live, _ := s.clipsHeldBack(ctx); live {
			return busy
		}
		return ready
	case store.BoxCreating, store.BoxBooting:
		return types.ClipServer{State: types.ClipServerStarting,
			Text: "The video server is starting. Your clips will be made once it's up and no session is live on it."}
	}
	return types.ClipServer{State: types.ClipServerWaiting,
		Text: "Waiting for the video server. To save cost it only runs around your sessions, so these clips will be made the next time it's up (usually around your next session). They're kept in the queue until then."}
}

/* clipsHeldBack is whether clips must wait: a session live, or about to start, on the video
 * server they are made on (the on-demand box's project; any session at all on a static one). */
func (s *Server) clipsHeldBack(ctx context.Context) (bool, error) {
	def := s.defaultCostProject()
	if s.box != nil {
		d, err := s.store.SFUBoxDemand(ctx, s.box.cfg.Project, def, s.box.cfg.WarmLead)
		if err != nil {
			return true, err
		}
		return d.Live > 0 || d.Soon > 0, nil
	}
	live, err := s.store.LiveSessions(ctx, def)
	if err != nil {
		return true, err
	}
	return len(live) > 0, nil
}

// clipFormatsOK is the formats asked for, each once and each a format.
func clipFormatsOK(formats []string) ([]string, bool) {
	seen := map[string]bool{}
	var out []string
	for _, f := range formats {
		if _, ok := clips.SizeOf(f); !ok {
			return nil, false
		}
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out, len(out) > 0
}

// clipLengthProblem is what is wrong with a clip's or reel's length, in plain words.
func clipLengthProblem(kind string, segs []clips.Segment) string {
	total := clips.Total(segs)
	if kind == types.ClipKindClip {
		if len(segs) != 1 {
			return "A clip is one stretch of the recording."
		}
		if total < types.ClipMinSec || total > types.ClipMaxSec {
			return fmt.Sprintf("A clip has to be %d seconds to %d minutes long.", types.ClipMinSec, types.ClipMaxSec/60)
		}
		return ""
	}
	if len(segs) < types.ReelMinMoments || len(segs) > types.ReelMaxMoments {
		return fmt.Sprintf("A reel stitches %d to %d moments.", types.ReelMinMoments, types.ReelMaxMoments)
	}
	for _, sg := range segs {
		if sg.Duration() < 2 || sg.Duration() > 30 {
			return "Each moment of a reel has to be 2 to 30 seconds long."
		}
	}
	if total < 10 || total > 90 {
		return "A reel has to be 10 to 90 seconds long in all (30 to 60 works best)."
	}
	return ""
}

// clipLine is one caption line of a recording on its player timeline, and whether it was said
// while AI was paused (kept off anything sent to a model; it is still captioned).
type clipLine struct {
	clips.Line
	aiOff bool
}

// clipLines is every caption line of the takes on the player timeline, oldest first.
func (s *Server) clipLines(ctx context.Context, wb types.Webinar, takes []store.RecordingFile) ([]clipLine, []highlights.Part, error) {
	spans, ok := captionSpans(takes, "")
	if !ok {
		return nil, nil, nil
	}
	ids := make([]string, len(takes))
	for i, t := range takes {
		ids[i] = t.ID
	}
	parts := highlights.Parts(spans, ids)
	lines, err := s.captionLines(ctx, wb, spans)
	if err != nil {
		return nil, nil, err
	}
	off, err := s.store.AIOffWindows(ctx, wb.ID)
	if err != nil {
		return nil, nil, err
	}
	out := make([]clipLine, 0, len(lines))
	for _, l := range lines {
		start, ok := highlights.OnPlaylist(spans, l.Start)
		if !ok {
			continue
		}
		end := start
		if !l.End.IsZero() {
			if e, ok := highlights.OnPlaylist(spans, l.End); ok && e > start {
				end = e
			}
		}
		out = append(out, clipLine{Line: clips.Line{StartSec: start, EndSec: end, Text: l.Text}, aiOff: off.Contains(l.Start)})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartSec < out[j].StartSec })
	return out, parts, nil
}

// saidIn is the text of the lines inside the segments (in their order), leaving out what was
// said while AI was paused: what the post text is written from.
func saidIn(lines []clipLine, segs []clips.Segment) []string {
	var out []string
	for _, sg := range segs {
		for _, l := range lines {
			if l.aiOff || l.EndSec <= sg.PlayerStart || l.StartSec >= sg.PlayerEnd {
				continue
			}
			out = append(out, l.Text)
		}
	}
	return out
}

// handleCreateClips is POST /api/host/webinars/{slug}/recordings/{id}/clips.
func (s *Server) handleCreateClips(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	if ok, why := s.clipsAvailable(); !ok {
		httpx.Error(w, http.StatusConflict, "clips_unavailable", why)
		return
	}
	var req types.CreateClipsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Bad request.")
		return
	}
	if req.Kind != types.ClipKindClip && req.Kind != types.ClipKindReel {
		httpx.Error(w, http.StatusBadRequest, "bad_kind", "Make a clip or a reel.")
		return
	}
	formats, ok := clipFormatsOK(req.Formats)
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "bad_format", "Pick at least one format: 9:16, 1:1 or 16:9.")
		return
	}
	if req.Framing == "" {
		req.Framing = types.ClipFramingFit
	}
	if !clips.ValidFraming(req.Framing) {
		httpx.Error(w, http.StatusBadRequest, "bad_framing", "Pick how the picture fills the frame.")
		return
	}
	hook := aiwrite.Hook(req.Hook)
	title := strings.Join(strings.Fields(req.Title), " ")
	if r := []rune(title); len(r) > types.ClipTitleMaxRunes {
		title = string(r[:types.ClipTitleMaxRunes])
	}
	if title == "" {
		title = map[string]string{types.ClipKindClip: "Clip", types.ClipKindReel: "Reel"}[req.Kind]
	}
	if rc.wb.Status != types.StatusEnded {
		httpx.Error(w, http.StatusConflict, aiStatusNotEnded, "Clips can be made once the session has ended.")
		return
	}
	takes := captionTakes(rc.parts)
	if len(takes) == 0 {
		httpx.Error(w, http.StatusConflict, types.HighlightsNotReady, "This recording isn't ready to play yet.")
		return
	}
	lines, parts, err := s.clipLines(ctx, rc.wb, takes)
	if err != nil {
		s.fail(w, r, "clips: lines", err)
		return
	}
	if len(parts) == 0 {
		httpx.Error(w, http.StatusConflict, types.HighlightsNotReady, "This recording isn't ready to play yet.")
		return
	}
	segs, err := clips.Segments(req.Ranges, parts)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_range", err.Error())
		return
	}
	if why := clipLengthProblem(req.Kind, segs); why != "" {
		httpx.Error(w, http.StatusBadRequest, "bad_length", why)
		return
	}

	// Room: in the queue, and in the host's storage.
	unfinished, err := s.store.UnfinishedClipJobs(ctx, rc.sessionID)
	if err != nil {
		s.fail(w, r, "clips: count", err)
		return
	}
	if unfinished+len(formats) > clipMaxUnfinished {
		httpx.Error(w, http.StatusConflict, "too_many_clips",
			fmt.Sprintf("Up to %d clips of a recording can wait to be made at once. Make more once some are done.", clipMaxUnfinished))
		return
	}
	if st, err := s.store.RecordingStorageFor(ctx, rc.wb.Host.ID, s.cfg.RecordingsRetentionDays); err == nil && st.QuotaBytes > 0 && st.UsedBytes >= st.QuotaBytes {
		httpx.JSON(w, http.StatusConflict, types.RecordingQuotaError{
			Error: "quota_exceeded", Message: "Your recording storage is full. Delete recordings or clips you no longer need to make room.",
			UsedBytes: st.UsedBytes, QuotaBytes: st.QuotaBytes,
		})
		return
	} else if err != nil {
		s.fail(w, r, "clips: storage", err)
		return
	}

	var words []clips.Word
	if req.Captions {
		cl := make([]clips.Line, len(lines))
		for i, l := range lines {
			cl[i] = l.Line
		}
		words = clips.OnClip(clips.Words(cl), segs)
	}
	total := clips.Total(segs)
	postStatus := types.ClipPostPending
	if s.aiOutputGate(ctx, rc.wb) != "" {
		postStatus = types.ClipPostOff
	}
	user := userFromContext(ctx)
	jobs := make([]store.NewClipJob, 0, len(formats))
	ids := make([]string, 0, len(formats))
	for _, f := range formats {
		id := uuid.NewString()
		ids = append(ids, id)
		jobs = append(jobs, store.NewClipJob{
			ID: id, RecordingID: rc.sessionID, CreatedBy: user.ID, Kind: req.Kind, SourceID: req.SourceID,
			Title: title, Format: f, Framing: req.Framing, Captions: req.Captions, Hook: hook,
			Segments: segs, DurationSec: total, PostStatus: postStatus, StorageKey: clipStorageKey(id),
			Subtitles: clips.ASS(clips.ASSInput{Format: f, Words: words, Hook: hook, DurationSec: total}),
		})
	}
	if err := s.store.CreateClipJobs(ctx, jobs); err != nil {
		s.fail(w, r, "clips: create", err)
		return
	}
	s.log.Info("clips queued", "slug", rc.wb.ID, "recording", rc.sessionID, "kind", req.Kind,
		"formats", strings.Join(formats, ","), "seconds", total, "captions", req.Captions, "words", len(words))
	if postStatus == types.ClipPostPending {
		s.writeClipPosts(ctx, rc.wb, ids, aiwrite.PostsInput{
			Topic: rc.wb.Topic, HostName: rc.wb.Host.Name, Title: title, Hook: hook,
			Said: saidIn(lines, segs), DurationSec: int(total), Reel: req.Kind == types.ClipKindReel,
		})
	}
	out, err := s.clipsResponse(ctx, rc.sessionID)
	if err != nil {
		s.fail(w, r, "clips: list", err)
		return
	}
	httpx.JSON(w, http.StatusCreated, out)
}

/* writeClipPosts writes the post text of the jobs (one clip in its formats) and stores it,
 * whatever the caller does meanwhile. Nothing said in it (no captions there) is a failure
 * the host can retry once there is a transcript. */
func (s *Server) writeClipPosts(parent context.Context, wb types.Webinar, ids []string, in aiwrite.PostsInput) {
	bg := context.WithoutCancel(parent)
	ctx, cancel := context.WithTimeout(bg, clipPostsBudget)
	defer cancel()
	if len(in.Said) == 0 {
		_ = s.store.SaveClipPosts(bg, ids, []types.ClipPost{}, types.ClipPostFailed)
		return
	}
	if v, err := s.store.BrandVoice(ctx, wb.Host.ID); err == nil {
		in.Voice = aiwrite.RepurposeVoice{Tone: v.Tone, Audience: v.Audience, DoWords: v.DoWords, DontWords: v.DontWords, Sample: v.Sample}
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureClipPosts, wb.Host.ID, ai.Request{
		Messages:        aiwrite.PostsMessages(in),
		Schema:          aiwrite.PostsSchema,
		MaxTokens:       aiwrite.PostsMaxTokens,
		ReasoningEffort: "low",
		AttemptTimeout:  30 * time.Second,
	})
	var posts []types.ClipPost
	if err == nil {
		posts, err = aiwrite.ParsePosts(reply.Text)
	}
	if err != nil || len(posts) == 0 {
		if err != nil && !errors.Is(err, errAILimit) && !errors.Is(err, ai.ErrUnavailable) {
			s.log.Warn("clips: post text", "slug", wb.ID, "error", err)
		}
		_ = s.store.SaveClipPosts(bg, ids, []types.ClipPost{}, types.ClipPostFailed)
		return
	}
	if err := s.store.SaveClipPosts(bg, ids, posts, types.ClipPostReady); err != nil {
		s.log.Error("clips: save post text", "slug", wb.ID, "error", err)
	}
}

// clipJob loads …/clips/{clipId} of the recording; false when it has answered.
func (s *Server) clipJob(w http.ResponseWriter, r *http.Request, rc clipRec) (store.ClipJobRow, bool) {
	id := chi.URLParam(r, "clipId")
	if uuid.Validate(id) != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such clip.")
		return store.ClipJobRow{}, false
	}
	j, err := s.store.ClipJob(r.Context(), rc.sessionID, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such clip.")
		return j, false
	}
	if err != nil {
		s.fail(w, r, "clips: load", err)
		return j, false
	}
	return j, true
}

// handleRewriteClipPosts is POST …/clips/{clipId}/posts: "Write it again".
func (s *Server) handleRewriteClipPosts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	j, ok := s.clipJob(w, r, rc)
	if !ok {
		return
	}
	if gate := s.aiOutputGate(ctx, rc.wb); gate != "" {
		httpx.Error(w, http.StatusConflict, gate, highlightRefusals[gate])
		return
	}
	if err := s.aiCapCheck(ctx, types.AIFeatureClipPosts, rc.wb.Host.ID); errors.Is(err, errAILimit) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
		return
	} else if err != nil {
		s.fail(w, r, "clips: cap", err)
		return
	}
	var segs []clips.Segment
	if err := json.Unmarshal(j.Segments, &segs); err != nil {
		s.fail(w, r, "clips: segments", err)
		return
	}
	lines, _, err := s.clipLines(ctx, rc.wb, captionTakes(rc.parts))
	if err != nil {
		s.fail(w, r, "clips: lines", err)
		return
	}
	s.writeClipPosts(ctx, rc.wb, []string{j.ID}, aiwrite.PostsInput{
		Topic: rc.wb.Topic, HostName: rc.wb.Host.Name, Title: j.Title, Hook: j.Hook,
		Said: saidIn(lines, segs), DurationSec: int(j.DurationSec), Reel: j.Kind == types.ClipKindReel,
	})
	out, err := s.clipsResponse(ctx, rc.sessionID)
	if err != nil {
		s.fail(w, r, "clips: list", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleClipFile is GET …/clips/{clipId}/file: the MP4, as a download.
func (s *Server) handleClipFile(w http.ResponseWriter, r *http.Request) {
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	j, ok := s.clipJob(w, r, rc)
	if !ok {
		return
	}
	if j.Status != store.ClipReady {
		httpx.Error(w, http.StatusConflict, "not_ready", "This clip isn't made yet.")
		return
	}
	if !s.redirectRecordingObject(w, r, j.StorageKey, clipFilename(rc.wb.Topic, j), "video/mp4", false) {
		httpx.Error(w, http.StatusNotFound, "file_missing", "The file for this clip is missing.")
	}
}

// clipFilename is a download's name: the title and format, safe for any file system.
func clipFilename(topic string, j store.ClipJobRow) string {
	name := j.Title
	if name == "" {
		name = topic
	}
	var b strings.Builder
	for _, r := range name {
		if b.Len() >= 60 {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteByte('-')
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "clip"
	}
	return base + "-" + j.Format + ".mp4"
}

// handleDeleteClip is DELETE …/clips/{clipId}.
func (s *Server) handleDeleteClip(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	j, ok := s.clipJob(w, r, rc)
	if !ok {
		return
	}
	key, err := s.store.DeleteClipJob(ctx, rc.sessionID, j.ID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such clip.")
		return
	}
	if err != nil {
		s.fail(w, r, "clips: delete", err)
		return
	}
	if j.Status == store.ClipReady && s.recordings != nil {
		if err := s.recordings.Delete(ctx, key); err == nil {
			_ = s.store.ForgetClipBlobs(ctx, []string{key})
		} else {
			s.log.Warn("clips: delete file (the sweep retries)", "key", key, "error", err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// sweepClipBlobs deletes the files of deleted clips (clip_blob_deletions), in batches.
func (s *Server) sweepClipBlobs(ctx context.Context) {
	if _, err := s.store.FailStaleClipJobs(ctx, clipMaxAttempts, clipGaveUp); err != nil {
		s.log.Warn("clips: fail stale", "error", err)
	}
	if s.recordings == nil {
		return
	}
	keys, err := s.store.ClipBlobDeletions(ctx, 200)
	if err != nil {
		s.log.Error("clips: blob deletions", "error", err)
		return
	}
	var done []string
	for _, k := range keys {
		if err := s.recordings.Delete(ctx, k); err != nil && !errors.Is(err, media.ErrNotFound) {
			s.log.Warn("clips: delete file", "key", k, "error", err)
			continue
		}
		done = append(done, k)
	}
	if len(done) > 0 {
		if err := s.store.ForgetClipBlobs(ctx, done); err != nil {
			s.log.Error("clips: forget deleted files", "error", err)
		}
	}
}

// ---------------------------------------------------------------- the admin's "Make it now"

/* handleAdminClipsMakeNow is POST /api/admin/clips/make-now: start the on-demand video server
 * to make the queued clips now rather than at the next session. The queue keeps it wanted for
 * clipRushFor or until it is made; then it goes as it would after a session. */
func (s *Server) handleAdminClipsMakeNow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	n, err := s.store.RushClipJobs(ctx, time.Now().Add(clipRushFor))
	if err != nil {
		s.fail(w, r, "clips: rush", err)
		return
	}
	out := types.ClipMakeNowResponse{Queued: int(min(n, 1<<20))}
	switch {
	case n == 0:
		out.Text = "No clips are waiting."
	case s.box == nil:
		out.Text = "The video server is always on here: it makes the clips as soon as nothing is live on it."
	default:
		if err := s.store.RetrySFUBox(ctx, s.box.cfg.Project); err != nil {
			s.log.Warn("clips: make now: retry box", "error", err)
		}
		s.box.invalidate()
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), boxJoinStepBudget)
		s.boxStep(sctx, s.box)
		cancel()
		out.Text = "Starting the video server to make the waiting clips (a few minutes to start). It goes off again once they're made and nothing else needs it."
	}
	s.log.Info("clips: make now", "admin", userFromContext(ctx).Email, "queued", n)
	httpx.JSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------- the video server's endpoints

// clipWork is a claimed job as the video server renders it.
type clipWork struct {
	ID          string      `json:"id"`
	Format      string      `json:"format"`
	Width       int         `json:"width"`
	Height      int         `json:"height"`
	Framing     string      `json:"framing"`
	Inputs      []clipInput `json:"inputs"`
	Subtitles   string      `json:"subtitles,omitempty"`
	DurationSec float64     `json:"durationSec"`
	LeaseSec    int         `json:"leaseSec"`
}

// clipInput is one stretch: a signed read of its take, and where in it.
type clipInput struct {
	URL         string  `json:"url"`
	StartSec    float64 `json:"startSec"`
	DurationSec float64 `json:"durationSec"`
}

type clipClaimReply struct {
	Job *clipWork `json:"job"`
	// Wait says why there is no job when one may be waiting: "live" (a session is on the
	// server or about to start).
	Wait string `json:"wait,omitempty"`
}

// mountClipJobsInternal adds the video server's clip endpoints, beside the mix recorder's.
func (s *Server) mountClipJobsInternal(r chi.Router) {
	if s.cfg.MixRecSecret == "" {
		return
	}
	r.Group(func(r chi.Router) {
		r.Use(s.requireMixRecSecret)
		r.Post("/internal/clip-jobs/claim", s.handleClipClaim)
		r.Post("/internal/clip-jobs/{id}/progress", s.handleClipProgress)
		r.Post("/internal/clip-jobs/{id}/upload-url", s.handleClipUploadURL)
		r.Post("/internal/clip-jobs/{id}/complete", s.handleClipComplete)
	})
}

// handleClipClaim is POST /api/internal/clip-jobs/claim: the next job, or none.
func (s *Server) handleClipClaim(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	held, err := s.clipsHeldBack(ctx)
	if err != nil {
		s.fail(w, r, "clips: claim: live", err)
		return
	}
	if held {
		httpx.JSON(w, http.StatusOK, clipClaimReply{Wait: "live"})
		return
	}
	signer, ok := s.recordings.(media.Presigner)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "no_object_storage", "Recording storage cannot sign reads.")
		return
	}
	// A job whose recording cannot be read is failed and the next one tried.
	for range 5 {
		j, ok, err := s.store.ClaimClipJob(ctx, clipLease, clipMaxAttempts, clipGaveUp)
		if err != nil {
			s.fail(w, r, "clips: claim", err)
			return
		}
		if !ok {
			httpx.JSON(w, http.StatusOK, clipClaimReply{})
			return
		}
		work, why, err := s.clipWorkFor(ctx, signer, j)
		if err != nil {
			s.fail(w, r, "clips: claim: work", err)
			return
		}
		if why != "" {
			_ = s.store.FailClipJob(ctx, j.ID, why, false, clipMaxAttempts)
			continue
		}
		s.log.Info("clip claimed", "clip", j.ID, "format", j.Format, "attempt", j.Attempts, "seconds", j.DurationSec)
		httpx.JSON(w, http.StatusOK, clipClaimReply{Job: &work})
		return
	}
	httpx.JSON(w, http.StatusOK, clipClaimReply{})
}

// clipWorkFor is the render of j; why, in the host's words, when it cannot be made.
func (s *Server) clipWorkFor(ctx context.Context, signer media.Presigner, j store.ClipJobRow) (clipWork, string, error) {
	size, ok := clips.SizeOf(j.Format)
	if !ok {
		return clipWork{}, "This clip's format isn't one we make any more.", nil
	}
	var segs []clips.Segment
	if err := json.Unmarshal(j.Segments, &segs); err != nil || len(segs) == 0 {
		return clipWork{}, "This clip's moments couldn't be read. Make it again.", nil
	}
	work := clipWork{ID: j.ID, Format: j.Format, Width: size.W, Height: size.H, Framing: j.Framing,
		Subtitles: j.Subtitles, DurationSec: j.DurationSec, LeaseSec: int(clipLease / time.Second)}
	if j.Format == types.ClipFormatWide {
		work.Framing = types.ClipFramingFit
	}
	for _, sg := range segs {
		take, err := s.store.RecordingFileByID(ctx, sg.PartID)
		if errors.Is(err, store.ErrNotFound) {
			return clipWork{}, "The recording this clip comes from is gone.", nil
		}
		if err != nil {
			return clipWork{}, "", err
		}
		if take.Status != types.RecordingReady || take.StorageKey == "" {
			return clipWork{}, "The recording this clip comes from isn't available.", nil
		}
		u, err := signer.PresignedURL(ctx, take.StorageKey, clipSourceURLFor)
		if err != nil {
			return clipWork{}, "", err
		}
		work.Inputs = append(work.Inputs, clipInput{URL: u, StartSec: sg.FileStart, DurationSec: sg.Duration()})
	}
	return work, "", nil
}

type clipProgressBody struct {
	Percent int `json:"percent"`
}

type clipProgressReply struct {
	// Stop tells the video server to drop the job: "gone" (deleted, or no longer its) or
	// "live" (a session started; the job is back in the queue).
	Stop string `json:"stop,omitempty"`
}

// handleClipProgress is POST /api/internal/clip-jobs/{id}/progress: renews the lease.
func (s *Server) handleClipProgress(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	if uuid.Validate(id) != nil {
		httpx.JSON(w, http.StatusOK, clipProgressReply{Stop: "gone"})
		return
	}
	var body clipProgressBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Bad body.")
		return
	}
	if held, err := s.clipsHeldBack(ctx); err == nil && held {
		if err := s.store.RequeueClipJob(ctx, id); err != nil {
			s.fail(w, r, "clips: requeue", err)
			return
		}
		s.log.Info("clip back in the queue: a session is live", "clip", id)
		httpx.JSON(w, http.StatusOK, clipProgressReply{Stop: "live"})
		return
	}
	ok, err := s.store.ClipJobProgress(ctx, id, body.Percent, clipLease)
	if err != nil {
		s.fail(w, r, "clips: progress", err)
		return
	}
	if !ok {
		httpx.JSON(w, http.StatusOK, clipProgressReply{Stop: "gone"})
		return
	}
	httpx.JSON(w, http.StatusOK, clipProgressReply{})
}

// handleClipUploadURL is POST /api/internal/clip-jobs/{id}/upload-url: one signed PUT.
func (s *Server) handleClipUploadURL(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	j, err := s.store.ClipJobByID(ctx, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && j.Status != store.ClipProcessing) || uuid.Validate(chi.URLParam(r, "id")) != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such clip being made.")
		return
	}
	if err != nil {
		s.fail(w, r, "clips: upload url", err)
		return
	}
	signer, ok := s.recordings.(media.PutPresigner)
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "no_object_storage", "Recording storage cannot take an upload.")
		return
	}
	u, err := signer.PresignedPutURL(ctx, j.StorageKey, "video/mp4", clipUploadWindow)
	if err != nil {
		s.fail(w, r, "clips: presign", err)
		return
	}
	httpx.JSON(w, http.StatusOK, mixRecUpload{URL: u, ContentType: "video/mp4"})
}

type clipResult struct {
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
	// Retry says the failure may pass (the network, the server restarting); false is the
	// job itself (its source cannot be read or decoded).
	Retry bool `json:"retry,omitempty"`
}

/* handleClipComplete is POST /api/internal/clip-jobs/{id}/complete: made (a size) or failed
 * (an error). A job deleted while it was being made has its uploaded file deleted here. */
func (s *Server) handleClipComplete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	if uuid.Validate(id) != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such clip.")
		return
	}
	var body clipResult
	if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Bad body.")
		return
	}
	if body.SizeBytes < 0 || body.SizeBytes > clipMaxBytes || body.DurationMs < 0 || body.DurationMs > int64(time.Hour/time.Millisecond) {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_stats", "Bad size or duration.")
		return
	}
	if body.Error != "" || body.SizeBytes == 0 {
		s.log.Warn("clip failed on the video server", "clip", id, "retry", body.Retry, "error", body.Error)
		if err := s.store.FailClipJob(ctx, id, "The video server couldn't make this clip. Make it again, or contact support if it keeps happening.",
			body.Retry, clipMaxAttempts); err != nil {
			s.fail(w, r, "clips: fail", err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ok, err := s.store.FinishClipJob(ctx, id, body.SizeBytes, body.DurationMs)
	if err != nil {
		s.fail(w, r, "clips: finish", err)
		return
	}
	if !ok {
		// Deleted (or taken back) while it was being made: its file has no row.
		if _, err := s.store.ClipJobByID(ctx, id); errors.Is(err, store.ErrNotFound) && s.recordings != nil {
			_ = s.recordings.Delete(ctx, clipStorageKey(id))
		}
		httpx.Error(w, http.StatusConflict, "gone", "That clip is no longer wanted.")
		return
	}
	s.log.Info("clip made", "clip", id, "bytes", body.SizeBytes, "ms", body.DurationMs)
	w.WriteHeader(http.StatusNoContent)
}
