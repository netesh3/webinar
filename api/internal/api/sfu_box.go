package api

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The on-demand video server (config.SFUBox, deploy/digitalocean/README.md).
 *
 * The DigitalOcean box (a c-4, $0.125/h) used to run around the clock. Now it exists only
 * while something needs it: the API creates a droplet from the newest 'webinar-sfu-image'
 * snapshot, with the 'sfu-data' volume (keys, certificates, mix-recording staging) and the
 * reserved IP, and deletes it again after a quiet spell.
 * The volume and the IP outlive every droplet, so each one comes up as the same server.
 *
 * The manager is a state machine stepped by the one-minute tick (and by a join that finds the
 * box down), one step at a time under the row lease in sfu_box_state:
 *
 *   down ─create→ creating ─active, IP assigned→ booting ─health OK→ ready
 *   ready ─not wanted, nothing running→ deleting ─gone→ down
 *   ready ─not wanted, something still running→ draining (back to ready if wanted again)
 *   create or boot fails → retried with backoff; after MaxFailures, failed (still retried):
 *   admins are alerted (email, bell, push) and hosts see an error with "Try again".
 *
 * Wanted ("up") is: AlwaysOn, or any session on the project live, finalizing its transcript,
 * recording or uploading, scheduled to start within WarmLead (or up to 30 minutes late), a
 * join or instant session asking for it, or LiveKit reporting people or egress on it; or less
 * than IdleGrace since the last of those. There is deliberately no fallback to another video
 * server: a session on this project waits for this box. */

var errSFUFailed = errors.New("sfu box failed to start")

// sfuFailed is the error code for a video server that could not be started.
const sfuFailed = "sfu_failed"

const (
	// boxLeaseTTL bounds one step (a handful of DigitalOcean calls).
	boxLeaseTTL = 90 * time.Second
	// boxStepBudget is the most one step may take inside the tick.
	boxStepBudget = 45 * time.Second
	// boxJoinStepBudget is the step a join runs when it finds the box down.
	boxJoinStepBudget = 10 * time.Second
	// boxRequestHold is how long a join or instant session keeps the box wanted.
	boxRequestHold = 10 * time.Minute
	// boxStateCache is how long a join trusts the state it read.
	boxStateCache = 3 * time.Second
	// boxProbeEvery throttles a join's own readiness probe while booting.
	boxProbeEvery = 10 * time.Second
	// boxProbeTimeout bounds each readiness check.
	boxProbeTimeout = 5 * time.Second
	// boxDeleteResend re-sends a delete that has not finished.
	boxDeleteResend = 3 * time.Minute
	// boxBootEstimate is what the waiting screen says a boot takes.
	boxBootEstimate = 2 * time.Minute
	// boxIPStuckAlert is how long an active droplet may wait for the reserved IP before the
	// admins are told. It is not deleted for it: a new droplet would wait for the same IP.
	boxIPStuckAlert = 3 * time.Minute
	// boxParkCheckEvery is how often a box that is down checks the IP is parked.
	boxParkCheckEvery = 5 * time.Minute
)

// boxCloud is the DigitalOcean calls the manager makes (doapi.Client; a fake in tests).
type boxCloud interface {
	DropletsByTag(ctx context.Context, tag string) ([]doapi.Droplet, error)
	DropletsByName(ctx context.Context, name string) ([]doapi.Droplet, error)
	Droplet(ctx context.Context, id int64) (doapi.Droplet, error)
	CreateDroplet(ctx context.Context, req doapi.CreateDroplet) (doapi.Droplet, error)
	DeleteDroplet(ctx context.Context, id int64) error
	LatestSnapshot(ctx context.Context, tag, namePrefix, region string) (doapi.Image, error)
	VolumeByName(ctx context.Context, name, region string) (doapi.Volume, error)
	ReservedIPDroplet(ctx context.Context, ip string) (int64, error)
	AssignReservedIP(ctx context.Context, ip string, dropletID int64) error
}

// boxActivity is a RoomManager that can say what is running on the server (lk.Client).
type boxActivity interface {
	Activity(ctx context.Context) (lk.Activity, error)
}

type boxManager struct {
	cfg   config.SFUBox
	cloud boxCloud
	// probe is the readiness check; activity asks LiveKit what is running. Tests replace both.
	probe    func(ctx context.Context) error
	activity func(ctx context.Context) (lk.Activity, error)
	now      func() time.Time

	mu        sync.Mutex
	cached    store.SFUBoxState
	cachedAt  time.Time
	lastProbe time.Time
	// lastSkipLog throttles boxRoom's "not reachable, skipped" line; lastParkCheck the IP check
	// while down.
	lastSkipLog   time.Time
	lastParkCheck time.Time
	// lastCaptionsSweep throttles the check for a stray captions droplet (captions_box.go).
	lastCaptionsSweep time.Time
}

func (b *boxManager) invalidate() {
	b.mu.Lock()
	b.cachedAt = time.Time{}
	b.mu.Unlock()
}

// newBoxManager wires the box for cfg.SFUBox, or nil when it is off.
func (s *Server) newBoxManager() *boxManager {
	bc := s.cfg.SFUBox
	if !bc.Enabled() {
		return nil
	}
	// The defaults of config.loadSFUBox, for a config built by hand (tests).
	if bc.ManagedTag == "" {
		bc.ManagedTag = "webinar-sfu-ondemand"
	}
	if bc.WarmLead <= 0 {
		bc.WarmLead = 15 * time.Minute
	}
	if bc.IdleGrace <= 0 {
		bc.IdleGrace = 40 * time.Minute
	}
	if bc.BootTimeout <= 0 {
		bc.BootTimeout = 12 * time.Minute
	}
	if bc.MaxFailures < 1 {
		bc.MaxFailures = 3
	}
	bc.Captions = bc.Captions.WithDefaults()
	b := &boxManager{cfg: bc, cloud: doapi.New(bc.Token), now: time.Now}
	b.probe = s.boxProbe
	b.activity = s.boxLiveKitActivity
	return b
}

