package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/push"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Web Push.
 *
 * A browser subscribes from the confirmation page after registering ("tell me when it
 * starts", scoped to that registration by its join key) or from Settings → Notifications
 * (bound to the signed-in account). Things that happen — a host going live, a knock at a
 * meeting's door, a recap being ready — write rows into push_messages, in the same places
 * the email outbox is written; the tick's realtime lane sends what is due (flushPush), and
 * the code that wrote "starting now" also kicks a flush so it does not wait for the next
 * minute.
 *
 * Off entirely without VAPID keys (config.Push): s.push is nil, the public key says
 * enabled:false, subscribe answers 404, and nothing is ever queued.
 */

// pushKindsOrder is the Settings page's list, attendee kinds first.
var pushKindsOrder = []struct {
	kind  types.PushKind
	host  bool
	admin bool // listed for admins only
}{
	{types.PushWebinarLive, false, false},
	{types.PushWebinarReminder, false, false},
	{types.PushReplayReady, false, false},
	{types.PushMeetingStarted, false, false},
	{types.PushLobbyKnock, true, false},
	{types.PushApprovalRequested, true, false},
	{types.PushRecapReady, true, false},
	{types.PushRecordingExpiring, true, false},
	{types.PushOpsAlert, true, true},
}

const (
	// pushReminderLead is when the "starts soon" push goes: fifteen minutes before.
	pushReminderLead = 15 * time.Minute
	// pushFlushBudget is the realtime lane's slice for sending pushes.
	pushFlushBudget = 20 * time.Second
	// pushBatch is how many messages one claim takes; pushWorkers how many endpoints are
	// posted to at once.
	pushBatch   = 200
	pushWorkers = 8
	// pushRetention is how long a finished message row is kept (it is the dedupe record).
	pushRetention      = 30 * 24 * time.Hour
	pushRetentionEvery = 24 * time.Hour
	pushIcon           = "/icons/icon-192.png"
	pushBadge          = "/icons/badge-96.png"
)

func newPushSender(s *Server) {
	cfg := s.cfg.Push()
	if !cfg.Enabled() {
		return
	}
	s.push = push.NewSender(cfg, nil)
	s.pushEndpointOK = push.ValidEndpoint
	s.log.Info("web push enabled")
}

func (s *Server) mountPush(r chi.Router) {
	subscribeLimit := httpx.NewRateLimiter(30, time.Minute)
	testLimit := httpx.NewRateLimiter(5, time.Minute)
	r.Get("/push/public-key", s.handlePushPublicKey)
	r.With(subscribeLimit.Middleware).Post("/push/subscribe", s.handlePushSubscribe)
	r.With(subscribeLimit.Middleware).Delete("/push/subscribe", s.handlePushUnsubscribe)
	r.With(s.requireUser).Get("/push/preferences", s.handlePushPreferences)
	r.With(s.requireUser).Put("/push/preferences", s.handleSetPushPreferences)
	r.With(s.requireUser, testLimit.Middleware).Post("/push/test", s.handlePushTest)
}

// handlePushPublicKey is GET /api/push/public-key.
func (s *Server) handlePushPublicKey(w http.ResponseWriter, r *http.Request) {
	out := types.PushPublicKeyResponse{}
	if s.push != nil {
		out = types.PushPublicKeyResponse{Enabled: true, PublicKey: s.push.PublicKey()}
	}
	httpx.JSON(w, http.StatusOK, out)
}

func (s *Server) pushOff(w http.ResponseWriter) bool {
	if s.push == nil {
		httpx.Error(w, http.StatusNotFound, "push_off", "Notifications are not set up on this server.")
		return true
	}
	return false
}

// handlePushSubscribe is POST /api/push/subscribe.
func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	if s.pushOff(w) {
		return
	}
	var req types.PushSubscribeRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	req.Endpoint = strings.TrimSpace(req.Endpoint)
	if err := s.pushEndpointOK(req.Endpoint); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_endpoint", "That browser's push service isn't supported.")
		return
	}
	if err := push.ValidKeys(req.Keys.P256dh, req.Keys.Auth); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_keys", "That subscription's keys are not valid.")
		return
	}
	if old := strings.TrimSpace(req.OldEndpoint); old != "" && old != req.Endpoint {
		renewed, err := s.store.RenewPushSubscription(r.Context(), old, req.Endpoint, req.Keys.P256dh, req.Keys.Auth)
		if err != nil {
			s.fail(w, r, "push renew", err)
			return
		}
		if renewed {
			httpx.JSON(w, http.StatusOK, types.PushSubscribeResponse{Scope: "renewed"})
			return
		}
	}
	sub := store.PushSubscription{
		Endpoint: req.Endpoint, P256dh: req.Keys.P256dh, Auth: req.Keys.Auth,
		UserAgent: strings.ToValidUTF8(req.UA, ""),
	}
	scope := ""
	if user, ok := s.optionalUser(r); ok {
		sub.UserID = user.ID
		scope = "account"
	}
	if key := strings.ToUpper(strings.TrimSpace(req.JoinKey)); key != "" {
		reg, err := s.store.ByJoinKey(r.Context(), key)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That join key doesn't match a registration.")
			return
		}
		if err != nil {
			s.fail(w, r, "push subscribe: join key", err)
			return
		}
		sub.RegistrationID = reg.ID
		if scope == "" {
			scope = "registration"
		}
	}
	if scope == "" {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Sign in, or subscribe from your registration.")
		return
	}
	if err := s.store.SavePushSubscription(r.Context(), sub); err != nil {
		s.fail(w, r, "push subscribe", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.PushSubscribeResponse{Scope: scope})
}

