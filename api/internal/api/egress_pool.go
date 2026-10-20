package api

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/egresspool"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

/* Edge egress workers: one VM per live Edge webinar, for projects whose SFU box runs in
 * remote-egress mode (config EgressPool; deploy/egress-worker).
 *
 * Start: when a mix is about to start for an Edge webinar on such a project and fewer
 * workers are up than Edge webinars are live there, a stopped worker is started, and the
 * mix is retried every few seconds until the worker has joined (about a minute).
 *
 * Stop: when no Edge webinar has been live on the project for egressIdleGrace, its workers
 * are stopped. Not one by one while others are live: LiveKit does not say which worker
 * runs which mix, and stopping the wrong one would end a webinar.
 *
 * There is no fallback to the SFU box's own egress (it does not run one in this mode):
 * a pool that is full or that GCP will not start is an email to the operators, who add
 * workers with the "Egress pool: add workers" workflow. The host is not told. */

const (
	egressIdleGrace    = 5 * time.Minute
	egressEnsureEvery  = 15 * time.Second
	egressAlertEvery   = 15 * time.Minute
	egressStartTimeout = 3 * time.Minute
	egressRetryEvery   = 10 * time.Second
	egressRetryFor     = 4 * time.Minute
	egressPoolWorkflow = "https://github.com/netesh3/webinar/actions/workflows/egress-pool.yml"
	egressStopTimeout  = 3 * time.Minute
	egressCallTimeout  = 20 * time.Second
)

type egressPoolState struct {
	mu         sync.Mutex
	pools      map[string]*egresspool.Pool // by LiveKit project id
	lastEnsure map[string]time.Time
	idleSince  map[string]time.Time
	lastAlert  map[string]time.Time
	starting   map[string]bool // worker name -> a start is in flight
	gcpProject string
}

var egressPools = egressPoolState{
	pools:      map[string]*egresspool.Pool{},
	lastEnsure: map[string]time.Time{},
	idleSince:  map[string]time.Time{},
	lastAlert:  map[string]time.Time{},
	starting:   map[string]bool{},
}

// egressPoolFor is the pool of a LiveKit project, or nil when it has none.
func (s *Server) egressPoolFor(ctx context.Context, projectID string) *egresspool.Pool {
	proj, ok := s.cfg.LiveKitProjectByID(projectID)
	if !ok || proj.EgressPool == nil {
		return nil
	}
	egressPools.mu.Lock()
	defer egressPools.mu.Unlock()
	if p := egressPools.pools[projectID]; p != nil {
		return p
	}
	gcp := strings.TrimSpace(proj.EgressPool.GCPProject)
	if gcp == "" {
		if egressPools.gcpProject == "" {
			mctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			id, err := egresspool.MetadataProject(mctx)
			cancel()
			if err != nil {
				s.log.Error("egress pool: no GCP project (set egressPool.gcpProject)", "project", projectID, "error", err)
				return nil
			}
			egressPools.gcpProject = id
		}
		gcp = egressPools.gcpProject
	}
	p := &egresspool.Pool{GCPProject: gcp, Zone: proj.EgressPool.Zone, Label: proj.EgressPool.Label}
	egressPools.pools[projectID] = p
	return p
}

/* ensureEgressWorker makes sure a worker is up, or coming up, for wb's mix. Called from
 * startBroadcastIfEnabled for Edge webinars, which runs on every join, so it is debounced
 * per project; the sweeper calls it too, so a missed start is caught within a tick. */
func (s *Server) ensureEgressWorker(ctx context.Context, wb types.Webinar) {
	if wb.Delivery != types.DeliveryEdge {
		return
	}
	projectID := wb.SFUProject
	if projectID == "" {
		if fresh, err := s.store.WebinarBySlug(ctx, wb.ID); err == nil {
			projectID = fresh.SFUProject
		}
	}
	pool := s.egressPoolFor(ctx, projectID)
	if pool == nil {
		return
	}
	egressPools.mu.Lock()
	if time.Since(egressPools.lastEnsure[projectID]) < egressEnsureEvery {
		egressPools.mu.Unlock()
		return
	}
	egressPools.lastEnsure[projectID] = time.Now()
	egressPools.mu.Unlock()

	s.ensurePoolCapacity(ctx, projectID, pool, wb)
}

