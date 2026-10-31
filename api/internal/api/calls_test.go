package api_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/push"
	"github.com/netkumar/webcast/api/types"
)

/* Calling (calls.go, 31 Oct 2026): the lifecycle and who may move it, the abuse limits, who a
 * host may find to call (and that nobody else's address leaks), the push fan-out with a data
 * message for the apps, and the ring reaching the callee's open tab. */

// callPair is a host in h and a callee signed in on their own browser.
func callPair(t *testing.T, h *harness) (caller types.Account, callee *harness, calleeAcct types.Account) {
	t.Helper()
	n := time.Now().UnixNano()
	caller = h.signup("Asha Caller", fmt.Sprintf("caller-%d@test.dev", n), true)
	callee = h.browser()
	calleeAcct = callee.signup("Ravi Callee", fmt.Sprintf("callee-%d@test.dev", n), false)
	return caller, callee, calleeAcct
}

func (h *harness) startCall(req types.StartCallRequest, want int) types.StartCallResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/calls", req)
	if res.StatusCode != want {
		h.t.Fatalf("start call: status %d (want %d) body %s", res.StatusCode, want, raw)
	}
	var out types.StartCallResponse
	h.decode(raw, &out)
	return out
}

func (h *harness) callAction(id, action string) (*http.Response, types.Call, []byte) {
	h.t.Helper()
	method, path := http.MethodPost, "/api/calls/"+id+"/"+action
	if action == "" {
		method, path = http.MethodGet, "/api/calls/"+id
	}
	res, raw := h.do(method, path, nil)
	var out types.Call
	switch res.StatusCode {
	case http.StatusOK:
		h.decode(raw, &out)
	case http.StatusConflict:
		var c types.CallConflict
		h.decode(raw, &c)
		out = c.Call
	}
	return res, out, raw
}

func (h *harness) isPanelist(slug, userID string) bool {
	h.t.Helper()
	ids, err := h.store.PanelistIDs(context.Background(), slug)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, id := range ids {
		if id == userID {
			return true
		}
	}
	return false
}