// managesProject is whether project's server is the on-demand box.
func (s *Server) managesProject(project string) bool {
	return s.box != nil && project != "" && project == s.box.cfg.Project
}

// ---------------------------------------------------------------- the decision

// boxInputs is everything the up/down decision reads.
type boxInputs struct {
	Now        time.Time
	AlwaysOn   bool
	Live       int
	Soon       int
	Finalizing int
	Recordings int
	Requested  bool
	/* Clips is clip jobs being made on the box (their lease alive) and jobs an admin asked
	 * to make now (clip_jobs.go). Wanted while there are any, so a render is never cut off;
	 * but not a session, so it does not start the idle grace: once they are made the box
	 * goes as soon as nothing else needs it. */
	Clips int
	// RoomsBusy is LiveKit reporting participants or egress on the server.
	RoomsBusy  bool
	LastNeeded *time.Time
	IdleGrace  time.Duration
}

type boxDecision struct {
	Desired string
	// Needed is something wanting the box right now (not just the grace).
	Needed bool
	// ClipsOnly is Needed by clip jobs alone, which does not restart the idle grace.
	ClipsOnly bool
	Reason    string
}

// decideBox is the whole up/down rule, pure so it is tested on its own.
func decideBox(in boxInputs) boxDecision {
	var why []string
	if in.AlwaysOn {
		why = append(why, "always on")
	}
	if in.Live > 0 {
		why = append(why, fmt.Sprintf("%d live", in.Live))
	}
	if in.Finalizing > 0 {
		why = append(why, fmt.Sprintf("%d finalizing", in.Finalizing))
	}
	if in.Recordings > 0 {
		why = append(why, fmt.Sprintf("%d recording or uploading", in.Recordings))
	}
	if in.Soon > 0 {
		why = append(why, fmt.Sprintf("%d starting soon", in.Soon))
	}
	if in.Requested {
		why = append(why, "requested")
	}
	if in.RoomsBusy {
		why = append(why, "rooms or egress running")
	}
	sessions := len(why)
	if in.Clips > 0 {
		why = append(why, fmt.Sprintf("%d clips to make", in.Clips))
	}
	if len(why) > 0 {
		return boxDecision{Desired: "up", Needed: true, ClipsOnly: sessions == 0, Reason: strings.Join(why, ", ")}
	}
	if in.LastNeeded != nil {
		if left := in.IdleGrace - in.Now.Sub(*in.LastNeeded); left > 0 {
			return boxDecision{Desired: "up", Reason: fmt.Sprintf("idle grace, %s left", left.Round(time.Minute))}
		}
	}
	return boxDecision{Desired: "down", Reason: "nothing needs it"}
}

// boxBackoff is the wait before attempt n+1 after n failures: 30s, 1m, 2m, 4m, then 5m.
func boxBackoff(failures int) time.Duration {
	d := 30 * time.Second
	for i := 1; i < failures && d < 5*time.Minute; i++ {
		d *= 2
	}
	return min(d, 5*time.Minute)
}

// ---------------------------------------------------------------- the tick

/* sweepSFUBox is the box's step: a lane of RunTick of its own, with its own deadline, so no
 * sweep can starve it. Its own lease (sfu_box_state) keeps two runners from stepping at once.
 * It used to run inside the realtime lane after the sweeps that ask the box's LiveKit about
 * every live session; with the box unreachable those ate the lane, this step started with an
 * expired context, and the reserved IP that would have made the box reachable was never
 * moved (24 Oct 2026). */
func (s *Server) sweepSFUBox(ctx context.Context) {
	if s.box == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, boxStepBudget)
	defer cancel()
	s.boxStep(ctx)
}

/* boxStep is one step of the state machine, under the row lease. A step that cannot take the
 * lease does nothing: whoever holds it is stepping. */
