package api_test

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/push"
	"github.com/netkumar/webcast/api/types"
)

// fakePushService stands in for FCM / Mozilla / Apple: it counts what each endpoint was sent
// and answers with whatever status the test set for it (201 by default).
type fakePushService struct {
	srv    *httptest.Server
	mu     sync.Mutex
	hits   map[string]int
	status map[string]int
	header map[string]http.Header
}

func newFakePushService(t *testing.T) *fakePushService {
	t.Helper()
	f := &fakePushService{hits: map[string]int{}, status: map[string]int{}, header: map[string]http.Header{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.hits[r.URL.Path]++
		f.header[r.URL.Path] = r.Header.Clone()
		code := f.status[r.URL.Path]
		if code == 0 {
			code = http.StatusCreated
		}
		w.WriteHeader(code)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakePushService) count(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits["/ep/"+name]
}

func (f *fakePushService) set(name string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status["/ep/"+name] = code
}

// browser is a subscription a real browser would hand the page: an endpoint on the fake
// service and a fresh P-256 key and auth secret.
func (f *fakePushService) browser(t *testing.T, name, joinKey string) types.PushSubscribeRequest {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	return types.PushSubscribeRequest{
		Endpoint: f.srv.URL + "/ep/" + name,
		Keys: types.PushKeys{
			P256dh: base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()),
			Auth:   base64.RawURLEncoding.EncodeToString(auth),
		},
		UA: "test", JoinKey: joinKey,
	}
}

func newPushHarness(t *testing.T) (*harness, *fakePushService) {
	t.Helper()
	pub, priv, err := push.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(c *config.Config) {
		c.VAPIDPublicKey, c.VAPIDPrivateKey, c.VAPIDSubject = pub, priv, "mailto:ops@example.com"
	})
	api.SetPushEndpointCheck(h.server, func(string) error { return nil })
	return h, newFakePushService(t)
}

func (h *harness) subscribe(req types.PushSubscribeRequest, want int) types.PushSubscribeResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/push/subscribe", req)
	if res.StatusCode != want {
		h.t.Fatalf("subscribe %s: status %d (want %d) body %s", req.Endpoint, res.StatusCode, want, raw)
	}
	var out types.PushSubscribeResponse
	if want == http.StatusOK {
		h.decode(raw, &out)
	}
	return out
}

func (h *harness) flushPush() {
	h.t.Helper()
	h.server.WaitBackground()
	api.FlushPush(h.server, context.Background())
}

func (h *harness) pushCount(sql string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		h.t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func TestPushOffWithoutVAPID(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodGet, "/api/push/public-key", nil)
	var key types.PushPublicKeyResponse
	h.decode(raw, &key)
	if res.StatusCode != http.StatusOK || key.Enabled || key.PublicKey != "" {
		t.Fatalf("public key with push off: %d %+v", res.StatusCode, key)
	}
	f := newFakePushService(t)
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPost, "/api/push/subscribe", f.browser(t, "a", ""))
	wantCode(t, res, raw, http.StatusNotFound, "push_off")
	res, raw = h.do(http.MethodPost, "/api/push/test", nil)
	wantCode(t, res, raw, http.StatusNotFound, "push_off")

	wb := h.newWebinar("Off", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: %d %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()
	if n := h.pushCount(`SELECT count(*) FROM push_messages`); n != 0 {
		t.Fatalf("push off queued %d messages", n)
	}
}

