package api_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The passcode, which was decoration.
 *
 * Two independent faults, and either alone made the feature worthless:
 *
 *   It was serialised into the browse list and the public webinar page, both
 *   unauthenticated. Anybody could read the code out of the API.
 *
 *   It was never compared to anything. The field was stored, length-checked and
 *   returned, and no code path asked whether a registrant knew it.
 *
 * Both are easy to reintroduce, because neither shows up in the UI: a leaked field looks
 * like a field, and an unenforced gate looks like an open webinar. Hence tests that name
 * the endpoint and the caller rather than testing "passcode logic".
 */

const passcode = "Redis-2026"

func newPasscodedWebinar(t *testing.T, h *harness) types.Webinar {
	t.Helper()
	return h.newWebinar("Passcoded Session", func(in *types.WebinarInput) {
		in.Passcode = passcode
	})
}

// getJSON fetches with no cookies at all, which is what an anonymous visitor is.
func getJSON(t *testing.T, url string, dst any) {
	t.Helper()
	res, err := (&http.Client{}).Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %d body %s", url, res.StatusCode, raw)
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		t.Fatalf("GET %s: decode %v body %s", url, err, raw)
	}
}

func TestPasscodeNotLeakedToThePublic(t *testing.T) {
	h := newHarness(t)
	h.signup("Passcode Host", "pc-host@test.dev", true)
	wb := newPasscodedWebinar(t, h)

	// The host set it, so the host must still be able to read it back — this is the
	// half of the fix that a blanket `json:"-"` would have broken.
	var mine types.Webinar
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host read: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &mine)
	if mine.Passcode != passcode {
		t.Errorf("the host cannot see their own passcode: got %q want %q", mine.Passcode, passcode)
	}

	// The public single-webinar page.
	var public types.Webinar
	getJSON(t, h.srv.URL+"/api/webinars/"+wb.ID, &public)
	if public.Passcode != "" {
		t.Errorf("GET /api/webinars/{slug} leaks the passcode: %q", public.Passcode)
	}
	if !public.PasscodeRequired {
		t.Error("the public payload must still say a passcode is required, or the form cannot ask")
	}

	/* The webinar list.
	 *
	 * Through the harness client rather than getJSON, because this list is no longer
	 * public: it needs a session and returns only what that account is involved in. The
	 * caller here is the host who created this webinar, so it is in their scope — which
	 * makes this a sharper test than before, not a weaker one. It now asks the awkward
	 * question: does the OWNER's own list leak the passcode? The host detail endpoint is
	 * deliberately unredacted, so a list that reused that path would.
	 */
	var list []types.Webinar
	res, raw = h.do(http.MethodGet, "/api/webinars", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &list)
	found := false
	for _, w := range list {
		if w.ID != wb.ID {
			continue
		}
		found = true
		if w.Passcode != "" {
			t.Errorf("GET /api/webinars leaks the passcode: %q", w.Passcode)
		}
		if !w.PasscodeRequired {
			t.Error("browse list must flag that a passcode is required")
		}
	}
	if !found {
		t.Fatal("the webinar is not in the browse list, so nothing was actually checked")
	}

	/* And it must not be anywhere else in the bytes.
	 *
	 * Asserting on the decoded field only checks the field the test knows about. The
	 * passcode reaching the public through some other route — a nested copy, a field added
	 * later — is the same bug, so the whole body is searched. */
	res2, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	body, _ := io.ReadAll(res2.Body)
	if strings.Contains(strings.ToUpper(string(body)), strings.ToUpper(passcode)) {
		t.Errorf("the passcode appears somewhere in the public response body: %s", body)
	}
}

func TestPasscodeIsRequiredToRegister(t *testing.T) {
	h := newHarness(t)
	h.signup("Passcode Host", "pc-host2@test.dev", true)
	wb := newPasscodedWebinar(t, h)
	h.logout()

	register := func(code string) (*http.Response, []byte) {
		t.Helper()
		return h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register",
			types.RegisterRequest{
				FirstName: "Wants", LastName: "In", Email: "wants-in@test.dev",
				Consent: true, Phone: testPhone, Passcode: code,
			})
	}

	// No passcode at all. This is the exact request that used to be granted.
	res, raw := register("")
	if res.StatusCode == http.StatusCreated || res.StatusCode == http.StatusOK {
		t.Fatalf("registered with no passcode: status %d body %s", res.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "passcode") {
		t.Errorf("the error must name the passcode field so the form can show it: %s", raw)
	}

	// Wrong passcode.
	if res, raw := register("not-the-code"); res.StatusCode == http.StatusCreated {
		t.Fatalf("registered with the wrong passcode: body %s", raw)
	}

	/* A near miss. Someone who was read the code over a call types it in whatever case
	 * and with a trailing space, and refusing that produces a support ticket rather than
	 * security — the rate limiter is what makes guessing expensive. */
	res, raw = register("  redis-2026 ")
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("a correct passcode in the wrong case was rejected: status %d body %s",
			res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	if reg.JoinKey == "" {
		t.Fatal("registration succeeded without issuing a join key")
	}
}

func TestPasscodeGateCannotBeSkippedByJoining(t *testing.T) {
	h := newHarness(t)
	h.signup("Passcode Host", "pc-host3@test.dev", true)
	wb := newPasscodedWebinar(t, h)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	h.logout()

	/* The join endpoint takes a join key, not a passcode, and that is correct — but only
	 * because a join key cannot be obtained without the passcode. This is the test that
	 * ties those two facts together: if registration ever stops enforcing, the room is
	 * open again and nothing else would notice. */
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: "AAAAAAAAAAAA"})
	if res.StatusCode == http.StatusOK {
		t.Fatalf("a made-up join key got a token: %s", raw)
	}

	// And with the passcode, the whole path works end to end.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register",
		types.RegisterRequest{
			FirstName: "Real", LastName: "Attendee", Email: "real@test.dev",
			Consent: true, Phone: testPhone, Passcode: passcode,
		})
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("register with the passcode: status %d body %s", res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join with a properly obtained key: status %d body %s", res.StatusCode, raw)
	}
}

