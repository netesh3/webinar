package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The admin "Cost by host" report: GET /api/admin/costs and /api/admin/costs/hosts/{id}.
 *
 * Usage, not money (types/costs.go): the browser prices it with the Cost calculator's rates
 * (web/lib/host-costs.ts). What is worked out here:
 *
 *   - which provider each session's video server bills through (config CostProvider);
 *   - the concurrency split (splitConcurrency): an hour two sessions share on one server is
 *     half an hour each, and the render time an Edge webinar needs beyond the first one live
 *     on the same server is shared among the Edge webinars live then;
 *   - each host's usage by provider, and the platform's, for the shared costs.
 *
 * A report is cached for costCacheTTL per range: the queries scan every session in it, and
 * an admin flicking between hosts should not repeat them. ?fresh=1 skips the cache. */

const costCacheTTL = 10 * time.Minute

// costZone is where the date range's days start: the business runs on India time.
var costZone = time.FixedZone("IST", 5*3600+1800)

type costReport struct {
	from, to   string
	rangeStart time.Time
	rangeEnd   time.Time
	sessions   []costSession
	hosts      map[string]*types.AdminCostHost
	platform   types.AdminCostPlatform
	at         time.Time
}

type costSession struct {
	hostID string
	types.AdminCostSession
}

var costCache = struct {
	sync.Mutex
	m map[string]*costReport
}{m: map[string]*costReport{}}

// parseCostRange reads from and to (YYYY-MM-DD, to inclusive). Either may be empty.
func parseCostRange(q interface{ Get(string) string }) (from, to string, lo, hi time.Time, err error) {
	from, to = strings.TrimSpace(q.Get("from")), strings.TrimSpace(q.Get("to"))
	lo = time.Time{}
	hi = time.Now().Add(time.Minute)
	if from != "" {
		if lo, err = time.ParseInLocation("2006-01-02", from, costZone); err != nil {
			return "", "", lo, hi, errors.New("from must be YYYY-MM-DD")
		}
	}
	if to != "" {
		var d time.Time
		if d, err = time.ParseInLocation("2006-01-02", to, costZone); err != nil {
			return "", "", lo, hi, errors.New("to must be YYYY-MM-DD")
		}
		if end := d.AddDate(0, 0, 1); end.Before(hi) {
			hi = end
		}
	}
	if !lo.IsZero() && !hi.After(lo) {
		return "", "", lo, hi, errors.New("to must not be before from")
	}
	return from, to, lo, hi, nil
}

// costProviderOf is who bills for a project's servers.
func (s *Server) costProviderOf(project string) string {
	if p, ok := s.cfg.LiveKitProjectByID(project); ok {
		return p.CostProvider()
	}
	return config.CostProviderOfName(project)
}

// defaultCostProject is where a session with no pin (and a host with none) was placed.
func (s *Server) defaultCostProject() string {
	if c := s.sfu.Candidates(); len(c) > 0 {
		return c[0]
	}
	if ids := s.sfu.IDs(); len(ids) > 0 {
		return ids[0]
	}
	return "default"
}

// concurrencyShare is one session's part of its server: busy hours, and extra-render hours.
type concurrencyShare struct{ box, edgeExtra float64 }

/* splitConcurrency shares each video server's time among the sessions on it. Between any two
 * consecutive starts or ends on a project, n sessions are live, e of them Edge: each gets
 * dt/n of the server, and each Edge one dt·(e-1)/e of extra rendering (the server renders one
 * mix; the rest need a worker). Only time inside [lo, hi) counts. */
func splitConcurrency(spans []store.CostSpan, lo, hi time.Time) map[string]concurrencyShare {
	type ev struct {
		at    time.Time
		start bool
		i     int
	}
	byProject := map[string][]ev{}
	for i, sp := range spans {
		st, en := sp.Start, sp.End
		if st.Before(lo) {
			st = lo
		}
		if en.After(hi) {
			en = hi
		}
		if !en.After(st) {
			continue
		}
		byProject[sp.Project] = append(byProject[sp.Project], ev{st, true, i}, ev{en, false, i})
	}
	out := map[string]concurrencyShare{}
	for _, evs := range byProject {
		sort.Slice(evs, func(a, b int) bool {
			if !evs[a].at.Equal(evs[b].at) {
				return evs[a].at.Before(evs[b].at)
			}
			return !evs[a].start && evs[b].start // ends first: touching sessions do not overlap
		})
		live := map[int]bool{}
		edges := 0
		for k, e := range evs {
			if e.start {
				live[e.i] = true
				if spans[e.i].Edge {
					edges++
				}
			} else {
				delete(live, e.i)
				if spans[e.i].Edge {
					edges--
				}
			}
			if k+1 == len(evs) || len(live) == 0 {
				continue
			}
			dt := evs[k+1].at.Sub(e.at).Hours()
			if dt <= 0 {
				continue
			}
			n := float64(len(live))
			for i := range live {
				sh := out[spans[i].WebinarID]
				sh.box += dt / n
				if spans[i].Edge && edges > 1 {
					sh.edgeExtra += dt * float64(edges-1) / float64(edges)
				}
				out[spans[i].WebinarID] = sh
			}
		}
	}
	return out
}