// handlePushUnsubscribe is DELETE /api/push/subscribe.
func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if s.pushOff(w) {
		return
	}
	var req types.PushUnsubscribeRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil || strings.TrimSpace(req.Endpoint) == "" {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	var userID, regID string
	if user, ok := s.optionalUser(r); ok {
		userID = user.ID
	}
	if key := strings.ToUpper(strings.TrimSpace(req.JoinKey)); key != "" {
		reg, err := s.store.ByJoinKey(r.Context(), key)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, r, "push unsubscribe: join key", err)
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not_found", "That join key doesn't match a registration.")
			return
		}
		regID = reg.ID
	}
	err := s.store.RemovePushSubscription(r.Context(), strings.TrimSpace(req.Endpoint), userID, regID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "push unsubscribe", err)
		return
	}
	// Not found is a success: the browser is not subscribed, which is what was asked.
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// handlePushPreferences is GET /api/push/preferences.
func (s *Server) handlePushPreferences(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	prefs, err := s.store.PushPreferences(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "push preferences", err)
		return
	}
	devices, err := s.store.PushDeviceCount(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "push preferences: devices", err)
		return
	}
	out := types.PushPreferencesResponse{Enabled: s.push != nil, Devices: devices}
	for _, k := range pushKindsOrder {
		if k.admin && !user.IsAdmin {
			continue
		}
		on, set := prefs[k.kind]
		out.Preferences = append(out.Preferences, types.PushPreference{Kind: k.kind, Enabled: !set || on, Host: k.host})
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleSetPushPreferences is PUT /api/push/preferences.
func (s *Server) handleSetPushPreferences(w http.ResponseWriter, r *http.Request) {
	var req types.PushPreferencesUpdate
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	known := map[types.PushKind]bool{}
	for _, k := range pushKindsOrder {
		known[k.kind] = true
	}
	set := map[types.PushKind]bool{}
	for _, p := range req.Preferences {
		if !known[p.Kind] {
			httpx.Fields(w, map[string]string{"preferences": "Unknown notification type: " + string(p.Kind)})
			return
		}
		set[p.Kind] = p.Enabled
	}
	if err := s.store.SetPushPreferences(r.Context(), userFromContext(r.Context()).ID, set); err != nil {
		s.fail(w, r, "set push preferences", err)
		return
	}
	s.handlePushPreferences(w, r)
}

// handlePushTest is POST /api/push/test: one notification to every browser of this account.
func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	if s.pushOff(w) {
		return
	}
	user := userFromContext(r.Context())
	n, err := s.store.QueuePushToUsers(r.Context(), []string{user.ID}, store.PushMessage{
		Kind: types.PushTest, Title: s.cfg.AppName + " notifications are on",
		Body: "This is a test. You'll be told here when a webinar starts.",
		URL:  "/settings#notifications", Tag: "test", TTL: 10 * time.Minute, Urgency: "high",
	})
	if err != nil {
		s.fail(w, r, "push test", err)
		return
	}
	if n == 0 {
		httpx.Error(w, http.StatusConflict, "no_devices", "Turn on notifications on this device first.")
		return
	}
	s.flushPushSoon()
	httpx.JSON(w, http.StatusOK, types.PushTestResponse{Queued: n})
}

// ------------------------------------------------------------------ queueing

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

