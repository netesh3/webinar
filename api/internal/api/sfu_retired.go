package api

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Retired video servers: no new room goes to a Hetzner server or to a disabled project.
 *
 * Production video is the on-demand DigitalOcean box (SFU_BOX_PROJECT, sfu_box.go). The
 * Hetzner SFU (LiveKit project "default", from the legacy LIVEKIT_* trio) was deleted on
 * 2026-10-26, and the GCP test server (project "india") is disabled and its VMs deleted. While
 * either entry is still in LIVEKIT_PROJECTS nothing new may land on it, and nothing that has
 * not run yet may stay on it. So the pool the handlers see (routingPool) never offers a
 * Hetzner project for a new room while any other project is taking rooms (disabled ones are
 * never candidates anyway), and puts the box's project first, so a host with no assignment
 * gets the box. A deployment with only Hetzner-looking projects (the dev stack's "default",
 * one LiveKit Cloud project without a "provider") is left exactly as it was: there is nothing
 * to move to.
 *
 * Disabled projects count as retired too (2026-10-26). A disabled project still answers Get, so
 * that a session live on it is not cut off (lk.Pool), but a webinar that has not run yet and
 * is pinned to one used to keep that pin and join the disabled server: with "india"'s VMs gone,
 * that was a join to nothing.
 *
 * Webinars already pinned to a retired project (moveOffRetired):
 *   - draft or scheduled: moved to where a new room would go (the box), at boot
 *     (MoveOffRetiredServers) or at the first join after it, and switched to edge when they
 *     fit, as BackfillEdgeDelivery does. Never while LiveKit still reports somebody in the old
 *     room: a host in the green room on the old server keeps it, and the move happens at a
 *     later join. A server that is gone answers nothing within retiredRoomCheck, which reads as
 *     an empty room.
 *   - live: left where they are. Moving a live room splits it; it ends there.
 *   - ended: the pin stays as the record of where it ran (cost reports read it).
 * A project removed from LIVEKIT_PROJECTS altogether is the unknown-project path instead
 * (sfu.go repin): moved at its next join, wherever it was.
 * A host assigned to a retired project (Admin -> Accounts -> Video server) is unassigned at
 * boot, so the box's demand and the deploy guard count their sessions on the box.
 *
 * The provider is config.LiveKitProject.CostProvider: an explicit "provider", else GCP for a
 * project with sfuVm/egressPool, else the id/label guess, where anything unrecognised reads as
 * Hetzner. So a new non-Hetzner entry in LIVEKIT_PROJECTS should say its "provider". */

// retiredProvider is the video-server provider that takes no new rooms.
const retiredProvider = "hetzner"

/* routingPool is the SFU pool with retired projects taken out of the new-room order and the
 * box's project put first. Get and IDs pass through: a retired project still serves the rooms
 * pinned to it, which is what keeps a live session there alive. Computed per call because an
 * operator's (or a test's) pool can change under it. */
type routingPool struct {
	SFUPool
	s *Server
}

func (p routingPool) Candidates() []string {
	all := p.SFUPool.Candidates()
	out := p.s.nonRetired(all)
	if len(out) == 0 {
		// Nothing but Hetzner-looking projects: nothing to move to, so nothing changes.
		return all
	}
	if box := p.s.cfg.SFUBox.Project; box != "" {
		if i := slices.Index(out, box); i > 0 {
			out = append([]string{box}, slices.Delete(out, i, i+1)...)
		}
	}
	return out
}

// nonRetired is ids without the Hetzner ones, in order.
func (s *Server) nonRetired(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if s.costProviderOf(id) != retiredProvider {
			out = append(out, id)
		}
	}
	return out
}

/* sfuRetired reports whether a configured project is retired while some other project is
 * taking new rooms: a Hetzner server, or a disabled project. Retired only decides where a
 * webinar that has not run yet goes; a session live on a retired project keeps it. */
func (s *Server) sfuRetired(project string) bool {
	if project == "" || s.sfu == nil {
		return false
	}
	if s.costProviderOf(project) != retiredProvider && !s.projectDisabled(project) {
		return false
	}
	return len(s.nonRetired(s.sfu.Candidates())) > 0
}

/* projectDisabled reports a configured project that takes no new rooms: listed in the pool
 * (IDs) but not offered for one (Candidates), which is what "disabled": true in
 * LIVEKIT_PROJECTS makes it (lk.Pool). Unknown is not disabled: that is repin's case. */
func (s *Server) projectDisabled(project string) bool {
	return slices.Contains(s.sfu.IDs(), project) && !slices.Contains(s.sfu.Candidates(), project)
}

