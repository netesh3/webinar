package api

import (
	"context"
	"errors"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/lk"
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

// SetSpamEvery sets how long a pending message waits for a spam pass; the returned func
// restores it.
func SetSpamEvery(d time.Duration) func() {
	old := spamEvery
	spamEvery = d
	return func() { spamEvery = old }
}

// RunSpamLane is the spam lane of RunTick on its own.
func RunSpamLane(s *Server, ctx context.Context) { s.runSpamLane(ctx) }

// SetHighlightsRetryAfter sets how long a failed pick waits; the returned func restores it.
func SetHighlightsRetryAfter(d time.Duration) func() {
	old := highlightsRetryAfter
	highlightsRetryAfter = d
	return func() { highlightsRetryAfter = old }
}

// RunRecaps is the recap lane of RunTick on its own.
func RunRecaps(s *Server, ctx context.Context) { s.runRecaps(ctx) }

// SetRecapDelay makes a recap due this long after the end; the returned func restores it.
func SetRecapDelay(d time.Duration) func() {
	old := recapDelay
	recapDelay = d
	return func() { recapDelay = old }
}

// SetRepurposeRetryAfter sets how long a failed draft waits; the returned func restores it.
func SetRepurposeRetryAfter(d time.Duration) func() {
	old := repurposeRetryAfter
	repurposeRetryAfter = d
	return func() { repurposeRetryAfter = old }
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
func SweepRecordingExpiryReminders(s *Server, ctx context.Context) {
	s.sweepRecordingExpiryReminders(ctx)
}

// SweepExpiredRecordings is the recording retention job on its own, without its lease.
func SweepExpiredRecordings(s *Server, ctx context.Context) { s.sweepExpiredRecordings(ctx) }

// SweepAbandonedVideoUploads aborts uploads nobody finished, without its lease.
func SweepAbandonedVideoUploads(s *Server, ctx context.Context) { s.sweepAbandonedVideoUploads(ctx) }

// RecordingStartStorage is the storage check a cloud recording's start makes.
func RecordingStartStorage(s *Server, ctx context.Context, hostID, recordingID string) string {
	return s.recordingStartStorage(ctx, hostID, recordingID)
}

// SetPushEndpointCheck replaces which subscription endpoints are accepted, so a test can
// point a browser at its own fake push service.
func SetPushEndpointCheck(s *Server, f func(string) error) { s.pushEndpointOK = f }

// FlushPush sends every push message that is due, now.
func FlushPush(s *Server, ctx context.Context) { s.flushPush(ctx) }

// SweepPushReminders queues the 15-minute reminders that are due.
func SweepPushReminders(s *Server, ctx context.Context) { s.sweepPushReminders(ctx) }

/* SetBox points the on-demand box at a fake DigitalOcean (doapitest) and replaces its
 * readiness probe, its LiveKit activity check and its clock. cfg.SFUBox must be enabled. */
func SetBox(s *Server, cloud *doapi.Client, probe func(context.Context) error,
	activity func(context.Context) (lk.Activity, error), now func() time.Time) {
	if s.box == nil {
		panic("SetBox: cfg.SFUBox is not enabled")
	}
	s.box.cloud = cloud
	s.box.probe = probe
	s.box.activity = activity
	s.box.now = now
	s.box.invalidate()
}

// BoxStep is one step of the on-demand box's state machine.
func BoxStep(s *Server, ctx context.Context) { s.boxStep(ctx, s.box) }

// ForgetBoxCache drops the box state a join would trust for a few seconds, and the probe throttle.
func ForgetBoxCache(s *Server) {
	s.box.invalidate()
	s.box.mu.Lock()
	s.box.lastProbe = time.Time{}
	s.box.mu.Unlock()
}

// SetCaptionsOn flips CAPTIONS_BOX_ENABLED on a running server (as a restart with it would).
func SetCaptionsOn(s *Server, on bool) { s.box.cfg.Captions.On = on }

// ForgetCaptionsSweep lets the next step check for a stray captions droplet at once.
func ForgetCaptionsSweep(s *Server) {
	s.box.mu.Lock()
	s.box.lastCaptionsSweep = time.Time{}
	s.box.mu.Unlock()
}

// SweepClipBlobs is the maintenance pass that deletes the files of deleted clips.
func SweepClipBlobs(s *Server, ctx context.Context) { s.sweepClipBlobs(ctx) }

// AIModelFor is the per-feature model (AI_MODEL_HIGHLIGHTS for the clip features).
func AIModelFor(s *Server, feature string) string { return s.aiModelFor(feature) }

/* SetEdgeStreamTiming shortens the event stream's heartbeat and the idle check's refresh and
 * grace (edge_idle.go); the returned func restores them. */
func SetEdgeStreamTiming(heartbeat, refresh, grace time.Duration) func() {
	oh, or, og := edgeHeartbeat, edgeIdleRefresh, edgeIdleGrace
	edgeHeartbeat, edgeIdleRefresh, edgeIdleGrace = heartbeat, refresh, grace
	return func() { edgeHeartbeat, edgeIdleRefresh, edgeIdleGrace = oh, or, og }
}

// SetPoolBox is SetBox for one box of the pool (SFU_BOX_SLOTS), by its project.
func SetPoolBox(s *Server, project string, cloud *doapi.Client, probe func(context.Context) error,
	activity func(context.Context) (lk.Activity, error), now func() time.Time) {
	b := s.boxFor(project)
	if b == nil {
		panic("SetPoolBox: no box for " + project)
	}
	b.cloud, b.probe, b.activity, b.now = cloud, probe, activity, now
	b.invalidate()
}

// SweepBoxes is the tick's box lane: upcoming sessions placed, then every box's step.
func SweepBoxes(s *Server, ctx context.Context) {
	s.sweepSFUBox(ctx)
	for _, b := range s.pool() {
		b.invalidate()
		b.mu.Lock()
		b.lastProbe = time.Time{}
		b.mu.Unlock()
	}
}

// PoolPoints is what a session costs its box (sfu_pool.go).
func PoolPoints(s *Server, ctx context.Context, wb types.Webinar) int {
	return s.sessionPoints(ctx, wb)
}