func pushTopic(wb types.Webinar) string {
	t := strings.TrimSpace(wb.Topic)
	if t == "" {
		if isMeeting(wb) {
			return "Your meeting"
		}
		return "Your webinar"
	}
	return clip(t, 80)
}

// registrantJoinURL is a registrant's personal join link, as a path; {joinKey} is filled in
// per registrant by the fan-out.
func registrantJoinURL(slug string) string {
	return "/webinars/" + url.PathEscape(slug) + "/room?k={joinKey}"
}

/* pushWentLive tells a webinar's (or meeting's) registrants it has started. Called by each of
 * the three ways a session goes live — Go live, a simulive's start time, a simulive's Start
 * now — after the change committed. Deduplicated on the scheduled start, so a host who drops
 * and presses Go live again does not ring everybody's phone twice. */
func (s *Server) pushWentLive(ctx context.Context, wb types.Webinar) {
	if s.push == nil {
		return
	}
	m := store.PushMessage{
		Kind:  types.PushWebinarLive,
		Title: pushTopic(wb) + " is starting now",
		Body:  "Tap to join.",
		URL:   registrantJoinURL(wb.ID), Tag: "webinar-" + wb.ID,
		Urgency: "high", TTL: 30 * time.Minute,
		DedupeKey: "live:" + wb.ID + ":" + wb.StartsAt,
	}
	if isMeeting(wb) {
		m.Kind = types.PushMeetingStarted
		m.Title = "Meeting started: " + pushTopic(wb)
		m.Body = "Tap to join."
	}
	n, err := s.store.QueuePushToRegistrants(ctx, wb.ID, nil, m)
	if err != nil {
		s.log.Error("push: queue went-live", "slug", wb.ID, "error", err)
		return
	}
	if n > 0 {
		s.log.Info("push: went-live queued", "slug", wb.ID, "browsers", n)
		s.flushPushSoon()
	}
}

// sweepPushReminders queues the 15-minute "starts soon" push for every webinar entering the
// window. Idempotent: each browser holds one reminder per scheduled start.
func (s *Server) sweepPushReminders(ctx context.Context) {
	if s.push == nil {
		return
	}
	due, err := s.store.DuePushReminders(ctx, pushReminderLead)
	if err != nil {
		s.log.Error("push reminders: query", "error", err)
		return
	}
	for _, d := range due {
		if ctx.Err() != nil {
			return
		}
		mins := int(time.Until(d.StartsAt).Round(time.Minute) / time.Minute)
		if mins < 1 {
			mins = 1
		}
		wb := types.Webinar{ID: d.Slug, Topic: d.Topic, Kind: d.Kind}
		what := "starts"
		if isMeeting(wb) {
			what = "meeting starts"
		}
		title := fmt.Sprintf("%s %s in %d min", pushTopic(wb), what, mins)
		if isMeeting(wb) {
			title = fmt.Sprintf("%s: %s in %d min", pushTopic(wb), what, mins)
		}
		_, err := s.store.QueuePushToRegistrants(ctx, d.Slug, nil, store.PushMessage{
			Kind: types.PushWebinarReminder, Title: title,
			Body: "Your join link is ready. Tap to open it.",
			URL:  registrantJoinURL(d.Slug), Tag: "webinar-" + d.Slug,
			Urgency: "normal", TTL: time.Until(d.StartsAt),
			DedupeKey: "soon:" + d.Slug + ":" + d.StartsAt.UTC().Format(time.RFC3339),
		})
		if err != nil {
			s.log.Error("push reminders: queue", "slug", d.Slug, "error", err)
		}
	}
}

// pushReplayReady tells the registrants a replay goes to that it is up, when the email is due.
func (s *Server) pushReplayReady(ctx context.Context, wb types.Webinar, recordingID string, regIDs []string, due time.Time) {
	if s.push == nil || len(regIDs) == 0 {
		return
	}
	n, err := s.store.QueuePushToRegistrants(ctx, wb.ID, regIDs, store.PushMessage{
		Kind: types.PushReplayReady, Title: "Recording available: " + pushTopic(wb),
		Body: "Watch the replay.",
		URL:  "/w/" + url.PathEscape(wb.ID) + "/recording/" + url.PathEscape(recordingID),
		Tag:  "replay-" + wb.ID, TTL: 3 * 24 * time.Hour, DueAt: due,
		DedupeKey: "replay:" + recordingID,
	})
	if err != nil {
		s.log.Error("push: queue replay", "slug", wb.ID, "error", err)
		return
	}
	if n > 0 && due.IsZero() {
		s.flushPushSoon()
	}
}