func (s *Server) boxStep(ctx context.Context) {
	b := s.box
	project := b.cfg.Project
	holder, st, ok, err := s.store.TakeSFUBoxLease(ctx, project, boxLeaseTTL)
	if err != nil {
		s.log.Error("sfu box: lease", "project", project, "error", err)
		return
	}
	if !ok {
		return
	}
	defer func() {
		rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		_ = s.store.ReleaseSFUBoxLease(rctx, project, holder)
		rcancel()
		b.invalidate()
	}()

	now := b.now()
	def := s.defaultCostProject()
	dem, err := s.store.SFUBoxDemand(ctx, project, def, b.cfg.WarmLead)
	if err != nil {
		s.log.Error("sfu box: demand", "project", project, "error", err)
		return
	}
	finalizing, err := s.store.FinalizingOn(ctx, project, def)
	if err != nil {
		s.log.Error("sfu box: finalizing", "project", project, "error", err)
		return
	}
	clipsMaking, clipsRushed, err := s.store.ClipDemand(ctx, clipMaxAttempts)
	if err != nil {
		s.log.Error("sfu box: clip demand", "project", project, "error", err)
		return
	}
	var act lk.Activity
	var actErr error
	if st.Actual == store.BoxReady || st.Actual == store.BoxDraining {
		act, actErr = b.activity(ctx)
	}
	in := boxInputs{
		Now: now, AlwaysOn: b.cfg.AlwaysOn, Clips: clipsMaking + clipsRushed,
		Live: dem.Live, Soon: dem.Soon, Finalizing: finalizing, Recordings: dem.Recordings,
		Requested:  st.RequestedUntil != nil && st.RequestedUntil.After(now),
		RoomsBusy:  actErr == nil && act.Busy(),
		LastNeeded: st.LastNeededAt, IdleGrace: b.cfg.IdleGrace,
	}
	if dem.LastEnded != nil && (in.LastNeeded == nil || dem.LastEnded.After(*in.LastNeeded)) {
		in.LastNeeded = dem.LastEnded
	}
	dec := decideBox(in)
	if dec.Needed && !dec.ClipsOnly {
		in.LastNeeded = &now
	}
	st.LastNeededAt = in.LastNeeded
	if st.Desired != dec.Desired {
		s.log.Info("sfu box: desired state", "project", project, "desired", dec.Desired, "reason", dec.Reason)
	}
	st.Desired = dec.Desired

	before := st.Actual
	s.boxAct(ctx, &st, in, act, actErr)
	if st.Actual != before {
		s.log.Info("sfu box: state", "project", project, "from", before, "to", st.Actual,
			"droplet", st.DropletID, "reason", dec.Reason, "error", st.LastError)
	}

	// Not ready when a session should already have begun: tell the admins, once.
	if st.Desired == "up" && st.Actual != store.BoxReady && dem.NextStart != nil &&
		now.After(*dem.NextStart) && st.AlertedAt == nil {
		s.boxAlert(ctx, &st, "ALERT: video server not ready at a session's start",
			fmt.Sprintf("A session on %s was due to start at %s and the video server is %s (droplet %d). Last error: %s\n\n"+
				"Hosts and attendees see \"Starting servers…\" until it is up. There is no fallback server.",
				project, dem.NextStart.UTC().Format(time.RFC3339), st.Actual, st.DropletID, orNone(st.LastError)))
	}

	if err := s.store.SaveSFUBox(ctx, holder, st); err != nil {
		s.log.Error("sfu box: save", "project", project, "error", err)
		return
	}
	// The captions droplet follows, once the video box's step is saved (captions_box.go).
	s.captionsBoxStep(ctx, holder, st)
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func (s *Server) setBoxActual(st *store.SFUBoxState, actual string, now time.Time) {
	if st.Actual != actual {
		st.Actual = actual
		st.Since = now
	}
}

// boxAct moves the box one step towards st.Desired.
func (s *Server) boxAct(ctx context.Context, st *store.SFUBoxState, in boxInputs, act lk.Activity, actErr error) {
	b := s.box
	now := in.Now
	switch st.Actual {
	case store.BoxDown, store.BoxFailed:
		if st.Desired == "down" {
			if st.Actual == store.BoxFailed {
				s.setBoxActual(st, store.BoxDown, now)
				st.Failures, st.NextAttemptAt, st.AlertedAt = 0, nil, nil
			}
			// A managed droplet nobody knows about (a delete or create whose answer was lost):
			// take it back so the normal path deletes it.
			if d, ok := s.boxFindManaged(ctx); ok {
				s.boxAdopt(ctx, st, d, now)
				return
			}
			// The IP goes back to the park droplet when the box goes; a park that failed (an
			// unassign still pending at DigitalOcean) is retried here, every few minutes.
			b.mu.Lock()
			due := time.Since(b.lastParkCheck) >= boxParkCheckEvery
			if due {
				b.lastParkCheck = time.Now()
			}
			b.mu.Unlock()
			if due {
				s.boxParkIP(ctx)
			}
			return
		}
		if st.NextAttemptAt != nil && now.Before(*st.NextAttemptAt) {
			return
		}
		if d, ok := s.boxFindManaged(ctx); ok {
			s.boxAdopt(ctx, st, d, now)
			return
		}
		d, err := s.boxCreate(ctx)
		if err != nil {
			s.boxFailure(ctx, st, now, "create", err)
			return
		}
		st.DropletID = d.ID
		st.LastError = ""
		s.setBoxActual(st, store.BoxCreating, now)
		if err := s.store.StartSFUBoxRun(ctx, b.cfg.Project, d.ID, d.Created()); err != nil {
			s.log.Error("sfu box: record run", "error", err)
		}

	case store.BoxCreating:
		d, err := b.cloud.Droplet(ctx, st.DropletID)
		if doapi.IsNotFound(err) {
			s.boxGone(ctx, st, now)
			s.boxFailure(ctx, st, now, "create", errors.New("the new droplet disappeared"))
			return
		}
		if err != nil {
			st.LastError = "read droplet: " + err.Error()
			return
		}
		if st.Desired == "down" {
			// Nobody can be on a server that never came up.
			s.boxDelete(ctx, st, now)
			return
		}
		if d.Status == "active" {
			if err := s.boxAssignIP(ctx, d.ID); err != nil {
				st.LastError = "assign reserved IP: " + err.Error()
				s.boxIPStuck(ctx, st, d, now, err)
				// Not the boot deadline: the droplet is up and a new one would wait for the
				// same IP. The next step (a minute) assigns again.
				return
			}
			st.LastError = ""
			s.setBoxActual(st, store.BoxBooting, now)
			return
		}
		s.boxBootDeadline(ctx, st, d, now)

	case store.BoxBooting:
		perr := b.probe(ctx)
		if perr == nil {
			s.setBoxActual(st, store.BoxReady, now)
			st.Failures, st.LastError, st.NextAttemptAt, st.AlertedAt = 0, "", nil, nil
			if err := s.store.ReadySFUBoxRun(ctx, b.cfg.Project, st.DropletID); err != nil {
				s.log.Error("sfu box: record ready", "error", err)
			}
			return
		}
		st.LastError = "not ready yet: " + perr.Error()
		if st.Desired == "down" {
			// Not ready, so nobody should be on it; but an adopted droplet might be serving
			// through a failed check, so ask LiveKit before deleting.
			if a, aerr := b.activity(ctx); aerr == nil && a.Busy() {
				return
			}
			s.boxDelete(ctx, st, now)
			return
		}
		d, err := b.cloud.Droplet(ctx, st.DropletID)
		if doapi.IsNotFound(err) {
			s.boxGone(ctx, st, now)
			s.boxFailure(ctx, st, now, "boot", errors.New("the droplet disappeared while booting"))
			return
		}
		if err == nil {
			// The IP is assigned on the way into booting; an adopted droplet may not have it.
			if ipErr := s.boxAssignIP(ctx, d.ID); ipErr != nil {
				st.LastError = "assign reserved IP: " + ipErr.Error()
			}
			s.boxBootDeadline(ctx, st, d, now)
		}

	case store.BoxReady, store.BoxDraining:
		if st.Desired == "up" {
			s.setBoxActual(st, store.BoxReady, now)
			_, err := b.cloud.Droplet(ctx, st.DropletID)
			if doapi.IsNotFound(err) {
				s.boxGone(ctx, st, now)
				s.boxAlert(ctx, st, "ALERT: video server droplet disappeared",
					fmt.Sprintf("Droplet %d of %s was deleted outside the API while it was wanted. A new one is being created.",
						st.DropletID, b.cfg.Project))
				return
			}
			if err == nil {
				// The reserved IP is what everybody connects to: put it back if it moved.
				s.boxKeepIP(ctx, st)
			}
			return
		}
		if busy, why := s.boxBusy(ctx, in, act, actErr); busy {
			if st.Actual != store.BoxDraining {
				s.log.Info("sfu box: idle but still busy, draining", "project", b.cfg.Project, "why", why)
			}
			s.setBoxActual(st, store.BoxDraining, now)
			return
		}
		s.boxDelete(ctx, st, now)

	case store.BoxDeleting:
		_, err := b.cloud.Droplet(ctx, st.DropletID)
		if doapi.IsNotFound(err) {
			s.boxGone(ctx, st, now)
			return
		}
		if err == nil && now.Sub(st.Since) > boxDeleteResend {
			if err := b.cloud.DeleteDroplet(ctx, st.DropletID); err != nil {
				st.LastError = "delete droplet: " + err.Error()
			}
		}
	}
}

/* boxBusy is the drain check before a delete: never while anything is live, finalizing,
 * recording or uploading, or LiveKit has people or egress on it. LiveKit not answering counts
 * as busy unless the box fails its health check too (then nothing can be using it). */
func (s *Server) boxBusy(ctx context.Context, in boxInputs, act lk.Activity, actErr error) (bool, string) {
	switch {
	case in.Live > 0, in.Finalizing > 0, in.Recordings > 0, in.Soon > 0:
		return true, "sessions"
	case in.Clips > 0:
		return true, "clips being made"
	case actErr == nil && act.Busy():
		return true, fmt.Sprintf("%d participants, %d egress", act.Participants, act.Egresses)
	case actErr != nil:
		if s.box.probe(ctx) == nil {
			return true, "livekit did not say what is running: " + actErr.Error()
		}
	}
	return false, ""
}

// boxBootDeadline fails a droplet that has not come up within BootTimeout.
func (s *Server) boxBootDeadline(ctx context.Context, st *store.SFUBoxState, d doapi.Droplet, now time.Time) {
	// The later of the droplet's birth and entering this state: an adopted droplet (days old,
	// say) gets the full timeout from when it was adopted, not an instant failure.
	created := maxTime(d.Created(), st.Since)
	if now.Sub(created) <= s.box.cfg.BootTimeout {
		return
	}
	reason := fmt.Errorf("droplet %d not ready %s after create (status %s; %s)",
		d.ID, now.Sub(created).Round(time.Second), d.Status, orNone(st.LastError))
	// Failing the check but with people on it (an adopted box whose TURN certificate lapsed,
	// say): never pull it from under them. Tell the admins instead.
	if a, aerr := s.box.activity(ctx); aerr == nil && a.Busy() {
		if st.AlertedAt == nil {
			s.boxAlert(ctx, st, "ALERT: video server failing its health check while in use",
				fmt.Sprintf("%v\n\nLiveKit reports %d participants and %d egress on it, so it is left running.",
					reason, a.Participants, a.Egresses))
		}
		return
	}
	s.boxDelete(ctx, st, now)
	s.boxFailure(ctx, st, now, "boot", reason)
}

// boxFailure counts a failed attempt, schedules the next and alerts at MaxFailures.
func (s *Server) boxFailure(ctx context.Context, st *store.SFUBoxState, now time.Time, what string, err error) {
	st.Failures++
	next := now.Add(boxBackoff(st.Failures))
	st.NextAttemptAt = &next
	st.LastError = what + ": " + err.Error()
	s.log.Error("sfu box: attempt failed", "project", s.box.cfg.Project, "what", what,
		"failures", st.Failures, "error", err)
	if st.Failures < s.box.cfg.MaxFailures {
		return
	}
	if st.Actual == store.BoxDown {
		s.setBoxActual(st, store.BoxFailed, now)
	}
	if st.AlertedAt == nil {
		s.boxAlert(ctx, st, "ALERT: video server could not be started",
			fmt.Sprintf("The on-demand video server for %s failed %d times in a row (%s).\n\nLast error: %s\n\n"+
				"It keeps retrying every few minutes. Hosts see \"The video server could not be started\" with a Try again "+
				"button; there is no fallback server. To keep it up by hand set SFU_BOX_ALWAYS_ON=true on the API, "+
				"or see deploy/digitalocean/README.md.",
				s.box.cfg.Project, st.Failures, what, st.LastError))
	}
}

// boxGone records the droplet as deleted and the box down.
func (s *Server) boxGone(ctx context.Context, st *store.SFUBoxState, now time.Time) {
	if st.DropletID != 0 {
		if err := s.store.EndSFUBoxRun(ctx, s.box.cfg.Project, st.DropletID); err != nil {
			s.log.Error("sfu box: record end", "error", err)
		}
	}
	st.DropletID = 0
	s.setBoxActual(st, store.BoxDown, now)
	s.boxParkIP(ctx)
}

// boxDelete sends the delete.
func (s *Server) boxDelete(ctx context.Context, st *store.SFUBoxState, now time.Time) {
	if st.DropletID == 0 {
		s.setBoxActual(st, store.BoxDown, now)
		return
	}
	if err := s.box.cloud.DeleteDroplet(ctx, st.DropletID); err != nil {
		st.LastError = "delete droplet: " + err.Error()
		return
	}
	s.log.Info("sfu box: deleting droplet", "project", s.box.cfg.Project, "droplet", st.DropletID)
	s.setBoxActual(st, store.BoxDeleting, now)
}

// boxFindManaged is a droplet carrying the managed tag, if there is one.
func (s *Server) boxFindManaged(ctx context.Context) (doapi.Droplet, bool) {
	list, err := s.box.cloud.DropletsByTag(ctx, s.box.cfg.ManagedTag)
	if err != nil {
		s.log.Warn("sfu box: list droplets", "error", err)
		return doapi.Droplet{}, false
	}
	for _, d := range list {
		if d.Status != "archive" {
			return d, true
		}
	}
	return doapi.Droplet{}, false
}

// boxAdopt takes an existing managed droplet as this box's.
func (s *Server) boxAdopt(ctx context.Context, st *store.SFUBoxState, d doapi.Droplet, now time.Time) {
	s.log.Info("sfu box: adopting existing droplet", "project", s.box.cfg.Project, "droplet", d.ID, "status", d.Status)
	st.DropletID = d.ID
	if err := s.store.StartSFUBoxRun(ctx, s.box.cfg.Project, d.ID, d.Created()); err != nil {
		s.log.Error("sfu box: record run", "error", err)
	}
	if d.Status == "active" {
		s.setBoxActual(st, store.BoxBooting, now)
		return
	}
	s.setBoxActual(st, store.BoxCreating, now)
}

// boxCreate creates the droplet: newest snapshot, the volume, the tags and the boot script.
func (s *Server) boxCreate(ctx context.Context) (doapi.Droplet, error) {
	c := s.box.cfg
	img, err := s.box.cloud.LatestSnapshot(ctx, c.SnapshotTag, c.SnapshotTag+"-", c.Region)
	if err != nil {
		return doapi.Droplet{}, fmt.Errorf("snapshot %q: %w", c.SnapshotTag, err)
	}
	vol, err := s.box.cloud.VolumeByName(ctx, c.Volume, c.Region)
	if err != nil {
		return doapi.Droplet{}, fmt.Errorf("volume %q: %w", c.Volume, err)
	}
	if len(vol.DropletIDs) > 0 {
		return doapi.Droplet{}, fmt.Errorf("volume %q is still attached to droplet %d", c.Volume, vol.DropletIDs[0])
	}
	userData, err := boxUserData(c)
	if err != nil {
		return doapi.Droplet{}, err
	}
	tags := append([]string{}, c.Tags...)
	tags = append(tags, c.ManagedTag)
	s.log.Info("sfu box: creating droplet", "project", c.Project, "image", img.Name, "size", c.Size, "region", c.Region)
	return s.box.cloud.CreateDroplet(ctx, doapi.CreateDroplet{
		Name: c.Name, Region: c.Region, Size: c.Size, Image: img.ID,
		SSHKeys: c.SSHKeys, Monitoring: true, Tags: tags, UserData: userData,
		Volumes: []string{vol.ID}, VPCUUID: c.VPCUUID,
	})
}

// boxAssignIP points the reserved IP at the droplet, unless it already is.
func (s *Server) boxAssignIP(ctx context.Context, dropletID int64) error {
	ip := s.box.cfg.ReservedIP
	cur, err := s.box.cloud.ReservedIPDroplet(ctx, ip)
	if err != nil {
		return err
	}
	if cur == dropletID {
		return nil
	}
	aerr := s.box.cloud.AssignReservedIP(ctx, ip, dropletID)
	if aerr == nil {
		s.log.Info("sfu box: reserved IP assigned", "ip", ip, "droplet", dropletID, "from", cur)
		return nil
	}
	/* DigitalOcean refuses an assign the IP already has (422 "already assigned"), and its read
	 * can lag an assign made a moment ago (by an operator, or by the step before). Ask again:
	 * on the droplet now is success, not a failure to count. */
	if again, err := s.box.cloud.ReservedIPDroplet(ctx, ip); err == nil && again == dropletID {
		return nil
	}
	return aerr
}

// boxKeepIP checks a ready box still has the reserved IP and assigns it again if not.
func (s *Server) boxKeepIP(ctx context.Context, st *store.SFUBoxState) {
	ip := s.box.cfg.ReservedIP
	cur, err := s.box.cloud.ReservedIPDroplet(ctx, ip)
	if err != nil || cur == st.DropletID {
		return
	}
	s.log.Error("sfu box: reserved IP is not on the ready box, assigning it again",
		"project", s.box.cfg.Project, "ip", ip, "droplet", st.DropletID, "ipOn", cur)
	if err := s.boxAssignIP(ctx, st.DropletID); err != nil {
		st.LastError = "assign reserved IP: " + err.Error()
		s.log.Error("sfu box: assign reserved IP", "project", s.box.cfg.Project, "droplet", st.DropletID, "error", err)
	}
}

/* boxIPStuck is an active droplet whose reserved IP would not move: logged loudly every
 * step, and after boxIPStuckAlert the admins are told (once). The step keeps assigning. */
func (s *Server) boxIPStuck(ctx context.Context, st *store.SFUBoxState, d doapi.Droplet, now time.Time, err error) {
	waiting := now.Sub(maxTime(d.Created(), st.Since))
	s.log.Error("sfu box: could not assign the reserved IP to the active droplet",
		"project", s.box.cfg.Project, "ip", s.box.cfg.ReservedIP, "droplet", d.ID,
		"waiting", waiting.Round(time.Second), "error", err)
	if waiting < boxIPStuckAlert || st.AlertedAt != nil {
		return
	}
	s.boxAlert(ctx, st, "ALERT: video server waiting for its reserved IP",
		fmt.Sprintf("Droplet %d of %s is active but reserved IP %s could not be moved onto it for %s.\n\nLast error: %v\n\n"+
			"It keeps trying every minute. Nobody can reach the video server until the IP is on it; "+
			"assign it by hand in DigitalOcean (Networking > Reserved IPs) if this does not clear.",
			d.ID, s.box.cfg.Project, s.box.cfg.ReservedIP, waiting.Round(time.Second), err))
}

// boxParkIP moves the reserved IP to the park droplet (an unassigned one bills $5/month).
func (s *Server) boxParkIP(ctx context.Context) {
	name := s.box.cfg.ParkDroplet
	if name == "" {
		return
	}
	list, err := s.box.cloud.DropletsByName(ctx, name)
	if err != nil || len(list) == 0 {
		s.log.Warn("sfu box: park droplet not found; the reserved IP stays unassigned", "name", name, "error", err)
		return
	}
	if err := s.boxAssignIP(ctx, list[0].ID); err != nil {
		s.log.Warn("sfu box: could not park the reserved IP", "name", name, "error", err)
	}
}

var boxSafe = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// boxGrafanaFile is where the user data leaves the Grafana Cloud settings for sfu-boot.sh (tmpfs).
const boxGrafanaFile = "/run/webinarliv-grafana.env"

/* boxUserData is the droplet's first-boot script: fetch the boot script from the repo (the
 * snapshot's copy when GitHub cannot be reached) and run it. The boot script mounts the volume,
 * syncs the deploy files from the same ref and runs redeploy.sh (deploy/digitalocean/sfu-boot.sh).
 *
 * With the Grafana Cloud settings configured (config.BoxGrafana), it first writes them to
 * boxGrafanaFile (root only) and points SFU_GRAFANA_ENV at it; sfu-boot.sh merges them into the
 * volume's .env so Alloy starts with the stack, then removes the file. The values are checked
 * plain (config) and go in a quoted heredoc, so nothing in them is expanded or echoed. The
 * script is never logged (the create log names the image, size and region only).
 *
 * Nothing about captions: they never run on this box, only on the captions box (captions_box.go). */
func boxUserData(c config.SFUBox) (string, error) {
	for _, v := range []string{c.Repo, c.Ref, c.Volume} {
		if !boxSafe.MatchString(v) {
			return "", fmt.Errorf("SFU_BOX_REPO, SFU_BOX_REF and SFU_BOX_VOLUME must be plain names, got %q", v)
		}
	}
	grafana := ""
	if c.Grafana.Usable() {
		var b strings.Builder
		b.WriteString("# Grafana Cloud for Alloy (config.BoxGrafana); merged into .env by sfu-boot.sh.\n")
		b.WriteString("(umask 077; cat >" + boxGrafanaFile + " <<'WEBINARLIV_GRAFANA'\n")
		for _, p := range c.Grafana.Pairs() {
			b.WriteString(p[0] + "=" + p[1] + "\n")
		}
		b.WriteString("WEBINARLIV_GRAFANA\n)\n")
		b.WriteString("export SFU_GRAFANA_ENV=" + boxGrafanaFile + "\n")
		grafana = b.String()
	}
	return fmt.Sprintf(`#!/bin/bash
# Webinar Liv on-demand video server, first boot. Written by the API (api/internal/api/sfu_box.go).
set -uo pipefail
export SFU_DATA_DIR=/mnt/sfu-data SFU_VOLUME_NAME=%s SFU_REPO=%s SFU_REF=%s
%sboot=/usr/local/sbin/webinarliv-sfu-boot.sh
tmp="$(mktemp)"
if curl -fsSL --retry 5 --retry-delay 3 -m 60 "https://raw.githubusercontent.com/${SFU_REPO}/${SFU_REF}/deploy/digitalocean/sfu-boot.sh" -o "$tmp" && bash -n "$tmp"; then
  install -m 755 "$tmp" "$boot"
fi
rm -f "$tmp"
exec "$boot" >>/var/log/webinarliv-boot.log 2>&1
`, c.Volume, c.Repo, c.Ref, grafana), nil
}

// ---------------------------------------------------------------- readiness

/* boxProbe is the readiness check: LiveKit answers over HTTPS through Caddy (so the
 * certificate is there), the HLS origin answers (not a 5xx from Caddy), and TURN over TLS on
 * 443 presents a valid certificate for its name. */
func (s *Server) boxProbe(ctx context.Context) error {
	proj, ok := s.cfg.LiveKitProjectByID(s.box.cfg.Project)
	if !ok {
		return errors.New("project not configured")
	}
	base := proj.HTTPURL
	if base == "" {
		base = strings.Replace(strings.Replace(proj.URL, "wss://", "https://", 1), "ws://", "http://", 1)
	}
	if err := probeHTTP(ctx, base+"/", func(code int) bool { return code == http.StatusOK }); err != nil {
		return fmt.Errorf("livekit: %w", err)
	}
	if hls := strings.TrimRight(proj.BroadcastHLSBase, "/"); hls != "" {
		if err := probeHTTP(ctx, hls+"/", func(code int) bool { return code < 500 }); err != nil {
			return fmt.Errorf("hls: %w", err)
		}
	}
	turn := s.box.cfg.TurnHost
	if turn == "" {
		if u, err := url.Parse(base); err == nil && u.Hostname() != "" && net.ParseIP(u.Hostname()) == nil {
			turn = "turn." + u.Hostname()
		}
	}
	if turn != "" && turn != "-" {
		if err := probeTLS(ctx, s.box.cfg.ReservedIP, turn); err != nil {
			return fmt.Errorf("turn: %w", err)
		}
	}
	return nil
}

func probeHTTP(ctx context.Context, u string, ok func(int) bool) error {
	pctx, cancel := context.WithTimeout(ctx, boxProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(pctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	_ = res.Body.Close()
	if !ok(res.StatusCode) {
		return fmt.Errorf("%s answered %d", u, res.StatusCode)
	}
	return nil
}

func probeTLS(ctx context.Context, ip, host string) error {
	pctx, cancel := context.WithTimeout(ctx, boxProbeTimeout)
	defer cancel()
	addr := net.JoinHostPort(host, "443")
	if ip != "" {
		addr = net.JoinHostPort(ip, "443")
	}
	d := tls.Dialer{Config: &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}}
	conn, err := d.DialContext(pctx, "tcp", addr)
	if err != nil {
		return err
	}
	return conn.Close()
}

// boxLiveKitActivity asks the box's LiveKit what is running.
func (s *Server) boxLiveKitActivity(ctx context.Context) (lk.Activity, error) {
	room, err := s.sfu.Get(s.box.cfg.Project)
	if err != nil {
		return lk.Activity{}, err
	}
	a, ok := unwrapRoom(room).(boxActivity)
	if !ok {
		return lk.Activity{}, nil
	}
	actx, cancel := context.WithTimeout(ctx, boxProbeTimeout)
	defer cancel()
	return a.Activity(actx)
}

// ---------------------------------------------------------------- joins

// boxState is the row, cached for boxStateCache.
func (s *Server) boxState(ctx context.Context) (store.SFUBoxState, error) {
	b := s.box
	b.mu.Lock()
	if !b.cachedAt.IsZero() && time.Since(b.cachedAt) < boxStateCache {
		st := b.cached
		b.mu.Unlock()
		return st, nil
	}
	b.mu.Unlock()
	st, err := s.store.SFUBox(ctx, b.cfg.Project)
	if errors.Is(err, store.ErrNotFound) {
		st, err = store.SFUBoxState{Project: b.cfg.Project, Desired: "down", Actual: store.BoxDown, Since: time.Now()}, nil
	}
	if err != nil {
		return st, err
	}
	b.mu.Lock()
	b.cached, b.cachedAt = st, time.Now()
	b.mu.Unlock()
	return st, nil
}

// boxRequest keeps the box wanted for boxRequestHold (skipped when it already is for long).
func (s *Server) boxRequest(ctx context.Context, st store.SFUBoxState) {
	now := s.box.now()
	if st.RequestedUntil != nil && st.RequestedUntil.After(now.Add(boxRequestHold/2)) {
		return
	}
	if err := s.store.RequestSFUBox(ctx, s.box.cfg.Project, now.Add(boxRequestHold)); err != nil {
		s.log.Warn("sfu box: request", "error", err)
	}
	s.box.invalidate()
}

/* boxReady is sfuReady for the on-demand box: nil when it is up, errSFUStarting while it is
 * being created or booting (and asks for it), errSFUFailed once it has failed MaxFailures
 * times. A join that finds it down steps the manager itself, so the droplet is created now
 * rather than at the next tick. */
func (s *Server) boxReady(ctx context.Context) error {
	st, err := s.boxState(ctx)
	if err != nil {
		return err
	}
	switch st.Actual {
	case store.BoxReady:
		s.boxRequest(ctx, st)
		return nil
	case store.BoxDraining:
		// Still serving; wanted again. The next step takes it back to ready.
		s.boxRequest(ctx, st)
		return nil
	case store.BoxBooting:
		s.boxRequest(ctx, st)
		if s.boxProbeNow(ctx, st) {
			return nil
		}
		return errSFUStarting
	case store.BoxFailed:
		s.boxRequest(ctx, st)
		return errSFUFailed
	default: // down, creating, deleting
		s.boxRequest(ctx, st)
		if st.Actual == store.BoxDown {
			sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), boxJoinStepBudget)
			s.boxStep(sctx)
			cancel()
		}
		return errSFUStarting
	}
}

