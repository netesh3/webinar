package api_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Edge delivery (docs/edge-delivery.md): the audience watches LL-HLS and reads session events
 * from an SSE stream instead of LiveKit. These tests pin the contract that matters for running
 * it beside the existing modes: it is off unless switched on, a standard webinar is untouched,
 * an edge viewer never gets a LiveKit token, and everything the room says still reaches them —
 * through Postgres LISTEN/NOTIFY, the same path production uses across instances. */

func edgeConfig(c *config.Config) {
	c.BroadcastRTMPBase = "rtmp://origin.test/live"
	c.BroadcastHLSBase = "https://live.test/live"
}

// edgeHost signs up a host with the edge switch on and returns their account.
func edgeHost(t *testing.T, h *harness, email string) types.Account {
	t.Helper()
	acct := h.signup("Edge Host", email, true)
	grantFeature(t, h, acct.ID, types.FeatureEdgeDelivery)
	return acct
}

func edgeWebinar(h *harness, topic string) types.Webinar {
	return h.liveWebinar(topic, func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })
}

// joinAsGuestKey joins with a join key and no session, as an attendee's browser does.
func (h *harness) joinAsGuestKey(slug, joinKey string) (*http.Response, types.JoinResponse, []byte) {
	h.t.Helper()
	body, _ := json.Marshal(types.JoinRequest{JoinKey: joinKey})
	res, err := (&http.Client{}).Post(h.srv.URL+"/api/webinars/"+slug+"/join", "application/json", bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out types.JoinResponse
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res, out, raw
}

type sseEvent struct {
	kind string
	data string
}

// openEvents connects to the event stream and returns a channel of parsed events.
func (h *harness) openEvents(slug, token string) (<-chan sseEvent, *http.Response, func()) {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.srv.URL+"/api/webinars/"+slug+"/events?t="+token, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		h.t.Fatal(err)
	}
	out := make(chan sseEvent, 64)
	if res.StatusCode != http.StatusOK {
		close(out)
		return out, res, cancel
	}
	go func() {
		defer close(out)
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		var ev sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				ev.kind = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data = strings.TrimPrefix(line, "data: ")
			case line == "" && ev.kind != "":
				out <- ev
				ev = sseEvent{}
			}
		}
	}()
	return out, res, cancel
}

// waitFor reads events until one matches, or fails after the timeout.
func waitFor(t *testing.T, ch <-chan sseEvent, timeout time.Duration, match func(sseEvent) bool) sseEvent {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("event stream closed before the expected event")
			}
			if match(ev) {
				return ev
			}
		case <-deadline:
			t.Fatal("timed out waiting for an event")
		}
	}
}

// noEvent asserts nothing matching arrives within d.
func noEvent(t *testing.T, ch <-chan sseEvent, d time.Duration, match func(sseEvent) bool) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if match(ev) {
				t.Fatalf("unexpected event %s %s", ev.kind, ev.data)
			}
		case <-deadline:
			return
		}
	}
}

/* syncStream waits until the instance's LISTEN connection is up, by nudging the room's
 * metadata until a meta event comes back through Postgres. The listener opens lazily on
 * the first subscriber, so an event published in the first instant could otherwise be lost
 * — harmless in production (the browser refetches backlogs on connect), a flake in a test. */
func syncStream(t *testing.T, h *harness, slug string, ch <-chan sseEvent) {
	t.Helper()
	for i := 0; i < 50; i++ {
		on := i%2 == 0
		if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+slug+"/controls",
			types.ControlsPatch{ReactionsEnabled: &on}); res.StatusCode != http.StatusOK {
			t.Fatalf("controls: %d %s", res.StatusCode, raw)
		}
		select {
		case ev := <-ch:
			if ev.kind == "meta" {
				return
			}
		case <-time.After(200 * time.Millisecond):
		}
	}
	t.Fatal("event stream never received a live metadata event")
}

func TestEdgeDeliveryIsOffWithoutTheSwitch(t *testing.T) {
	h := newHarness(t, edgeConfig)
	h.signup("Plain Host", "edge-plain@test.dev", true)

	res, raw := h.do(http.MethodPost, "/api/host/webinars", edgeInput("Edge without switch"))
	if res.StatusCode == http.StatusCreated || res.StatusCode == http.StatusOK {
		t.Fatalf("edge saved without the switch: %d %s", res.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "delivery") {
		t.Fatalf("expected a delivery field error, got %s", raw)
	}

	// The default, and an explicit standard, still work and save standard.
	wb := h.newWebinar("Plain", nil)
	if wb.Delivery != types.DeliveryStandard {
		t.Fatalf("default delivery = %q, want standard", wb.Delivery)
	}
}

func setAttendeeLimit(t *testing.T, slug string, n int) {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `UPDATE webinars SET attendee_limit = $2 WHERE slug = $1`, slug, n); err != nil {
		t.Fatal(err)
	}
}

