package api

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/integrations"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* One room, one compositor, many outputs — and until now, one bad output took
 * the whole compositor down with it.
 *
 * LiveKit fails an egress outright when the RTMP URL it was started with is
 * refused, and an egress started with five URLs is an egress started with five
 * ways to fail. A stale LinkedIn key, a mistyped pasted key, a YouTube live that
 * was deleted: any one of them ended the mix, the sweeper put it back thirty
 * seconds later with the same URL, and the audience watched a black player in a
 * thirty-second loop while the host's own destinations had nothing to do with
 * our origin (production, 2026-10-18, "Publish Rejected: Invalid URL").
 *
 * So the compositor now starts on the one output we control — our own origin —
 * and every platform is attached afterwards, one UpdateStream each. A refusal
 * then costs that platform and nothing else, and it is remembered for the rest
 * of the session so a restart does not walk into the same wall. */

// mixDest is one RTMP output with the name it is logged and reported under.
// The URL carries the stream key and is never logged.
type mixDest struct {
	Platform string // "stream" for YouTube or a pasted key, else an integrations.RTMPPlatforms id
	URL      string
}

/* How long a refused destination stays refused. Long enough that a restart
 * loop cannot rediscover it every thirty seconds, short enough that a host who
 * fixes the key in another tab without touching this room gets it back within a
 * session. Saving a new key changes the URL, which is a new destination and is
 * tried at once. */
const destFailureTTL = 20 * time.Minute

type destFailure struct {
	platform string
	at       time.Time
}

type destFailureRegistry struct {
	mu sync.Mutex
	m  map[string]map[string]destFailure // slug -> URL -> failure
}

var destFailures = &destFailureRegistry{m: map[string]map[string]destFailure{}}

func (r *destFailureRegistry) mark(slug string, d mixDest, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m[slug] == nil {
		r.m[slug] = map[string]destFailure{}
	}
	r.m[slug][d.URL] = destFailure{platform: d.Platform, at: now}
}

func (r *destFailureRegistry) failed(slug, u string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.m[slug][u]
	if !ok {
		return false
	}
	if now.Sub(f.at) > destFailureTTL {
		delete(r.m[slug], u)
		return false
	}
	return true
}

// platformFailed reports whether this webinar's current destination for one
// platform was refused. Keyed by URL, so a re-saved key is not reported failed.
func (r *destFailureRegistry) platformFailed(slug, platform, u string, now time.Time) bool {
	if u == "" {
		return false
	}
	r.mu.Lock()
	f, ok := r.m[slug][u]
	r.mu.Unlock()
	return ok && f.platform == platform && now.Sub(f.at) <= destFailureTTL
}

func (r *destFailureRegistry) clear(slug string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.m, slug)
}

func (r *destFailureRegistry) forget(slug, u string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.m[slug], u)
}

/* mixPlan is everything this room's compositor should push to: our attendee
 * origin, for an Edge webinar, and the host's own destinations, each named.
 *
 * Refused destinations are left out — see destFailures. */
func (s *Server) mixPlan(ctx context.Context, wb types.Webinar) (origin string, dests []mixDest) {
	/* An edge webinar's audience watches this mix, as LL-HLS from the origin (or a CDN pull
	 * zone in front of it). The origin is the only push edge needs: a CDN mirrors it rather
	 * than taking a second ingest. */
	// A meeting pushes nowhere: no audience feed, and stream destinations are a webinar's.
	// Nor a simulive: its audience plays the recording, and a mix of the room would be the
	// host team pushed somewhere — an egress of a session that is never recorded
	// (refuseSimuliveRecording).
	if isMeeting(wb) || wb.Kind == types.KindSimulive {
		return "", nil
	}
	if wb.Delivery == types.DeliveryEdge {
		origin = s.cfg.BroadcastRTMPURL(wb.ID)
	}
	now := time.Now()
	seen := map[string]bool{}
	add := func(platform, u string) {
		if u == "" || seen[u] || u == origin {
			return
		}
		seen[u] = true
		if destFailures.failed(wb.ID, u, now) {
			return
		}
		dests = append(dests, mixDest{Platform: platform, URL: u})
	}
	extra, on, err := s.store.WebinarStreamIngest(ctx, wb.ID)
	if err != nil {
		s.log.Warn("stream dest: could not load ingest", "slug", wb.ID, "error", err)
	} else if on {
		// A saved-but-stopped destination is not one to push to.
		add("stream", extra)
	}
	for _, p := range integrations.RTMPPlatforms {
		add(p.ID, s.platformIngestFor(ctx, wb, p.ID))
	}
	return origin, dests
}

func destURLs(dests []mixDest) []string {
	out := make([]string, 0, len(dests))
	for _, d := range dests {
		out = append(out, d.URL)
	}
	return out
}

