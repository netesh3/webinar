package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/egresspool"
)

/* Stopping an SFU box while no webinar needs it (LiveKitProject.SfuVM).
 *
 * The Mumbai box costs ~$58 a month running and ~$12 stopped, and most hours nothing is on
 * it. So the sweeper starts it ahead of scheduled webinars and stops it after a quiet spell,
 * and a join or Start that finds it down starts it and answers 503 sfu_starting, which the
 * host and attendee screens show as "getting the video server ready" and retry.
 *
 * The check sits at the top of ensureRoom, before the first call to the server. That is also
 * what keeps a webinar on its server: ensureRoom moves a webinar pinned a moment ago to the
 * next project when the server refuses the room, and a stopped box would otherwise have sent
 * a Mumbai host's first session to Germany for good. */

var errSFUStarting = errors.New("sfu starting")

const (
	sfuSoonWindow   = 15 * time.Minute // start the box this far ahead of a scheduled webinar
	sfuKeepWindow   = time.Hour        // never stop it with a webinar due within this
	sfuIdleGrace    = 20 * time.Minute // quiet for this long before it is stopped
	sfuReadyFor     = 30 * time.Second // a box found answering is trusted for this long
	sfuProbeTimeout = 3 * time.Second
	sfuStartTimeout = 3 * time.Minute
)

type sfuVMState struct {
	mu         sync.Mutex
	pools      map[string]*egresspool.Pool
	readyUntil map[string]time.Time
	starting   map[string]bool
	lastNeeded map[string]time.Time
}

var sfuVMs = sfuVMState{
	pools:      map[string]*egresspool.Pool{},
	readyUntil: map[string]time.Time{},
	starting:   map[string]bool{},
	lastNeeded: map[string]time.Time{},
}

// sfuVMFor is the client for a project's SFU VM and its name, or nil when it has none.
func (s *Server) sfuVMFor(ctx context.Context, projectID string) (*egresspool.Pool, string) {
	proj, ok := s.cfg.LiveKitProjectByID(projectID)
	if !ok || proj.SfuVM == nil {
		return nil, ""
	}
	sfuVMs.mu.Lock()
	p := sfuVMs.pools[projectID]
	sfuVMs.mu.Unlock()
	if p != nil {
		return p, proj.SfuVM.Name
	}
	gcp := strings.TrimSpace(proj.SfuVM.GCPProject)
	if gcp == "" {
		mctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		id, err := egresspool.MetadataProject(mctx)
		cancel()
		if err != nil {
			s.log.Error("sfu vm: no GCP project (set sfuVm.gcpProject)", "project", projectID, "error", err)
			return nil, ""
		}
		gcp = id
	}
	p = &egresspool.Pool{GCPProject: gcp, Zone: proj.SfuVM.Zone}
	sfuVMs.mu.Lock()
	sfuVMs.pools[projectID] = p
	sfuVMs.mu.Unlock()
	return p, proj.SfuVM.Name
}

/* sfuReady is nil when the project's server can take a room now: it has no managed VM, or
 * the VM is running and LiveKit answers. Otherwise it starts the VM if it is stopped and
 * returns errSFUStarting. A failure to read the VM's state is let through, so a Compute API
 * blip never blocks a join the server could have taken. */
func (s *Server) sfuReady(ctx context.Context, projectID string) error {
	pool, name := s.sfuVMFor(ctx, projectID)
	if pool == nil {
		return nil
	}
	now := time.Now()
	sfuVMs.mu.Lock()
	sfuVMs.lastNeeded[projectID] = now
	ready := now.Before(sfuVMs.readyUntil[projectID])
	sfuVMs.mu.Unlock()
	if ready {
		return nil
	}

	sctx, cancel := context.WithTimeout(ctx, egressCallTimeout)
	status, err := pool.Status(sctx, name)
	cancel()
	if err != nil {
		s.log.Warn("sfu vm: could not read status, letting the join through", "project", projectID, "error", err)
		return nil
	}
	switch status {
	case "RUNNING":
		if s.sfuAnswers(ctx, projectID) {
			sfuVMs.mu.Lock()
			sfuVMs.readyUntil[projectID] = time.Now().Add(sfuReadyFor)
			sfuVMs.mu.Unlock()
			return nil
		}
		return errSFUStarting // booted, services still coming up
	case "TERMINATED", "SUSPENDED":
		s.startSFUVM(projectID, pool, name, "a join")
		return errSFUStarting
	default: // PROVISIONING, STAGING, STOPPING, REPAIRING: wait for it
		return errSFUStarting
	}
}

