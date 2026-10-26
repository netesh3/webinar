package api

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
)

/* The on-demand captions box (config.CaptionsBox, deploy/digitalocean/README.md "Captions box").
 *
 * On 24 Oct 2026 the caption agent took 0.66 of the c-4 video box's cores beside the edge mix's
 * 1.84, the box ran at 70–91 % and the audience stalled. With CAPTIONS_BOX_ENABLED the agent
 * runs on a droplet of its own instead (default s-4vcpu-8gb), one per video box, shared by every
 * room on it. The video box never runs one (since 24 Oct 2026 its image and deploy carry no
 * caption agent), so with CAPTIONS_BOX_ENABLED off a box room has no server captions at all:
 * dispatcherFor reports no dispatcher, and the room captions on-device ("server captions
 * unavailable").
 *
 * It follows the video box: wanted while the video box has a droplet that is not being deleted
 * (creating, booting, ready, draining), so it is created in the same step as the video droplet
 * and deleted in the step that deletes it. Stepped at the end of boxStep, under the same lease,
 * after the video box's own state is saved, so nothing here can delay or fail the video box:
 *
 *   down ─wanted→ creating ─active→ ready ─not wanted→ deleting ─no tagged droplet left→ down
 *   create fails, or not active within BootTimeout: deleted, failures++, retried with backoff
 *   (one ops email after MaxFailures). Video works without it: rooms caption on-device.
 *
 * No orphans: every captions droplet carries config.CaptionsBoxManagedTag. A wanted box that is
 * down adopts a tagged droplet before creating (a create whose answer was lost); deleting lists
 * by the tag and is done only when none is left; and a box that is down and not wanted checks
 * the tag every few minutes and deletes whatever it finds (the switch turned off mid-run).
 *
 * The agent connects to the video box's LiveKit over its public URL (the reserved IP) and
 * registers as a worker; the API's dispatch is unchanged. A room dispatched before the worker
 * was up (or while it was full) has a dispatch with no job, so while the box is ready each step
 * re-creates those (RedispatchIdle; never a dispatch with a job). Until the agent reports live,
 * the room's browsers caption on-device and the host sees that source, as with any dispatch no
 * worker picked up. */

// captionsRedispatcher is lk.Client's RedispatchIdle.
type captionsRedispatcher interface {
	RedispatchIdle(ctx context.Context, room, agentName string) (bool, error)
}

var _ captionsRedispatcher = (*lk.Client)(nil)

// captionsStepReserve is the least time left in the step for the captions box to be stepped.
const captionsStepReserve = 5 * time.Second

/* captionsOn is whether a captions box is wanted at all: CAPTIONS_BOX_ENABLED=true with
 * CAPTIONS_PROVIDER=local set explicitly (config.CaptionsBoxOn). The captions box was retired
 * from production on 2026-10-27 (captions run on the video box, captionsOnVideoBox); this is
 * its fallback, and every coupling to it (made and deleted with the video box, the admin card,
 * the redispatch when it comes up) is behind this switch. */
func (s *Server) captionsOn() bool {
	// One switch for the whole pool; every box's captions follow it.
	return s.box != nil && s.box.cfg.Captions.On && s.cfg.CaptionsProvider.ExplicitLocal() && s.serverCaptionsConfigured()
}

/* captionsOnVideoBox is whether the caption worker runs on the video box itself
 * (CAPTIONS_PROVIDER=deepgram: the captions-worker service, deploy/livekit-box), so a box
 * room has a worker for its dispatch without any captions droplet. */
func (s *Server) captionsOnVideoBox() bool {
	return s.cfg.CaptionsProvider.OnVideoBox() && s.serverCaptionsConfigured()
}

// captionsBoxWanted is the rule: the video box has a droplet that is not going away.
func (s *Server) captionsBoxWanted(video store.SFUBoxState) bool {
	if !s.captionsOn() {
		return false
	}
	switch video.Actual {
	case store.BoxCreating, store.BoxBooting, store.BoxReady, store.BoxDraining:
		return true
	}
	return false
}

