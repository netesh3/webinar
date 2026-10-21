package api

/* Edge delivery: the audience watches LL-HLS and never connects to LiveKit.
 *
 * Everything in this file is reached only for a webinar whose delivery is "edge"
 * (types.DeliveryEdge). Standard webinars, including CDN-broadcast (WHEP) ones, take exactly
 * the paths they took before this existed. See docs/edge-delivery.md for the whole picture.
 *
 * What an edge viewer still needs from the session — chat, Q&A, polls, raised hands,
 * controls, status, stage invites — used to arrive over the LiveKit data channel and room
 * metadata. Here it arrives over GET /api/webinars/{slug}/events (server-sent events) instead,
 * fed by tapping the two calls every one of those features already goes through: SendData
 * and SetMetadata on the room manager (edgeRoom). Nothing that sends a packet needed editing,
 * and the stage keeps receiving exactly what it received before. */

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/livekit/protocol/livekit"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/realtime"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// ------------------------------------------------------------------- tap

/* edgePool wraps the SFU pool so every room manager it hands out is an edgeRoom.
 *
 * Wrapping at the pool is what makes the tap complete: every handler resolves its room manager
 * through s.sfu (sfuFor, sfuForSlug), so there is no SendData call site that can be missed. */
type edgePool struct {
	SFUPool
	s *Server
}

func (p edgePool) Get(id string) (RoomManager, error) {
	rm, err := p.SFUPool.Get(id)
	if err != nil || rm == nil {
		return rm, err
	}
	return edgeRoom{RoomManager: rm, s: p.s}, nil
}

// edgeRoom forwards to the real room manager and copies data packets and metadata to the
// realtime bus when the room's webinar is on edge delivery.
type edgeRoom struct {
	RoomManager
	s *Server
}

func (r edgeRoom) SendData(ctx context.Context, room, topic string, data []byte, to []string) error {
	if topic == dataTopic {
		r.s.publishEdge(ctx, lk.SlugFromRoom(room), realtime.KindPacket, data, to)
	}
	return r.RoomManager.SendData(ctx, room, topic, data, to)
}

func (r edgeRoom) SetMetadata(ctx context.Context, room, metadata string) error {
	r.s.publishEdge(ctx, lk.SlugFromRoom(room), realtime.KindMeta, []byte(metadata), nil)
	return r.RoomManager.SetMetadata(ctx, room, metadata)
}

/* publishEdge puts one packet or metadata write on the bus, if this webinar is edge.
 *
 * Published before the LiveKit call, not after: an edge webinar's room may have no one on the
 * stage yet (the host is still setting up), and LiveKit refusing a packet for an empty room
 * must not keep it from the audience who is already watching. */
func (s *Server) publishEdge(ctx context.Context, slug, kind string, data []byte, to []string) {
	if slug == "" || s.rt == nil || !json.Valid(data) {
		return
	}
	if !s.isEdge(ctx, slug) {
		return
	}
	s.rt.Publish(ctx, realtime.Event{Slug: slug, Kind: kind, To: to, Data: json.RawMessage(data)})
}

// deliveryTTL is how long isEdge trusts a cached answer. A host switching delivery mid-session
// is not supported anyway; this only has to keep chat from querying the row per message.
const deliveryTTL = 15 * time.Second

type deliveryEntry struct {
	edge bool
	at   time.Time
}

// isEdge reports whether a webinar is on edge delivery, from a short cache.
func (s *Server) isEdge(ctx context.Context, slug string) bool {
	if v, ok := s.deliveryCache.Load(slug); ok {
		if e := v.(deliveryEntry); time.Since(e.at) < deliveryTTL {
			return e.edge
		}
	}
	d, err := s.store.WebinarDelivery(ctx, slug)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.log.Warn("edge: could not read delivery", "slug", slug, "error", err)
		}
		return false
	}
	edge := d == types.DeliveryEdge
	s.deliveryCache.Store(slug, deliveryEntry{edge: edge, at: time.Now()})
	return edge
}

func (s *Server) forgetDelivery(slug string) { s.deliveryCache.Delete(slug) }

// --------------------------------------------------------- saving the choice

/* resolveDelivery validates the delivery a save asks for and returns what to store.
 *
 * "" keeps what is saved (or standard on a create), so a client that never heard of the field
 * changes nothing. Edge needs the host's switch, a live webinar in this app (not Zoom, not
 * simulive, not a recurring series — each of those has its own audience path), and a live
 * origin to push to; anything else is a field error rather than a silent downgrade, because a
 * host testing edge has to know they are not getting it. */