/* firstOutput splits a plan into the URL the compositor is started with and the
 * ones attached after it. Our origin when there is one; otherwise the first
 * platform, which is all a room that only streams out can do. */
func firstOutput(origin string, dests []mixDest) (start string, startDest *mixDest, rest []mixDest) {
	if origin != "" {
		return origin, nil, dests
	}
	if len(dests) == 0 {
		return "", nil, nil
	}
	d := dests[0]
	return d.URL, &d, dests[1:]
}

/* attachDestinations adds each destination to a running compositor, one call
 * each, so a refusal is that destination's alone. Returns the ones that were
 * refused, already recorded in destFailures. */
func (s *Server) attachDestinations(ctx context.Context, slug string, sfu RoomManager, egressID string, dests []mixDest) []mixDest {
	var refused []mixDest
	for _, d := range dests {
		if _, err := sfu.UpdateStream(ctx, egressID, []string{d.URL}, nil); err != nil {
			destFailures.mark(slug, d, time.Now())
			refused = append(refused, d)
			// The platform only: the URL is the stream key.
			s.log.Warn("stream dest: destination refused, the mix carries on without it",
				"slug", slug, "egress", egressID, "platform", d.Platform, "error", redactErr(err, d.URL))
		}
	}
	return refused
}

/* redactErr keeps an error message but drops the URL from it, in case a client
 * library echoes the request back. */
func redactErr(err error, secret string) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if secret != "" {
		msg = strings.ReplaceAll(msg, secret, "[destination]")
	}
	return msg
}

/* sameHost reports whether a URL LiveKit echoes back in a stream result names
 * the same server as one of ours. Egress redacts the stream key out of those
 * URLs, so the path is not comparable; scheme, host and port are. */
func sameHost(a, b string) bool {
	ua, errA := url.Parse(strings.TrimSpace(a))
	ub, errB := url.Parse(strings.TrimSpace(b))
	if errA != nil || errB != nil || ua.Host == "" {
		return false
	}
	return strings.EqualFold(ua.Scheme, ub.Scheme) && strings.EqualFold(ua.Host, ub.Host)
}

/* noteFailedStreams reads the per-output results LiveKit reports for a
 * compositor and retires every destination it says failed: recorded in
 * destFailures and, while the egress is still running, detached from it so
 * egress stops retrying it. Our own origin is never retired — losing it is the
 * mix failing, which the restart path handles.
 *
 * Returns whether any destination was retired. */
func (s *Server) noteFailedStreams(ctx context.Context, slug string, info *livekit.EgressInfo, sfu RoomManager, active bool) bool {
	results := info.GetStreamResults()
	if len(results) == 0 {
		return false
	}
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return false
	}
	origin, _ := s.mixPlan(ctx, wb)
	all := s.allDestinations(ctx, wb)
	retired := false
	for _, res := range results {
		if res.GetStatus() != livekit.StreamInfo_FAILED {
			continue
		}
		if origin != "" && sameHost(res.GetUrl(), origin) {
			continue
		}
		for _, d := range all {
			if !sameHost(res.GetUrl(), d.URL) {
				continue
			}
			if destFailures.failed(slug, d.URL, time.Now()) {
				break
			}
			destFailures.mark(slug, d, time.Now())
			retired = true
			s.log.Warn("stream dest: platform refused the stream, retired for this session",
				"slug", slug, "egress", info.GetEgressId(), "platform", d.Platform, "error", res.GetError())
			if active && sfu != nil {
				if _, err := sfu.UpdateStream(ctx, info.GetEgressId(), nil, []string{d.URL}); err != nil {
					s.log.Warn("stream dest: could not detach a refused destination",
						"slug", slug, "platform", d.Platform, "error", redactErr(err, d.URL))
				}
			}
			break
		}
	}
	return retired
}

// allDestinations is the plan without the refused-destination filter, for
// matching a failure LiveKit reports back to the destination it was.
func (s *Server) allDestinations(ctx context.Context, wb types.Webinar) []mixDest {
	var out []mixDest
	extra, on, err := s.store.WebinarStreamIngest(ctx, wb.ID)
	if err == nil && on && extra != "" {
		out = append(out, mixDest{Platform: "stream", URL: extra})
	}
	for _, p := range integrations.RTMPPlatforms {
		if u := s.platformIngestFor(ctx, wb, p.ID); u != "" {
			out = append(out, mixDest{Platform: p.ID, URL: u})
		}
	}
	return out
}

/* A restart that keeps failing must not keep restarting at the sweeper's pace.
 *
 * Every attempt is a Chromium boot and a three-core admission on the SFU box,
 * and a mix that cannot start (our origin down, the egress node full) would
 * otherwise do that forever every thirty seconds. Attempts that end quickly
 * back off, doubling up to a ceiling; one that ran for a while resets it. */
type mixRestartState struct {
	attempts  int
	lastStart time.Time
}

