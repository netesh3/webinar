package api_test

import (
	"context"
	"net/http"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Load tests (admin_loadtest.go): admin-only, test accounts only, off by default. */

type loadTestSeats struct {
	JoinKeys []string `json:"joinKeys"`
}

func adminUserID(t *testing.T, h *harness, email string) string {
	t.Helper()
	u, err := h.store.UserByEmail(context.Background(), email)
	if err != nil {
		t.Fatalf("user %s: %v", email, err)
	}
	return u.ID
}

// The kit's host signs up like anybody, cannot sign in unverified, and an admin can verify only a .invalid address.
func TestAdminVerifiesOnlyTestAccounts(t *testing.T) {
	h := newHarness(t)
	for _, email := range []string{"lt-host@loadtest.invalid", "real-person@test.dev"} {
		res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
			Name: "LT Host", Email: email, Password: "webcast-dev", Phone: testPhone,
		})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("signup %s: %d %s", email, res.StatusCode, raw)
		}
	}
	if res, _ := h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{Email: "lt-host@loadtest.invalid", Password: "webcast-dev"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("unverified login: %d, want 403", res.StatusCode)
	}
	testID := adminUserID(t, h, "lt-host@loadtest.invalid")
	realID := adminUserID(t, h, "real-person@test.dev")

	// A host who is not an admin gets nothing.
	h.signup("Plain Host", "plain-host@test.dev", true)
	if res, _ := h.do(http.MethodPost, "/api/admin/users/"+testID+"/verify-email", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin verify: %d, want 403", res.StatusCode)
	}

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPost, "/api/admin/users/"+realID+"/verify-email", nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("verify a real address: %d %s, want 422", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/admin/users/"+testID+"/verify-email", nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("verify the test account: %d %s", res.StatusCode, raw)
	}
	h.login("lt-host@loadtest.invalid")
}

func TestLoadTestSeatsAndCeiling(t *testing.T) {
	h := newHarness(t, edgeConfig)
	ctx := context.Background()

	// A customer's (non-.invalid) webinar can never be a load test.
	h.signup("Customer", "customer@test.dev", true)
	customer := h.liveWebinar("Customer webinar", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })

	h.signup("LT Host", "lt-host@loadtest.invalid", true)
	wb := h.liveWebinar("Load test", func(in *types.WebinarInput) {
		in.Delivery = types.DeliveryEdge
		in.AttendeeLimit = 2
	})

	// Not an admin: refused, and nothing is marked.
	if res, _ := h.do(http.MethodPut, "/api/admin/webinars/"+wb.ID+"/load-test", map[string]int{"viewers": 5}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("host marks own webinar: %d, want 403", res.StatusCode)
	}

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPut, "/api/admin/webinars/"+customer.ID+"/load-test", map[string]int{"viewers": 5}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("mark a customer's webinar: %d %s, want 422", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/admin/webinars/"+customer.ID+"/load-test/seats", map[string]int{"count": 1}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("seats on a customer's webinar: %d %s, want 422", res.StatusCode, raw)
	}
	// Seats before the mark.
	if res, raw := h.do(http.MethodPost, "/api/admin/webinars/"+wb.ID+"/load-test/seats", map[string]int{"count": 1}); res.StatusCode != http.StatusConflict {
		t.Fatalf("seats before marking: %d %s, want 409", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPut, "/api/admin/webinars/"+wb.ID+"/load-test", map[string]int{"viewers": 0}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("zero viewers: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPut, "/api/admin/webinars/"+wb.ID+"/load-test", map[string]int{"viewers": 4}); res.StatusCode != http.StatusOK {
		t.Fatalf("mark: %d %s", res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodPost, "/api/admin/webinars/"+wb.ID+"/load-test/seats", map[string]int{"count": 4})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("seats: %d %s", res.StatusCode, raw)
	}
	var seats loadTestSeats
	h.decode(raw, &seats)
	if len(seats.JoinKeys) != 4 {
		t.Fatalf("seats = %v", seats.JoinKeys)
	}
	if res, raw := h.do(http.MethodPost, "/api/admin/webinars/"+wb.ID+"/load-test/seats", map[string]int{"count": 1}); res.StatusCode != http.StatusConflict {
		t.Fatalf("a fifth seat: %d %s, want 409", res.StatusCode, raw)
	}

	// The seats are name-only: no account, no email, nothing to mail or put in the CRM.
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var total, plain int
	if err := pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE email = '' AND is_guest AND state = 'approved' AND user_id IS NULL)
		  FROM registrations r JOIN webinars w ON w.id = r.webinar_id WHERE w.slug = $1`, wb.ID).Scan(&total, &plain); err != nil {
		t.Fatal(err)
	}
	if total != 4 || plain != 4 {
		t.Fatalf("seats: %d rows, %d name-only approved guests without an account; want 4 and 4", total, plain)
	}

	// Three viewers join and watch; the webinar's own limit is 2, the load test's 4.
	for i, key := range seats.JoinKeys[:3] {
		res, jr, raw := h.joinAsGuestKey(wb.ID, key)
		if res.StatusCode != http.StatusOK || jr.Delivery != types.DeliveryEdge || jr.EventsToken == "" {
			t.Fatalf("viewer %d join: %d %s", i, res.StatusCode, raw)
		}
		if err := h.store.TouchEdgeVisit(ctx, wb.ID, jr.Identity, time.Now()); err != nil {
			t.Fatal(err)
		}
	}

	// Off again: the plan/webinar ceiling is back and the fourth is turned away.
	if res, _ := h.do(http.MethodDelete, "/api/admin/webinars/"+wb.ID+"/load-test", nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("clear: %d", res.StatusCode)
	}
	if res, _, raw := h.joinAsGuestKey(wb.ID, seats.JoinKeys[3]); res.StatusCode != http.StatusConflict {
		t.Fatalf("join over the webinar limit with the load test off: %d %s, want 409 room_full", res.StatusCode, raw)
	}

	// Deleting the webinar takes the seats and the mark with it.
	if res, raw := h.do(http.MethodDelete, "/api/admin/webinars/"+wb.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}
	if _, ok, err := h.store.LoadTestViewers(ctx, wb.ID); err != nil || ok {
		t.Fatalf("load test after delete: %v %v", ok, err)
	}
}

/* A load test's mix draws the latency clock (and its time strip) for the kit's browser
 * viewers; a customer's mix never does unless EDGE_DEBUG_CLOCK is on for everyone. */
func TestLoadTestMixDrawsTheLatencyClock(t *testing.T) {
	const tmpl = "https://webinarliv.test/recorder-template"
	h := newHarness(t, func(c *config.Config) {
		edgeConfig(c)
		c.RecordingsEgressTemplateURL = tmpl
	})
	h.signup("LT Clock Host", "lt-clock@loadtest.invalid", true)
	wb := h.newWebinar("Load test clock", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })
	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPut, "/api/admin/webinars/"+wb.ID+"/load-test", map[string]int{"viewers": 5}); res.StatusCode != http.StatusOK {
		t.Fatalf("mark: %d %s", res.StatusCode, raw)
	}
	h.login("lt-clock@loadtest.invalid")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: %d %s", res.StatusCode, raw)
	}
	waitForCalls(t, h, "rtmp://origin.test/live/"+wb.ID)
	h.rooms.mu.Lock()
	templates := slices.Clone(h.rooms.templates)
	h.rooms.mu.Unlock()
	if !slices.Contains(templates, "mix="+tmpl+"/edge/clock") {
		t.Fatalf("load test mix templates = %v, want %s/edge/clock", templates, tmpl)
	}
}