func (s *Server) resolveDelivery(ctx context.Context, hostID string, in types.WebinarInput, prev string) (string, map[string]string) {
	want := strings.TrimSpace(in.Delivery)
	explicit := want != ""
	if !explicit {
		if prev == "" {
			return types.DeliveryStandard, nil
		}
		want = prev
	}
	switch want {
	case types.DeliveryStandard:
		return want, nil
	case types.DeliveryEdge:
	default:
		return "", map[string]string{"delivery": "Choose standard or edge delivery."}
	}
	if !s.hostFeature(ctx, hostID, types.FeatureEdgeDelivery) {
		if prev == types.DeliveryEdge {
			// Saved while the switch was on. Leave it; join checks the switch again.
			return prev, nil
		}
		return "", map[string]string{"delivery": featureLabel(types.FeatureEdgeDelivery) + " isn't switched on for this account."}
	}
	// A save that did not ask for edge but inherits it, and no longer fits (moved to Zoom,
	// made recurring), quietly becomes standard: refusing an edit over a field the host
	// never touched would be worse than the downgrade.
	if !explicit && ((in.Venue != "" && in.Venue != "app") || in.Kind == types.KindSimulive ||
		in.Kind == types.KindRecurring || seriesRequested(in)) {
		return types.DeliveryStandard, nil
	}
	switch {
	case in.Venue != "" && in.Venue != "app":
		return "", map[string]string{"delivery": "Edge delivery is for webinars that run in this app."}
	case in.Kind == types.KindSimulive:
		return "", map[string]string{"delivery": "A simulive session already plays a recording to everyone."}
	case in.Kind == types.KindRecurring || seriesRequested(in):
		return "", map[string]string{"delivery": "Edge delivery is for single webinars for now, not a recurring series."}
	case s.cfg.BroadcastRTMPBase == "":
		return "", map[string]string{"delivery": "Edge delivery needs the live origin (BROADCAST_RTMP_BASE), which this server doesn't have."}
	}
	return want, nil
}

func (s *Server) saveDelivery(ctx context.Context, slug, delivery string) error {
	if delivery == "" {
		return nil
	}
	s.forgetDelivery(slug)
	return s.store.SetWebinarDelivery(ctx, slug, delivery)
}

// ------------------------------------------------------------ join and tokens

/* edgeAudience reports whether this join should get the edge audience response: an edge
 * webinar, the host's switch still on, an origin to play, and a person who is not on the stage.
 * Anyone on the stage — a promoted attendee — gets an ordinary LiveKit token. */
func (s *Server) edgeAudience(ctx context.Context, wb types.Webinar, onStage bool) (playback string, ok bool) {
	if onStage || wb.Delivery != types.DeliveryEdge || wb.Kind == types.KindSimulive {
		return "", false
	}
	if s.cfg.SessionSecret == "" || !s.hostFeature(ctx, wb.Host.ID, types.FeatureEdgeDelivery) {
		return "", false
	}
	u := s.cfg.EdgePlaybackURLFor(s.pinnedProject(ctx, wb), wb.ID)
	return u, u != ""
}

const (
	// eventsIssuer keeps an events token from ever passing as a session or a rejoin token,
	// which are signed with the same secret.
	eventsIssuer = "webcast-events"
	// eventsTokenTTL bounds a leaked token. The browser asks for a fresh one by joining
	// again, which it does anyway after a long disconnect.
	eventsTokenTTL = 6 * time.Hour
)

type eventsClaims struct {
	Name string `json:"name,omitempty"`
	jwt.RegisteredClaims
}

// signEvents returns a token naming one viewer of one webinar.
func signEvents(secret []byte, identity, name, slug string, now time.Time) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, eventsClaims{
		Name: name,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   identity,
			Audience:  jwt.ClaimStrings{slug},
			Issuer:    eventsIssuer,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(eventsTokenTTL)),
		},
	})
	return tok.SignedString(secret)
}

var errEventsToken = errors.New("invalid events token")