func (h *harness) expireCall(id string) {
	h.t.Helper()
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE calls SET expires_at = now() - interval '1 second' WHERE id = $1`, id); err != nil {
		h.t.Fatal(err)
	}
}

func TestCallLifecycle(t *testing.T) {
	h := newHarness(t)
	_, callee, calleeAcct := callPair(t, h)
	stranger := h.browser()
	stranger.signup("Sam Stranger", fmt.Sprintf("stranger-%d@test.dev", time.Now().UnixNano()), true)

	// No meeting: the call makes an instant one, without the instant switch.
	first := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusCreated)
	if !first.MeetingCreated || first.MeetingSlug == "" || first.JoinURL != "/host/"+first.MeetingSlug+"/room" {
		t.Fatalf("instant call %+v", first)
	}
	expires, err := time.Parse(time.RFC3339, first.ExpiresAt)
	if err != nil || time.Until(expires) > 46*time.Second || time.Until(expires) < 40*time.Second {
		t.Fatalf("expiresAt %q, want about 45 s out", first.ExpiresAt)
	}
	wb := h.hostWebinar(first.MeetingSlug)
	if wb.Kind != types.KindMeeting {
		t.Fatalf("the call's meeting is a %q", wb.Kind)
	}
	if !h.isPanelist(first.MeetingSlug, calleeAcct.ID) {
		t.Fatal("the callee has no seat in the meeting while it rings")
	}

	// Both ends read it; nobody else may know it exists.
	if res, c, raw := h.callAction(first.CallID, ""); res.StatusCode != http.StatusOK || c.State != types.CallRinging || c.Role != "caller" {
		t.Fatalf("caller get: %d %s", res.StatusCode, raw)
	}
	if res, c, raw := callee.callAction(first.CallID, ""); res.StatusCode != http.StatusOK || c.Role != "callee" || c.CallerName != "Asha Caller" {
		t.Fatalf("callee get: %d %s", res.StatusCode, raw)
	}
	for _, action := range []string{"", "accept", "decline", "cancel"} {
		if res, _, raw := stranger.callAction(first.CallID, action); res.StatusCode != http.StatusNotFound {
			t.Fatalf("stranger %q: %d %s", action, res.StatusCode, raw)
		}
	}
	if res, _, raw := h.callAction("not-a-call", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("junk id: %d %s", res.StatusCode, raw)
	}
	// Each side has its own buttons.
	if res, _, raw := h.callAction(first.CallID, "accept"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("caller accepting: %d %s", res.StatusCode, raw)
	}
	if res, _, raw := callee.callAction(first.CallID, "cancel"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("callee cancelling: %d %s", res.StatusCode, raw)
	}

	// Decline, idempotently; then nothing else.
	if res, c, raw := callee.callAction(first.CallID, "decline"); res.StatusCode != http.StatusOK || c.State != types.CallDeclined {
		t.Fatalf("decline: %d %s", res.StatusCode, raw)
	}
	if res, c, _ := callee.callAction(first.CallID, "decline"); res.StatusCode != http.StatusOK || c.State != types.CallDeclined {
		t.Fatalf("decline again: %d", res.StatusCode)
	}
	if res, c, raw := callee.callAction(first.CallID, "accept"); res.StatusCode != http.StatusConflict || c.State != types.CallDeclined ||
		errorCode(t, raw) != "call_ended" {
		t.Fatalf("accept after decline: %d %s", res.StatusCode, raw)
	}
	if h.isPanelist(first.MeetingSlug, calleeAcct.ID) {
		t.Fatal("a declined call left the callee their seat")
	}

	// Into the same meeting: pressing Call twice rings once; accept lets them in.
	slug := first.MeetingSlug
	second := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug}, http.StatusCreated)
	if again := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug}, http.StatusOK); again.CallID != second.CallID {
		t.Fatalf("a second press rang again: %s then %s", second.CallID, again.CallID)
	}
	res, accepted, raw := callee.callAction(second.CallID, "accept")
	if res.StatusCode != http.StatusOK || accepted.State != types.CallAccepted || accepted.JoinURL != "/host/"+slug+"/room" {
		t.Fatalf("accept: %d %s", res.StatusCode, raw)
	}
	if res, c, _ := callee.callAction(second.CallID, "accept"); res.StatusCode != http.StatusOK || c.State != types.CallAccepted {
		t.Fatalf("accept again: %d", res.StatusCode)
	}
	if res, _, raw := h.callAction(second.CallID, "cancel"); res.StatusCode != http.StatusConflict {
		t.Fatalf("cancel after accept: %d %s", res.StatusCode, raw)
	}
	if !h.isPanelist(slug, calleeAcct.ID) {
		t.Fatal("accepting did not keep the seat")
	}
	// The join link works for them: the meeting's stage door.
	if res, raw := callee.do(http.MethodPost, "/api/host/webinars/"+slug+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("callee join: %d %s", res.StatusCode, raw)
	}

	// Cancel by the caller.
	callee2 := h.browser()
	other := callee2.signup("Mia Other", fmt.Sprintf("other-%d@test.dev", time.Now().UnixNano()), false)
	third := h.startCall(types.StartCallRequest{CalleeUserID: other.ID, MeetingSlug: slug}, http.StatusCreated)
	if res, c, raw := h.callAction(third.CallID, "cancel"); res.StatusCode != http.StatusOK || c.State != types.CallCancelled {
		t.Fatalf("cancel: %d %s", res.StatusCode, raw)
	}
	if res, c, _ := callee2.callAction(third.CallID, "accept"); res.StatusCode != http.StatusConflict || c.State != types.CallCancelled {
		t.Fatalf("accept after cancel: %d %+v", res.StatusCode, c)
	}
	if h.isPanelist(slug, other.ID) {
		t.Fatal("a cancelled call left its seat")
	}

	// No answer: missed when read, and too late to accept.
	fourth := h.startCall(types.StartCallRequest{CalleeUserID: other.ID, MeetingSlug: slug}, http.StatusCreated)
	h.expireCall(fourth.CallID)
	if res, c, raw := callee2.callAction(fourth.CallID, "accept"); res.StatusCode != http.StatusConflict || c.State != types.CallMissed {
		t.Fatalf("accept after expiry: %d %s", res.StatusCode, raw)
	}
	if res, c, _ := h.callAction(fourth.CallID, ""); c.State != types.CallMissed || res.StatusCode != http.StatusOK {
		t.Fatalf("missed call reads %q", c.State)
	}

	// And the sweep ends one nobody looked at.
	fifth := h.startCall(types.StartCallRequest{CalleeUserID: other.ID, MeetingSlug: slug}, http.StatusCreated)
	h.expireCall(fifth.CallID)
	api.SweepCalls(h.server, context.Background())
	var state string
	if err := h.store.Pool().QueryRow(context.Background(), `SELECT state FROM calls WHERE id = $1`, fifth.CallID).Scan(&state); err != nil || state != "missed" {
		t.Fatalf("swept call is %q (%v)", state, err)
	}
	if h.isPanelist(slug, other.ID) {
		t.Fatal("a missed call left its seat")
	}
}

func TestCallWhoMayCall(t *testing.T) {
	h := newHarness(t)
	caller, _, calleeAcct := callPair(t, h)

	wantStart := func(hh *harness, req types.StartCallRequest, status int, code string) {
		t.Helper()
		res, raw := hh.do(http.MethodPost, "/api/calls", req)
		wantCode(t, res, raw, status, code)
	}
	wantStart(h, types.StartCallRequest{CalleeUserID: caller.ID}, http.StatusUnprocessableEntity, "validation_failed")
	wantStart(h, types.StartCallRequest{CalleeUserID: "nobody"}, http.StatusUnprocessableEntity, "validation_failed")
	wantStart(h, types.StartCallRequest{CalleeUserID: "00000000-0000-4000-8000-000000000000"}, http.StatusNotFound, "callee_not_found")

	// A webinar is not a room to ring somebody into.
	webinar := h.newWebinar("Not a meeting", nil)
	wantStart(h, types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: webinar.ID}, http.StatusUnprocessableEntity, "not_a_meeting")

	// Another host's meeting is not there at all.
	h.logout()
	h.login("neeraj@acme.dev")
	theirs := h.newWebinar("Neeraj's meeting", func(in *types.WebinarInput) { in.Kind = types.KindMeeting })
	h.logout()
	h.login(caller.Email)
	wantStart(h, types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: theirs.ID}, http.StatusNotFound, "not_found")

	// Meetings switched off for the account: no calls either.
	forceFeature(t, h, caller.ID, types.FeatureMeetings, false)
	wantStart(h, types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusForbidden, "feature_off")
	forceFeature(t, h, caller.ID, types.FeatureMeetings, true)

	// An account that cannot host cannot call; signed out is 401.
	attendee := h.browser()
	attendee.signup("Ann Attendee", fmt.Sprintf("attendee-%d@test.dev", time.Now().UnixNano()), false)
	wantStart(attendee, types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusForbidden, "not_a_host")
	anon := h.browser()
	if res, _ := anon.do(http.MethodPost, "/api/calls", types.StartCallRequest{CalleeUserID: calleeAcct.ID}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", res.StatusCode)
	}
	if res, _ := anon.do(http.MethodGet, "/api/me/events", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed-out event stream: %d", res.StatusCode)
	}
}

func TestCallAbuseLimits(t *testing.T) {
	h := newHarness(t)
	_, callee, calleeAcct := callPair(t, h)
	first := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusCreated)
	slug := first.MeetingSlug

	// Three declines in a row: not rung again for an hour.
	if res, _, raw := callee.callAction(first.CallID, "decline"); res.StatusCode != http.StatusOK {
		t.Fatalf("decline: %d %s", res.StatusCode, raw)
	}
	for i := 0; i < 2; i++ {
		c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug}, http.StatusCreated)
		callee.callAction(c.CallID, "decline")
	}
	res, raw := h.do(http.MethodPost, "/api/calls", types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug})
	wantCode(t, res, raw, http.StatusTooManyRequests, "callee_unavailable")
	// An hour later they may ring again.
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE calls SET created_at = created_at - interval '2 hours', ended_at = ended_at - interval '2 hours'`); err != nil {
		t.Fatal(err)
	}
	c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug}, http.StatusCreated)
	h.callAction(c.CallID, "cancel")

	// Ten attempts an hour, to anybody.
	for i := 0; i < 9; i++ {
		c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug}, http.StatusCreated)
		h.callAction(c.CallID, "cancel")
	}
	res, raw = h.do(http.MethodPost, "/api/calls", types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: slug})
	wantCode(t, res, raw, http.StatusTooManyRequests, "rate_limited")
}

