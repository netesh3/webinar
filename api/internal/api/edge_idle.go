package api

import (
	"context"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

/* Edge event streams that nobody is reading any more.
 *
 * Behind the CDN and Cloud Run's front end, a browser that goes away does not end its event
 * stream on this side: the proxies keep the upstream connection open and accept the
 * heartbeats, so every write succeeds and the request context is never cancelled. In the
 * 24 Oct 2026 load test every one of 1,780 streams ran its full edgeStreamLife (1,500 s to
 * the second), long after the viewer had sent its goodbye, so each instance held ~500 dead
 * streams (~1,000 goroutines) for 25 minutes after every step. The browser's beats and
 * goodbye are what say a viewer is there (handleEdgeBeat, handleEdgeLeave); two things now
 * end a stream from them:
 *
 *   - the goodbye publishes a realtime.KindBye, which closes that viewer's older streams on
 *     whichever instance holds them (handleEdgeLeave, removeEdgeViewer);
 *   - while the webinar is live, a stream whose viewer has no believable visit (no beat for
 *     store.EdgeVisitStale) is ended with "reconnect" at its next heartbeat. A browser that
 *     is in fact still there reconnects within two seconds and its connect counts as a beat.
 *
 * The check costs one query per webinar per instance per edgeIdleRefresh, shared by every
 * stream on the instance, never one per stream. */

var (
	// edgeIdleRefresh is how long an instance trusts its last read of who is watching.
	edgeIdleRefresh = time.Minute
	// edgeIdleGrace is how long a stream, and the session, must have been going before a
	// missing visit can end the stream: enough for the first beats after going live to land.
	edgeIdleGrace = store.EdgeVisitStale + 30*time.Second
)

type edgeLivenessEntry struct {
	at      time.Time
	ok      bool
	loading bool
	val     store.EdgeLiveness
}

// edgeLivenessCache is the per-instance read edgeViewerGone shares. The zero value is ready.
type edgeLivenessCache struct {
	mu sync.Mutex
	m  map[string]*edgeLivenessEntry
}

/* edgeViewerGone reports whether the stream identity opened at since, on slug, has nobody
 * behind it: the webinar has been live for longer than the grace, so has the stream, and the
 * viewer has no believable visit. Any doubt (not live, a failed read, a read in progress
 * for the first time) is "not gone": the stream's own lifetime still bounds it. */
func (s *Server) edgeViewerGone(ctx context.Context, slug, identity string, since, now time.Time) bool {
	if now.Sub(since) < edgeIdleGrace {
		return false
	}
	c := &s.edgeLiveness
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]*edgeLivenessEntry{}
	}
	e := c.m[slug]
	if e == nil {
		e = &edgeLivenessEntry{}
		c.m[slug] = e
	}
	if !e.loading && now.Sub(e.at) >= edgeIdleRefresh {
		e.loading = true
		c.mu.Unlock()
		qctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		val, err := s.store.EdgeLivenessFor(qctx, slug)
		cancel()
		c.mu.Lock()
		e.loading, e.at, e.ok, e.val = false, now, err == nil, val
		if err != nil && ctx.Err() == nil {
			s.log.Warn("edge events: liveness read failed", "slug", slug, "error", err)
		}
		// Forget webinars nobody on this instance has asked about for a while.
		for k, old := range c.m {
			if !old.loading && now.Sub(old.at) > 10*edgeIdleRefresh {
				delete(c.m, k)
			}
		}
	}
	ok, val := e.ok, e.val
	c.mu.Unlock()
	if !ok || !val.Live || val.StartedAt.IsZero() || now.Sub(val.StartedAt) < edgeIdleGrace {
		return false
	}
	_, watching := val.Watching[identity]
	return !watching
}