func addUsage(a *types.AdminCostUsage, b types.AdminCostUsage) {
	a.Sessions += b.Sessions
	a.Webinars += b.Webinars
	a.Meetings += b.Meetings
	a.Simulives += b.Simulives
	a.Attendees += b.Attendees
	a.SessionHours += b.SessionHours
	a.LiveHours += b.LiveHours
	a.BoxShareHours += b.BoxShareHours
	a.EdgeLiveHours += b.EdgeLiveHours
	a.EdgeExtraHours += b.EdgeExtraHours
	a.StagePairHours += b.StagePairHours
	a.EdgeViewerHours += b.EdgeViewerHours
	a.WebRTCViewerHours += b.WebRTCViewerHours
	a.MeetingParticipantHours += b.MeetingParticipantHours
	a.SimuliveViewerHours += b.SimuliveViewerHours
	a.ZoomAttendeeHours += b.ZoomAttendeeHours
	a.CompositeRecHours += b.CompositeRecHours
	a.MixRecHours += b.MixRecHours
	a.BrowserRecHours += b.BrowserRecHours
	a.RecordedGB += b.RecordedGB
	a.CaptionLiveHours += b.CaptionLiveHours
	a.CaptionFinalHours += b.CaptionFinalHours
}

// sessionUsage turns one session's sums into usage, by what kind of session it was.
func sessionUsage(c store.CostSession, share concurrencyShare) (types.AdminCostUsage, string) {
	wall := c.EndedAt.Sub(c.StartedAt).Hours()
	u := types.AdminCostUsage{Sessions: 1, Attendees: c.Audience, SessionHours: wall}
	u.CompositeRecHours = c.CompositeRecHours
	u.MixRecHours = c.MixRecHours
	u.BrowserRecHours = c.BrowserRecHours
	u.RecordedGB = float64(c.RecordedBytes) / 1e9
	zoom := strings.HasPrefix(c.Venue, "zoom")
	switch {
	case c.Kind == string(types.KindSimulive):
		u.Simulives = 1
		u.SimuliveViewerHours = c.AllHours
		return u, types.CostProviderNone
	case zoom:
		if c.Kind == string(types.KindMeeting) {
			u.Meetings = 1
		} else {
			u.Webinars = 1
		}
		u.ZoomAttendeeHours = c.AllHours
		return u, types.CostProviderNone
	}
	u.LiveHours = wall
	u.BoxShareHours = share.box
	if c.ServerCaptions {
		u.CaptionLiveHours = wall
	}
	if c.Transcribed {
		u.CaptionFinalHours = wall
	}
	if c.Kind == string(types.KindMeeting) {
		u.Meetings = 1
		u.MeetingParticipantHours = c.AllHours
		return u, ""
	}
	u.Webinars = 1
	if c.Delivery == types.DeliveryEdge {
		u.EdgeLiveHours = wall
		u.EdgeExtraHours = share.edgeExtra
	}
	u.EdgeViewerHours = c.EdgeHours
	u.WebRTCViewerHours = c.RTCAudienceHours
	n := float64(c.Stage)
	u.StagePairHours = wall * n * max(0, n-1)
	return u, ""
}

func (s *Server) costReport(ctx context.Context, from, to string, lo, hi time.Time, fresh bool) (*costReport, error) {
	key := fmt.Sprintf("%p|%s|%s", s, from, to)
	costCache.Lock()
	if r := costCache.m[key]; r != nil && !fresh && time.Since(r.at) < costCacheTTL {
		costCache.Unlock()
		return r, nil
	}
	costCache.Unlock()

	r, err := s.buildCostReport(ctx, from, to, lo, hi)
	if err != nil {
		return nil, err
	}
	costCache.Lock()
	costCache.m[key] = r
	costCache.Unlock()
	return r, nil
}