// captionsBoxStep moves the captions droplet one step, after the video box's step.
func (s *Server) captionsBoxStep(ctx context.Context, b *boxManager, holder string, video store.SFUBoxState) {
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) < captionsStepReserve {
		return
	}
	project := b.cfg.Project
	cb, err := s.store.CaptionsBox(ctx, project)
	if err != nil {
		s.log.Error("captions box: read", "project", project, "error", err)
		return
	}
	if !(b.cfg.Captions.On && s.cfg.CaptionsProvider.ExplicitLocal()) && cb.Actual == store.BoxDown && cb.DropletID == 0 && cb.Failures == 0 {
		// Never switched on (or long off): only the occasional check for a stray droplet.
		s.captionsSweepStray(ctx, b, &cb, b.now())
		if cb.Actual == store.BoxDown {
			return
		}
	} else {
		before := cb.Actual
		s.captionsBoxAct(ctx, b, &cb, video, b.now())
		if cb.Actual != before {
			s.log.Info("captions box: state", "project", project, "from", before, "to", cb.Actual,
				"droplet", cb.DropletID, "error", cb.LastError)
		}
	}
	if err := s.store.SaveCaptionsBox(ctx, holder, cb); err != nil {
		s.log.Error("captions box: save", "project", project, "error", err)
	}
}

func (s *Server) setCaptionsActual(cb *store.CaptionsBoxState, actual string, now time.Time) {
	if cb.Actual != actual {
		cb.Actual = actual
		cb.Since = now
	}
}

func (s *Server) captionsBoxAct(ctx context.Context, b *boxManager, cb *store.CaptionsBoxState, video store.SFUBoxState, now time.Time) {
	cc := b.cfg.Captions
	wanted := s.captionsBoxWanted(video)
	switch cb.Actual {
	case store.BoxDown:
		if !wanted {
			if !s.captionsOn() {
				cb.Failures, cb.NextAttemptAt, cb.AlertedAt, cb.LastError = 0, nil, nil, ""
			}
			s.captionsSweepStray(ctx, b, cb, now)
			return
		}
		if cb.NextAttemptAt != nil && now.Before(*cb.NextAttemptAt) {
			return
		}
		list, err := b.cloud.DropletsByTag(ctx, cc.ManagedTag)
		if err != nil {
			s.captionsFailure(ctx, b, cb, now, "list droplets", err)
			return
		}
		if live := liveDroplets(list); len(live) > 0 {
			// A create whose answer was lost, or one left from before: take the first, delete the rest.
			d := live[0]
			s.log.Info("captions box: adopting existing droplet", "project", b.cfg.Project, "droplet", d.ID, "status", d.Status)
			for _, extra := range live[1:] {
				s.captionsDeleteDroplet(ctx, b, cb, extra.ID)
			}
			cb.DropletID = d.ID
			s.captionsStartRun(ctx, b, d)
			s.setCaptionsActual(cb, store.BoxCreating, now)
			return
		}
		d, err := s.captionsBoxCreate(ctx, b)
		if err != nil {
			s.captionsFailure(ctx, b, cb, now, "create", err)
			return
		}
		cb.DropletID, cb.LastError = d.ID, ""
		s.captionsStartRun(ctx, b, d)
		s.setCaptionsActual(cb, store.BoxCreating, now)

	case store.BoxCreating:
		if !wanted {
			s.captionsDeleteAll(ctx, b, cb, now)
			return
		}
		d, err := b.cloud.Droplet(ctx, cb.DropletID)
		if doapi.IsNotFound(err) {
			s.captionsGone(ctx, b, cb, now)
			s.captionsFailure(ctx, b, cb, now, "create", errors.New("the new droplet disappeared"))
			return
		}
		if err != nil {
			cb.LastError = "read droplet: " + err.Error()
			return
		}
		if d.Status == "active" {
			s.setCaptionsActual(cb, store.BoxReady, now)
			cb.Failures, cb.NextAttemptAt, cb.AlertedAt, cb.LastError = 0, nil, nil, ""
			if err := s.store.ReadySFUBoxRun(ctx, store.CaptionsRunProject(b.cfg.Project), d.ID); err != nil {
				s.log.Error("captions box: record ready", "error", err)
			}
			return
		}
		if waited := now.Sub(maxTime(d.Created(), cb.Since)); waited > cc.BootTimeout {
			s.captionsDeleteAll(ctx, b, cb, now)
			s.captionsFailure(ctx, b, cb, now, "boot",
				fmt.Errorf("droplet %d not active %s after create (status %s)", d.ID, waited.Round(time.Second), d.Status))
		}

	case store.BoxReady:
		if !wanted {
			s.captionsDeleteAll(ctx, b, cb, now)
			return
		}
		if _, err := b.cloud.Droplet(ctx, cb.DropletID); doapi.IsNotFound(err) {
			s.log.Error("captions box: droplet disappeared while wanted; making a new one",
				"project", b.cfg.Project, "droplet", cb.DropletID)
			s.captionsGone(ctx, b, cb, now)
			return
		}
		if video.Actual == store.BoxReady || video.Actual == store.BoxDraining {
			s.captionsRedispatch(ctx, b)
		}

	case store.BoxDeleting:
		list, err := b.cloud.DropletsByTag(ctx, cc.ManagedTag)
		if err != nil {
			cb.LastError = "list droplets: " + err.Error()
			return
		}
		live := liveDroplets(list)
		if len(live) == 0 {
			s.captionsGone(ctx, b, cb, now)
			return
		}
		if now.Sub(cb.Since) > boxDeleteResend {
			for _, d := range live {
				s.captionsDeleteDroplet(ctx, b, cb, d.ID)
			}
		}
	}
}

