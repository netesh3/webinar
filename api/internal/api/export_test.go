package api

import (
	"context"
	"errors"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/netkumar/webcast/api/internal/ai"
)

// SetMaintenanceHook runs f first in every maintenance lane, so a test can stand in
// for a slow job.
func SetMaintenanceHook(s *Server, f func(context.Context)) { s.maintenanceHook = f }

// KindForGoogle is kindForGoogle, for the account-kind tests.
var KindForGoogle = kindForGoogle

// OnBroadcastEgressEnded is the broadcast half of the egress_ended webhook.
func OnBroadcastEgressEnded(s *Server, ctx context.Context, info *livekit.EgressInfo) {
	s.onBroadcastEgressEnded(ctx, info)
}

// SetMixQuickRestart shortens the delay before a lost mix is put back; the
// returned func restores it.
func SetMixQuickRestart(d time.Duration) func() {
	old := mixQuickRestart
	mixQuickRestart = d
	return func() { mixQuickRestart = old }
}

// ActiveBroadcast is the egress this process holds as a room's mix.
func ActiveBroadcast(slug string) string {
	broadcastMu.Lock()
	defer broadcastMu.Unlock()
	return activeBroadcasts[slug]
}

// AIComplete is aiComplete, for the budget tests: one AI call on behalf of hostID.
func AIComplete(s *Server, ctx context.Context, feature, hostID string, req ai.Request) (ai.Reply, error) {
	return s.aiComplete(ctx, feature, hostID, req)
}

// IsAILimit reports whether err is a monthly AI cap.
func IsAILimit(err error) bool { return errors.Is(err, errAILimit) }

// RunRecaps is the recap lane of RunTick on its own.
func RunRecaps(s *Server, ctx context.Context) { s.runRecaps(ctx) }

// SetRecapDelay makes a recap due this long after the end; the returned func restores it.
func SetRecapDelay(d time.Duration) func() {
	old := recapDelay
	recapDelay = d
	return func() { recapDelay = old }
}