// boxProbeNow is a join's own readiness check while booting, at most every boxProbeEvery.
func (s *Server) boxProbeNow(ctx context.Context, st store.SFUBoxState) bool {
	b := s.box
	b.mu.Lock()
	if time.Since(b.lastProbe) < boxProbeEvery {
		b.mu.Unlock()
		return false
	}
	b.lastProbe = time.Now()
	b.mu.Unlock()
	if b.probe(ctx) != nil {
		return false
	}
	ok, err := s.store.MarkSFUBoxReady(ctx, b.cfg.Project, st.DropletID)
	if err != nil {
		s.log.Warn("sfu box: mark ready", "error", err)
		return false
	}
	b.invalidate()
	if ok {
		s.log.Info("sfu box: ready (seen by a join)", "project", b.cfg.Project, "droplet", st.DropletID)
	}
	return true
}

// boxProjectFor is the project wb's room is (or will be) on.
func (s *Server) boxProjectFor(ctx context.Context, wb types.Webinar) string {
	if wb.SFUProject != "" {
		return wb.SFUProject
	}
	candidates := s.sfu.Candidates()
	if len(candidates) == 0 {
		return ""
	}
	return s.firstChoice(ctx, wb, candidates)
}

// boxWarmFor asks for the box ahead of a session that will need it (an instant session).
func (s *Server) boxWarmFor(ctx context.Context, wb types.Webinar) {
	if s.box == nil || !s.managesProject(s.boxProjectFor(ctx, wb)) {
		return
	}
	st, err := s.boxState(ctx)
	if err != nil {
		return
	}
	s.boxRequest(ctx, st)
	if st.Actual == store.BoxDown || st.Actual == store.BoxFailed {
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), boxJoinStepBudget)
		s.boxStep(sctx)
		cancel()
	}
}