// verifyEvents returns the identity and display name in a genuine, unexpired token for slug.
func verifyEvents(secret []byte, token, slug string, now time.Time) (identity, name string, err error) {
	parsed, err := jwt.ParseWithClaims(token, &eventsClaims{},
		func(t *jwt.Token) (any, error) { return secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(eventsIssuer),
		jwt.WithAudience(slug),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	if err != nil {
		return "", "", errors.Join(errEventsToken, err)
	}
	c, ok := parsed.Claims.(*eventsClaims)
	if !ok || c.Subject == "" {
		return "", "", errEventsToken
	}
	return c.Subject, c.Name, nil
}

/* edgeOccupancy is the attendee count an edge join is checked against: viewers with an open
 * event stream. The video server cannot count them, because they are not on it. */
func (s *Server) edgeOccupancy(ctx context.Context, slug string) (int, error) {
	return s.store.OpenEdgeVisits(ctx, slug)
}

// issueEdgeAudience writes the edge audience's join response: no LiveKit token, the playback
// URL, and the token for the event stream.
func (s *Server) issueEdgeAudience(w http.ResponseWriter, r *http.Request, wb types.Webinar, identity, name, playback string) bool {
	tok, err := signEvents([]byte(s.cfg.SessionSecret), identity, name, wb.ID, time.Now())
	if err != nil {
		s.fail(w, r, "edge: sign events token", err)
		return false
	}
	s.log.Info("edge audience joined", "slug", wb.ID, "identity", identity)
	httpx.JSON(w, http.StatusOK, types.JoinResponse{
		Room:           lk.RoomName(wb.ID),
		Role:           types.RoleAttendee,
		Identity:       identity,
		DisplayName:    name,
		Controls:       wb.Controls,
		Topic:          wb.Topic,
		StartedAt:      wb.StartedAt,
		EndedAt:        wb.EndedAt,
		Hidden:         lk.HiddenFor(types.RoleAttendee, wb.Controls.HideAttendees),
		JoinKey:        joinKeyFromIdentity(identity),
		MaxDurationMin: wb.MaxDurationMin,
		Delivery:       types.DeliveryEdge,
		PlaybackURL:    playback,
		EventsToken:    tok,
		DebugClock:     s.cfg.EdgeDebugClock,
		LowLatency:     s.cfg.EdgePlaybackLowLatency,
	})
	return true
}

// -------------------------------------------------------------- the stream

const (
	// edgeHeartbeat keeps proxies (the Worker, Cloud Run's front end) from treating a quiet
	// stream as dead, and lets the server notice a browser that went away.
	edgeHeartbeat = 15 * time.Second
	// edgeStreamLife ends a stream well before Cloud Run's request timeout, with an explicit
	// "reconnect" event, so the browser reconnects on our schedule rather than after an error.
	edgeStreamLife = 25 * time.Minute
	// edgeWriteGrace is how long one write may take. The server's WriteTimeout (60s) would
	// otherwise end every stream a minute in; each write pushes the deadline forward instead.
	edgeWriteGrace = 30 * time.Second
)

var edgeEventSeq atomic.Int64

/* handleEdgeEvents is the event stream an edge viewer reads instead of the LiveKit data
 * channel.
 *
 * The token comes as ?t= because EventSource cannot send headers. The first event is the
 * current room metadata, so a viewer is in step the moment they connect. There is no replay
 * of what they missed while disconnected — the browser refetches the chat, question and poll
 * backlogs on every (re)connect, the same way a LiveKit attendee does after a reconnect. */
func (s *Server) handleEdgeEvents(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	identity, name, err := verifyEvents([]byte(s.cfg.SessionSecret), r.URL.Query().Get("t"), slug, time.Now())
	if err != nil || s.cfg.SessionSecret == "" {
		httpx.Error(w, http.StatusUnauthorized, "bad_token", "Join the webinar again.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "edge events: load webinar", err)
		return
	}
	if wb.Delivery != types.DeliveryEdge {
		httpx.Error(w, http.StatusConflict, "not_edge", "This webinar isn't on edge delivery.")
		return
	}
	if removed, rerr := s.store.WasRemoved(r.Context(), slug, identity); rerr == nil && removed {
		httpx.Error(w, http.StatusForbidden, "removed", "The host removed you from this webinar.")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		httpx.Error(w, http.StatusInternalServerError, "no_stream", "Streaming isn't available.")
		return
	}
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	sub, cancel := s.rt.Hub().Subscribe(slug, identity)
	defer cancel()

	/* Connecting counts as a beat; the stream ENDING says nothing, so nothing is closed here.
	 *
	 * Neither end of a stream can be trusted to mean the viewer came or went. Behind the CDN
	 * a browser that closed its tab left the stream open on this side until edgeStreamLife,
	 * and when a viewer reloaded, the old stream ending closed the visit of the new one: on
	 * instant-webinar-4178 a phone that left at 11:11 was "there" until 11:29, and then
	 * "gone" for the twelve minutes it was actually back. The visit is the browser's beats
	 * (handleEdgeBeat) and its goodbye (handleEdgeLeave) instead. */
	if wb.Status == types.StatusLive {
		_ = s.store.TouchAttendance(r.Context(), slug, identity, "", name)
		if err := s.store.TouchEdgeVisit(r.Context(), slug, identity, time.Now()); err != nil {
			s.log.Warn("edge events: open visit", "slug", slug, "error", err)
		}
	}

	write := func(kind string, data []byte) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(edgeWriteGrace))
		var err error
		if kind == "" {
			_, err = fmt.Fprint(w, ": ping\n\n")
		} else {
			_, err = io.WriteString(w, sseFrame(edgeEventSeq.Add(1), kind, data))
		}
		if err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Reconnect quickly after a drop, and start in step with the room.
	_, _ = fmt.Fprint(w, "retry: 2000\n\n")
	if meta, err := s.roomMetadata(r.Context(), wb); err == nil && !write(realtime.KindMeta, []byte(meta)) {
		return
	}

	beat := time.NewTicker(edgeHeartbeat)
	defer beat.Stop()
	life := time.NewTimer(edgeStreamLife)
	defer life.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-life.C:
			write("reconnect", []byte("{}"))
			return
		case <-beat.C:
			if !write("", nil) {
				return
			}
		case e, open := <-sub.C:
			if !open {
				// Dropped for falling behind. Ending the response makes the browser
				// reconnect and refetch the backlogs.
				return
			}
			if !write(e.Kind, e.Data) {
				return
			}
		}
	}
}