// liveDroplets drops the archived ones (a droplet DigitalOcean still lists while it goes).
func liveDroplets(list []doapi.Droplet) []doapi.Droplet {
	var out []doapi.Droplet
	for _, d := range list {
		if d.Status != "archive" {
			out = append(out, d)
		}
	}
	return out
}

/* captionsSweepStray is the check a box that is down and not wanted makes every few minutes:
 * a tagged droplet here is one nobody tracks (the switch turned off mid-run, a create whose
 * answer was lost), and is deleted. */
func (s *Server) captionsSweepStray(ctx context.Context, b *boxManager, cb *store.CaptionsBoxState, now time.Time) {
	b.mu.Lock()
	due := time.Since(b.lastCaptionsSweep) >= boxParkCheckEvery
	if due {
		b.lastCaptionsSweep = time.Now()
	}
	b.mu.Unlock()
	if !due {
		return
	}
	list, err := b.cloud.DropletsByTag(ctx, b.cfg.Captions.ManagedTag)
	if err != nil {
		s.log.Warn("captions box: list droplets", "error", err)
		return
	}
	live := liveDroplets(list)
	if len(live) == 0 {
		return
	}
	s.log.Warn("captions box: deleting a captions droplet nothing needs", "project", b.cfg.Project, "droplets", len(live))
	cb.DropletID = live[0].ID
	for _, d := range live {
		s.captionsDeleteDroplet(ctx, b, cb, d.ID)
	}
	s.setCaptionsActual(cb, store.BoxDeleting, now)
}

