package api

import (
	"context"
	"errors"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/types"
)

// StartMeetingLimitSweeper runs a background loop that checks for live webinars
// that have exceeded their maximum configured duration, and ends them cleanly.
func (s *Server) StartMeetingLimitSweeper(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepExpiredWebinars(ctx)
			s.sweepEmptyWebinars(ctx)
			s.sweepBroadcasts(ctx)
			s.sweepSimulive(ctx)
			s.reconcileEgressRecordings(ctx)
			s.flushOutbox(ctx)
			/* Drip steps are queued before the outbox is flushed, so a step that
			 * came due in the last thirty seconds goes out on this tick rather
			 * than waiting for the next one. */
			s.AdvanceDrips(ctx)
			/* And then the bots, which are the other way round: a woken flow sends
			 * its own messages inline rather than queueing them, so it goes after
			 * AdvanceDrips only so that a flow which enrols somebody and then waits
			 * is not a tick behind the sequence it just put them on. */
			s.AdvanceBots(ctx)
			s.flushWhatsAppOutbox(ctx)
		}
	}
}

func (s *Server) sweepExpiredWebinars(ctx context.Context) {
	slugs, err := s.store.ExpiredLiveWebinars(ctx)
	if err != nil {
		s.log.Error("meeting limit sweeper: query failed", "error", err)
		return
	}

	for _, slug := range slugs {
		s.log.Warn("meeting limit sweeper: terminating webinar that reached maximum duration", "slug", slug)
		if wb, err := s.endWebinarSession(ctx, slug); err != nil {
			s.log.Error("meeting limit sweeper: end session failed", "slug", slug, "error", err)
		} else {
			s.log.Info("meeting limit sweeper: webinar automatically closed", "slug", slug, "maxDurationMin", wb.MaxDurationMin)
		}
	}
}

/* sweepEmptyWebinars ends a live webinar that nobody is in.
 *
 * A host who closes the tab rather than pressing End leaves the room live: the
 * session keeps counting against the meeting limit, any Egress keeps encoding,
 * and the webinar sits in the listing as if it were happening. Only rooms past
 * their scheduled start are considered, so a host who opens early and waits is
 * left alone.
 *
 * Emptiness is measured over time rather than at an instant, and the clock is
 * in the database rather than in this process: a single empty poll is what a
 * mass reconnect looks like from here, and Cloud Run replaces instances often
 * enough that in-memory state would keep restarting the count.
 */
func (s *Server) sweepSimulive(ctx context.Context) {
	due, err := s.store.DueSimuliveSlugs(ctx)
	if err != nil {
		s.log.Error("simulive sweeper: due query failed", "error", err)
		return
	}
	for _, slug := range due {
		wb, err := s.store.SetStatus(ctx, slug, types.StatusLive)
		if err != nil {
			s.log.Error("simulive sweeper: start failed", "slug", slug, "error", err)
			continue
		}
		s.log.Info("simulive started", "slug", slug)
		if sfu, err := s.sfuFor(ctx, wb); err == nil {
			_, _, _, _ = s.ensureRoom(ctx, wb, lk.RoomName(slug))
			if meta, err := s.roomMetadata(ctx, wb); err == nil {
				_ = sfu.SetMetadata(ctx, lk.RoomName(slug), meta)
			}
		}
	}

	expired, err := s.store.ExpiredSimuliveSlugs(ctx)
	if err != nil {
		s.log.Error("simulive sweeper: expiry query failed", "error", err)
		return
	}
	for _, slug := range expired {
		if _, err := s.endWebinarSession(ctx, slug); err != nil {
			s.log.Error("simulive sweeper: end failed", "slug", slug, "error", err)
		}
	}
}

func (s *Server) sweepEmptyWebinars(ctx context.Context) {
	grace := time.Duration(s.cfg.EmptyRoomCloseMin) * time.Minute
	if grace <= 0 {
		return
	}

	slugs, err := s.store.LiveWebinarsPastStart(ctx)
	if err != nil {
		s.log.Error("empty room sweeper: query failed", "error", err)
		return
	}

	for _, slug := range slugs {
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if err != nil {
			continue
		}
		if wb.Kind == types.KindSimulive {
			continue
		}
		sfu, err := s.sfuFor(ctx, wb)
		if err != nil {
			continue
		}
		count, err := sfu.ParticipantCount(ctx, lk.RoomName(slug))
		if err != nil {
			// An SFU we cannot reach is not an empty room. Ending a live webinar
			// on a failed API call would be the worst possible reading of it.
			s.log.Warn("empty room sweeper: participant count failed", "slug", slug, "error", err)
			continue
		}
		emptyFor, err := s.store.MarkWebinarEmptiness(ctx, slug, count == 0)
		if err != nil {
			s.log.Warn("empty room sweeper: could not record emptiness", "slug", slug, "error", err)
			continue
		}
		if count > 0 || emptyFor < grace {
			continue
		}

		s.log.Warn("empty room sweeper: ending webinar nobody is in",
			"slug", slug, "emptyForMin", int(emptyFor.Minutes()), "graceMin", s.cfg.EmptyRoomCloseMin)
		if _, err := s.endWebinarSession(ctx, slug); err != nil {
			s.log.Error("empty room sweeper: end session failed", "slug", slug, "error", err)
		}
	}
}