func TestPushSubscribeScoping(t *testing.T) {
	h, f := newPushHarness(t)

	res, raw := h.do(http.MethodGet, "/api/push/public-key", nil)
	var key types.PushPublicKeyResponse
	h.decode(raw, &key)
	if res.StatusCode != http.StatusOK || !key.Enabled || key.PublicKey == "" {
		t.Fatalf("public key: %d %+v", res.StatusCode, key)
	}

	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Scoping", nil)
	h.logout()
	reg := h.registerAs(wb.ID, "guest-scope@example.com")

	// A guest with no join key is nobody.
	h.subscribe(f.browser(t, "g", ""), http.StatusUnauthorized)
	h.subscribe(f.browser(t, "g", "NOPE-NOPE"), http.StatusNotFound)
	bad := f.browser(t, "g", reg.JoinKey)
	bad.Keys.Auth = "short"
	h.subscribe(bad, http.StatusBadRequest)

	guest := f.browser(t, "g", reg.JoinKey)
	if out := h.subscribe(guest, http.StatusOK); out.Scope != "registration" {
		t.Fatalf("guest scope: %+v", out)
	}
	// Subscribing again is the same row.
	h.subscribe(guest, http.StatusOK)
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1 AND user_id IS NULL`, guest.Endpoint); n != 1 {
		t.Fatalf("guest rows: %d", n)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_subscription_registrations l JOIN push_subscriptions s ON s.id = l.subscription_id WHERE s.endpoint = $1`, guest.Endpoint); n != 1 {
		t.Fatalf("guest links: %d", n)
	}

	// Signed in, the browser is the account's.
	acct := h.signup("Pat", "pat-scope@example.com", false)
	mine := f.browser(t, "u", "")
	if out := h.subscribe(mine, http.StatusOK); out.Scope != "account" {
		t.Fatalf("account scope: %+v", out)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, mine.Endpoint, acct.ID); n != 1 {
		t.Fatal("account subscription not owned")
	}
	res, raw = h.do(http.MethodGet, "/api/push/preferences", nil)
	var prefs types.PushPreferencesResponse
	h.decode(raw, &prefs)
	if res.StatusCode != http.StatusOK || prefs.Devices != 1 || !prefs.Enabled {
		t.Fatalf("preferences: %d %+v", res.StatusCode, prefs)
	}

	// A guest cannot remove a browser an account is signed in on.
	h.logout()
	h.do(http.MethodDelete, "/api/push/subscribe", types.PushUnsubscribeRequest{Endpoint: mine.Endpoint})
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1`, mine.Endpoint); n != 1 {
		t.Fatal("a signed-out caller removed an account's browser")
	}
	// The guest's own unsubscribe drops the link, and the browser with it.
	if res, raw := h.do(http.MethodDelete, "/api/push/subscribe",
		types.PushUnsubscribeRequest{Endpoint: guest.Endpoint, JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("guest unsubscribe: %d %s", res.StatusCode, raw)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1`, guest.Endpoint); n != 0 {
		t.Fatal("unowned, unlinked subscription left behind")
	}
	// The account removes its own.
	h.login("pat-scope@example.com")
	h.do(http.MethodDelete, "/api/push/subscribe", types.PushUnsubscribeRequest{Endpoint: mine.Endpoint})
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1`, mine.Endpoint); n != 0 {
		t.Fatal("account unsubscribe left the row")
	}
}

/* "Starting now" goes to the registrants of THAT webinar — on the browsers they opted in from,
 * and on their account's browsers unless the account turned it off — and to nobody else. */
func TestPushStartingNowFanOut(t *testing.T) {
	h, f := newPushHarness(t)
	ctx := context.Background()

	h.login("neeraj@acme.dev")
	a := h.newWebinar("Alpha launch", nil)
	b := h.newWebinar("Beta launch", nil)
	h.logout()

	g1 := h.registerAs(a.ID, "g1@example.com")
	h.subscribe(f.browser(t, "g1", g1.JoinKey), http.StatusOK)
	g2 := h.registerAs(b.ID, "g2@example.com")
	h.subscribe(f.browser(t, "g2", g2.JoinKey), http.StatusOK)

	u3 := h.signup("Ann", "u3@example.com", false)
	r3 := h.registerAs(a.ID, "u3@example.com")
	if _, err := h.store.Pool().Exec(ctx, `UPDATE registrations SET user_id = $1 WHERE join_key = $2`, u3.ID, r3.JoinKey); err != nil {
		t.Fatal(err)
	}
	h.subscribe(f.browser(t, "u3", ""), http.StatusOK)
	h.logout()

	u4 := h.signup("Bo", "u4@example.com", false)
	r4 := h.registerAs(a.ID, "u4@example.com")
	if _, err := h.store.Pool().Exec(ctx, `UPDATE registrations SET user_id = $1 WHERE join_key = $2`, u4.ID, r4.JoinKey); err != nil {
		t.Fatal(err)
	}
	h.subscribe(f.browser(t, "u4", ""), http.StatusOK)
	if res, raw := h.do(http.MethodPut, "/api/push/preferences", types.PushPreferencesUpdate{
		Preferences: []types.PushPreference{{Kind: types.PushWebinarLive, Enabled: false}},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("set preferences: %d %s", res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodPut, "/api/push/preferences", types.PushPreferencesUpdate{
		Preferences: []types.PushPreference{{Kind: "nonsense", Enabled: false}},
	})
	if res.StatusCode == http.StatusOK {
		t.Fatalf("unknown kind accepted: %s", raw)
	}
	h.logout()

	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+a.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: %d %s", res.StatusCode, raw)
	}
	h.flushPush()

	if f.count("g1") != 1 || f.count("u3") != 1 {
		t.Fatalf("registrants of %s not told: g1=%d u3=%d", a.ID, f.count("g1"), f.count("u3"))
	}
	if f.count("g2") != 0 {
		t.Fatal("a registrant of another webinar was told")
	}
	if f.count("u4") != 0 {
		t.Fatal("an account that turned starting-now off was told")
	}
	if hdr := f.header["/ep/g1"]; hdr.Get("Urgency") != "high" || hdr.Get("TTL") == "" || hdr.Get("TTL") == "0" {
		t.Errorf("starting-now headers: urgency %q ttl %q", hdr.Get("Urgency"), hdr.Get("TTL"))
	}
	// The link is the registrant's own.
	var url string
	if err := h.store.Pool().QueryRow(ctx, `
		SELECT m.url FROM push_messages m JOIN push_subscriptions s ON s.id = m.subscription_id
		 WHERE s.endpoint LIKE '%/ep/g1' AND m.kind = 'webinar_live'`).Scan(&url); err != nil {
		t.Fatal(err)
	}
	if url != "/webinars/"+a.ID+"/room?k="+g1.JoinKey {
		t.Fatalf("join link: %q", url)
	}

	// Pressing Go live again (a rejoin) and any second path to "live" tell nobody twice.
	h.do(http.MethodPost, "/api/host/webinars/"+a.ID+"/start", nil)
	h.flushPush()
	if f.count("g1") != 1 {
		t.Fatalf("starting-now sent twice: %d", f.count("g1"))
	}
}

func TestPushReminderSweep(t *testing.T) {
	h, f := newPushHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Soon", nil) // starts in five minutes
	far := h.newWebinar("Later", func(in *types.WebinarInput) {
		in.StartsAt = time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	})
	h.logout()
	r := h.registerAs(wb.ID, "soon@example.com")
	h.subscribe(f.browser(t, "soon", r.JoinKey), http.StatusOK)
	r2 := h.registerAs(far.ID, "later@example.com")
	h.subscribe(f.browser(t, "later", r2.JoinKey), http.StatusOK)

	api.SweepPushReminders(h.server, context.Background())
	api.SweepPushReminders(h.server, context.Background()) // every pass; told once
	h.flushPush()
	if f.count("soon") != 1 {
		t.Fatalf("reminder: %d", f.count("soon"))
	}
	if f.count("later") != 0 {
		t.Fatal("a webinar three hours out was reminded")
	}
}

func TestPushGoneRemovesSubscription(t *testing.T) {
	h, f := newPushHarness(t)
	h.signup("Gone", "gone@example.com", false)
	sub := f.browser(t, "gone", "")
	h.subscribe(sub, http.StatusOK)
	f.set("gone", http.StatusGone)

	res, raw := h.do(http.MethodPost, "/api/push/test", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("test: %d %s", res.StatusCode, raw)
	}
	h.flushPush()
	if f.count("gone") != 1 {
		t.Fatalf("not sent: %d", f.count("gone"))
	}
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1`, sub.Endpoint); n != 0 {
		t.Fatal("410 left the subscription in place")
	}
	// With no browser left, the test button says so.
	res, raw = h.do(http.MethodPost, "/api/push/test", nil)
	wantCode(t, res, raw, http.StatusConflict, "no_devices")
}

