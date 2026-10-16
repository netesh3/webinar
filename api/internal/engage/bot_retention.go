package engage

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
)

// pruneFinishedBotSessions deletes finished bot conversations past retention, once a day.
func (s *Module) pruneFinishedBotSessions(ctx context.Context) {
	if _, due, err := s.store.TryLease(ctx, "bot-session-retention", 24*time.Hour); err != nil || !due {
		return
	}
	n, err := s.store.PruneFinishedBotSessions(ctx, time.Now().Add(-crmstore.BotSessionRetention), 5000)
	if err != nil {
		s.log.Error("bot session retention: prune failed", "error", err)
		return
	}
	if n > 0 {
		s.log.Info("bot session retention: deleted finished conversations", "rows", n)
	}
}