// captionsDeleteAll sends a delete for the tracked droplet and every tagged one.
func (s *Server) captionsDeleteAll(ctx context.Context, b *boxManager, cb *store.CaptionsBoxState, now time.Time) {
	ids := map[int64]bool{}
	if cb.DropletID != 0 {
		ids[cb.DropletID] = true
	}
	if list, err := b.cloud.DropletsByTag(ctx, b.cfg.Captions.ManagedTag); err == nil {
		for _, d := range liveDroplets(list) {
			ids[d.ID] = true
		}
	} else {
		cb.LastError = "list droplets: " + err.Error()
	}
	for id := range ids {
		s.captionsDeleteDroplet(ctx, b, cb, id)
	}
	if len(ids) == 0 {
		s.setCaptionsActual(cb, store.BoxDown, now)
		return
	}
	s.log.Info("captions box: deleting droplet", "project", b.cfg.Project, "droplet", cb.DropletID)
	// Deleting until the tag lists nothing: a failed delete is sent again from there.
	s.setCaptionsActual(cb, store.BoxDeleting, now)
}

func (s *Server) captionsDeleteDroplet(ctx context.Context, b *boxManager, cb *store.CaptionsBoxState, id int64) {
	if err := b.cloud.DeleteDroplet(ctx, id); err != nil && !doapi.IsNotFound(err) {
		cb.LastError = "delete droplet: " + err.Error()
		s.log.Warn("captions box: delete droplet", "droplet", id, "error", err)
	}
}

// captionsGone records the droplet deleted and the box down.
func (s *Server) captionsGone(ctx context.Context, b *boxManager, cb *store.CaptionsBoxState, now time.Time) {
	if cb.DropletID != 0 {
		if err := s.store.EndSFUBoxRun(ctx, store.CaptionsRunProject(b.cfg.Project), cb.DropletID); err != nil {
			s.log.Error("captions box: record end", "error", err)
		}
	}
	cb.DropletID = 0
	s.setCaptionsActual(cb, store.BoxDown, now)
}

func (s *Server) captionsStartRun(ctx context.Context, b *boxManager, d doapi.Droplet) {
	if err := s.store.StartSFUBoxRun(ctx, store.CaptionsRunProject(b.cfg.Project), d.ID, d.Created()); err != nil {
		s.log.Error("captions box: record run", "error", err)
	}
}

// captionsFailure counts a failed attempt, backs off, and emails the ops list once at MaxFailures.
func (s *Server) captionsFailure(ctx context.Context, b *boxManager, cb *store.CaptionsBoxState, now time.Time, what string, err error) {
	cb.Failures++
	next := now.Add(boxBackoff(cb.Failures))
	cb.NextAttemptAt = &next
	cb.LastError = what + ": " + err.Error()
	s.log.Error("captions box: attempt failed", "project", b.cfg.Project, "what", what,
		"failures", cb.Failures, "error", err)
	if cb.Failures < b.cfg.MaxFailures || cb.AlertedAt != nil {
		return
	}
	cb.AlertedAt = &now
	s.alertOps(ctx, "captions-box:"+b.cfg.Project, "ALERT: captions server could not be started",
		fmt.Sprintf("The captions droplet for %s failed %d times in a row (%s).\n\nLast error: %s\n\n"+
			"Video is not affected: rooms caption on each speaker's device until it is up. It keeps retrying "+
			"every few minutes. To run captions on the video server again, set CAPTIONS_BOX_ENABLED=false "+
			"(takes effect for the next video server). See deploy/digitalocean/README.md, \"Captions box\".",
			b.cfg.Project, cb.Failures, what, cb.LastError))
}