// ---------------------------------------------------------------- alerts

/* boxAlert tells the admins: email (alertOps, throttled per subject), the bell and a push.
 * Stamps st.AlertedAt so one outage is one alert; it clears when the box is ready. */
func (s *Server) boxAlert(ctx context.Context, st *store.SFUBoxState, subject, body string) {
	now := s.box.now()
	st.AlertedAt = &now
	s.alertOps(ctx, "sfu-box:"+s.box.cfg.Project+":"+subject, subject, body)
	ids, err := s.store.AdminUserIDs(ctx)
	if err != nil {
		s.log.Error("sfu box: admin ids", "error", err)
		return
	}
	for _, id := range ids {
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			UserID: id, Kind: types.NotifyOpsAlert, Subject: subject, Body: body,
		}); err != nil {
			s.log.Error("sfu box: bell", "error", err)
		}
	}
	s.pushToHost(ctx, ids, store.PushMessage{
		Kind: types.PushOpsAlert, Title: clip(subject, 120), Body: clip(body, 240),
		URL: "/admin", Tag: "ops-sfu-box", Urgency: "high", TTL: 6 * time.Hour,
	})
}

// ---------------------------------------------------------------- endpoints

// videoServerStatus is what the waiting screen shows for a webinar.
func (s *Server) videoServerStatus(ctx context.Context, wb types.Webinar) (types.VideoServerStatus, error) {
	if !s.managesProject(s.boxProjectFor(ctx, wb)) {
		return types.VideoServerStatus{State: types.VideoServerNone, Message: "Ready."}, nil
	}
	st, err := s.boxState(ctx)
	if err != nil {
		return types.VideoServerStatus{}, err
	}
	since := int(time.Since(st.Since).Seconds())
	switch st.Actual {
	case store.BoxReady, store.BoxDraining:
		return types.VideoServerStatus{State: types.VideoServerReady, Message: "Ready.", SinceSec: since}, nil
	case store.BoxFailed:
		return types.VideoServerStatus{State: types.VideoServerFailed, SinceSec: since,
			Message: "The video server could not be started. We've told the team and it keeps retrying."}, nil
	}
	eta := int(boxBootEstimate.Seconds())
	if st.Actual == store.BoxBooting || st.Actual == store.BoxCreating {
		eta = max(15, eta-since)
	}
	return types.VideoServerStatus{State: types.VideoServerStarting, SinceSec: since, EtaSec: eta,
		Message: "Starting servers… (about 2 minutes)"}, nil
}