/* reconcileEgressRecordings finishes recordings whose EGRESS_ENDED webhook never
 * landed, by asking storage how big the file actually is.
 *
 * The webhook is the fast path and usually the only one that runs. It is also a
 * single HTTP request from the SFU to an API that may be cold, redeployed, or
 * briefly unreachable, and LiveKit stops retrying long before a host notices a
 * recording that will not play. The bucket, meanwhile, has the answer: for
 * Egress the object only exists once the upload finished, so a size is proof of
 * a complete file.
 */
func (s *Server) reconcileEgressRecordings(ctx context.Context) {
	stater, ok := s.recordings.(media.Stater)
	if !ok || s.recordings == nil {
		return
	}

	pending, err := s.store.UnaccountedEgressRecordings(ctx, 20)
	if err != nil {
		s.log.Error("egress reconcile: query failed", "error", err)
		return
	}
	for _, rec := range pending {
		// A stop that has only just been requested is still uploading; give the
		// webhook the first shot before going behind its back.
		if time.Since(rec.CreatedAt) < time.Minute {
			continue
		}
		size, err := stater.Stat(ctx, rec.StorageKey)
		if errors.Is(err, media.ErrNotFound) {
			if time.Since(rec.CreatedAt) > egressUploadWindow {
				s.log.Warn("egress reconcile: no file appeared, marking failed",
					"slug", rec.Webinar, "recording", rec.ID, "key", rec.StorageKey)
				if err := s.store.MarkRecordingFailed(ctx, rec.ID); err != nil {
					s.log.Error("egress reconcile: mark failed", "recording", rec.ID, "error", err)
				}
			}
			continue
		}
		if err != nil {
			s.log.Warn("egress reconcile: stat failed",
				"recording", rec.ID, "key", rec.StorageKey, "error", err)
			continue
		}
		if size <= 0 {
			continue
		}
		if _, err := s.store.FinishRecordingWithStats(ctx, rec.ID, size, 0); err != nil {
			s.log.Error("egress reconcile: finish failed", "recording", rec.ID, "error", err)
			continue
		}
		s.log.Info("egress reconcile: recovered recording from storage",
			"slug", rec.Webinar, "recording", rec.ID, "sizeBytes", size)
	}
}

// egressUploadWindow is how long a finished Egress may take to put its file in
// the bucket before the recording is called lost. Generous on purpose: a long
// session on a slow uplink is still uploading well after the room is gone, and
// a row marked failed early is one a host stops waiting for.
const egressUploadWindow = 2 * time.Hour

// StartRecordingRetentionSweeper deletes cloud recordings past RECORDINGS_RETENTION_DAYS.
// Cloud Run may scale to zero, so this also runs once at boot and whenever a
// host lists recordings; the ticker covers a long-lived instance.
func (s *Server) StartRecordingRetentionSweeper(ctx context.Context) {
	if s.cfg.RecordingsRetentionDays <= 0 {
		return
	}
	s.sweepExpiredRecordings(ctx)

	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepExpiredRecordings(ctx)
		}
	}
}

func (s *Server) sweepExpiredRecordings(ctx context.Context) {
	if s.cfg.RecordingsRetentionDays <= 0 {
		return
	}
	age := time.Duration(s.cfg.RecordingsRetentionDays) * 24 * time.Hour
	expired, err := s.store.ExpiredRecordings(ctx, age, 50)
	if err != nil {
		s.log.Error("recording retention: query failed", "error", err)
		return
	}
	for _, rec := range expired {
		keys, err := s.store.DeleteRecording(ctx, rec.Webinar, rec.ID)
		if err != nil {
			s.log.Error("recording retention: delete row failed",
				"slug", rec.Webinar, "recording", rec.ID, "error", err)
			continue
		}
		if s.recordings != nil {
			for _, key := range keys {
				if key == "" {
					continue
				}
				if err := s.recordings.Delete(ctx, key); err != nil {
					s.log.Warn("recording retention: blob left behind",
						"slug", rec.Webinar, "recording", rec.ID, "key", key, "error", err)
				}
			}
		}
		s.log.Info("recording retention: deleted expired recording",
			"slug", rec.Webinar, "recording", rec.ID, "createdAt", rec.CreatedAt,
			"retentionDays", s.cfg.RecordingsRetentionDays)
	}
}