func (s *Server) ensurePoolCapacity(ctx context.Context, projectID string, pool *egresspool.Pool, wb types.Webinar) {
	cctx, cancel := context.WithTimeout(ctx, egressCallTimeout)
	defer cancel()
	live, err := s.store.LiveEdgeWebinarsOn(cctx, projectID)
	if err != nil {
		s.log.Warn("egress pool: could not count live webinars", "project", projectID, "error", err)
		return
	}
	workers, err := pool.List(cctx)
	if err != nil {
		s.log.Error("egress pool: could not list workers", "project", projectID, "error", err)
		s.alertOps(ctx, "list:"+projectID, "Edge egress pool: cannot list workers",
			fmt.Sprintf("The API could not list the egress workers of project %q (label %q, zone %s):\n\n%v\n\n"+
				"Edge webinars on this project will have no picture until this is fixed.",
				projectID, pool.Label, pool.Zone, err))
		return
	}
	need := len(live)
	busy := 0
	var stopped []string
	egressPools.mu.Lock()
	for _, w := range workers {
		if w.Busy() || egressPools.starting[w.Name] {
			busy++
		} else if w.Startable() {
			stopped = append(stopped, w.Name)
		}
	}
	egressPools.mu.Unlock()
	if busy >= need {
		return
	}
	if len(stopped) == 0 {
		s.alertOps(ctx, "full:"+projectID, "ALERT: Edge egress pool full — a webinar has no picture",
			fmt.Sprintf("%d Edge webinars are live on project %q but its pool has %d workers and none is free.\n\n"+
				"Webinar waiting: %s\nLive on this project: %s\n\n"+
				"Add a worker now (leave_running = true gets it live fastest):\n%s\n\n"+
				"The webinar's mix starts by itself within a minute of a worker coming up.",
				need, projectID, len(workers), wb.ID, strings.Join(live, ", "), egressPoolWorkflow))
		return
	}
	for _, name := range stopped[:min(len(stopped), need-busy)] {
		s.startWorker(projectID, pool, name, wb)
	}
}

// startWorker powers a worker on in the background and retries wb's mix until it runs.
func (s *Server) startWorker(projectID string, pool *egresspool.Pool, name string, wb types.Webinar) {
	egressPools.mu.Lock()
	if egressPools.starting[name] {
		egressPools.mu.Unlock()
		return
	}
	egressPools.starting[name] = true
	egressPools.mu.Unlock()

	s.log.Info("egress pool: starting worker", "project", projectID, "worker", name, "for", wb.ID)
	go func() { // #nosec G118 -- background work that must outlive the request; it carries its own timeout
		ctx, cancel := context.WithTimeout(context.Background(), egressStartTimeout)
		err := pool.Start(ctx, name)
		cancel()
		egressPools.mu.Lock()
		delete(egressPools.starting, name)
		egressPools.mu.Unlock()
		if err != nil {
			s.log.Error("egress pool: could not start worker", "project", projectID, "worker", name, "error", err)
			subject := "ALERT: Edge egress worker did not start"
			if errors.Is(err, egresspool.ErrCapacity) {
				subject = "ALERT: GCP has no capacity for an Edge egress worker"
			}
			s.alertOps(context.Background(), "start:"+projectID, subject,
				fmt.Sprintf("Starting %s (project %q, zone %s) for webinar %s failed:\n\n%v\n\n"+
					"If this is capacity or quota, add a worker in another zone or raise the quota. Workflow:\n%s",
					name, projectID, pool.Zone, wb.ID, err, egressPoolWorkflow))
			return
		}
		s.log.Info("egress pool: worker up", "project", projectID, "worker", name)
		s.retryMixUntilRunning(wb)
	}()
}

/* retryMixUntilRunning starts wb's mix every few seconds until it runs or the webinar is
 * no longer live: a freshly started worker takes about a minute to join, and the normal
 * restart backoff (10s doubling) would leave the audience waiting longer than that. */
