package api

import (
	"context"
	"time"
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