func TestPushBackoff(t *testing.T) {
	h, f := newPushHarness(t)
	h.signup("Flaky", "flaky@example.com", false)
	sub := f.browser(t, "flaky", "")
	h.subscribe(sub, http.StatusOK)
	f.set("flaky", http.StatusServiceUnavailable)

	h.do(http.MethodPost, "/api/push/test", nil)
	h.flushPush()
	if f.count("flaky") != 1 {
		t.Fatalf("first try: %d", f.count("flaky"))
	}
	var failures int
	var resting bool
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT failures, next_attempt_at > now() FROM push_subscriptions WHERE endpoint = $1`, sub.Endpoint).
		Scan(&failures, &resting); err != nil {
		t.Fatal(err)
	}
	if failures != 1 || !resting {
		t.Fatalf("backoff not recorded: failures=%d resting=%v", failures, resting)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_messages WHERE state = 'pending' AND attempts = 1`); n != 1 {
		t.Fatalf("message not kept for retry: %d", n)
	}

	// While it rests, nothing is sent to it.
	api.FlushPush(h.server, context.Background())
	if f.count("flaky") != 1 {
		t.Fatalf("sent during backoff: %d", f.count("flaky"))
	}

	// Rested and healthy again: the message goes and the endpoint is forgiven.
	f.set("flaky", http.StatusCreated)
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE push_subscriptions SET next_attempt_at = now() - interval '1 second' WHERE endpoint = $1`, sub.Endpoint); err != nil {
		t.Fatal(err)
	}
	api.FlushPush(h.server, context.Background())
	if f.count("flaky") != 2 {
		t.Fatalf("retry: %d", f.count("flaky"))
	}
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1 AND failures = 0 AND last_ok_at IS NOT NULL`, sub.Endpoint); n != 1 {
		t.Fatal("success did not clear the backoff")
	}
	if n := h.pushCount(`SELECT count(*) FROM push_messages WHERE state = 'sent'`); n != 1 {
		t.Fatal("message not marked sent")
	}
}