func (s *Server) retryMixUntilRunning(wb types.Webinar) {
	deadline := time.Now().Add(egressRetryFor)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), egressCallTimeout)
		fresh, err := s.store.WebinarBySlug(ctx, wb.ID)
		if err != nil || fresh.Status != types.StatusLive {
			cancel()
			return
		}
		broadcastMu.Lock()
		status := activeBroadcasts[wb.ID]
		broadcastMu.Unlock()
		if status != "" && status != "starting" {
			cancel()
			return
		}
		if sfu, err := s.sfuFor(ctx, fresh); err == nil && status == "" {
			s.startBroadcastIfEnabled(ctx, fresh, sfu)
		}
		cancel()
		time.Sleep(egressRetryEvery)
	}
	s.log.Warn("egress pool: mix still not running after the worker came up", "slug", wb.ID)
}

/* sweepEgressPools runs every tick: it catches a missed start, and stops a project's
 * workers once nothing Edge has been live there for egressIdleGrace. */
func (s *Server) sweepEgressPools(ctx context.Context) {
	for _, proj := range s.cfg.LiveKitProjects {
		if proj.EgressPool == nil {
			continue
		}
		pool := s.egressPoolFor(ctx, proj.ID)
		if pool == nil {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, egressCallTimeout)
		live, err := s.store.LiveEdgeWebinarsOn(cctx, proj.ID)
		cancel()
		if err != nil {
			continue
		}
		if len(live) > 0 {
			egressPools.mu.Lock()
			delete(egressPools.idleSince, proj.ID)
			egressPools.mu.Unlock()
			if wb, err := s.store.WebinarBySlug(ctx, live[0]); err == nil {
				s.ensurePoolCapacity(ctx, proj.ID, pool, wb)
			}
			continue
		}
		egressPools.mu.Lock()
		since, idle := egressPools.idleSince[proj.ID]
		if !idle {
			egressPools.idleSince[proj.ID] = time.Now()
		}
		egressPools.mu.Unlock()
		if !idle || time.Since(since) < egressIdleGrace {
			continue
		}
		lctx, lcancel := context.WithTimeout(ctx, egressCallTimeout)
		workers, err := pool.List(lctx)
		lcancel()
		if err != nil {
			continue
		}
		for _, w := range workers {
			egressPools.mu.Lock()
			starting := egressPools.starting[w.Name]
			egressPools.mu.Unlock()
			if w.Status != "RUNNING" || starting {
				continue
			}
			name, projectID := w.Name, proj.ID
			s.log.Info("egress pool: stopping idle worker", "project", projectID, "worker", name)
			go func() { // #nosec G118 -- background work that must outlive the tick; it carries its own timeout
				sctx, scancel := context.WithTimeout(context.Background(), egressStopTimeout)
				defer scancel()
				if err := pool.Stop(sctx, name); err != nil {
					s.log.Error("egress pool: could not stop worker", "project", projectID, "worker", name, "error", err)
					s.alertOps(context.Background(), "stop:"+projectID, "Edge egress worker did not stop (still billing)",
						fmt.Sprintf("Stopping idle worker %s (project %q) failed:\n\n%v\n\nStop it by hand in the GCP console.",
							name, projectID, err))
				}
			}()
		}
	}
}

/* alertOps emails the operators (OPS_ALERT_EMAILS, else the admin accounts, else the
 * product inbox), at most once per key per egressAlertEvery. Always logged as an error,
 * so it shows in Cloud Logging even without SMTP. */
func (s *Server) alertOps(ctx context.Context, key, subject, body string) {
	egressPools.mu.Lock()
	if time.Since(egressPools.lastAlert[key]) < egressAlertEvery {
		egressPools.mu.Unlock()
		return
	}
	egressPools.lastAlert[key] = time.Now()
	egressPools.mu.Unlock()

	s.log.Error("ops alert", "subject", subject, "body", body)
	if !s.mail.Configured() {
		return
	}
	to := s.cfg.OpsAlertEmails
	if len(to) == 0 {
		actx, cancel := context.WithTimeout(ctx, 10*time.Second)
		admins, err := s.store.AdminEmails(actx)
		cancel()
		if err == nil {
			to = admins
		}
	}
	if len(to) == 0 {
		to = []string{notify.HostRequestRecipient}
	}
	for _, addr := range to {
		addr := addr
		go func() { // #nosec G118 -- best-effort mail that must outlive the caller
			mctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := s.mail.Send(mctx, notify.Message{To: addr, Subject: subject, Body: body}); err != nil {
				s.log.Error("ops alert: send failed", "to", addr, "error", err)
			}
		}()
	}
}
