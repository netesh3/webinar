package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The rejoin cookie and the rejoin check.
 *
 * A guest's browser that joined once can get back in on a refresh with nothing but the
 * httpOnly cookie, for that webinar only, until they press Leave, the webinar ends, or
 * the host removes them. A deliberate join with the key still works after a removal —
 * that is unchanged — but the automatic path does not.
 */

type browser struct {
	t   *testing.T
	h   *harness
	jar *cookiejar.Jar
	c   *http.Client
}

func newBrowser(t *testing.T, h *harness) *browser {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &browser{t: t, h: h, jar: jar, c: &http.Client{Jar: jar}}
}

func (b *browser) post(path string, body any) (*http.Response, []byte) {
	b.t.Helper()
	raw, _ := json.Marshal(body)
	res, err := b.c.Post(b.h.srv.URL+path, "application/json", bytes.NewReader(raw))
	if err != nil {
		b.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res, out
}

func (b *browser) rejoinCookie(slug string) *http.Cookie {
	u, _ := url.Parse(b.h.srv.URL + "/api/webinars/" + slug + "/join")
	for _, c := range b.jar.Cookies(u) {
		if c.Name == "webcast_rejoin" {
			return c
		}
	}
	return nil
}

func (b *browser) check(slug string, key string) types.RejoinCheckResponse {
	b.t.Helper()
	res, raw := b.post("/api/webinars/"+slug+"/rejoin-check", types.JoinRequest{JoinKey: key})
	if res.StatusCode != http.StatusOK {
		b.t.Fatalf("rejoin-check: status %d body %s", res.StatusCode, raw)
	}
	var out types.RejoinCheckResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		b.t.Fatal(err)
	}
	return out
}

func TestRejoinCookie(t *testing.T) {
	h := newHarness(t)
	h.signup("Rejoin Host", "rejoin-host@test.dev", true)
	wb := h.newWebinar("Rejoin me", nil)
	other := h.newWebinar("Some other webinar", nil)
	h.goLive(wb.ID)
	h.goLive(other.ID)
	reg := h.registerAsGuest(wb.ID, "rejoin-guest@test.dev")
	g := newBrowser(t, h)

	// Before any join there is nothing to go back with.
	if res, raw := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{}); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("join with no credential: status %d body %s, want 401", res.StatusCode, raw)
	}

	res, raw := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}
	var set *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == "webcast_rejoin" {
			set = c
		}
	}
	if set == nil {
		t.Fatal("a successful join set no rejoin cookie")
	}
	if !set.HttpOnly || set.Path != "/api/webinars/"+wb.ID || set.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie attributes: httpOnly=%v path=%q sameSite=%v", set.HttpOnly, set.Path, set.SameSite)
	}
	if bytes.Contains([]byte(set.Value), []byte(reg.JoinKey)) {
		t.Fatal("the rejoin cookie carries the join key")
	}

	t.Run("refresh with only the cookie", func(t *testing.T) {
		res, raw := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("join by cookie: status %d body %s", res.StatusCode, raw)
		}
		var join types.JoinResponse
		h.decode(raw, &join)
		if join.Identity != "att_"+reg.JoinKey {
			t.Fatalf("identity %q, want the registration's own", join.Identity)
		}
		if got := g.check(wb.ID, ""); !got.Rejoin {
			t.Fatalf("rejoin-check by cookie = %+v, want rejoin", got)
		}
	})

	t.Run("scoped to its webinar", func(t *testing.T) {
		// The jar would not send it to another webinar's path; present it anyway.
		req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/webinars/"+other.ID+"/join",
			bytes.NewReader([]byte(`{}`)))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "webcast_rejoin", Value: set.Value})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("cookie for one webinar on another: status %d, want 401", res.StatusCode)
		}
	})

	t.Run("leave clears it", func(t *testing.T) {
		if res, raw := g.post("/api/webinars/"+wb.ID+"/leave", nil); res.StatusCode != http.StatusOK {
			t.Fatalf("leave: status %d body %s", res.StatusCode, raw)
		}
		if c := g.rejoinCookie(wb.ID); c != nil {
			t.Fatalf("rejoin cookie survived Leave: %+v", c)
		}
		if res, _ := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{}); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("join after Leave with no key: status %d, want 401", res.StatusCode)
		}
		if got := g.check(wb.ID, ""); got.Rejoin || got.Reason != "no_credential" {
			t.Fatalf("rejoin-check after Leave = %+v", got)
		}
	})

	t.Run("refused after removal", func(t *testing.T) {
		if res, raw := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
			t.Fatalf("rejoin with key: status %d body %s", res.StatusCode, raw)
		}
		res, raw := h.do(http.MethodDelete,
			"/api/host/webinars/"+wb.ID+"/participants/att_"+reg.JoinKey, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("remove: status %d body %s", res.StatusCode, raw)
		}
		res, raw = g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
		if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "removed" {
			t.Fatalf("cookie after removal: status %d body %s, want 403 removed", res.StatusCode, raw)
		}
		if got := g.check(wb.ID, reg.JoinKey); got.Rejoin || got.Reason != "removed" {
			t.Fatalf("rejoin-check after removal = %+v", got)
		}
		res, raw = g.post("/api/webinars/"+wb.ID+"/join?rejoin=1", types.JoinRequest{JoinKey: reg.JoinKey})
		if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "removed" {
			t.Fatalf("automatic rejoin by key after removal: status %d body %s", res.StatusCode, raw)
		}
		// Pressing Join with the link is a deliberate return, as it always was.
		if res, raw := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
			t.Fatalf("deliberate join after removal: status %d body %s", res.StatusCode, raw)
		}
		// Running the webinar again starts clean.
		if _, err := h.store.Pool().Exec(context.Background(),
			`UPDATE webinars SET started_at = now() + interval '1 second' WHERE slug = $1`, wb.ID); err != nil {
			t.Fatal(err)
		}
		if got := g.check(wb.ID, reg.JoinKey); !got.Rejoin {
			t.Fatalf("a removal from an earlier run still counts: %+v", got)
		}
	})

	t.Run("refused when ended", func(t *testing.T) {
		if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
			t.Fatal(err)
		}
		if g.rejoinCookie(wb.ID) == nil {
			t.Fatal("precondition: the last join should have left a cookie")
		}
		if got := g.check(wb.ID, reg.JoinKey); got.Rejoin || got.Reason != "ended" {
			t.Fatalf("rejoin-check when ended = %+v", got)
		}
		if c := g.rejoinCookie(wb.ID); c != nil {
			t.Fatal("rejoin cookie survived the webinar ending")
		}
	})
}

func TestRejoinCheckForTheStage(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage-rejoin@test.dev", true)
	wb := h.newWebinar("Green room", nil)

	// Before the start: the host's stage is open, the audience's room is not.
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/rejoin-check", types.JoinRequest{})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s", res.StatusCode, raw)
	}
	var got types.RejoinCheckResponse
	h.decode(raw, &got)
	if !got.Rejoin || !got.Stage {
		t.Fatalf("host before start = %+v, want rejoin to the stage", got)
	}

	h.logout()
	reg := h.registerAsGuest(wb.ID, "too-soon@test.dev")
	if got := newBrowser(t, h).check(wb.ID, reg.JoinKey); got.Rejoin || got.Reason != "not_live" {
		t.Fatalf("attendee before start = %+v, want not_live", got)
	}
}