// retiredProjects is every configured project sfuRetired holds for.
func (s *Server) retiredProjects() []string {
	var out []string
	for _, id := range s.sfu.IDs() {
		if s.sfuRetired(id) {
			out = append(out, id)
		}
	}
	return out
}

// notRunYet is a session that has not started: the only kind that may change video server.
func notRunYet(wb types.Webinar) bool {
	return wb.Status == types.StatusDraft || wb.Status == types.StatusScheduled
}

// webinarFitsEdge is edgeFits for a saved webinar: a webinar in this app, not a meeting or simulive.
func webinarFitsEdge(wb types.Webinar) bool {
	return edgeFits(types.WebinarInput{Kind: wb.Kind, Venue: wb.Venue})
}

// retiredRoomCheck bounds the look at the old server before a move: it may already be gone.
const retiredRoomCheck = 3 * time.Second

/* moveOffRetired moves a webinar that has not run yet off a retired project, to where a new
 * room would go now, and returns the new project and its client. ok is false when it stays:
 * it is live or ended, somebody is in its room on the old server, or there is nowhere else.
 * A concurrent move wins: the pin it wrote is returned. */
func (s *Server) moveOffRetired(ctx context.Context, wb types.Webinar) (project string, room RoomManager, ok bool, err error) {
	from := wb.SFUProject
	if !notRunYet(wb) || !s.sfuRetired(from) {
		return "", nil, false, nil
	}
	if old, getErr := s.sfu.Get(from); getErr == nil && old != nil {
		cctx, cancel := context.WithTimeout(ctx, retiredRoomCheck)
		people, pErr := old.Participants(cctx, lk.RoomName(wb.ID))
		cancel()
		// An error is a room that does not exist or a server that is gone: nobody to strand.
		if pErr == nil && len(people) > 0 {
			s.log.Info("sfu: webinar on a retired video server has people in its room; not moving it yet",
				"slug", wb.ID, "project", from, "participants", len(people))
			return "", nil, false, nil
		}
	}
	candidates := s.sfu.Candidates()
	if len(candidates) == 0 {
		return "", nil, false, nil
	}
	to := s.firstChoice(ctx, wb, candidates)
	if to == from {
		return "", nil, false, nil
	}
	moved, err := s.store.MoveSFUProject(ctx, wb.ID, from, to)
	if err != nil {
		return "", nil, false, err
	}
	if !moved {
		// Somebody else moved it (or it started) first: follow whatever is recorded now.
		latest, rerr := s.store.SFUProjectOf(ctx, wb.ID)
		if rerr != nil || latest == "" || latest == from {
			return "", nil, false, rerr
		}
		to = latest
	} else {
		s.log.Warn("sfu: moved a webinar off a retired video server",
			"slug", wb.ID, "from", from, "to", to)
		if webinarFitsEdge(wb) && wb.Delivery != types.DeliveryEdge && s.edgeOnlyProject(to) {
			if derr := s.saveDelivery(ctx, wb.ID, types.DeliveryEdge); derr != nil {
				s.log.Warn("sfu: could not switch a moved webinar to edge", "slug", wb.ID, "error", derr)
			}
		}
	}
	room, err = s.sfu.Get(to)
	if err != nil {
		return "", nil, false, err
	}
	return to, room, true, nil
}

/* MoveOffRetiredServers runs once at boot: unassign hosts from retired projects and move every
 * draft or scheduled webinar pinned to one (moveOffRetired). Idempotent, and a failure only
 * logs; whatever it leaves behind is moved at its first join. Before BackfillEdgeDelivery, so
 * the backfill sees the new pins. */
func (s *Server) MoveOffRetiredServers(ctx context.Context) {
	retired := s.retiredProjects()
	if len(retired) == 0 {
		return
	}
	if n, err := s.store.UnassignHostsFrom(ctx, retired); err != nil {
		s.log.Warn("sfu: could not unassign hosts from retired video servers", "error", err)
	} else if n > 0 {
		s.log.Info("sfu: unassigned hosts from retired video servers", "hosts", n, "projects", retired)
	}
	slugs, err := s.store.UnrunWebinarsOn(ctx, retired)
	if err != nil {
		s.log.Warn("sfu: could not list webinars on retired video servers", "error", err)
		return
	}
	moved := 0
	for _, slug := range slugs {
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			s.log.Warn("sfu: load webinar on a retired video server", "slug", slug, "error", err)
			continue
		}
		if _, _, ok, err := s.moveOffRetired(ctx, wb); err != nil {
			s.log.Warn("sfu: move webinar off a retired video server", "slug", slug, "error", err)
		} else if ok {
			moved++
		}
	}
	s.log.Info("sfu: retired video servers", "projects", retired, "webinars_pinned", len(slugs), "moved", moved)
}