func TestContactsPrivacy(t *testing.T) {
	h := newHarness(t)
	n := time.Now().UnixNano()
	caller, callee, calleeAcct := callPair(t, h)
	strangerEmail := fmt.Sprintf("zed-stranger-%d@test.dev", n)
	stranger := h.browser()
	strangerAcct := stranger.signup("Zed Stranger", strangerEmail, false)

	// Somebody who was in a meeting with the host is a contact (here: called, accepted).
	c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusCreated)
	callee.callAction(c.CallID, "accept")

	contacts := func(q string) []types.Contact {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/contacts?q="+strings.ReplaceAll(q, "@", "%40"), nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("contacts %q: %d %s", q, res.StatusCode, raw)
		}
		if strings.Contains(string(raw), "callee-") && !strings.Contains(q, "@") {
			t.Fatalf("contacts %q leaked an address: %s", q, raw)
		}
		var out types.ContactsResponse
		h.decode(raw, &out)
		return out.Contacts
	}
	has := func(list []types.Contact, id string) bool {
		for _, c := range list {
			if c.UserID == id {
				return true
			}
		}
		return false
	}
	if list := contacts(""); !has(list, calleeAcct.ID) || has(list, strangerAcct.ID) || has(list, caller.ID) {
		t.Fatalf("recent contacts %+v", list)
	}
	if list := contacts("rav"); len(list) != 1 || list[0].Name != "Ravi Callee" || list[0].Email != "" {
		t.Fatalf("by name %+v", list)
	}
	// A stranger is not found by name, nor by part of an address.
	for _, q := range []string{"Zed", "zed-stranger", "zed-stranger-", "@test.dev", "test.dev"} {
		if list := contacts(q); has(list, strangerAcct.ID) {
			t.Fatalf("stranger found by %q", q)
		}
	}
	// Only by their whole address, which is all that is echoed back.
	list := contacts(strings.ToUpper(strangerEmail))
	if len(list) != 1 || list[0].UserID != strangerAcct.ID || list[0].Name != "Zed Stranger" {
		t.Fatalf("exact address %+v", list)
	}
	if list := contacts("nobody-" + strangerEmail); len(list) != 0 {
		t.Fatalf("unknown address %+v", list)
	}
	if list := contacts(caller.Email); len(list) != 0 {
		t.Fatal("the host found themselves")
	}

	// Hosts only, and per account rate-limited.
	if res, _ := stranger.do(http.MethodGet, "/api/contacts", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-host contacts: %d", res.StatusCode)
	}
	limited := false
	for i := 0; i < 40 && !limited; i++ {
		res, _ := h.do(http.MethodGet, "/api/contacts?q=x", nil)
		limited = res.StatusCode == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("contacts are not rate-limited")
	}
}