func TestPushHostKindsRespectPreferences(t *testing.T) {
	h, f := newPushHarness(t)
	h.login("neeraj@acme.dev")
	h.subscribe(f.browser(t, "host", ""), http.StatusOK)
	wb := h.newWebinar("Gated", func(in *types.WebinarInput) { in.Approval = types.ApprovalManual })
	h.logout()

	h.registerAs(wb.ID, "waiting@example.com")
	h.flushPush()
	before := f.count("host")
	if before != 1 {
		t.Fatalf("host told %d times about a registration to approve", before)
	}
	var title string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT title FROM push_messages WHERE kind = 'approval_requested' ORDER BY created_at DESC LIMIT 1`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(title, "approve") {
		t.Fatalf("title: %q", title)
	}

	h.login("neeraj@acme.dev")
	h.do(http.MethodPut, "/api/push/preferences", types.PushPreferencesUpdate{
		Preferences: []types.PushPreference{{Kind: types.PushApprovalRequested, Enabled: false}},
	})
	h.logout()
	h.registerAs(wb.ID, "waiting3@example.com")
	h.flushPush()
	if f.count("host") != before {
		t.Fatal("host told after turning approvals off")
	}
}

// A knock reaches the host's phone only while the host is not in the room.
func TestPushLobbyKnockWhenHostAway(t *testing.T) {
	h, f := newPushHarness(t)
	host := meetingHost(t, h)
	h.subscribe(f.browser(t, "mhost", ""), http.StatusOK)
	wb := h.instantMeeting("Standup", nil)

	h.mustKnock(wb.ID, "Rita")
	h.flushPush()
	if f.count("mhost") != 1 {
		t.Fatalf("host away, knock pushes: %d", f.count("mhost"))
	}
	var title, url string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT title, url FROM push_messages WHERE kind = 'lobby_knock'`).Scan(&title, &url); err != nil {
		t.Fatal(err)
	}
	if title != "Rita is waiting to join" || url != "/host/"+wb.ID+"/room" {
		t.Fatalf("knock push: %q %q", title, url)
	}

	// In the room, the lobby panel tells them; no push. (A new minute would be a new push,
	// so clear the dedupe row to prove it is the presence that stops it.)
	if _, err := h.store.Pool().Exec(context.Background(), `DELETE FROM push_messages`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE webinars SET sfu_project = $2 WHERE slug = $1`, wb.ID, h.rooms.project); err != nil {
		t.Fatal(err)
	}
	h.rooms.setRoster(roomOf(host.ID, 1)...)
	h.mustKnock(wb.ID, "Sam")
	h.flushPush()
	if f.count("mhost") != 1 {
		t.Fatalf("host in the room still pushed: %d", f.count("mhost"))
	}
}

// The service worker's pushsubscriptionchange: the new endpoint inherits the old one's scope.
func TestPushSubscriptionRenewal(t *testing.T) {
	h, f := newPushHarness(t)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Renew", nil)
	h.logout()
	reg := h.registerAs(wb.ID, "renew@example.com")
	old := f.browser(t, "old", reg.JoinKey)
	h.subscribe(old, http.StatusOK)

	next := f.browser(t, "new", "")
	next.OldEndpoint = old.Endpoint
	if out := h.subscribe(next, http.StatusOK); out.Scope != "renewed" {
		t.Fatalf("renew scope: %+v", out)
	}
	if n := h.pushCount(`SELECT count(*) FROM push_subscriptions WHERE endpoint = $1`, old.Endpoint); n != 0 {
		t.Fatal("old endpoint kept")
	}
	h.login("neeraj@acme.dev")
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	h.flushPush()
	if f.count("new") != 1 || f.count("old") != 0 {
		t.Fatalf("renewed browser not told: new=%d old=%d", f.count("new"), f.count("old"))
	}
}
