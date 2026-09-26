package api

import (
	"context"
	"errors"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/types"
)

/* How often the background job runs, and how long one pass may take.
 *
 * The in-process ticker below is one of two ways a pass starts. On an always-on process (a
 * dedicated server, or Cloud Run with min-instances) it is the only one. On Cloud Run
 * scaled to zero there is no process and no CPU between requests, so Cloud Scheduler calls
 * POST /api/internal/tick once a minute and the pass runs inside that request (see
 * handleInternalTick and deploy/cloud-scheduler-tick.sh). Both run RunTick, which takes the
 * `sweep` lease, so they never overlap — within an instance or across them.
 */
const (
	tickEvery = 30 * time.Second
	// tickBudget bounds one pass; the lease outlives it so an overrun cannot start a twin.
	tickBudget = 90 * time.Second
	tickLease  = 2 * time.Minute
	// Recording retention deletes files, and once every five minutes is plenty; its lease
	// is never released, which is what makes it run at most that often.
	retentionEvery = 5 * time.Minute
)

// StartMeetingLimitSweeper runs RunTick every tickEvery until ctx is done.
func (s *Server) StartMeetingLimitSweeper(ctx context.Context) {
	ticker := time.NewTicker(tickEvery)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.RunTick(ctx)
		}
	}
}

/* RunTick is one pass of every job that runs on a clock: meeting limits, empty rooms,
 * broadcasts, simulive, lost recordings, the email outbox, and the CRM's drips, bots and
 * WhatsApp outbox. Reports false when another runner held the lease and nothing was done.
 *
 * Everything is due-time driven — a row with due_at <= now() — so a late pass catches up
 * rather than losing anything: the pass after a gap sends what came due during it.
 */
func (s *Server) RunTick(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, tickBudget)
	defer cancel()

	release, ok, err := s.store.TryLease(ctx, "sweep", tickLease)
	if err != nil {
		s.log.Error("sweep: could not take lease", "error", err)
		return false
	}
	if !ok {
		return false
	}
	defer release()

	s.sweepExpiredWebinars(ctx)
	s.sweepEmptyWebinars(ctx)
	s.sweepBroadcasts(ctx)
	s.sweepSimulive(ctx)
	s.reconcileEgressRecordings(ctx)
	s.flushOutbox(ctx)
	// The CRM's drips, bots and WhatsApp outbox. See Engage.Tick.
	s.engage.Tick(ctx)

	if s.cfg.RecordingsRetentionDays > 0 {
		if _, due, err := s.store.TryLease(ctx, "recording-retention", retentionEvery); err == nil && due {
			s.sweepExpiredRecordings(ctx)
		}
	}
	return true
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

/* StartRecordingRetentionSweeper runs recording retention once at boot, under the same
 * lease RunTick uses, so a fresh instance catches up without waiting for its first tick.
 * After that RunTick owns it (at most once per retentionEvery, across all instances). */
func (s *Server) StartRecordingRetentionSweeper(ctx context.Context) {
	if s.cfg.RecordingsRetentionDays <= 0 {
		return
	}
	if _, due, err := s.store.TryLease(ctx, "recording-retention", retentionEvery); err == nil && due {
		s.sweepExpiredRecordings(ctx)
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