func TestWebinarWithoutPasscodeStillOpen(t *testing.T) {
	h := newHarness(t)
	h.signup("Open Host", "open-host@test.dev", true)
	// No passcode set, which is every existing webinar. Enforcement must not have
	// silently closed these.
	wb := h.newWebinar("Open Session", nil)
	h.logout()

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register",
		types.RegisterRequest{
			FirstName: "Any", LastName: "One", Email: "anyone@test.dev", Consent: true, Phone: testPhone,
		})
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("registering for a webinar with no passcode broke: status %d body %s",
			res.StatusCode, raw)
	}

	var public types.Webinar
	getJSON(t, h.srv.URL+"/api/webinars/"+wb.ID, &public)
	if public.PasscodeRequired {
		t.Error("a webinar with no passcode must not claim to require one")
	}
}

// ------------------------------------------------------------------ phone number

/* The mobile number: optional, and shape-checked when it is given.
 *
 * Optional because the registration form is what captures a lead, and a required number on it
 * loses the registrations of everybody who will give a name and an email and no more. What is
 * NOT optional is the shape of a number that IS given: "9876543210" with no country code is
 * something nobody can dial, and storing it is worse for the host than storing nothing.
 *
 * Shape-checked rather than validated against a numbering plan, so these tests pin the bounds
 * and not the plausibility: E.164 says a country code is 1-3 digits and the whole number is at
 * most 15, and those are the parts that do not go stale. A wrong number that passes is one the
 * host can see and correct; a right number that fails is an attendee who cannot register.
 */
func TestRegistrationChecksTheShapeOfAnyNumberItIsGiven(t *testing.T) {
	h := newHarness(t)
	h.signup("Phone Host", "phone-host@test.dev", true)
	wb := h.newWebinar("Phone Session", nil)
	h.logout()

	register := func(phone string, email string) (*http.Response, []byte) {
		t.Helper()
		return h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register",
			types.RegisterRequest{
				FirstName: "Dial", LastName: "Tone", Email: email, Consent: true,
				Phone: phone,
			})
	}

	// No number at all is fine: the field is optional.
	if res, raw := register("", "none@test.dev"); res.StatusCode != http.StatusCreated {
		t.Errorf("registering with no number: status %d body %s, want 201", res.StatusCode, raw)
	}

	// A malformed one still names the field, so the form can show the message against it.
	if res, raw := register("98765", "malformed@test.dev"); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("a number with no country code was accepted: status %d body %s", res.StatusCode, raw)
	} else if !strings.Contains(string(raw), "phone") {
		t.Errorf("the error must name the phone field so the form can show it: %s", raw)
	}

	// Seven digits is below every country's reachable mobile length.
	if res, _ := register("+1234567", "short@test.dev"); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("a seven-digit number was accepted: status %d", res.StatusCode)
	}
	// Sixteen digits exceeds the E.164 maximum.
	if res, _ := register("+9198765432101234", "long@test.dev"); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("a sixteen-digit number was accepted: status %d", res.StatusCode)
	}

	/* Stored in E.164 whatever shape it arrived in.
	 *
	 * The three below are the same number typed by three people. If they are stored verbatim
	 * the host's export has three formats in it and nothing can dial any of them. */
	for i, typed := range []string{"+91 98765 43210", "+91-98765-43210", "0091 (98765) 43210"} {
		res, raw := register(typed, fmt.Sprintf("shape%d@test.dev", i))
		if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
			t.Fatalf("%q was rejected: status %d body %s", typed, res.StatusCode, raw)
		}
		var reg types.Registration
		h.decode(raw, &reg)
		if reg.Phone != "+919876543210" {
			t.Errorf("%q stored as %q, want +919876543210", typed, reg.Phone)
		}
	}
}

func TestHostSeesTheNumber(t *testing.T) {
	h := newHarness(t)
	h.signup("Phone Host", "phone-host2@test.dev", true)
	wb := h.newWebinar("Phone Session", nil)

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register",
		types.RegisterRequest{
			FirstName: "Callable", LastName: "Person", Email: "callable@test.dev",
			Consent: true, Phone: "+44 20 7946 0958",
		})
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}

	// The number is collected so a host can follow up; if it does not reach the host's own
	// view of the registrant list, collecting it achieved nothing.
	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/registrants", nil)
	var rows []types.RegistrantRow
	h.decode(raw, &rows)
	found := false
	for _, r := range rows {
		if r.Email == "callable@test.dev" {
			found = true
			if r.Phone != "+442079460958" {
				t.Errorf("the host sees phone %q, want +442079460958", r.Phone)
			}
		}
	}
	if !found {
		t.Fatal("the registrant is not in the host's list, so nothing was checked")
	}
}