// pushToHost queues one host-side notification to these accounts and flushes soon.
func (s *Server) pushToHost(ctx context.Context, userIDs []string, m store.PushMessage) {
	if s.push == nil || len(userIDs) == 0 {
		return
	}
	n, err := s.store.QueuePushToUsers(ctx, userIDs, m)
	if err != nil {
		s.log.Error("push: queue host", "kind", m.Kind, "error", err)
		return
	}
	if n > 0 {
		s.flushPushSoon()
	}
}

// pushApprovalRequested tells the host a registration is waiting for approval.
func (s *Server) pushApprovalRequested(ctx context.Context, wb types.Webinar, hostID string, reg types.Registration, waiting int) {
	title := "New registration to approve"
	if waiting > 1 {
		title = fmt.Sprintf("%d registrations to approve", waiting)
	}
	who := strings.TrimSpace(reg.FirstName + " " + reg.LastName)
	if who == "" {
		who = "Someone"
	}
	s.pushToHost(ctx, []string{hostID}, store.PushMessage{
		Kind: types.PushApprovalRequested, Title: title,
		Body: clip(who, 60) + " registered for " + pushTopic(wb) + ".",
		URL:  "/host/" + url.PathEscape(wb.ID) + "?tab=people", Tag: "approvals-" + wb.ID,
		TTL: 24 * time.Hour,
	})
}

// pushRecapReady tells the host a session's AI recap is ready.
func (s *Server) pushRecapReady(ctx context.Context, wb types.Webinar, hostID string) {
	s.pushToHost(ctx, []string{hostID}, store.PushMessage{
		Kind: types.PushRecapReady, Title: "Your recap is ready",
		Body: pushTopic(wb) + " — summary, highlights and follow-ups.",
		URL:  "/host/" + url.PathEscape(wb.ID) + "?tab=ai", Tag: "recap-" + wb.ID,
		TTL: 3 * 24 * time.Hour, DedupeKey: "recap:" + wb.ID,
	})
}

// pushRecordingExpiring is the push beside the 7-day and 1-day expiry email.
func (s *Server) pushRecordingExpiring(ctx context.Context, batch []store.ExpiringRecording, subject string) {
	if len(batch) == 0 {
		return
	}
	target := "/recordings"
	if len(batch) == 1 || allSameWebinar(batch) {
		target = "/host/" + url.PathEscape(batch[0].Webinar) + "?tab=recording"
	}
	body := "Keep them longer before they're deleted."
	if len(batch) == 1 {
		body = clip(strings.TrimSpace(batch[0].Topic), 80) + " — keep it longer before it's deleted."
	}
	s.pushToHost(ctx, []string{batch[0].HostID}, store.PushMessage{
		Kind: types.PushRecordingExpiring, Title: clip(subject, 120), Body: body,
		URL: target, Tag: "recording-expiry", TTL: 24 * time.Hour,
	})
}

func allSameWebinar(batch []store.ExpiringRecording) bool {
	for _, e := range batch {
		if e.Webinar != batch[0].Webinar {
			return false
		}
	}
	return true
}

/* pushLobbyKnock tells the host and co-hosts somebody is at a meeting's door — only when the
 * host is not in the room (when they are, the lobby panel already says so). At most one per
 * meeting per minute: ten people arriving together is one buzz, and the tag folds them. */
func (s *Server) pushLobbyKnock(ctx context.Context, wb types.Webinar, name string) {
	if s.push == nil {
		return
	}
	if wb.SFUProject != "" {
		if sfu, err := s.sfuFor(ctx, wb); err == nil {
			if parts, err := sfu.Participants(ctx, lk.RoomName(wb.ID)); err == nil {
				for _, p := range parts {
					if p.Identity == hostIdentity(wb.Host.ID) {
						return
					}
				}
			}
		}
	}
	ids, err := s.store.LobbyNotifyUserIDs(ctx, wb.ID)
	if err != nil {
		s.log.Warn("push: lobby recipients", "slug", wb.ID, "error", err)
		return
	}
	s.pushToHost(ctx, ids, store.PushMessage{
		Kind: types.PushLobbyKnock, Title: clip(name, 60) + " is waiting to join",
		Body: pushTopic(wb) + " — tap to let them in.",
		URL:  "/host/" + url.PathEscape(wb.ID) + "/room", Tag: "lobby-" + wb.ID,
		Urgency: "high", TTL: 5 * time.Minute,
		DedupeKey: "lobby:" + wb.ID + ":" + strconv.FormatInt(time.Now().Unix()/60, 10),
	})
}