func TestCallPushFanOutIsDataOnlyForTheApps(t *testing.T) {
	ctx := context.Background()
	f, sa := newFakeFCMService(t)
	pub, priv, err := push.GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(c *config.Config) {
		c.FCMServiceAccountJSON = sa
		c.VAPIDPublicKey, c.VAPIDPrivateKey, c.VAPIDSubject = pub, priv, "mailto:ops@example.com"
	})
	api.SetPushEndpointCheck(h.server, func(string) error { return nil })
	web := newFakePushService(t)

	_, callee, calleeAcct := callPair(t, h)
	callee.do(http.MethodPost, "/api/push/native", types.NativePushRegisterRequest{Platform: "android", Token: fcmToken("callee")})
	callee.subscribe(web.browser(t, "callee", ""), http.StatusOK)

	c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusCreated)
	h.flushPush()

	// The app install's row is a data message; both rows are urgent, short-lived and tagged.
	if n := h.pushCount(`SELECT count(*) FROM push_messages
		WHERE kind = 'incoming_call' AND urgency = 'high' AND ttl_sec <= 45 AND tag = $1
		  AND data->>'type' = 'incoming_call' AND data->>'callId' = $2 AND data_only`, "call-"+c.CallID, c.CallID); n != 2 {
		t.Fatalf("incoming_call rows: %d, want 2 (browser, app)", n)
	}
	if web.count("callee") != 1 {
		t.Fatalf("browser rung %d times", web.count("callee"))
	}
	sends := f.sentTo()
	if len(sends) != 1 {
		t.Fatalf("FCM sends %v", sends)
	}
	f.mu.Lock()
	msg := f.sends[0]["message"].(map[string]any)
	f.mu.Unlock()
	if _, has := msg["notification"]; has {
		t.Fatalf("the ring has a notification block: %v", msg)
	}
	android := msg["android"].(map[string]any)
	if android["priority"] != "HIGH" || android["notification"] != nil {
		t.Fatalf("android %v", android)
	}
	data := msg["data"].(map[string]any)
	if data["type"] != "incoming_call" || data["callId"] != c.CallID || data["callerName"] != "Asha Caller" ||
		data["joinUrl"] != c.JoinURL || data["expiresAt"] != c.ExpiresAt || data["callerAvatarUrl"] != "" ||
		data["kind"] != string(types.PushIncomingCall) {
		t.Fatalf("FCM data %v", data)
	}
	headers := msg["apns"].(map[string]any)["headers"].(map[string]any)
	if headers["apns-push-type"] != "alert" || headers["apns-priority"] != "10" {
		t.Fatalf("iOS fallback headers %v", headers)
	}

	// The end stops the ring everywhere: a silent data message for the app.
	callee.callAction(c.CallID, "decline")
	h.flushPush()
	if n := h.pushCount(`SELECT count(*) FROM push_messages WHERE data->>'type' = 'call_ended'
		AND data->>'state' = 'declined' AND tag = $1`, "call-"+c.CallID); n != 2 {
		t.Fatalf("call_ended rows: %d", n)
	}
	if sends := f.sentTo(); len(sends) != 2 {
		t.Fatalf("FCM sends after the end: %v", sends)
	}
	f.mu.Lock()
	end := f.sends[1]["message"].(map[string]any)
	f.mu.Unlock()
	if _, has := end["notification"]; has {
		t.Fatal("call_ended drew a notification")
	}
	if h := end["apns"].(map[string]any)["headers"].(map[string]any); h["apns-push-type"] != "background" {
		t.Fatalf("declined call_ended on iOS %v", h)
	}

	// Calls turned off in Settings: nothing queued.
	callee.do(http.MethodPut, "/api/push/preferences", types.PushPreferencesUpdate{
		Preferences: []types.PushPreference{{Kind: types.PushIncomingCall, Enabled: false}},
	})
	before := h.pushCount(`SELECT count(*) FROM push_messages`)
	h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID, MeetingSlug: c.MeetingSlug}, http.StatusCreated)
	if after := h.pushCount(`SELECT count(*) FROM push_messages`); after != before {
		t.Fatalf("queued %d with calls turned off", after-before)
	}
	_ = ctx
}

