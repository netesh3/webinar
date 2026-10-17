package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* handleCopyWebinar is POST /api/host/webinars/{slug}/copy: a new draft written
 * the same way as this one, for the host to date and schedule.
 *
 * It goes through createWebinar, so the copy passes every check a new webinar
 * does (the plan's ceiling, the feature switches) rather than inheriting a limit
 * the account may no longer have. What a session produced stays behind:
 * registrants, attendance, recordings, chat, Q&A, votes, scores and the outbox.
 * A recurring session becomes one standalone webinar. Panelists are listed but
 * not emailed: invites go out when the draft is scheduled (syncPanelistMail
 * skips drafts). Under requireTrueOwner, so the copy belongs to the host. */
func (s *Server) handleCopyWebinar(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	user := userFromContext(r.Context())

	src, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "copy webinar: load", err)
		return
	}
	panel, err := s.store.PanelistContacts(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "copy webinar: panelists", err)
		return
	}

	in := copyInput(src, panel, time.Now())
	if in.Kind == types.KindSimulive && !s.ownsReadyRecording(r.Context(), user.ID, in.SimuliveRecordingID) {
		in.Kind, in.SimuliveRecordingID = types.KindLive, ""
	}
	if in.Options.AutoRecord && !user.HasFeature(types.FeatureCloudRecording) {
		in.Options.AutoRecord = false
	}
	if zoom.IsVenue(in.Venue) && !user.HasFeature(types.FeatureZoom) {
		in.Venue = zoom.VenueApp
	}

	wb, ok := s.createWebinar(w, r, user, in)
	if !ok {
		return
	}
	if err := s.store.CopyWebinarExtras(r.Context(), user.ID, slug, wb.ID); err != nil {
		s.log.Warn("copy webinar: polls and survey", "from", slug, "to", wb.ID, "error", err)
	}
	if err := s.engage.CopyWebinarMessages(r.Context(), user.ID, slug, wb.ID); err != nil {
		s.log.Warn("copy webinar: message setup", "from", slug, "to", wb.ID, "error", err)
	}
	if err := s.copyCover(r.Context(), slug, wb.ID); err != nil {
		s.log.Warn("copy webinar: cover", "from", slug, "to", wb.ID, "error", err)
	}

	wb, err = s.store.WebinarBySlug(r.Context(), wb.ID)
	if err != nil {
		s.fail(w, r, "copy webinar: reload", err)
		return
	}
	s.log.Info("webinar copied", "from", slug, "to", wb.ID, "host", user.ID)
	httpx.JSON(w, http.StatusCreated, wb)
}

// copyTopic is "Copy of …", kept under the topic limit normalizeWebinarInput enforces.
func copyTopic(topic string) string {
	t := "Copy of " + strings.TrimSpace(topic)
	for len(t) > 200 {
		_, size := utf8.DecodeLastRuneInString(t)
		t = t[:len(t)-size]
	}
	return strings.TrimSpace(t)
}

/* copyStart is the source's weekday and time of day, next week or later: a copy
 * is usually the same session run again. At least a day ahead, so it clears the
 * scheduling lead whatever the source's date was. The host is told to confirm it. */
func copyStart(src string, now time.Time) string {
	t, err := time.Parse(time.RFC3339, src)
	if err != nil {
		t = now.Add(7 * 24 * time.Hour).Truncate(time.Hour)
	}
	for !t.After(now.Add(24 * time.Hour)) {
		t = t.Add(7 * 24 * time.Hour)
	}
	return t.UTC().Format(time.RFC3339)
}

// copyInput is the schedule form filled in from src, as a draft.
func copyInput(src types.Webinar, panel []store.PanelistContact, now time.Time) types.WebinarInput {
	kind := src.Kind
	if kind == types.KindRecurring || src.SeriesID != "" {
		kind = types.KindLive
	}
	questions := make([]types.CustomQuestion, 0, len(src.CustomQuestions))
	for _, q := range src.CustomQuestions {
		q.ID = ""
		questions = append(questions, q)
	}
	emails := make([]string, 0, len(panel))
	for _, p := range panel {
		emails = append(emails, p.Email)
	}
	venue := src.Venue
	if venue == "" {
		venue = zoom.VenueApp
	}
	return types.WebinarInput{
		Topic:                copyTopic(src.Topic),
		Summary:              src.Summary,
		Descript:             src.Descript,
		Track:                src.Track,
		StartsAt:             copyStart(src.StartsAt, now),
		Duration:             src.Duration,
		TimeZone:             src.TimeZone,
		Kind:                 kind,
		Status:               types.StatusDraft,
		SimuliveRecordingID:  src.SimuliveRecordingID,
		RegistrationRequired: src.RegistrationRequired,
		Approval:             src.Approval,
		AttendeeLimit:        src.AttendeeLimit,
		Passcode:             src.Passcode,
		Agenda:               src.Agenda,
		Takeaways:            src.Takeaways,
		CustomQuestions:      questions,
		PanelistEmails:       emails,
		Options:              src.Options,
		Controls:             src.Controls,
		Venue:                venue,
	}
}

// ownsReadyRecording is whether a simulive copy may keep playing this recording.
func (s *Server) ownsReadyRecording(ctx context.Context, hostID, recordingID string) bool {
	if recordingID == "" {
		return false
	}
	list, err := s.store.HostReadyRecordings(ctx, hostID)
	if err != nil {
		s.log.Warn("copy webinar: recordings", "host", hostID, "error", err)
		return false
	}
	for _, rec := range list {
		if rec.ID == recordingID {
			return true
		}
	}
	return false
}

/* copyCover gives the copy its own cover file. Never the source's key: covers
 * belong to one row each (images.go), so replacing or deleting either webinar's
 * cover leaves the other's alone. */
func (s *Server) copyCover(ctx context.Context, fromSlug, toSlug string) error {
	data, mime, key, err := s.store.WebinarImageMedia(ctx, fromSlug)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if key != "" && s.recordings != nil {
		file, _, err := s.recordings.Open(ctx, key)
		if err != nil {
			return err
		}
		data, err = io.ReadAll(io.LimitReader(file, maxWebinarImageBytes+1))
		file.Close()
		if err != nil {
			return err
		}
	}
	if len(data) == 0 {
		return nil
	}
	newData, newKey := data, ""
	if s.recordings != nil {
		newKey = coverKey(toSlug, mime)
		if err := s.putImage(ctx, newKey, data); err != nil {
			s.dropImage(ctx, newKey)
			return err
		}
		newData = nil
	}
	old, err := s.store.SetWebinarImage(ctx, toSlug, mime, newData, newKey)
	if err != nil {
		s.dropImage(ctx, newKey)
		return err
	}
	s.dropImage(ctx, old)
	return nil
}