// ------------------------------------------------------------------ sending

// flushPushSoon sends what is due after the response, so "starting now" does not wait for
// the next tick.
func (s *Server) flushPushSoon() {
	if s.push == nil {
		return
	}
	s.inBackground(func(ctx context.Context) {
		ctx, cancel := context.WithTimeout(ctx, pushFlushBudget)
		defer cancel()
		s.flushPush(ctx)
	})
}

/* flushPush sends due messages until there are none or ctx runs out.
 *
 * Each claimed batch is grouped by endpoint. Endpoints are posted to in parallel (pushWorkers
 * at a time); one endpoint's messages go in order, and the first transient failure stops the
 * rest of its group — they are released for the next pass, which the backoff then delays. */
func (s *Server) flushPush(ctx context.Context) {
	if s.push == nil {
		return
	}
	for ctx.Err() == nil {
		claimed, err := s.store.ClaimDuePush(ctx, pushBatch)
		if err != nil {
			if ctx.Err() == nil {
				s.log.Error("push: claim", "error", err)
			}
			return
		}
		if len(claimed) == 0 {
			return
		}
		groups := map[string][]store.ClaimedPush{}
		var order []string
		for _, c := range claimed {
			if _, ok := groups[c.SubscriptionID]; !ok {
				order = append(order, c.SubscriptionID)
			}
			groups[c.SubscriptionID] = append(groups[c.SubscriptionID], c)
		}
		sem := make(chan struct{}, pushWorkers)
		var wg sync.WaitGroup
		for _, id := range order {
			group := groups[id]
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				s.sendPushGroup(ctx, group)
			}()
		}
		wg.Wait()
		if len(claimed) < pushBatch {
			return
		}
	}
}

func (s *Server) sendPushGroup(ctx context.Context, group []store.ClaimedPush) {
	// A store write must land even when the flush budget ran out mid-send, or a delivered
	// message would be sent again once its claim lapsed.
	wctx := context.WithoutCancel(ctx)
	for i, c := range group {
		payload, _ := json.Marshal(types.PushPayload{
			Kind: c.Kind, Title: clip(c.Title, 120), Body: clip(c.Body, 300), URL: c.URL,
			Tag: c.Tag, Renotify: c.Tag != "", Icon: pushIcon, Badge: pushBadge,
		})
		res := s.push.Send(ctx, push.Target{Endpoint: c.Endpoint, P256dh: c.P256dh, Auth: c.Auth},
			push.Message{Payload: payload, TTL: c.TTL, Urgency: c.Urgency})
		switch res.Outcome {
		case push.Sent:
			if err := s.store.PushSent(wctx, c.ID, c.SubscriptionID); err != nil {
				s.log.Error("push: record sent", "error", err)
			}
		case push.Gone:
			s.log.Info("push: subscription gone, removing", "status", res.Status)
			if err := s.store.PushGone(wctx, c.SubscriptionID); err != nil {
				s.log.Error("push: remove gone", "error", err)
			}
			return
		case push.Drop:
			s.log.Warn("push: message refused", "kind", c.Kind, "error", res.Err)
			if err := s.store.PushDropped(wctx, c.ID, errText(res.Err)); err != nil {
				s.log.Error("push: record dropped", "error", err)
			}
		case push.Retry:
			failures, _ := s.store.PushFailures(wctx, c.SubscriptionID)
			rest := push.Backoff(failures+1, res.RetryAfter)
			s.log.Warn("push: send failed, backing off", "kind", c.Kind, "rest", rest, "error", res.Err)
			if err := s.store.PushRetry(wctx, c.ID, c.SubscriptionID, errText(res.Err), rest); err != nil {
				s.log.Error("push: record retry", "error", err)
			}
			// The rest of this endpoint's messages wait out the same backoff.
			for _, later := range group[i+1:] {
				if err := s.store.PushRelease(wctx, later.ID); err != nil {
					s.log.Error("push: release", "error", err)
				}
			}
			return
		}
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (s *Server) sweepPushMessages(ctx context.Context) {
	n, err := s.store.PrunePushMessages(ctx, time.Now().Add(-pushRetention), 5000)
	if err != nil {
		s.log.Error("push retention: prune failed", "error", err)
		return
	}
	if n > 0 {
		s.log.Info("push retention: deleted finished messages", "rows", n)
	}
}