// meEvents opens GET /api/me/events on this browser's session.
func (h *harness) meEvents() (<-chan sseEvent, func()) {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, h.srv.URL+"/api/me/events", nil)
	res, err := h.client.Do(req)
	if err != nil {
		cancel()
		h.t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		cancel()
		h.t.Fatalf("me events: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	out := make(chan sseEvent, 64)
	go func() {
		defer close(out)
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
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
	return out, cancel
}

func callEvent(t *testing.T, ch <-chan sseEvent, typ, callID string) map[string]any {
	t.Helper()
	var got map[string]any
	waitFor(t, ch, 5*time.Second, func(e sseEvent) bool {
		if e.kind != "call" {
			return false
		}
		got = map[string]any{}
		_ = json.Unmarshal([]byte(e.data), &got)
		return got["type"] == typ && got["callId"] == callID
	})
	return got
}

func TestCallEventsReachTheOpenTabs(t *testing.T) {
	h := newHarness(t)
	_, callee, calleeAcct := callPair(t, h)

	ring, stop := callee.meEvents()
	defer stop()
	waitFor(t, ring, 5*time.Second, func(e sseEvent) bool { return e.kind == "ready" })
	mine, stopMine := h.meEvents()
	defer stopMine()
	waitFor(t, mine, 5*time.Second, func(e sseEvent) bool { return e.kind == "ready" })

	c := h.startCall(types.StartCallRequest{CalleeUserID: calleeAcct.ID}, http.StatusCreated)
	got := callEvent(t, ring, "incoming_call", c.CallID)
	if got["callerName"] != "Asha Caller" || got["meetingSlug"] != c.MeetingSlug || got["joinUrl"] != c.JoinURL ||
		got["expiresAt"] != c.ExpiresAt || got["topic"] == "" {
		t.Fatalf("incoming_call %v", got)
	}
	if v, present := got["callerAvatarUrl"]; !present || v != nil {
		t.Fatalf("callerAvatarUrl %v (present %v), want null", v, present)
	}

	// A tab opened mid-ring is told at once.
	late, stopLate := callee.meEvents()
	defer stopLate()
	callEvent(t, late, "incoming_call", c.CallID)

	// Hanging up stops the ring on every tab, and the caller's own tab hears it too.
	h.callAction(c.CallID, "cancel")
	if ended := callEvent(t, ring, "call_ended", c.CallID); ended["state"] != "cancelled" {
		t.Fatalf("call_ended %v", ended)
	}
	callEvent(t, late, "call_ended", c.CallID)
	callEvent(t, mine, "call_ended", c.CallID)
}