// captionsBoxCreate creates the droplet: newest captions snapshot, the tags and the boot script.
func (s *Server) captionsBoxCreate(ctx context.Context, b *boxManager) (doapi.Droplet, error) {
	c := b.cfg
	cc := c.Captions
	proj, ok := s.cfg.LiveKitProjectByID(c.Project)
	if !ok {
		return doapi.Droplet{}, fmt.Errorf("project %q is not configured", c.Project)
	}
	userData, err := captionsUserData(c, proj, s.cfg.CaptionsSecret, s.captionAgentName())
	if err != nil {
		return doapi.Droplet{}, err
	}
	img, err := b.cloud.LatestSnapshot(ctx, cc.SnapshotTag, cc.SnapshotTag+"-", c.Region)
	if err != nil {
		return doapi.Droplet{}, fmt.Errorf("snapshot %q: %w", cc.SnapshotTag, err)
	}
	tags := append([]string{}, cc.Tags...)
	tags = append(tags, cc.ManagedTag)
	s.log.Info("captions box: creating droplet", "project", c.Project, "image", img.Name, "size", cc.Size,
		"region", c.Region, "maxRooms", cc.MaxRooms)
	return b.cloud.CreateDroplet(ctx, doapi.CreateDroplet{
		Name: cc.Name, Region: c.Region, Size: cc.Size, Image: img.ID,
		SSHKeys: c.SSHKeys, Monitoring: true, Tags: tags, UserData: userData, VPCUUID: c.VPCUUID,
	})
}

/* captionsValueSafe is what a value in the captions box's env file may hold: it goes in a quoted
 * heredoc and a docker env file, so no whitespace, quotes, backslash, $ or backtick (keys,
 * secrets, URLs and model names all fit). */
var captionsValueSafe = regexp.MustCompile(`^[A-Za-z0-9._:/@+=%?&,~-]+$`)

/* captionsUserData is the captions droplet's first-boot script: the agent's settings, written
 * root-only to /etc/webinarliv/captions.env, then the boot script from the repo (the snapshot's
 * copy when GitHub cannot be reached), which starts the agent (deploy/digitalocean/captions-boot.sh).
 * With the video box's Grafana Cloud settings configured, they go in too (captionsGrafana), so the
 * box reports to Grafana Cloud like the video box.
 *
 * The LiveKit key and secret and CAPTIONS_SECRET travel in the user data: the captions box has no
 * volume to keep them on (the video box's are on sfu-data). User data is readable from inside the
 * droplet (metadata service) and by holders of the DigitalOcean token, the same exposure as the
 * Grafana token the video box gets this way. The values are checked plain and go in a quoted
 * heredoc, so nothing in them is expanded or echoed; an error names the variable, never the
 * value; the script is never logged. */
func captionsUserData(c config.SFUBox, proj config.LiveKitProject, captionsSecret, agentName string) (string, error) {
	for _, v := range []string{c.Repo, c.Ref} {
		if !boxSafe.MatchString(v) {
			return "", fmt.Errorf("SFU_BOX_REPO and SFU_BOX_REF must be plain names, got %q", v)
		}
	}
	cc := c.Captions
	lkURL := cc.LiveKitURL
	if lkURL == "" {
		lkURL = proj.URL
	}
	pairs := [][2]string{
		{"LIVEKIT_URL", lkURL},
		{"LIVEKIT_API_KEY", proj.Key},
		{"LIVEKIT_API_SECRET", proj.Secret},
		{"CAPTIONS_API_URL", strings.TrimRight(cc.APIURL, "/")},
		{"CAPTIONS_SECRET", captionsSecret},
		{"CAPTIONS_AGENT_NAME", agentName},
		{"CAPTIONS_MODEL", cc.Model},
		{"CAPTIONS_CPUS", strconv.Itoa(cc.CPUs)},
		{"CAPTIONS_MAX_ROOMS", strconv.Itoa(cc.MaxRooms)},
		{"CAPTIONS_LANGUAGE", "en"},
	}
	var env strings.Builder
	for _, p := range pairs {
		if !captionsValueSafe.MatchString(p[1]) {
			return "", fmt.Errorf("captions box: %s is empty or has a character the env file cannot carry", p[0])
		}
		env.WriteString(p[0] + "=" + p[1] + "\n")
	}
	return fmt.Sprintf(`#!/bin/bash
# Webinar Liv on-demand captions box, first boot. Written by the API (api/internal/api/captions_box.go).
set -uo pipefail
export CAPTIONS_REPO=%s CAPTIONS_REF=%s
(umask 077; mkdir -p /etc/webinarliv; cat >/etc/webinarliv/captions.env <<'WEBINARLIV_CAPTIONS'
%sWEBINARLIV_CAPTIONS
)
%sboot=/usr/local/sbin/webinarliv-captions-boot.sh
tmp="$(mktemp)"
if curl -fsSL --retry 5 --retry-delay 3 -m 60 "https://raw.githubusercontent.com/${CAPTIONS_REPO}/${CAPTIONS_REF}/deploy/digitalocean/captions-boot.sh" -o "$tmp" && bash -n "$tmp"; then
  install -m 755 "$tmp" "$boot"
fi
rm -f "$tmp"
exec "$boot" >>/var/log/webinarliv-captions-boot.log 2>&1
`, c.Repo, c.Ref, env.String(), captionsGrafana(c.Grafana)), nil
}