func edgeInput(topic string) types.WebinarInput {
	return types.WebinarInput{
		Topic: topic, StartsAt: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		Duration: 60, TimeZone: "UTC", Kind: types.KindLive, Status: types.StatusScheduled,
		RegistrationRequired: true, Approval: types.ApprovalAutomatic, AttendeeLimit: 50,
		Delivery: types.DeliveryEdge,
	}
}

func TestEdgeJoinGivesPlaybackNotALiveKitToken(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-join@test.dev")
	wb := edgeWebinar(h, "Edge join")
	if wb.Delivery != types.DeliveryEdge {
		t.Fatalf("delivery = %q, want edge", wb.Delivery)
	}
	reg := h.registerAsGuest(wb.ID, "edge-join-guest@test.dev")

	res, join, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if join.Token != "" || join.URL != "" {
		t.Fatalf("edge viewer got LiveKit credentials: token=%q url=%q", join.Token, join.URL)
	}
	if join.Delivery != types.DeliveryEdge || join.EventsToken == "" {
		t.Fatalf("join = %+v, want edge delivery with an events token", join)
	}
	if want := "https://live.test/live/" + wb.ID + "/index.m3u8"; join.PlaybackURL != want {
		t.Fatalf("playback = %q, want %q", join.PlaybackURL, want)
	}

	// The broadcast starts for an edge webinar even though this host is not on CDN broadcast.
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.rooms.mu.Lock()
		calls := strings.Join(h.rooms.egressCalls, "|")
		h.rooms.mu.Unlock()
		if strings.Contains(calls, "rtmp://origin.test/live/"+wb.ID) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no broadcast egress to the origin; calls %q", calls)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// A standard webinar of the same host is exactly as before.
	plain := h.liveWebinar("Edge host, standard webinar", nil)
	preg := h.registerAsGuest(plain.ID, "edge-join-plain@test.dev")
	res, pjoin, raw := h.joinAsGuestKey(plain.ID, preg.JoinKey)
	if res.StatusCode != http.StatusOK || pjoin.Token == "" || pjoin.Delivery != "" || pjoin.EventsToken != "" {
		t.Fatalf("standard join changed: %d %+v %s", res.StatusCode, pjoin, raw)
	}
}

func TestEdgePlaybackBaseOverridesTheOrigin(t *testing.T) {
	h := newHarness(t, edgeConfig, func(c *config.Config) { c.EdgePlaybackBase = "https://webinarliv.b-cdn.net/live" })
	edgeHost(t, h, "edge-cdn@test.dev")
	wb := edgeWebinar(h, "Edge CDN")
	reg := h.registerAsGuest(wb.ID, "edge-cdn-guest@test.dev")
	_, join, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey)
	if want := "https://webinarliv.b-cdn.net/live/" + wb.ID + "/index.m3u8"; join.PlaybackURL != want {
		t.Fatalf("playback = %q, want %q (%s)", join.PlaybackURL, want, raw)
	}
}

func TestEdgeEventsCarryChatAndTargetedInvites(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-events@test.dev")
	wb := edgeWebinar(h, "Edge events")
	alice := h.registerAsGuest(wb.ID, "edge-alice@test.dev")
	bob := h.registerAsGuest(wb.ID, "edge-bob@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	_, bj, _ := h.joinAsGuestKey(wb.ID, bob.JoinKey)

	// A token for one webinar does not open another's stream, and garbage is refused.
	if _, res, cancel := h.openEvents(wb.ID, "not-a-token"); res.StatusCode != http.StatusUnauthorized {
		cancel()
		t.Fatalf("bad token: %d, want 401", res.StatusCode)
	} else {
		cancel()
	}

	aEv, res, aCancel := h.openEvents(wb.ID, aj.EventsToken)
	defer aCancel()
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("events: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	waitFor(t, aEv, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" }) // the opening state
	bEv, _, bCancel := h.openEvents(wb.ID, bj.EventsToken)
	defer bCancel()
	waitFor(t, bEv, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
	syncStream(t, h, wb.ID, aEv)

	// Host chat to everyone reaches both viewers, as the same packet the stage receives.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgChat, ID: "edge-chat-1", Text: "hello edge",
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("host chat: %d %s", res.StatusCode, raw)
	}
	isChat := func(e sseEvent) bool { return e.kind == "packet" && strings.Contains(e.data, "hello edge") }
	waitFor(t, aEv, 3*time.Second, isChat)
	waitFor(t, bEv, 3*time.Second, isChat)

	// A stage invite is for Alice alone.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("invite: %d %s", res.StatusCode, raw)
	}
	isInvite := func(e sseEvent) bool { return e.kind == "packet" && strings.Contains(e.data, `"stage-invite"`) }
	waitFor(t, aEv, 3*time.Second, isInvite)
	noEvent(t, bEv, 500*time.Millisecond, isInvite)
}