// handleVideoServerStatus is GET /api/webinars/{slug}/server. Public like the webinar itself.
func (s *Server) handleVideoServerStatus(w http.ResponseWriter, r *http.Request) {
	wb, err := s.store.WebinarBySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "video server status", err)
		return
	}
	out, err := s.videoServerStatus(r.Context(), wb)
	if err != nil {
		s.fail(w, r, "video server status", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, out)
}

/* handleRetryVideoServer is POST /api/host/webinars/{slug}/server/retry: the host's "Try
 * again" after the box failed. Clears the backoff and steps the manager now. */
func (s *Server) handleRetryVideoServer(w http.ResponseWriter, r *http.Request) {
	wb, err := s.store.WebinarBySlug(r.Context(), chi.URLParam(r, "slug"))
	if err != nil {
		s.fail(w, r, "retry video server", err)
		return
	}
	if s.managesProject(s.boxProjectFor(r.Context(), wb)) {
		if err := s.store.RetrySFUBox(r.Context(), s.box.cfg.Project); err != nil {
			s.fail(w, r, "retry video server", err)
			return
		}
		s.box.invalidate()
		st, err := s.boxState(r.Context())
		if err == nil {
			s.boxRequest(r.Context(), st)
		}
		sctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), boxJoinStepBudget)
		s.boxStep(sctx)
		cancel()
	}
	out, err := s.videoServerStatus(r.Context(), wb)
	if err != nil {
		s.fail(w, r, "retry video server", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

func boxTime(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// handleAdminSFUBox is GET /api/admin/sfu-box.
func (s *Server) handleAdminSFUBox(w http.ResponseWriter, r *http.Request) {
	if s.box == nil {
		httpx.JSON(w, http.StatusOK, types.AdminSFUBox{Runs: []types.AdminSFUBoxRun{}})
		return
	}
	c := s.box.cfg
	st, err := s.store.SFUBox(r.Context(), c.Project)
	if errors.Is(err, store.ErrNotFound) {
		st, err = store.SFUBoxState{Project: c.Project, Desired: "down", Actual: store.BoxDown}, nil
	}
	if err != nil {
		s.fail(w, r, "admin sfu box", err)
		return
	}
	now := time.Now()
	hours, _, _, err := s.store.SFUBoxHours(r.Context(), c.Project, now.Add(-30*24*time.Hour), now)
	if err != nil {
		s.fail(w, r, "admin sfu box hours", err)
		return
	}
	runs, err := s.store.SFUBoxRecentRuns(r.Context(), c.Project, 20)
	if err != nil {
		s.fail(w, r, "admin sfu box runs", err)
		return
	}
	out := types.AdminSFUBox{
		Enabled: true, Project: c.Project, Desired: st.Desired, Actual: st.Actual, DropletID: st.DropletID,
		LastError: st.LastError, Failures: st.Failures, AlwaysOn: c.AlwaysOn,
		NextAttemptAt: boxTime(st.NextAttemptAt), LastNeededAt: boxTime(st.LastNeededAt),
		RequestedUntil: boxTime(st.RequestedUntil),
		WarmLeadMin:    int(c.WarmLead.Minutes()), IdleGraceMin: int(c.IdleGrace.Minutes()),
		HoursLast30d: hours, Runs: []types.AdminSFUBoxRun{},
	}
	if !st.Since.IsZero() {
		out.Since = st.Since.UTC().Format(time.RFC3339)
	}
	for _, run := range runs {
		end := now
		if run.DeletedAt != nil {
			end = *run.DeletedAt
		}
		out.Runs = append(out.Runs, types.AdminSFUBoxRun{
			DropletID: run.DropletID, CreatedAt: run.CreatedAt.UTC().Format(time.RFC3339),
			ReadyAt: boxTime(run.ReadyAt), DeletedAt: boxTime(run.DeletedAt),
			Hours: end.Sub(run.CreatedAt).Hours(),
		})
	}
	httpx.JSON(w, http.StatusOK, out)
}

// boxLiveStatus is the box's line in GET /api/internal/live-status (the DO deploy reads it).
type boxLiveStatus struct {
	Desired   string `json:"desired"`
	Actual    string `json:"actual"`
	DropletID int64  `json:"dropletId"`
	Since     string `json:"since"`
}

func (s *Server) boxLiveStatuses(ctx context.Context) map[string]boxLiveStatus {
	out := map[string]boxLiveStatus{}
	if s.box == nil {
		return out
	}
	st, err := s.store.SFUBox(ctx, s.box.cfg.Project)
	if errors.Is(err, store.ErrNotFound) {
		out[s.box.cfg.Project] = boxLiveStatus{Desired: "down", Actual: store.BoxDown}
		return out
	}
	if err != nil {
		return out
	}
	out[s.box.cfg.Project] = boxLiveStatus{Desired: st.Desired, Actual: st.Actual, DropletID: st.DropletID,
		Since: st.Since.UTC().Format(time.RFC3339)}
	return out
}
