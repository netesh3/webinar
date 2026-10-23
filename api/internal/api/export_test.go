package api

import (
	"context"
	"errors"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
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

// SetEmbedder puts e in place of the server's embedder (the fake in tests).
func SetEmbedder(s *Server, e ai.Embedder) { s.embedder = e }

// RetrieveKnowledge is the hybrid retrieval a suggested answer uses, for a session.
func RetrieveKnowledge(s *Server, ctx context.Context, wb types.Webinar, question string) ([]store.KnowledgeHit, error) {
	r, err := s.retrieveKnowledge(ctx, wb, question, knowledgeTopChunks, knowledgeTokenBudget)
	return r.hits, err
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

// SetQAAutoDraftCap sets the most automatic drafts a session gets; the returned func restores it.
func SetQAAutoDraftCap(n int) func() {
	old := qaAutoDraftCap
	qaAutoDraftCap = n
	return func() { qaAutoDraftCap = old }
}

// SetQAClusterTiming makes the Q&A assistant's check run on the request path (sync) and sets
// how long a question waits for a pass; the returned func restores both.
func SetQAClusterTiming(sync bool, every time.Duration) func() {
	oldSync, oldEvery := qaClusterSync, qaClusterEvery
	qaClusterSync, qaClusterEvery = sync, every
	return func() { qaClusterSync, qaClusterEvery = oldSync, oldEvery }
}

// SetQAAuto sets Auto mode's delay and session cap; the returned func restores both.
func SetQAAuto(delay time.Duration, sessionCap int) func() {
	oldDelay, oldCap := qaAutoDelay, qaAutoSessionCap
	qaAutoDelay, qaAutoSessionCap = delay, sessionCap
	return func() { qaAutoDelay, qaAutoSessionCap = oldDelay, oldCap }
}

// SetBroadcastRestartDelay shortens the wait before a mix is put back after a recording that
// carried it stops; the returned func restores it.
func SetBroadcastRestartDelay(d time.Duration) func() {
	old := broadcastRestartDelay
	broadcastRestartDelay = d
	return func() { broadcastRestartDelay = old }
}

// SetRecordings puts m in place of the server's recording storage (a store that can sign
// uploads, for the record-from-mix tests).
func SetRecordings(s *Server, m media.Store) { s.recordings = m }

// ForgetMixRestarts clears a slug's mix restart backoff, which is process-wide and would
// otherwise carry over from an earlier test that used the same slug.
func ForgetMixRestarts(slug string) { forgetMixRestarts(slug) }

// SweepRecordingExpiryReminders is the 7-day / 1-day reminder job on its own, without its lease.
func SweepRecordingExpiryReminders(s *Server, ctx context.Context) { s.sweepRecordingExpiryReminders(ctx) }

// SweepExpiredRecordings is the recording retention job on its own, without its lease.
func SweepExpiredRecordings(s *Server, ctx context.Context) { s.sweepExpiredRecordings(ctx) }

// RecordingStartStorage is the storage check a cloud recording's start makes.
func RecordingStartStorage(s *Server, ctx context.Context, hostID, recordingID string) string {
	return s.recordingStartStorage(ctx, hostID, recordingID)
}