func (s *Server) buildCostReport(ctx context.Context, from, to string, lo, hi time.Time) (*costReport, error) {
	def := s.defaultCostProject()
	if lo.IsZero() {
		first, ok, err := s.store.CostFirstSession(ctx)
		if err != nil {
			return nil, err
		}
		lo = hi
		if ok && first.Before(hi) {
			lo = first
		}
	}
	rows, err := s.store.CostSessions(ctx, lo, hi, def)
	if err != nil {
		return nil, err
	}
	// Spans run up to a day either side: a session can share the server with one that
	// started outside the range. Shares only count the time inside the range's sessions.
	spans, err := s.store.CostSpans(ctx, lo.Add(-24*time.Hour), hi.Add(24*time.Hour), def)
	if err != nil {
		return nil, err
	}
	shares := splitConcurrency(spans, time.Time{}, hi.Add(24*time.Hour))
	firsts, err := s.store.CostFirstSessions(ctx, def)
	if err != nil {
		return nil, err
	}
	ai, err := s.store.CostAIUsage(ctx, lo, hi)
	if err != nil {
		return nil, err
	}
	storage, err := s.store.CostStorageUsage(ctx, lo, hi)
	if err != nil {
		return nil, err
	}
	sends, err := s.store.CostSends(ctx, lo, hi)
	if err != nil {
		return nil, err
	}

	r := &costReport{
		from: from, to: to, rangeStart: lo, rangeEnd: hi, at: time.Now(),
		hosts: map[string]*types.AdminCostHost{},
		platform: types.AdminCostPlatform{
			ByProvider:     map[string]types.AdminCostUsage{},
			FirstSessionAt: map[string]string{},
		},
	}
	host := func(id, name, email string) *types.AdminCostHost {
		h := r.hosts[id]
		if h == nil {
			h = &types.AdminCostHost{
				HostID: id, Name: name, Email: email, ByProvider: map[string]types.AdminCostUsage{},
				Extras: types.AdminCostHostExtras{
					AI: []types.AdminCostAI{}, Emails: []types.AdminCostCount{}, WhatsApp: []types.AdminCostCount{},
				},
			}
			r.hosts[id] = h
		}
		return h
	}
	for p, t := range firsts {
		prov := s.costProviderOf(p)
		if cur, ok := r.platform.FirstSessionAt[prov]; !ok || t.UTC().Format(time.RFC3339) < cur {
			r.platform.FirstSessionAt[prov] = t.UTC().Format(time.RFC3339)
		}
	}
	for _, c := range rows {
		u, prov := sessionUsage(c, shares[c.WebinarID])
		if prov == "" {
			prov = s.costProviderOf(c.Project)
		}
		project := c.Project
		if prov == types.CostProviderNone {
			project = ""
		}
		r.sessions = append(r.sessions, costSession{hostID: c.HostID, AdminCostSession: types.AdminCostSession{
			ID: c.Slug, Topic: c.Topic, Kind: c.Kind, Delivery: c.Delivery, Provider: prov, Project: project,
			StartedAt: c.StartedAt.UTC().Format(time.RFC3339), EndedAt: c.EndedAt.UTC().Format(time.RFC3339),
			Usage: u,
		}})
		pu := r.platform.ByProvider[prov]
		addUsage(&pu, u)
		r.platform.ByProvider[prov] = pu
		r.platform.SessionHours += u.SessionHours
		if c.HostID == "" {
			continue
		}
		h := host(c.HostID, c.HostName, c.HostEmail)
		hu := h.ByProvider[prov]
		addUsage(&hu, u)
		h.ByProvider[prov] = hu
	}
	for _, a := range ai {
		if a.HostID == "" {
			r.platform.UnattributedAIUSD += a.CostUSD
			continue
		}
		h := host(a.HostID, "", "")
		h.Extras.AI = append(h.Extras.AI, types.AdminCostAI{
			Feature: a.Feature, Calls: a.Calls, PromptTokens: a.PromptTokens,
			CompletionTokens: a.CompletionTokens, CostUSD: a.CostUSD,
		})
	}
	for _, st := range storage {
		if st.HostID == "" {
			r.platform.UnattributedRecordingGBDays += st.RecordingGBDays
			continue
		}
		if st.RecordingGBDays+st.MediaGBDays+st.KnowledgeGBDays+st.RecordingGB+st.MediaGB+st.KnowledgeGB == 0 {
			continue
		}
		h := host(st.HostID, "", "")
		x := &h.Extras
		x.RecordingGBDays, x.RecordingGB = st.RecordingGBDays, st.RecordingGB
		x.MediaGBDays, x.MediaGB = st.MediaGBDays, st.MediaGB
		x.KnowledgeGBDays, x.KnowledgeGB = st.KnowledgeGBDays, st.KnowledgeGB
	}
	for _, sd := range sends {
		h := host(sd.HostID, "", "")
		c := types.AdminCostCount{Kind: sd.Kind, Count: sd.Count}
		if sd.Channel == "whatsapp" {
			h.Extras.WhatsApp = append(h.Extras.WhatsApp, c)
		} else {
			h.Extras.Emails = append(h.Extras.Emails, c)
		}
	}
	// Names for hosts that only turned up through AI, storage or sends.
	var unnamed []string
	for id, h := range r.hosts {
		if h.Email == "" {
			unnamed = append(unnamed, id)
		}
	}
	if len(unnamed) > 0 {
		named, err := s.store.CostHosts(ctx, unnamed)
		if err != nil {
			return nil, err
		}
		for _, n := range named {
			r.hosts[n.ID].Name, r.hosts[n.ID].Email = n.Name, n.Email
		}
	}
	return r, nil
}