var (
	mixRestartMu sync.Mutex
	mixRestarts  = map[string]*mixRestartState{}
	// mixHealthyRun is how long a compositor must have run for its end not to
	// count as a failed start.
	mixHealthyRun = 2 * time.Minute
	// mixQuickRestart is the delay before putting a lost mix back from the
	// egress webhook, ahead of the sweeper. A var so tests do not sleep.
	mixQuickRestart = 3 * time.Second
)

func mixBackoff(attempts int) time.Duration {
	if attempts <= 1 {
		return 0
	}
	d := 10 * time.Second
	for i := 2; i < attempts && d < 5*time.Minute; i++ {
		d *= 2
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

// noteMixStart records a start attempt for the backoff.
func noteMixStart(slug string, now time.Time) {
	mixRestartMu.Lock()
	defer mixRestartMu.Unlock()
	st := mixRestarts[slug]
	if st == nil {
		st = &mixRestartState{}
		mixRestarts[slug] = st
	}
	if !st.lastStart.IsZero() && now.Sub(st.lastStart) >= mixHealthyRun {
		st.attempts = 0
	}
	st.attempts++
	st.lastStart = now
}

// mixRestartAllowed reports whether a restart is due, given the backoff.
func mixRestartAllowed(slug string, now time.Time) bool {
	mixRestartMu.Lock()
	defer mixRestartMu.Unlock()
	st := mixRestarts[slug]
	if st == nil || st.lastStart.IsZero() {
		return true
	}
	if now.Sub(st.lastStart) >= mixHealthyRun {
		return true
	}
	return now.Sub(st.lastStart) >= mixBackoff(st.attempts)
}

func forgetMixRestarts(slug string) {
	mixRestartMu.Lock()
	defer mixRestartMu.Unlock()
	delete(mixRestarts, slug)
}

/* onBroadcastEgressEnded puts a live room's mix back within seconds of it
 * stopping, instead of at the sweeper's next pass, and retires whatever
 * destination made it stop. Only for an egress this process recorded as the
 * room's broadcast, so a recording or a deliberate stop is left alone. */
func (s *Server) onBroadcastEgressEnded(ctx context.Context, info *livekit.EgressInfo) {
	slug := lk.SlugFromRoom(info.GetRoomName())
	if slug == "" {
		return
	}
	broadcastMu.Lock()
	current := activeBroadcasts[slug]
	if current != info.GetEgressId() {
		broadcastMu.Unlock()
		return
	}
	delete(activeBroadcasts, slug)
	broadcastMu.Unlock()

	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil || wb.Status != types.StatusLive {
		return
	}
	s.noteFailedStreams(ctx, slug, info, nil, false)
	if info.GetStatus() == livekit.EgressStatus_EGRESS_FAILED && isPublishRejection(info.GetError()) {
		/* Refused before anything ran: the URL it was started with is the culprit. With an
		 * origin that is our own server and nothing to retire; without one it is the first
		 * platform, which is what kept the old loop going. */
		if start := egressStartDest(info.GetEgressId()); start != nil {
			destFailures.mark(slug, *start, time.Now())
			s.log.Warn("stream dest: the mix could not start on this destination, retired for this session",
				"slug", slug, "platform", start.Platform)
		}
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	time.AfterFunc(mixQuickRestart, func() {
		rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if !mixRestartAllowed(slug, time.Now()) {
			return // the sweeper retries once the backoff allows it
		}
		fresh, err := s.store.WebinarBySlug(rctx, slug)
		if err != nil || fresh.Status != types.StatusLive {
			return
		}
		s.log.Info("cdn broadcast: mix ended while live, putting it back", "slug", slug,
			"status", info.GetStatus().String())
		s.startBroadcastIfEnabled(rctx, fresh, sfu)
	})
}

func isPublishRejection(msg string) bool {
	m := strings.ToLower(msg)
	return strings.Contains(m, "publish") || strings.Contains(m, "invalid url") ||
		strings.Contains(m, "failed to connect") || strings.Contains(m, "rejected")
}

/* Which destination each compositor was started on, when it was not our origin.
 * Needed because a refusal at start is reported against the egress, not a
 * stream result, and the destination is what has to be retired. */
var (
	egressStartMu    sync.Mutex
	egressStartDests = map[string]mixDest{}
)

func noteEgressStartDest(egressID string, d *mixDest) {
	if egressID == "" || d == nil {
		return
	}
	egressStartMu.Lock()
	defer egressStartMu.Unlock()
	egressStartDests[egressID] = *d
}

func egressStartDest(egressID string) *mixDest {
	egressStartMu.Lock()
	defer egressStartMu.Unlock()
	d, ok := egressStartDests[egressID]
	if !ok {
		return nil
	}
	delete(egressStartDests, egressID)
	return &d
}