/* handleEdgeBeat is an edge viewer's browser saying they are still watching, every 30 seconds
 * while the player is up (web/lib/edge-events.ts). It keeps their visit open, or opens one
 * if the webinar went live after they connected; a viewer whose beats stop is closed at the
 * last one (store.SweepEdgeVisits). Same credential as the stream, in the query for the same
 * reason: one shape for every edge call. */
func (s *Server) handleEdgeBeat(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	identity, _, err := verifyEvents([]byte(s.cfg.SessionSecret), r.URL.Query().Get("t"), slug, time.Now())
	if err != nil || s.cfg.SessionSecret == "" {
		httpx.Error(w, http.StatusUnauthorized, "bad_token", "Join the webinar again.")
		return
	}
	if err := s.store.TouchEdgeVisit(r.Context(), slug, identity, time.Now()); err != nil {
		s.fail(w, r, "edge beat", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

/* handleEdgeLeave is the goodbye: the Leave button, or navigator.sendBeacon as the page goes
 * away. A beacon cannot be retried or read, so this answers 204 whatever happens and a lost
 * one is covered by the beats stopping. */
func (s *Server) handleEdgeLeave(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	identity, _, err := verifyEvents([]byte(s.cfg.SessionSecret), r.URL.Query().Get("t"), slug, time.Now())
	if err != nil || s.cfg.SessionSecret == "" {
		httpx.Error(w, http.StatusUnauthorized, "bad_token", "Join the webinar again.")
		return
	}
	if err := s.store.CloseEdgeVisit(r.Context(), slug, identity, time.Now()); err != nil {
		s.log.Warn("edge leave: close visit", "slug", slug, "error", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

/* handleHostEdgeStatus is the host's view of edge delivery for one webinar: whether it is on,
 * how many people are watching the feed, and what they play. Polled by the host room badge. */
func (s *Server) handleHostEdgeStatus(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "edge status: load webinar", err)
		return
	}
	out := types.EdgeStatus{Delivery: wb.Delivery}
	if out.Delivery == "" {
		out.Delivery = types.DeliveryStandard
	}
	if wb.Delivery == types.DeliveryEdge {
		out.PlaybackURL = s.cfg.EdgePlaybackURLFor(s.pinnedProject(r.Context(), wb), wb.ID)
		n, err := s.edgeOccupancy(r.Context(), slug)
		if err != nil {
			s.log.Warn("edge status: occupancy", "slug", slug, "error", err)
		}
		out.Viewers = n
		if wb.Status == types.StatusLive {
			out.AudienceStream = s.audienceStream(r.Context(), wb)
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* audienceStream asks LiveKit, not this process's memory, whether the webinar's mix is
 * encoding: the instance answering the poll is often not the one that started it. A failed
 * read says "live", so a LiveKit blip never puts a "getting ready" popup over a running show. */
func (s *Server) audienceStream(ctx context.Context, wb types.Webinar) string {
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return types.AudienceStreamLive
	}
	infos, err := sfu.ListEgress(ctx, lk.RoomName(wb.ID))
	if err != nil {
		return types.AudienceStreamLive
	}
	for _, info := range infos {
		if len(info.GetStreamResults()) > 0 && info.GetStatus() == livekit.EgressStatus_EGRESS_ACTIVE {
			return types.AudienceStreamLive
		}
	}
	return types.AudienceStreamPreparing
}

// deliveryCacheMap is the type behind Server.deliveryCache.
type deliveryCacheMap = sync.Map

/* removeEdgeViewer is the host's Remove for someone watching the edge feed: the same records
 * handleRemoveParticipant writes for a LiveKit participant, then a "removed" packet to that
 * viewer alone. Their browser shows the removal and stops; the events handler refuses them
 * from then on (WasRemoved). */
func (s *Server) removeEdgeViewer(ctx context.Context, sfu RoomManager, slug, identity string) {
	if err := s.store.RevokeStage(ctx, slug, identity); err != nil {
		s.log.Warn("edge remove: could not revoke stage grant", "slug", slug, "error", err)
	}
	if err := s.store.RecordRemoval(ctx, slug, identity); err != nil {
		s.log.Warn("edge remove: could not record removal", "slug", slug, "error", err)
	}
	// Their seat is free now, not when their beats stop.
	if err := s.store.CloseEdgeVisit(ctx, slug, identity, time.Now()); err != nil {
		s.log.Warn("edge remove: could not close visit", "slug", slug, "error", err)
	}
	_ = s.sendRoomPacket(ctx, sfu, slug, []string{identity}, map[string]any{
		"kind": "removed", "identity": identity, "at": time.Now().UnixMilli(),
	})
	s.log.Info("edge viewer removed", "slug", slug, "identity", identity)
}

/* mixTemplateURL is the composite page the room's mix egress loads.
 *
 * For an edge webinar with EDGE_DEBUG_CLOCK on, the same page at <template>/clock, which
 * draws a server-synced clock in a corner; read against the edge player's own clock, the
 * difference is the glass-to-glass latency. A path segment rather than a query string because
 * LiveKit appends its own query (?url=…&token=…) to the base URL. */
/* mixTemplateURL is the composite page an egress renders for this webinar.
 *
 * Edge webinars get <template>/edge: the screen share fills the whole frame with the cameras
 * as small tiles over a corner, because the edge mix is the audience's only picture and a
 * share squeezed beside a camera strip lost a third of its pixels (unreadable slides at
 * 720p). Recordings and the CDN broadcast keep the template as it is. /clock adds the
 * latency clock (EDGE_DEBUG_CLOCK). Path segments, because LiveKit appends its own query. */
func (s *Server) mixTemplateURL(wb types.Webinar) string {
	base := s.cfg.RecordingsEgressTemplateURL
	if base == "" || wb.Delivery != types.DeliveryEdge {
		return base
	}
	u := strings.TrimRight(base, "/") + "/edge"
	if s.cfg.EdgeDebugClock {
		u += "/clock"
	}
	return u
}

func (s *Server) handleServerTime(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, types.ServerTime{Now: time.Now().UnixMilli()})
}

// edgeEncoding is the edge mix encoding from config (EDGE_ENCODING_*, validated at load).
func (s *Server) edgeEncoding() lk.BroadcastEncoding {
	enc := lk.BroadcastEncoding{
		Width: s.cfg.EdgeEncodingWidth, Height: s.cfg.EdgeEncodingHeight,
		FPS: s.cfg.EdgeEncodingFPS, BitrateKbps: s.cfg.EdgeVideoBitrateKbps,
		AudioBitrateKbps: s.cfg.EdgeAudioBitrateKbps,
		Profile:          s.cfg.EdgeH264Profile,
	}
	// A config built by hand (tests, tools) rather than by Load gets today's encoding.
	if enc.Width == 0 || enc.Height == 0 {
		enc.Width, enc.Height = 1280, 720
	}
	if enc.FPS == 0 {
		enc.FPS = 30
	}
	if enc.BitrateKbps == 0 {
		enc.BitrateKbps = 1700
	}
	if enc.Profile == "" {
		enc.Profile = "baseline"
	}
	return enc
}

/* sseFrame renders one Server-Sent Events message. The stream is text/event-stream, never
 * HTML, so the risk is not script injection but framing: a CR or LF inside the event name
 * or the payload would end the field early and let the rest be read as a new field (a
 * forged "event:" or "id:"). The name loses any line breaks, and each line of the payload
 * becomes its own "data:" field, which is how the SSE format carries multi-line data. */
func sseFrame(id int64, kind string, data []byte) string {
	var b strings.Builder
	b.WriteString("id: ")
	b.WriteString(strconv.FormatInt(id, 10))
	b.WriteString("\nevent: ")
	b.WriteString(strings.NewReplacer("\r", "", "\n", "").Replace(kind))
	b.WriteByte('\n')
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\n"), "\r", "\n"), "\n")
	for _, line := range lines {
		b.WriteString("data: ")
		b.WriteString(line)
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	return b.String()
}
