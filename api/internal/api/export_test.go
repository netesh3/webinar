package api

import (
	"context"
	"time"

	"github.com/livekit/protocol/livekit"
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