func TestEdgePromotionAndDemotionSwitchTheJoin(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-stage@test.dev")
	h.rooms.mu.Lock()
	h.rooms.strictRoster = true
	h.rooms.mu.Unlock()
	wb := edgeWebinar(h, "Edge stage")
	alice := h.registerAsGuest(wb.ID, "edge-stage-alice@test.dev")
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("invite: %d %s", res.StatusCode, raw)
	}
	// Alice is not in the LiveKit room (she is on the feed), so the grant alone is the promotion.
	h.acceptStage(wb.ID, alice.JoinKey)
	res, staged, raw := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	if res.StatusCode != http.StatusOK || staged.Token == "" || staged.Role != types.RolePanelist || staged.Delivery != "" {
		t.Fatalf("promoted join: %d %+v %s", res.StatusCode, staged, raw)
	}

	// Demoted while back on the feed (not in the room): the grant clears and the next join is edge again.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity+"/stage",
		types.StageRequest{Role: types.RoleAttendee}); res.StatusCode != http.StatusOK {
		t.Fatalf("demote: %d %s", res.StatusCode, raw)
	}
	_, back, raw := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	if back.Delivery != types.DeliveryEdge || back.Token != "" {
		t.Fatalf("demoted join = %+v %s, want edge", back, raw)
	}
}

func TestEdgeOccupancyAndRemoval(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-full@test.dev")
	h.rooms.mu.Lock()
	h.rooms.strictRoster = true
	h.rooms.mu.Unlock()
	wb := h.liveWebinar("Edge full", func(in *types.WebinarInput) {
		in.Delivery = types.DeliveryEdge
		in.AttendeeLimit = 3
	})
	alice := h.registerAsGuest(wb.ID, "edge-full-alice@test.dev")
	carol := h.registerAsGuest(wb.ID, "edge-full-carol@test.dev")
	bob := h.registerAsGuest(wb.ID, "edge-full-bob@test.dev")
	// Two seats for three registrants: registrations usually outnumber who shows up.
	setAttendeeLimit(t, wb.ID, 2)
	_, aj, _ := h.joinAsGuestKey(wb.ID, alice.JoinKey)
	_, cj, _ := h.joinAsGuestKey(wb.ID, carol.JoinKey)
	aEv, _, cancel := h.openEvents(wb.ID, aj.EventsToken)
	waitFor(t, aEv, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
	cEv, _, cCancel := h.openEvents(wb.ID, cj.EventsToken)
	defer cCancel()
	waitFor(t, cEv, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })

	// Two open streams fill the two seats; the video server's own count (0) is not consulted.
	if res, _, raw := h.joinAsGuestKey(wb.ID, bob.JoinKey); res.StatusCode != http.StatusConflict {
		t.Fatalf("second viewer over the limit: %d %s, want 409", res.StatusCode, raw)
	}

	// The host badge sees her.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/edge", nil)
	var status types.EdgeStatus
	h.decode(raw, &status)
	if res.StatusCode != http.StatusOK || status.Delivery != types.DeliveryEdge || status.Viewers != 2 {
		t.Fatalf("edge status: %d %+v", res.StatusCode, status)
	}

	// Removing her, though she is not in the LiveKit room, records it and her stream is refused after.
	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("remove: %d %s", res.StatusCode, raw)
	}
	cancel()
	time.Sleep(200 * time.Millisecond)
	if _, res, c := h.openEvents(wb.ID, aj.EventsToken); res.StatusCode != http.StatusForbidden {
		c()
		t.Fatalf("removed viewer's stream: %d, want 403", res.StatusCode)
	} else {
		c()
	}
	// Her seat is free again.
	if res, _, raw := h.joinAsGuestKey(wb.ID, bob.JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("bob after alice left: %d %s", res.StatusCode, raw)
	}
}