// sfuAnswers is LiveKit replying over HTTP: any response at all means it is up.
func (s *Server) sfuAnswers(ctx context.Context, projectID string) bool {
	proj, ok := s.cfg.LiveKitProjectByID(projectID)
	if !ok || proj.HTTPURL == "" {
		return true
	}
	pctx, cancel := context.WithTimeout(ctx, sfuProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, proj.HTTPURL, nil)
	if err != nil {
		return true
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return true
}

// startSFUVM powers the VM on in the background, once at a time, and alerts if GCP refuses.
func (s *Server) startSFUVM(projectID string, pool *egresspool.Pool, name, why string) {
	sfuVMs.mu.Lock()
	if sfuVMs.starting[projectID] {
		sfuVMs.mu.Unlock()
		return
	}
	sfuVMs.starting[projectID] = true
	sfuVMs.mu.Unlock()

	s.log.Info("sfu vm: starting", "project", projectID, "vm", name, "for", why)
	go func() { // #nosec G118 -- background work that must outlive the request; it carries its own timeout
		ctx, cancel := context.WithTimeout(context.Background(), sfuStartTimeout)
		err := pool.Start(ctx, name)
		cancel()
		sfuVMs.mu.Lock()
		delete(sfuVMs.starting, projectID)
		sfuVMs.mu.Unlock()
		if err != nil {
			s.log.Error("sfu vm: could not start", "project", projectID, "vm", name, "error", err)
			subject := "ALERT: video server did not start — webinars on it cannot begin"
			if errors.Is(err, egresspool.ErrCapacity) {
				subject = "ALERT: GCP has no capacity to start the video server"
			}
			s.alertOps(context.Background(), "sfu-start:"+projectID, subject,
				fmt.Sprintf("Starting %s (project %q, zone %s) for %s failed:\n\n%v\n\n"+
					"Hosts and attendees on this server see \"getting the video server ready\" until it runs. "+
					"Start it in the GCP console, or move the host to another video server in Admin.",
					name, projectID, pool.Zone, why, err))
			return
		}
		s.log.Info("sfu vm: up", "project", projectID, "vm", name)
	}()
}

/* sweepSFUVMs runs every tick: start a project's box ahead of webinars due on it, and stop
 * it once nothing has needed it for sfuIdleGrace with nothing live or due within the hour. */
func (s *Server) sweepSFUVMs(ctx context.Context) {
	candidates := s.sfu.Candidates()
	for _, proj := range s.cfg.LiveKitProjects {
		if proj.SfuVM == nil {
			continue
		}
		pool, name := s.sfuVMFor(ctx, proj.ID)
		if pool == nil {
			continue
		}
		isDefault := len(candidates) > 0 && candidates[0] == proj.ID
		dctx, cancel := context.WithTimeout(ctx, egressCallTimeout)
		live, soon, err := s.store.SFUDemand(dctx, proj.ID, sfuSoonWindow, isDefault)
		cancel()
		if err != nil {
			continue
		}
		sctx, scancel := context.WithTimeout(ctx, egressCallTimeout)
		status, err := pool.Status(sctx, name)
		scancel()
		if err != nil {
			continue
		}
		now := time.Now()
		if live > 0 || soon > 0 {
			sfuVMs.mu.Lock()
			sfuVMs.lastNeeded[proj.ID] = now
			sfuVMs.mu.Unlock()
			if status == "TERMINATED" || status == "SUSPENDED" {
				s.startSFUVM(proj.ID, pool, name, fmt.Sprintf("%d live and %d due soon", live, soon))
			}
			continue
		}
		if status != "RUNNING" {
			continue
		}
		sfuVMs.mu.Lock()
		last, seen := sfuVMs.lastNeeded[proj.ID]
		if !seen {
			// First look since this process started: give it the full grace from now.
			sfuVMs.lastNeeded[proj.ID] = now
		}
		sfuVMs.mu.Unlock()
		if !seen || now.Sub(last) < sfuIdleGrace {
			continue
		}
		kctx, kcancel := context.WithTimeout(ctx, egressCallTimeout)
		_, dueHour, err := s.store.SFUDemand(kctx, proj.ID, sfuKeepWindow, isDefault)
		kcancel()
		if err != nil || dueHour > 0 {
			continue
		}
		projectID := proj.ID
		s.log.Info("sfu vm: stopping idle video server", "project", projectID, "vm", name)
		sfuVMs.mu.Lock()
		delete(sfuVMs.readyUntil, projectID)
		sfuVMs.mu.Unlock()
		go func() { // #nosec G118 -- background work that must outlive the tick; it carries its own timeout
			stctx, stcancel := context.WithTimeout(context.Background(), egressStopTimeout)
			defer stcancel()
			if err := pool.Stop(stctx, name); err != nil {
				s.log.Error("sfu vm: could not stop", "project", projectID, "vm", name, "error", err)
				s.alertOps(context.Background(), "sfu-stop:"+projectID, "Video server did not stop (still billing)",
					fmt.Sprintf("Stopping idle %s (project %q) failed:\n\n%v\n\nStop it by hand in the GCP console.",
						name, projectID, err))
			}
		}()
	}
}
