package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The Studio (the clips switch): a host's recordings, the clips and reels made from them, and
 * a light content plan, across all their sessions.
 *
 *   GET   /api/host/studio/recordings?q=&cursor=   recording sessions of the host's own ended
 *         sessions, with where highlights, reels and clips stand. Read from the stored rows:
 *         listing never asks the AI for anything ("Find highlights" is the recording's own
 *         POST …/recordings/{id}/highlights).
 *   GET   /api/host/studio/clips?status=&cursor=    every clip and reel made from them, with
 *         its plan.
 *   PATCH /api/host/webinars/{slug}/recordings/{id}/clips/{clipId}/plan   a clip's plan, under
 *         the clip's own route and rules (host and co-hosts, the session host's switch).
 *
 * The two lists are the caller's own sessions only: the switch that lets a co-host work on a
 * session's clips is that session host's, so their clips stay on the session's Recording tab.
 * Planning is planning: nothing is posted anywhere from here. */

// studioLimit is ?limit=, bounded; the default page otherwise.
func studioLimit(r *http.Request) int {
	n, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || n <= 0 {
		return types.StudioPageSize
	}
	if n > types.StudioMaxPage {
		return types.StudioMaxPage
	}
	return n
}

// studioAllowed checks the caller's own switch; false when it has answered.
func (s *Server) studioAllowed(w http.ResponseWriter, r *http.Request) bool {
	user := userFromContext(r.Context())
	return s.requireHostFeature(w, r, user.ID, types.FeatureClips)
}

// handleStudioRecordings is GET /api/host/studio/recordings.
func (s *Server) handleStudioRecordings(w http.ResponseWriter, r *http.Request) {
	if !s.studioAllowed(w, r) {
		return
	}
	user := userFromContext(r.Context())
	q := r.URL.Query()
	search := q.Get("q")
	if len([]rune(search)) > 200 {
		search = string([]rune(search)[:200])
	}
	rows, next, err := s.store.StudioRecordings(r.Context(), user.ID, search, q.Get("cursor"), studioLimit(r))
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusBadRequest, "bad_cursor", "That page link is out of date. Reload the list.")
		return
	}
	if err != nil {
		s.fail(w, r, "studio: recordings", err)
		return
	}
	out := types.StudioRecordingsResponse{Recordings: make([]types.StudioRecording, 0, len(rows)), NextCursor: next}
	for _, row := range rows {
		out.Recordings = append(out.Recordings, types.StudioRecording{
			ID: row.ID, Slug: row.Slug, Topic: row.Topic, Kind: row.Kind,
			SessionAt:  row.SessionAt.UTC().Format(time.RFC3339),
			CreatedAt:  row.CreatedAt.UTC().Format(time.RFC3339),
			DurationMs: row.DurationMs, Takes: row.Takes, ThumbPartID: row.ThumbPartID,
			HighlightsStatus: studioAIStatus(row.Highlights), Highlights: row.Highlights.Count,
			ReelsStatus: studioAIStatus(row.Reels), Reels: row.Reels.Count,
			ClipsReady: row.ClipsReady, ClipsPending: row.ClipsPending, ClipsFailed: row.ClipsFailed,
		})
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

/* studioAIStatus is a stored suggestions row as the recording's own endpoint words it, with
 * not_started for none asked for yet, and for a write that was claimed but never finished
 * (its claim ran out): asking again is what either needs. */
func studioAIStatus(row store.StudioAIRow) string {
	if !row.Found {
		return types.StudioNotStarted
	}
	switch row.Status {
	case store.AIOutputReady:
		return types.AIStatusReady
	case store.AIOutputFailed:
		if row.Reason == "" {
			return aiStatusFailed
		}
		return row.Reason
	}
	if row.Claimed {
		return aiStatusProcessing
	}
	return types.StudioNotStarted
}

// handleStudioClips is GET /api/host/studio/clips.
func (s *Server) handleStudioClips(w http.ResponseWriter, r *http.Request) {
	if !s.studioAllowed(w, r) {
		return
	}
	ctx := r.Context()
	user := userFromContext(ctx)
	q := r.URL.Query()
	status := q.Get("status")
	switch status {
	case "", types.StudioClipsReady, types.StudioClipsPending, types.StudioClipsFailed:
	default:
		httpx.Error(w, http.StatusBadRequest, "bad_status", "Pick ready, pending or failed.")
		return
	}
	rows, next, err := s.store.StudioClips(ctx, user.ID, status, q.Get("cursor"), studioLimit(r))
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusBadRequest, "bad_cursor", "That page link is out of date. Reload the list.")
		return
	}
	if err != nil {
		s.fail(w, r, "studio: clips", err)
		return
	}
	out := types.StudioClipsResponse{Clips: make([]types.StudioClip, 0, len(rows)), NextCursor: next}
	queued := false
	for _, row := range rows {
		c := types.StudioClip{
			Clip: clipOut(row.Job), Slug: row.Slug, RecordingID: row.Job.RecordingID, Topic: row.Topic,
			SessionAt: row.SessionAt.UTC().Format(time.RFC3339),
		}
		if row.Plan != nil {
			p := planOut(*row.Plan)
			c.Plan = &p
		}
		queued = queued || row.Job.Status == store.ClipQueued
		out.Clips = append(out.Clips, c)
	}
	// Where the video server stands only matters, and is only looked up, when a clip waits.
	if queued {
		out.Server = s.clipServer(ctx)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, out)
}