func validCostProvider(p string) bool {
	return p == "" || slices.Contains([]string{types.CostProviderGCP, types.CostProviderHetzner, types.CostProviderDO}, p)
}

/* filterHost is a host as the provider filter sees it: only that provider's sessions, and
 * none of the host-wide costs (AI, mail, storage), which belong to no video server. */
func filterHost(h types.AdminCostHost, provider string) (types.AdminCostHost, bool) {
	if provider == "" {
		return h, true
	}
	u, ok := h.ByProvider[provider]
	if !ok {
		return h, false
	}
	h.ByProvider = map[string]types.AdminCostUsage{provider: u}
	h.Extras = types.AdminCostHostExtras{
		AI: []types.AdminCostAI{}, Emails: []types.AdminCostCount{}, WhatsApp: []types.AdminCostCount{},
	}
	return h, true
}

func (s *Server) costRequest(w http.ResponseWriter, r *http.Request) (*costReport, string, bool) {
	q := r.URL.Query()
	from, to, lo, hi, err := parseCostRange(q)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_range", err.Error())
		return nil, "", false
	}
	provider := q.Get("provider")
	if !validCostProvider(provider) {
		httpx.Error(w, http.StatusBadRequest, "bad_provider", "provider must be gcp, hetzner or do")
		return nil, "", false
	}
	rep, err := s.costReport(r.Context(), from, to, lo, hi, q.Get("fresh") == "1")
	if err != nil {
		s.fail(w, r, "admin costs", err)
		return nil, "", false
	}
	return rep, provider, true
}

// handleAdminCosts is GET /api/admin/costs?from=&to=&provider=: every host's usage.
func (s *Server) handleAdminCosts(w http.ResponseWriter, r *http.Request) {
	rep, provider, ok := s.costRequest(w, r)
	if !ok {
		return
	}
	out := types.AdminCostsResponse{
		From: rep.from, To: rep.to, Provider: provider,
		RangeStart: rep.rangeStart.UTC().Format(time.RFC3339), RangeEnd: rep.rangeEnd.UTC().Format(time.RFC3339),
		Hosts: []types.AdminCostHost{}, Platform: rep.platform, GeneratedAt: rep.at.UTC().Format(time.RFC3339),
	}
	for _, h := range rep.hosts {
		if fh, ok := filterHost(*h, provider); ok {
			out.Hosts = append(out.Hosts, fh)
		}
	}
	sort.Slice(out.Hosts, func(a, b int) bool { return out.Hosts[a].Email < out.Hosts[b].Email })
	httpx.JSON(w, http.StatusOK, out)
}

// handleAdminCostHost is GET /api/admin/costs/hosts/{id}?from=&to=&provider=: one host's
// usage and their sessions, newest first.
func (s *Server) handleAdminCostHost(w http.ResponseWriter, r *http.Request) {
	rep, provider, ok := s.costRequest(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	h := rep.hosts[id]
	if h == nil {
		named, err := s.store.CostHosts(r.Context(), []string{id})
		if err != nil {
			s.fail(w, r, "admin cost host", err)
			return
		}
		if len(named) == 0 {
			httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
			return
		}
		h = &types.AdminCostHost{
			HostID: id, Name: named[0].Name, Email: named[0].Email, ByProvider: map[string]types.AdminCostUsage{},
			Extras: types.AdminCostHostExtras{
				AI: []types.AdminCostAI{}, Emails: []types.AdminCostCount{}, WhatsApp: []types.AdminCostCount{},
			},
		}
	}
	fh, _ := filterHost(*h, provider)
	out := types.AdminCostHostDetail{
		From: rep.from, To: rep.to,
		RangeStart: rep.rangeStart.UTC().Format(time.RFC3339), RangeEnd: rep.rangeEnd.UTC().Format(time.RFC3339),
		Host: fh, Sessions: []types.AdminCostSession{}, Platform: rep.platform,
		GeneratedAt: rep.at.UTC().Format(time.RFC3339),
	}
	for i := len(rep.sessions) - 1; i >= 0; i-- {
		cs := rep.sessions[i]
		if cs.hostID == id && (provider == "" || cs.Provider == provider) {
			out.Sessions = append(out.Sessions, cs.AdminCostSession)
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}
