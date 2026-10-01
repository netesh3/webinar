package zoom

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSealRoundTrip(t *testing.T) {
	key, err := ParseKey("0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	blob, err := Seal(key, "refresh-token-value")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blob), "refresh-token-value") {
		t.Fatal("ciphertext contains the token")
	}
	got, err := Open(key, blob)
	if err != nil || got != "refresh-token-value" {
		t.Fatalf("open = %q %v", got, err)
	}
	other, _ := ParseKey("abcdef0123456789abcdef0123456789")
	if _, err := Open(other, blob); err == nil {
		t.Fatal("wrong key opened the token")
	}
}

func TestEmailsOffAndRegistrantJoinURL(t *testing.T) {
	var mu sync.Mutex
	var created mailOff
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"access-1","refresh_token":"refresh-2","expires_in":3600}`)
	})
	mux.HandleFunc("/v2/users/me/meetings", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Type     int     `json:"type"`
			Settings mailOff `json:"settings"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode create: %v", err)
		}
		mu.Lock()
		created = body.Settings
		mu.Unlock()
		if body.Type != 2 || body.Settings.ApprovalType != 0 || body.Settings.RegistrationType != 1 {
			t.Errorf("meeting type/approval = %d %+v", body.Type, body.Settings)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":1001,"start_url":"https://zoom.us/s/host-old","join_url":"https://zoom.us/j/generic"}`)
	})
	mux.HandleFunc("/v2/meetings/1001/registrants", func(w http.ResponseWriter, r *http.Request) {
		var person Person
		_ = json.NewDecoder(r.Body).Decode(&person)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"registrant_id":"reg-`+person.Email+`","join_url":"https://zoom.us/j/`+person.Email+`"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	key, _ := ParseKey("0123456789abcdef0123456789abcdef")
	repo := newMem()
	blob, _ := Seal(key, "refresh-1")
	repo.conns["host-a"] = Connection{UserID: "host-a", Email: "a@example.com", Refresh: blob, ZoomUserID: "za"}
	repo.conns["host-b"] = Connection{UserID: "host-b", Email: "b@example.com", Refresh: blob, ZoomUserID: "zb"}

	f := &Flow{
		Client: &Client{ID: "id", Secret: "secret", API: srv.URL + "/v2", OAuth: srv.URL, HTTP: srv.Client()},
		Repo:   repo,
		Seal:   func(p string) ([]byte, error) { return Seal(key, p) },
		Open:   func(b []byte) (string, error) { return Open(key, b) },
	}

	saved, err := f.Save(context.Background(), "host-a", Spec{
		Venue: VenueMeeting, Topic: "Sleep", StartsAt: time.Now().Add(2 * time.Hour), DurationMin: 60, TimeZone: "Asia/Kolkata",
	}, Object{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if saved.ZoomID != "1001" || saved.Venue != VenueMeeting {
		t.Fatalf("saved = %+v", saved)
	}
	mu.Lock()
	off := created
	mu.Unlock()
	if off.RegistrantsConfirmationEmail || off.RegistrantsEmailNotification ||
		off.Reminder.Enable || off.FollowUpAttendees.Enable || off.FollowUpAbsentees.Enable ||
		off.PanelistsInvitation {
		t.Fatalf("zoom emails not off: %+v", off)
	}

	if saved.JoinURL != "https://zoom.us/j/generic" {
		t.Fatalf("shared join = %q", saved.JoinURL)
	}
	if err := f.Push(context.Background(), "host-a", VenueMeeting, saved.ZoomID, "reg-1", "one@example.com", "One", "A", saved.JoinURL); err != nil {
		t.Fatal(err)
	}
	if err := f.Push(context.Background(), "host-a", VenueMeeting, saved.ZoomID, "reg-2", "two@example.com", "Two", "B", saved.JoinURL); err != nil {
		t.Fatal(err)
	}
	if repo.regIDs["reg-1"] == "" || repo.joins["reg-1"] == saved.JoinURL {
		t.Fatalf("personal link was not kept: id=%q join=%q", repo.regIDs["reg-1"], repo.joins["reg-1"])
	}
	a, err := f.AttendeeJoin(context.Background(), "reg-1")
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.AttendeeJoin(context.Background(), "reg-2")
	if err != nil {
		t.Fatal(err)
	}
	if a != "https://zoom.us/j/one@example.com" || b != "https://zoom.us/j/two@example.com" || a == b {
		t.Fatalf("join urls a=%s b=%s", a, b)
	}
	if _, err := f.AttendeeJoin(context.Background(), "missing"); err != ErrNoJoinURL {
		t.Fatalf("missing = %v", err)
	}

	email, ok, err := f.ConnectedEmail(context.Background(), "host-a")
	if err != nil || !ok || email != "a@example.com" {
		t.Fatalf("host a email = %q ok=%v err=%v", email, ok, err)
	}
	email, _, err = f.ConnectedEmail(context.Background(), "host-b")
	if err != nil || email != "b@example.com" {
		t.Fatalf("host b saw %q err=%v", email, err)
	}
}

func TestDisconnectedHostCannotPickZoom(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Error(w, "should not be called", http.StatusInternalServerError)
	}))
	defer srv.Close()
	f := &Flow{
		Client: &Client{ID: "id", Secret: "secret", API: srv.URL, OAuth: srv.URL, HTTP: srv.Client()},
		Repo:   newMem(),
		Open:   func([]byte) (string, error) { return "", nil },
	}
	_, err := f.Save(context.Background(), "host-a", Spec{Venue: VenueMeeting, Topic: "T", StartsAt: time.Now(), DurationMin: 30, TimeZone: "UTC"}, Object{}, 0)
	if !errorsIsNotConnected(err) {
		t.Fatalf("err = %v", err)
	}
	if hits != 0 {
		t.Fatalf("zoom was called %d times", hits)
	}
}

