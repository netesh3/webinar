package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The pool of on-demand video servers (config.SFUBox.Slots, deploy/digitalocean/README.md
 * "More video servers").
 *
 * One c-4 carries two or three webinars and a few meetings before its CPU runs out (load test,
 * 24 Oct 2026). So the box is a pool: the primary (SFU_BOX_*) and the slots declared in
 * SFU_BOX_SLOTS, each a droplet of its own with its own volume, reserved IP and LiveKit project,
 * stepped by the same state machine (sfu_box.go) under its own row lease.
 *
 * Every session costs points (config.BoxPoints: a webinar's mix, its share or recording, and its
 * seats; a meeting by its size) against a box's capacity (100 for a c-4). A session is placed
 * when its box is first chosen — ahead of its scheduled start (placeUpcoming, inside the warm
 * lead) or at Go live / an instant start / a meeting's first join (firstChoice) — on a box of
 * its region (types.Webinar.SFURegion) with room left:
 *
 *   1. a box that is already up (or coming up) with room, so a new droplet is only started when
 *      the running ones are full;
 *   2. otherwise the first box of the region with room, which its own step then brings up
 *      (the session now counts in that box's demand);
 *   3. otherwise, every box of the region full: the least loaded one, and the admins are told.
 *      A host is never refused for capacity; the warning is for whoever adds the next slot.
 *
 * The pin is the existing sfu_project (ClaimSFUProject), so joins, the mix, egress, captions and
 * recording all follow it, as they did with one box. A region with no box falls back to the
 * primary's area. With one box nothing here changes anything: every choice is that box. */

// placementCacheTTL is how long a choice for an unplaced session is reused by status polls.
const placementCacheTTL = 15 * time.Second

/* poolMemory is the pool's short memory, on the Server (zero value ready): recent choices for
 * sessions not pinned yet (the waiting screen polls), and when each region last alerted. */
type poolMemory struct {
	mu     sync.Mutex
	seen   map[string]placedAt
	alerts map[string]time.Time
}

type placedAt struct {
	project string
	at      time.Time
}

// poolAlertEvery is how often one region's "full" alert may repeat.
const poolAlertEvery = time.Hour

// poolAlertDue is whether area's "full" alert may go now (at most once per poolAlertEvery).
func (s *Server) poolAlertDue(area string) bool {
	m := &s.poolMem
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.alerts == nil {
		m.alerts = map[string]time.Time{}
	}
	if time.Since(m.alerts[area]) < poolAlertEvery {
		return false
	}
	m.alerts[area] = time.Now()
	return true
}

// boxPoints is the capacity model in force (the primary's, with defaults for a config built by hand).
func (s *Server) boxPoints() config.BoxPoints {
	if s.box == nil || s.box.cfg.Points == (config.BoxPoints{}) {
		return config.DefaultBoxPoints()
	}
	return s.box.cfg.Points
}

// sessionPoints is what wb costs the box it is on (config.BoxPoints).
func (s *Server) sessionPoints(ctx context.Context, wb types.Webinar) int {
	p := s.boxPoints()
	switch {
	case wb.Kind == types.KindSimulive:
		return p.Simulive
	case isMeeting(wb):
		return p.Meeting(s.meetingCapForHost(ctx, wb.Host.ID))
	default:
		return p.Webinar(s.audienceLimit(ctx, wb))
	}
}

// sessionArea is the area wb's video server should be in: its region, else the primary's.
func (s *Server) sessionArea(wb types.Webinar) string {
	def := config.DefaultBoxArea
	if s.box != nil && s.box.cfg.Area != "" {
		def = s.box.cfg.Area
	}
	if a := strings.ToLower(strings.TrimSpace(wb.SFURegion)); a != "" {
		return a
	}
	return def
}

// poolBox is one box's line in a placement: its manager, state and load.
type poolBox struct {
	b        *boxManager
	actual   string
	used     int
	sessions []poolSessionPoints
}

type poolSessionPoints struct {
	wb     types.Webinar
	points int
}

func (p poolBox) free() int { return p.b.cfg.Capacity - p.used }

// up is a box with a droplet that is serving or about to.
func (p poolBox) up() bool {
	switch p.actual {
	case store.BoxCreating, store.BoxBooting, store.BoxReady, store.BoxDraining:
		return true
	}
	return false
}

/* poolLoad is every box's state and the points of the sessions on it now (store.PoolSessions),
 * leaving out skip (the session being placed, so a re-placement does not count it twice). */
func (s *Server) poolLoad(ctx context.Context, skip string) ([]poolBox, error) {
	projects := make([]string, 0, len(s.boxes))
	byProject := map[string]*poolBox{}
	out := make([]poolBox, len(s.boxes))
	for i, b := range s.boxes {
		projects = append(projects, b.cfg.Project)
		st, err := s.store.SFUBox(ctx, b.cfg.Project)
		switch {
		case errors.Is(err, store.ErrNotFound):
			st = store.SFUBoxState{Actual: store.BoxDown}
		case err != nil:
			return nil, err
		}
		out[i] = poolBox{b: b, actual: st.Actual}
		byProject[b.cfg.Project] = &out[i]
	}
	sessions, err := s.store.PoolSessions(ctx, projects, s.defaultCostProject(), s.box.cfg.WarmLead)
	if err != nil {
		return nil, err
	}
	for _, ps := range sessions {
		if ps.Slug == skip {
			continue
		}
		pb := byProject[ps.Project]
		if pb == nil {
			continue
		}
		wb, err := s.store.WebinarBySlug(ctx, ps.Slug)
		if err != nil {
			continue
		}
		pts := s.sessionPoints(ctx, wb)
		pb.used += pts
		pb.sessions = append(pb.sessions, poolSessionPoints{wb: wb, points: pts})
	}
	return out, nil
}

/* placeSession is the box wb should go on (the rule at the top of this file), among the boxes
 * whose projects are in allowed (the enabled candidates). "" when none is allowed. */
func (s *Server) placeSession(ctx context.Context, wb types.Webinar, allowed map[string]bool) string {
	if len(s.boxes) == 0 {
		return ""
	}
	area := s.sessionArea(wb)
	inArea := func(boxes []poolBox, a string) []poolBox {
		var out []poolBox
		for _, p := range boxes {
			bArea := p.b.cfg.Area
			if bArea == "" {
				bArea = config.DefaultBoxArea
			}
			if bArea == a && allowed[p.b.cfg.Project] {
				out = append(out, p)
			}
		}
		return out
	}
	load, err := s.poolLoad(ctx, wb.ID)
	if err != nil {
		s.log.Warn("box pool: could not read the load; using the first box", "slug", wb.ID, "error", err)
		for _, b := range s.boxes {
			if allowed[b.cfg.Project] {
				return b.cfg.Project
			}
		}
		return ""
	}
	boxes := inArea(load, area)
	if len(boxes) == 0 {
		def := s.sessionArea(types.Webinar{})
		s.log.Info("box pool: no video server in the session's region; using the default region",
			"slug", wb.ID, "region", area, "using", def)
		area = def
		boxes = inArea(load, area)
	}
	if len(boxes) == 0 {
		return ""
	}
	if len(boxes) == 1 {
		return boxes[0].b.cfg.Project
	}
	need := s.sessionPoints(ctx, wb)
	for _, p := range boxes {
		if p.up() && p.free() >= need {
			return p.b.cfg.Project
		}
	}
	for _, p := range boxes {
		if !p.up() && p.free() >= need {
			s.log.Info("box pool: the running video servers are full; placing on the next one",
				"slug", wb.ID, "region", area, "project", p.b.cfg.Project, "points", need)
			return p.b.cfg.Project
		}
	}
	best := boxes[0]
	for _, p := range boxes[1:] {
		if p.free() > best.free() {
			best = p
		}
	}
	s.log.Warn("box pool: every video server in the region is full; placing on the least loaded",
		"slug", wb.ID, "region", area, "project", best.b.cfg.Project, "points", need,
		"used", best.used, "capacity", best.b.cfg.Capacity)
	subject := "ALERT: every video server in " + area + " is full"
	body := "A session (" + wb.ID + ", " + strconv.Itoa(need) + " points) was placed on " + best.b.cfg.Project +
		", which already carries " + strconv.Itoa(best.used) + " of its " + strconv.Itoa(best.b.cfg.Capacity) +
		" points: there is no free slot left in " + area + ".\n\nIt is not refused, but the box may run out of CPU. " +
		"Declare another slot in SFU_BOX_SLOTS (deploy/digitalocean/README.md \"More video servers\")."
	// One alert per region per throttle window (alertOps), on the bell as well as by email.
	if s.poolAlertDue(area) {
		s.alertOps(ctx, "sfu-pool-full:"+area, subject, body)
		s.alertAdminBells(ctx, subject, body)
	}
	return best.b.cfg.Project
}

/* poolChoice is placeSession for firstChoice, with a short memory for sessions that are not
 * pinned yet: the waiting screen asks every few seconds, and the answer only matters once. */
func (s *Server) poolChoice(ctx context.Context, wb types.Webinar, candidates []string) string {
	allowed := make(map[string]bool, len(candidates))
	for _, c := range candidates {
		allowed[c] = true
	}
	m := &s.poolMem
	m.mu.Lock()
	if hit, ok := m.seen[wb.ID]; ok && time.Since(hit.at) < placementCacheTTL && allowed[hit.project] {
		m.mu.Unlock()
		return hit.project
	}
	m.mu.Unlock()
	project := s.placeSession(ctx, wb, allowed)
	if project != "" {
		m.mu.Lock()
		if m.seen == nil {
			m.seen = map[string]placedAt{}
		}
		for k, v := range m.seen {
			if time.Since(v.at) >= placementCacheTTL {
				delete(m.seen, k)
			}
		}
		m.seen[wb.ID] = placedAt{project: project, at: time.Now()}
		m.mu.Unlock()
	}
	return project
}

/* placeUpcoming pins the scheduled sessions starting within the warm lead that have no box yet,
 * earliest first, so the box each needs counts it in its demand and is up when it starts. Only
 * with more than one box: with one, an unpinned session already counts on it (boxProjectOf). */
func (s *Server) placeUpcoming(ctx context.Context) {
	if len(s.boxes) < 2 {
		return
	}
	slugs, err := s.store.UnplacedSoon(ctx, s.box.cfg.WarmLead)
	if err != nil {
		s.log.Warn("box pool: upcoming sessions", "error", err)
		return
	}
	candidates := s.sfu.Candidates()
	if len(candidates) == 0 {
		return
	}
	for _, slug := range slugs {
		if ctx.Err() != nil {
			return
		}
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if err != nil || wb.SFUProject != "" {
			continue
		}
		choice := s.firstChoice(ctx, wb, candidates)
		if !s.managesProject(choice) {
			continue // a host an admin sent to another provider
		}
		pinned, fresh, err := s.store.ClaimSFUProject(ctx, slug, choice)
		if err != nil {
			s.log.Warn("box pool: pin an upcoming session", "slug", slug, "error", err)
			continue
		}
		if fresh {
			s.log.Info("box pool: upcoming session placed", "slug", slug, "project", pinned,
				"region", s.sessionArea(wb), "points", s.sessionPoints(ctx, wb))
		}
	}
}

// ---------------------------------------------------------------- admin

// handleAdminSFUPool is GET /api/admin/sfu-pool: every box, its state, load and sessions.
func (s *Server) handleAdminSFUPool(w http.ResponseWriter, r *http.Request) {
	out := types.AdminSFUPool{Boxes: []types.AdminPoolBox{}}
	if len(s.boxes) == 0 {
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	load, err := s.poolLoad(r.Context(), "")
	if err != nil {
		s.fail(w, r, "admin sfu pool", err)
		return
	}
	p := s.boxPoints()
	out.Enabled = true
	out.Points = types.AdminPoolPoints{Mix: p.Mix, Extra: p.Extra, ViewersPerPoint: p.ViewersPerPoint,
		MeetingBase: p.MeetingBase, MeetingBaseSize: p.MeetingBaseSize,
		MeetingPeoplePerPoint: p.MeetingPeoplePerPoint, Simulive: p.Simulive}
	for _, pb := range load {
		c := pb.b.cfg
		box := types.AdminPoolBox{Project: c.Project, Name: c.Name, Area: c.Area, Region: c.Region,
			Size: c.Size, Actual: pb.actual, Capacity: c.Capacity, Used: pb.used,
			Sessions: []types.AdminPoolSession{}}
		if st, err := s.store.SFUBox(r.Context(), c.Project); err == nil {
			box.Desired, box.DropletID = st.Desired, st.DropletID
		}
		for _, ps := range pb.sessions {
			box.Sessions = append(box.Sessions, types.AdminPoolSession{Slug: ps.wb.ID, Topic: ps.wb.Topic,
				Kind: string(ps.wb.Kind), Status: string(ps.wb.Status), StartsAt: ps.wb.StartsAt, Points: ps.points})
		}
		out.Boxes = append(out.Boxes, box)
	}
	httpx.JSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------- the session's region

/* sessionRegion is the region a schedule form asked for, checked against the areas the pool
 * serves (config.BoxAreas). "" is "no change" (the default area for a new session). */
func (s *Server) sessionRegion(raw string) (string, bool) {
	r := strings.ToLower(strings.TrimSpace(raw))
	if r == "" {
		return "", true
	}
	for _, a := range s.cfg.BoxAreas() {
		if a == r {
			return r, true
		}
	}
	return "", false
}

/* saveSessionRegion stores region on wb (and on the rest of its series), and on the copy the
 * handler answers with. It only decides where a session that has not been placed yet goes: one
 * already on a box (live, or placed in the warm lead before its start) stays where it is. */
func (s *Server) saveSessionRegion(ctx context.Context, wb *types.Webinar, region string) error {
	if region == "" || region == wb.SFURegion {
		return nil
	}
	var err error
	if wb.SeriesID != "" {
		err = s.store.SetSeriesRegion(ctx, wb.SeriesID, region)
	} else {
		err = s.store.SetSessionRegion(ctx, wb.ID, region)
	}
	if err == nil {
		wb.SFURegion = region
	}
	return err
}

// boxRegions is AppConfig.BoxRegions: never nil, so the client always gets a list.
func (s *Server) boxRegions() []string {
	if out := s.cfg.BoxAreas(); out != nil {
		return out
	}
	return []string{}
}