func planOut(p store.ClipPlanRow) types.ClipPlan {
	out := types.ClipPlan{Platforms: p.Platforms, Status: p.Status, Note: p.Note,
		UpdatedAt: p.UpdatedAt.UTC().Format(time.RFC3339)}
	if out.Platforms == nil {
		out.Platforms = []string{}
	}
	if p.PlannedOn != nil {
		out.PlannedOn = p.PlannedOn.Format(time.DateOnly)
	}
	return out
}

// clipPlatforms is every platform a plan can name, in the order the Studio shows them.
var clipPlatforms = []string{types.ClipPlatformReels, types.ClipPlatformShorts, types.ClipPlatformTikTok,
	types.ClipPlatformLinkedIn, types.ClipPlatformYouTube}

/* clipPlanFrom checks a plan as the host sent it and tidies it: platforms known and each once
 * (in the Studio's order), a real day, a known status, a scheduled clip with a day, a note
 * within bounds. The problem is in plain words; empty means fine. */
func clipPlanFrom(in types.ClipPlanInput) (store.ClipPlanRow, string) {
	var out store.ClipPlanRow
	want := map[string]bool{}
	for _, p := range in.Platforms {
		known := false
		for _, k := range clipPlatforms {
			known = known || k == p
		}
		if !known {
			return out, "Pick platforms from the list."
		}
		want[p] = true
	}
	out.Platforms = []string{}
	for _, k := range clipPlatforms {
		if want[k] {
			out.Platforms = append(out.Platforms, k)
		}
	}
	if day := strings.TrimSpace(in.PlannedOn); day != "" {
		t, err := time.Parse(time.DateOnly, day)
		if err != nil || t.Year() < 2000 || t.Year() > 2100 {
			return out, "Pick a real date."
		}
		out.PlannedOn = &t
	}
	switch in.Status {
	case "":
		out.Status = types.ClipPlanIdea
	case types.ClipPlanIdea, types.ClipPlanScheduled, types.ClipPlanPosted:
		out.Status = in.Status
	default:
		return out, "Pick idea, scheduled or posted."
	}
	if out.Status == types.ClipPlanScheduled && out.PlannedOn == nil {
		return out, "Pick a date to schedule it."
	}
	out.Note = strings.TrimSpace(in.Note)
	if len([]rune(out.Note)) > types.ClipPlanNoteMaxRunes {
		return out, "Keep the note under " + strconv.Itoa(types.ClipPlanNoteMaxRunes) + " characters."
	}
	return out, ""
}

// handlePatchClipPlan is PATCH /api/host/webinars/{slug}/recordings/{id}/clips/{clipId}/plan.
func (s *Server) handlePatchClipPlan(w http.ResponseWriter, r *http.Request) {
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	j, ok := s.clipJob(w, r, rc)
	if !ok {
		return
	}
	var in types.ClipPlanInput
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_json", "Bad request.")
		return
	}
	plan, why := clipPlanFrom(in)
	if why != "" {
		httpx.Error(w, http.StatusBadRequest, "bad_plan", why)
		return
	}
	if j.Status != store.ClipReady {
		httpx.Error(w, http.StatusConflict, "not_ready", "Plan a clip once it's made.")
		return
	}
	user := userFromContext(r.Context())
	saved, err := s.store.SaveClipPlan(r.Context(), rc.sessionID, j.ID, user.ID, plan)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such clip.")
		return
	}
	if err != nil {
		s.fail(w, r, "studio: plan", err)
		return
	}
	httpx.JSON(w, http.StatusOK, planOut(saved))
}