func TestGoLiveReturnsFreshStartURL(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"access-fresh","refresh_token":"refresh-1","expires_in":3600}`)
	})
	mux.HandleFunc("/v2/meetings/1001", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":1001,"start_url":"https://zoom.us/s/fresh-host"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	key, _ := ParseKey("0123456789abcdef0123456789abcdef")
	blob, _ := Seal(key, "refresh-1")
	repo := newMem()
	repo.conns["host-a"] = Connection{UserID: "host-a", Email: "a@example.com", Refresh: blob}
	f := &Flow{
		Client: &Client{ID: "id", Secret: "secret", API: srv.URL + "/v2", OAuth: srv.URL, HTTP: srv.Client()},
		Repo:   repo,
		Seal:   func(p string) ([]byte, error) { return Seal(key, p) },
		Open:   func(b []byte) (string, error) { return Open(key, b) },
	}
	got, err := f.GoLive(context.Background(), "host-a", VenueMeeting, "1001")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://zoom.us/s/fresh-host" {
		t.Fatalf("start = %s", got)
	}
	if IsVenue(VenueApp) || IsVenue("") {
		t.Fatal("this app must not take the zoom go-live path")
	}
	if _, err := f.GoLive(context.Background(), "host-a", VenueApp, "1001"); err == nil {
		t.Fatal("app venue go live should refuse")
	}
}

func TestPlanErrorStaysOnThisApp(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"a","refresh_token":"r","expires_in":1}`)
	})
	mux.HandleFunc("/v2/users/me/webinars", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"code":200,"message":"Webinar plan is not subscribed."}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	key, _ := ParseKey("0123456789abcdef0123456789abcdef")
	blob, _ := Seal(key, "refresh-1")
	repo := newMem()
	repo.conns["host-a"] = Connection{UserID: "host-a", Refresh: blob}
	f := &Flow{
		Client: &Client{ID: "id", Secret: "secret", API: srv.URL + "/v2", OAuth: srv.URL, HTTP: srv.Client()},
		Repo:   repo,
		Open:   func(b []byte) (string, error) { return Open(key, b) },
		Seal:   func(p string) ([]byte, error) { return Seal(key, p) },
	}
	saved, err := f.Save(context.Background(), "host-a", Spec{
		Venue: VenueWebinar, Topic: "T", StartsAt: time.Now(), DurationMin: 30, TimeZone: "UTC",
	}, Object{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Venue != VenueApp || saved.ZoomID != "" || saved.Notice == "" {
		t.Fatalf("saved = %+v", saved)
	}
}

func TestSwitchBackDeletesOnlyWhenNobodyPushed(t *testing.T) {
	var deleted bool
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"a","refresh_token":"r","expires_in":1}`)
	})
	mux.HandleFunc("/v2/meetings/9", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deleted = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	key, _ := ParseKey("0123456789abcdef0123456789abcdef")
	blob, _ := Seal(key, "refresh-1")
	repo := newMem()
	repo.conns["host-a"] = Connection{UserID: "host-a", Refresh: blob}
	f := &Flow{
		Client: &Client{ID: "id", Secret: "secret", API: srv.URL + "/v2", OAuth: srv.URL, HTTP: srv.Client()},
		Repo:   repo,
		Open:   func(b []byte) (string, error) { return Open(key, b) },
	}
	kept, err := f.Save(context.Background(), "host-a", Spec{Venue: VenueApp}, Object{Venue: VenueMeeting, ID: "9", StartURL: "https://zoom.us/s/old"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if deleted || kept.ZoomID != "9" || kept.Venue != VenueApp {
		t.Fatalf("kept = %+v deleted=%v", kept, deleted)
	}
	gone, err := f.Save(context.Background(), "host-a", Spec{Venue: VenueApp}, Object{Venue: VenueMeeting, ID: "9"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !deleted || gone.ZoomID != "" {
		t.Fatalf("gone = %+v deleted=%v", gone, deleted)
	}
}

func TestWebhookSignature(t *testing.T) {
	body := []byte(`{"event":"endpoint.url_validation","payload":{"plainToken":"abc"}}`)
	now := time.Unix(1_700_000_000, 0)
	ts := "1700000000"
	secret := "whsec"
	mac := hmacHex(secret, ts, body)
	if err := VerifySignature(secret, ts, mac, body, now); err != nil {
		t.Fatal(err)
	}
	if err := VerifySignature(secret, ts, "v0=nope", body, now); err == nil {
		t.Fatal("bad signature accepted")
	}
	if ValidationToken(secret, "abc") == "" {
		t.Fatal("empty validation token")
	}
}

func hmacHex(secret, ts string, body []byte) string {
	return "v0=" + ValidationToken(secret, "v0:"+ts+":"+string(body))
}

func errorsIsNotConnected(err error) bool {
	return err != nil && (err == ErrNotConnected || strings.Contains(err.Error(), "not connected"))
}

type memRepo struct {
	mu           sync.Mutex
	conns        map[string]Connection
	joins        map[string]string
	notes        map[string]string
	regIDs       map[string]string
	meetingJoins map[string]string
}

func newMem() *memRepo {
	return &memRepo{
		conns:  map[string]Connection{},
		joins:  map[string]string{},
		notes:  map[string]string{},
		regIDs: map[string]string{},
	}
}

func (m *memRepo) Connection(_ context.Context, userID string) (Connection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.conns[userID]
	if !ok {
		return Connection{}, ErrNotConnected
	}
	return c, nil
}

func (m *memRepo) SaveConnection(_ context.Context, c Connection) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.conns[c.UserID] = c
	return nil
}

func (m *memRepo) SaveRefresh(_ context.Context, userID string, cipher []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[userID]
	c.Refresh = cipher
	c.Invalid = false
	m.conns[userID] = c
	return nil
}

func (m *memRepo) MarkInvalid(_ context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[userID]
	c.Invalid = true
	m.conns[userID] = c
	return nil
}

func (m *memRepo) DeleteConnection(_ context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.conns, userID)
	return nil
}

func (m *memRepo) DeleteByZoomUser(_ context.Context, zoomUserID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, c := range m.conns {
		if c.ZoomUserID == zoomUserID {
			delete(m.conns, id)
		}
	}
	return nil
}

func (m *memRepo) SaveRegistrant(_ context.Context, regID, registrantID, joinURL, note string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.joins[regID] = joinURL
	m.regIDs[regID] = registrantID
	m.notes[regID] = note
	return nil
}

func (m *memRepo) RegistrantJoin(_ context.Context, regID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.joins[regID], nil
}

func (m *memRepo) RegistrantRef(_ context.Context, regID string) (string, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.regIDs[regID], m.joins[regID], nil
}

func (m *memRepo) SaveMeetingJoin(_ context.Context, zoomID, joinURL string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.meetingJoins == nil {
		m.meetingJoins = map[string]string{}
	}
	m.meetingJoins[zoomID] = joinURL
	return nil
}

func (m *memRepo) PushedCount(context.Context, string) (int, error) { return 0, nil }

func TestRegistrationUnavailable(t *testing.T) {
	paid := &APIError{Status: 400, Code: 200, Message: "Only available for Paid users."}
	off := &APIError{Status: 400, Code: 300, Message: "Registration has not been enabled for this meeting."}
	off3000 := &APIError{Status: 400, Code: 3000, Message: "Registration has not been enabled for this meeting."}
	missing := &APIError{Status: 404, Code: 3001, Message: "Meeting does not exist: 1001."}
	scope := &APIError{Status: 400, Code: 4711, Message: "Invalid access token, does not contain scopes:[meeting:write:registrant]."}
	rate := &APIError{Status: 429, Code: 429, Message: "You have exceeded the daily rate limit."}
	if !RegistrationUnavailable(paid) || !RegistrationUnavailable(off) || !RegistrationUnavailable(off3000) {
		t.Fatal("registration refusals should be recognized")
	}
	if RegistrationUnavailable(missing) || RegistrationUnavailable(scope) || RegistrationUnavailable(rate) || RegistrationUnavailable(errors.New("dial")) {
		t.Fatal("real failures must not look like a registration refusal")
	}
}

func TestPushMeetingSharedLinkFallback(t *testing.T) {
	const shared = "https://zoom.us/j/shared-meeting"
	const personal = "https://zoom.us/j/personal"
	cases := []struct {
		name      string
		venue     string
		status    int
		body      string
		shared    string
		fetch     bool
		priorID   string
		priorJoin string
		wantJoin  string
		wantNote  string
		wantReg   string
		wantErr   bool
		wantCode  int
		logMsg    string
	}{
		{
			name:     "paid meeting uses the shared link",
			venue:    VenueMeeting,
			status:   400,
			body:     `{"code":200,"message":"Only available for Paid users."}`,
			shared:   shared,
			wantJoin: shared,
			logMsg:   "Only available for Paid users.",
			wantCode: 200,
		},
		{
			name:     "registration disabled uses the shared link",
			venue:    VenueMeeting,
			status:   400,
			body:     `{"code":300,"message":"Registration has not been enabled for this meeting."}`,
			shared:   shared,
			wantJoin: shared,
			wantCode: 300,
		},
		{
			name:     "code 3000 registration refusal uses the shared link",
			venue:    VenueMeeting,
			status:   400,
			body:     `{"code":3000,"message":"Registration has not been enabled for this meeting."}`,
			shared:   shared,
			wantJoin: shared,
			wantCode: 3000,
		},
		{
			name:     "missing stored link is read back from the meeting",
			venue:    VenueMeeting,
			status:   400,
			body:     `{"code":200,"message":"Only available for Paid users."}`,
			fetch:    true,
			wantJoin: shared,
			wantCode: 200,
		},
		{
			name:     "deleted meeting stays an error",
			venue:    VenueMeeting,
			status:   404,
			body:     `{"code":3001,"message":"Meeting does not exist: 1001."}`,
			shared:   shared,
			wantNote: "Zoom didn't accept this person. They have no Zoom link yet.",
			wantErr:  true,
			wantCode: 3001,
		},
		{
			name:     "missing scope stays an error",
			venue:    VenueMeeting,
			status:   400,
			body:     `{"code":4711,"message":"Invalid access token, does not contain scopes:[meeting:write:registrant]."}`,
			shared:   shared,
			wantNote: "Zoom didn't accept this person. They have no Zoom link yet.",
			wantErr:  true,
			wantCode: 4711,
		},
		{
			name:     "rate limit stays an error",
			venue:    VenueMeeting,
			status:   429,
			body:     `{"code":429,"message":"You have exceeded the daily rate limit."}`,
			shared:   shared,
			wantNote: "Zoom is limiting requests. This person has no Zoom link yet.",
			wantErr:  true,
			wantCode: 429,
		},
		{
			name:     "webinar registration refusal is not a shared link",
			venue:    VenueWebinar,
			status:   400,
			body:     `{"code":200,"message":"Only available for Paid users."}`,
			shared:   shared,
			wantNote: "Zoom didn't accept this person. They have no Zoom link yet.",
			wantErr:  true,
			wantCode: 200,
		},
		{
			name:     "a personal registrant link wins",
			venue:    VenueMeeting,
			status:   201,
			body:     `{"registrant_id":"rid-1","join_url":"` + personal + `"}`,
			shared:   shared,
			wantJoin: personal,
			wantReg:  "rid-1",
		},
		{
			name:      "an existing personal link is left alone",
			venue:     VenueMeeting,
			status:    500,
			body:      `{"code":200,"message":"Only available for Paid users."}`,
			shared:    shared,
			priorID:   "rid-1",
			priorJoin: personal,
			wantJoin:  personal,
			wantReg:   "rid-1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls int
			mux := http.NewServeMux()
			mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"access_token":"access-1","refresh_token":"refresh-2","expires_in":3600}`)
			})
			kind := "meetings"
			if tc.venue == VenueWebinar {
				kind = "webinars"
			}
			mux.HandleFunc("/v2/"+kind+"/1001", func(w http.ResponseWriter, r *http.Request) {
				if !tc.fetch {
					t.Errorf("unexpected read of the zoom object")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"id":1001,"start_url":"https://zoom.us/s/host","join_url":"`+shared+`"}`)
			})
			mux.HandleFunc("/v2/"+kind+"/1001/registrants", func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Content-Type", "application/json")
				if tc.status >= 300 {
					w.WriteHeader(tc.status)
				}
				_, _ = io.WriteString(w, tc.body)
			})
			srv := httptest.NewServer(mux)
			defer srv.Close()
			key, _ := ParseKey("0123456789abcdef0123456789abcdef")
			blob, _ := Seal(key, "refresh-1")
			repo := newMem()
			repo.conns["host-a"] = Connection{UserID: "host-a", Email: "a@example.com", Refresh: blob}
			if tc.priorJoin != "" {
				repo.joins["reg-1"] = tc.priorJoin
				repo.regIDs["reg-1"] = tc.priorID
			}
			var logs bytes.Buffer
			f := &Flow{
				Client: &Client{ID: "id", Secret: "secret", API: srv.URL + "/v2", OAuth: srv.URL, HTTP: srv.Client()},
				Repo:   repo,
				Seal:   func(p string) ([]byte, error) { return Seal(key, p) },
				Open:   func(b []byte) (string, error) { return Open(key, b) },
				Log:    slog.New(slog.NewTextHandler(&logs, nil)),
			}
			err := f.Push(context.Background(), "host-a", tc.venue, "1001", "reg-1", "one@example.com", "One", "A", tc.shared)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				var api *APIError
				if !errors.As(err, &api) || api.Code != tc.wantCode {
					t.Fatalf("err = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if repo.joins["reg-1"] != tc.wantJoin || repo.notes["reg-1"] != tc.wantNote || repo.regIDs["reg-1"] != tc.wantReg {
				t.Fatalf("join=%q note=%q reg=%q", repo.joins["reg-1"], repo.notes["reg-1"], repo.regIDs["reg-1"])
			}
			if tc.priorID != "" && calls != 0 {
				t.Fatalf("zoom was called %d times for an existing personal link", calls)
			}
			if tc.fetch && repo.meetingJoins["1001"] != shared {
				t.Fatalf("stored meeting join = %q", repo.meetingJoins["1001"])
			}
			logged := logs.String()
			if strings.Contains(logged, "zoom.us/") {
				t.Fatalf("log contains a join link:\n%s", logged)
			}
			if tc.logMsg != "" && !strings.Contains(logged, tc.logMsg) {
				t.Fatalf("log missing %q:\n%s", tc.logMsg, logged)
			}
			if tc.wantJoin == shared && tc.wantCode != 0 && !strings.Contains(logged, "code="+strconv.Itoa(tc.wantCode)) {
				t.Fatalf("log missing code %d:\n%s", tc.wantCode, logged)
			}
		})
	}
}

func TestSharedLinkUpgradesWhenRegistrationWorks(t *testing.T) {
	const shared = "https://zoom.us/j/shared-meeting"
	const personal = "https://zoom.us/j/personal"
	var n int
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600}`)
	})
	mux.HandleFunc("/v2/meetings/1001/registrants", func(w http.ResponseWriter, r *http.Request) {
		n++
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"code":200,"message":"Only available for Paid users."}`)
			return
		}
		_, _ = io.WriteString(w, `{"registrant_id":"rid-2","join_url":"`+personal+`"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	key, _ := ParseKey("0123456789abcdef0123456789abcdef")
	blob, _ := Seal(key, "refresh-1")
	repo := newMem()
	repo.conns["host-a"] = Connection{UserID: "host-a", Refresh: blob}
	f := &Flow{
		Client: &Client{ID: "id", Secret: "secret", API: srv.URL + "/v2", OAuth: srv.URL, HTTP: srv.Client()},
		Repo:   repo,
		Open:   func(b []byte) (string, error) { return Open(key, b) },
	}
	if err := f.Push(context.Background(), "host-a", VenueMeeting, "1001", "reg-1", "one@example.com", "One", "A", shared); err != nil {
		t.Fatal(err)
	}
	if repo.joins["reg-1"] != shared || repo.regIDs["reg-1"] != "" || repo.notes["reg-1"] != "" {
		t.Fatalf("after refusal: join=%q reg=%q note=%q", repo.joins["reg-1"], repo.regIDs["reg-1"], repo.notes["reg-1"])
	}
	if err := f.Push(context.Background(), "host-a", VenueMeeting, "1001", "reg-1", "one@example.com", "One", "A", shared); err != nil {
		t.Fatal(err)
	}
	if repo.joins["reg-1"] != personal || repo.regIDs["reg-1"] != "rid-2" || repo.notes["reg-1"] != "" {
		t.Fatalf("after upgrade: join=%q reg=%q note=%q", repo.joins["reg-1"], repo.regIDs["reg-1"], repo.notes["reg-1"])
	}
}