// captionsGrafanaFile is where the user data leaves the Grafana Cloud settings for captions-boot.sh.
const captionsGrafanaFile = "/etc/webinarliv/grafana.env"

/* captionsGrafana is the user data's Grafana Cloud part: with all five settings usable (the video
 * box's, config.BoxGrafana), they are written root-only to captionsGrafanaFile, and
 * captions-boot.sh starts Alloy with them (box=<hostname>, role=captions). Otherwise nothing, and
 * no Alloy. A separate file from captions.env, so the token never reaches the agent's
 * environment. Quoted heredoc, values checked plain (config), never echoed or logged. */
func captionsGrafana(g config.BoxGrafana) string {
	if !g.Usable() {
		return ""
	}
	var b strings.Builder
	b.WriteString("# Grafana Cloud for Alloy (config.BoxGrafana); read by captions-boot.sh.\n")
	b.WriteString("(umask 077; cat >" + captionsGrafanaFile + " <<'WEBINARLIV_GRAFANA'\n")
	for _, p := range g.Pairs() {
		b.WriteString(p[0] + "=" + p[1] + "\n")
	}
	b.WriteString("WEBINARLIV_GRAFANA\n)\n")
	return b.String()
}

/* captionsRedispatch re-creates the dispatch of every live room on the box still waiting for
 * the agent whose dispatch has no job (see RedispatchIdle), now that the captions box is up,
 * or (captionsOnVideoBox) while the video box is ready: its worker may have registered after
 * the dispatch, after a redeploy say. */
func (s *Server) captionsRedispatch(ctx context.Context, b *boxManager) {
	waiting, err := s.store.CaptionsAwaitingAgent(ctx, b.cfg.Project, s.defaultCostProject())
	if err != nil {
		s.log.Warn("captions box: rooms waiting for the agent", "error", err)
		return
	}
	if len(waiting) == 0 {
		return
	}
	rm, err := s.sfu.Get(b.cfg.Project)
	if err != nil {
		return
	}
	r, ok := unwrapRoom(rm).(captionsRedispatcher)
	if !ok {
		return
	}
	for _, w := range waiting {
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) < boxCallTimeout {
			return
		}
		c, cancel := context.WithTimeout(ctx, boxCallTimeout)
		did, err := r.RedispatchIdle(c, lk.RoomName(w.Slug), s.captionAgentName())
		cancel()
		if err != nil {
			s.log.Warn("captions box: redispatch", "slug", w.Slug, "error", err)
			continue
		}
		if did {
			/* A room waits like this while the box starts, and also whenever the worker is
			 * full: it takes maxRooms rooms (one per two vCPUs) and LiveKit holds the rest
			 * until one ends. The room keeps on-device captions meanwhile, so this log is the
			 * only place the wait shows; "waiting" past maxRooms means the box is the limit. */
			s.log.Info("captions box: dispatch re-sent to the captions worker", "slug", w.Slug, "display", w.Display,
				"waiting", len(waiting), "maxRooms", b.cfg.Captions.MaxRooms)
		}
	}
}
