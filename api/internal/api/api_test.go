package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Integration tests against a real Postgres.
 *
 * They need a database because the authorization rules being tested — "an
 * unapproved registration cannot join", "a host cannot manage someone else's
 * webinar" — live in SQL and transactions. Mocking the store would test the
 * mock. LiveKit is faked, because whether the SFU works is not what's under test.
 *
 * Set TEST_DATABASE_URL to run; skipped otherwise so `go test ./...` stays green
 * on a machine with no database.
 */

// ------------------------------------------------------------- fake LiveKit

type fakeRooms struct {
	mu sync.Mutex
	// project is this fake's id, so a URL and a token can be traced back to the project that
	// produced them — which is the whole thing a multi-project test has to assert.
	project string
	/* refuseRooms makes EnsureRoom fail, which is how an exhausted LiveKit Cloud allowance
	 * presents: the project stops accepting new rooms. There is no way to arrange that
	 * against the real service from a test, and it is the trigger for the failover in
	 * Server.ensureRoom, so it has to be arrangeable here. */
	refuseRooms bool
	/* onEnsureRoom runs inside EnsureRoom, before it returns.
	 *
	 * The only way to make a CONCURRENT event deterministic: it simulates another request
	 * moving this webinar to a different project while this one is mid-call to the SFU, which
	 * is the exact window the follow-the-failover re-read in ensureRoom exists to close.
	 * Reproducing that with real goroutines is a race, and a race in a test is a flake. */
	onEnsureRoom func()
	created      map[string]uint32
	metadata     map[string]string
	count        int
	countErr     error

	lastSpec lk.Spec

	roster []types.LiveParticipant
	// promoted tracks, per identity, whether their stage seat came from the
	// host lifting them out of the audience rather than a scheduled panelist
	// slot — the real SFU carries this in the participant's own metadata
	// (lk.Metadata.Promoted); types.LiveParticipant has no such field, so the
	// fake keeps it alongside the roster instead. AllowAllToSpeak/
	// RevokeAllSpeaking are exactly the pair of bulk actions that need this
	// distinction to behave like the real thing: a scheduled panelist must
	// never be swept up in "revoke everyone I promoted".
	promoted map[string]bool

	// Recorded moderation calls, so a test can assert what reached the SFU
	// rather than only what the endpoint returned.
	muteAllKeep   []map[string]bool
	muted         []string
	speakingCalls []string
	hideAllCall   []hideCall
	roleChanges   []lk.Spec
	removed       []string
	deleted       []string
	egressCalls   []string
	stoppedEgress []string
	egressErr     error
	// liveEgress is what LiveKit would report for the room: the thing the
	// broadcast sweeper trusts over the API's own map of what it once started.
	liveEgress []*livekit.EgressInfo
	// sent records every realtime packet the API handed to the SFU, with the
	// recipient list. The list is the thing worth asserting: it is what decides who
	// a panelist-only message actually reaches.
	sent []sentPacket
}

type sentPacket struct {
	room  string
	topic string
	data  []byte
	to    []string
}

type hideCall struct {
	role   types.Role
	hidden bool
}

func newFakeRooms() *fakeRooms {
	return newFakeProject("test")
}

// newFakeProject is one LiveKit project's worth of fake. Named so a multi-project test reads
// as what it is; newFakeRooms is the single-project shorthand every other test uses.
func newFakeProject(id string) *fakeRooms {
	return &fakeRooms{
		project:  id,
		created:  map[string]uint32{},
		metadata: map[string]string{},
		promoted: map[string]bool{},
	}
}

// URL carries the project id, because "which project did this browser get pointed at" is
// exactly what the multi-project tests need to see.
func (f *fakeRooms) URL() string { return "ws://fake-livekit-" + f.project + ":7880" }

func (f *fakeRooms) Token(spec lk.Spec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastSpec = spec
	// Sanity: the real grant builder must accept this spec.
	if _, err := lk.GrantFor(spec); err != nil {
		return "", err
	}
	// The project is in the token for the same reason it is in the URL: a token signed by one
	// project alongside another's address is the failure mode worth catching.
	return "fake-token-for-" + string(spec.Role) + "@" + f.project, nil
}

func (f *fakeRooms) EnsureRoom(_ context.Context, room string, max, _ uint32, metadata string) (int, bool, error) {
	f.mu.Lock()
	hook := f.onEnsureRoom
	f.mu.Unlock()
	// Outside the lock: the hook writes to the database and may call back in here.
	if hook != nil {
		hook()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refuseRooms {
		// What an exhausted project looks like from here.
		return 0, false, fmt.Errorf("fake project %s refuses new rooms", f.project)
	}
	f.created[room] = max
	if _, exists := f.metadata[room]; !exists {
		f.metadata[room] = metadata
	}
	// known=false, so a test exercising the ceiling still goes through
	// ParticipantCount below — which is the fake's own notion of occupancy.
	return 0, false, nil
}

func (f *fakeRooms) SetMetadata(_ context.Context, room, metadata string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.metadata[room] = metadata
	return nil
}

func (f *fakeRooms) SendData(_ context.Context, room, topic string, data []byte, to []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, sentPacket{room: room, topic: topic, data: data, to: to})
	return nil
}

func (f *fakeRooms) ParticipantCount(context.Context, string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.count, f.countErr
}

func (f *fakeRooms) Participants(context.Context, string) ([]types.LiveParticipant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]types.LiveParticipant, len(f.roster))
	copy(out, f.roster)
	return out, nil
}

func (f *fakeRooms) MuteTrack(_ context.Context, _, identity string, _ livekit.TrackSource, muted bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.muted = append(f.muted, fmt.Sprintf("%s=%v", identity, muted))
	return nil
}

func (f *fakeRooms) MuteAll(_ context.Context, _ string, keep map[string]bool) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.muteAllKeep = append(f.muteAllKeep, keep)
	n := 0
	for _, p := range f.roster {
		if !keep[p.Identity] && !p.AudioMuted {
			n++
		}
	}
	return n, nil
}

func (f *fakeRooms) SetRole(_ context.Context, spec lk.Spec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.roleChanges = append(f.roleChanges, spec)
	// Mirrors the real metadata: a promotion is recorded only alongside a
	// panelist role, and sending someone back to the audience always clears
	// it — the same narrowing lk.metadataFor applies to Metadata.Promoted.
	if spec.Role == types.RolePanelist && spec.Promoted {
		f.promoted[spec.Identity] = true
	} else {
		delete(f.promoted, spec.Identity)
	}
	for i, p := range f.roster {
		if p.Identity != spec.Identity {
			continue
		}
		f.roster[i].Role = spec.Role
		f.roster[i].CanPublish = lk.CanPublish(spec.Role)
		f.roster[i].CanSpeak = lk.CanPublish(spec.Role) && !spec.MutedByHost
		f.roster[i].AudioOnly = spec.AudioOnly
		f.roster[i].MutedByHost = spec.MutedByHost
		return nil
	}
	return nil
}

// AllowAllToSpeak models the same narrowing the real SFU applies: only
// current attendees move, to the audio-only grant, and it is recorded as a
// promotion. A scheduled or already-promoted panelist is left alone.
func (f *fakeRooms) AllowAllToSpeak(_ context.Context, _ string, hideAttendees bool) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var granted []string
	for i, p := range f.roster {
		if p.Role != types.RoleAttendee {
			continue
		}
		f.roster[i].Role = types.RolePanelist
		f.roster[i].CanPublish = true
		f.roster[i].CanSpeak = true
		f.roster[i].AudioOnly = true
		f.roster[i].MutedByHost = false
		f.roster[i].Hidden = false // panelists are never hidden, regardless of hideAttendees
		f.promoted[p.Identity] = true
		granted = append(granted, p.Identity)
	}
	return granted, nil
}

// BringAllOnStage is AllowAllToSpeak's fake counterpart, widened to the full
// grant — AudioOnly false — the same way the real BringAllOnStage differs
// from the real AllowAllToSpeak and nothing else.
func (f *fakeRooms) BringAllOnStage(_ context.Context, _ string, hideAttendees bool) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var granted []string
	for i, p := range f.roster {
		if p.Role != types.RoleAttendee {
			continue
		}
		f.roster[i].Role = types.RolePanelist
		f.roster[i].CanPublish = true
		f.roster[i].CanSpeak = true
		f.roster[i].AudioOnly = false
		f.roster[i].MutedByHost = false
		f.roster[i].Hidden = false // panelists are never hidden, regardless of hideAttendees
		f.promoted[p.Identity] = true
		granted = append(granted, p.Identity)
	}
	return granted, nil
}

// RevokeAllSpeaking only moves identities the fake's own SetRole recorded as
// promoted — never a scheduled panelist — the same restriction the real
// RevokeAllSpeaking enforces via specOf.
func (f *fakeRooms) RevokeAllSpeaking(_ context.Context, _ string, hideAttendees bool) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var revoked []string
	for i, p := range f.roster {
		if !f.promoted[p.Identity] {
			continue
		}
		f.muted = append(f.muted, fmt.Sprintf("%s=true", p.Identity))
		f.roster[i].Role = types.RoleAttendee
		f.roster[i].CanPublish = false
		f.roster[i].CanSpeak = false
		f.roster[i].AudioOnly = false
		f.roster[i].MutedByHost = false
		f.roster[i].Hidden = hideAttendees
		delete(f.promoted, p.Identity)
		revoked = append(revoked, p.Identity)
	}
	return revoked, nil
}

// SetSpeaking models the real thing closely enough to be worth asserting against:
// it refuses the same cases the SFU refuses, and it moves the roster, so a test
// can check the state a host would actually see afterwards rather than only that
// a call was made.
func (f *fakeRooms) SetSpeaking(_ context.Context, _, identity string, blocked bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.speakingCalls = append(f.speakingCalls, fmt.Sprintf("%s=%v", identity, blocked))
	for i, p := range f.roster {
		if p.Identity != identity {
			continue
		}
		if p.Role == types.RoleHost {
			return lk.ErrIsHost
		}
		if p.Role != types.RolePanelist {
			return lk.ErrNotSpeaking
		}
		f.roster[i].CanSpeak = !blocked
		f.roster[i].MutedByHost = blocked
		return nil
	}
	return lk.ErrNotInRoom
}

func (f *fakeRooms) BlockSpeakingAll(_ context.Context, _ string, keep map[string]bool) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	blocked := 0
	for i, p := range f.roster {
		if keep[p.Identity] || p.Role != types.RolePanelist || p.MutedByHost {
			continue
		}
		f.roster[i].CanSpeak = false
		f.roster[i].MutedByHost = true
		blocked++
	}
	return blocked, nil
}

func (f *fakeRooms) HideAll(_ context.Context, _ string, role types.Role, hidden bool) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hideAllCall = append(f.hideAllCall, hideCall{role, hidden})
	return 1, nil
}

func (f *fakeRooms) RemoveParticipant(_ context.Context, _, identity string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, identity)
	return nil
}

func (f *fakeRooms) DeleteRoom(_ context.Context, room string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, room)
	return nil
}

func (f *fakeRooms) StartRoomCompositeEgress(_ context.Context, roomName, storageKey string, _ lk.EgressS3Options, _ string, _ livekit.EncodingOptionsPreset) (*livekit.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.egressErr != nil {
		return nil, f.egressErr
	}
	f.egressCalls = append(f.egressCalls, roomName+":"+storageKey)
	return &livekit.EgressInfo{
		EgressId: "EG_fake_" + roomName,
		Status:   livekit.EgressStatus_EGRESS_STARTING,
	}, nil
}

func (f *fakeRooms) StartBroadcastEgress(_ context.Context, roomName string, _ string, _ livekit.EncodingOptionsPreset, rtmpURL string, extraURLs []string) (*livekit.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.egressErr != nil {
		return nil, f.egressErr
	}
	f.egressCalls = append(f.egressCalls, roomName+":"+rtmpURL)
	if len(extraURLs) > 0 {
		f.egressCalls = append(f.egressCalls, "extra:"+strings.Join(extraURLs, ","))
	}
	return &livekit.EgressInfo{
		EgressId: "EG_fake_hls_" + roomName,
		Status:   livekit.EgressStatus_EGRESS_STARTING,
	}, nil
}

func (f *fakeRooms) StartCombinedEgress(_ context.Context, roomName string, _ string, _ livekit.EncodingOptionsPreset, rtmpURL string, storageKey string, _ lk.EgressS3Options, extraURLs []string) (*livekit.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.egressErr != nil {
		return nil, f.egressErr
	}
	f.egressCalls = append(f.egressCalls, roomName+":"+rtmpURL+":"+storageKey)
	if len(extraURLs) > 0 {
		f.egressCalls = append(f.egressCalls, "extra:"+strings.Join(extraURLs, ","))
	}
	return &livekit.EgressInfo{
		EgressId: "EG_fake_both_" + roomName,
		Status:   livekit.EgressStatus_EGRESS_STARTING,
	}, nil
}

func (f *fakeRooms) UpdateStream(_ context.Context, egressID string, add, remove []string) (*livekit.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.egressErr != nil {
		return nil, f.egressErr
	}
	f.egressCalls = append(f.egressCalls, "update:"+egressID)
	return &livekit.EgressInfo{EgressId: egressID, Status: livekit.EgressStatus_EGRESS_ACTIVE}, nil
}

func (f *fakeRooms) ListEgress(_ context.Context, _ string) ([]*livekit.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.liveEgress, nil
}

func (f *fakeRooms) StopEgress(_ context.Context, egressID string) (*livekit.EgressInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stoppedEgress = append(f.stoppedEgress, egressID)
	return &livekit.EgressInfo{
		EgressId: egressID,
		Status:   livekit.EgressStatus_EGRESS_ENDING,
	}, nil
}

func (f *fakeRooms) setRoster(list ...types.LiveParticipant) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.roster = list
}

// lastSent returns the most recent realtime packet, decoded.
func (f *fakeRooms) lastSent(t *testing.T) (map[string]any, []string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sent) == 0 {
		t.Fatal("no realtime packet was ever delivered to the SFU")
	}
	last := f.sent[len(f.sent)-1]
	var out map[string]any
	if err := json.Unmarshal(last.data, &out); err != nil {
		t.Fatalf("packet is not decodable: %v (%q)", err, last.data)
	}
	return out, last.to
}

// roomMeta decodes what the server pushed into room metadata, which is how a
// control change is meant to reach 500 browsers.
func (f *fakeRooms) roomMeta(t *testing.T, room string) types.RoomMeta {
	t.Helper()
	f.mu.Lock()
	raw := f.metadata[room]
	f.mu.Unlock()
	if raw == "" {
		t.Fatalf("no metadata was ever set on room %q", room)
	}
	var meta types.RoomMeta
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		t.Fatalf("room metadata is not decodable: %v (%q)", err, raw)
	}
	return meta
}

// --------------------------------------------------------------- test setup

type harness struct {
	t   *testing.T
	srv *httptest.Server
	// The same handler the server is serving, for the one test that reads the route
	// table instead of calling it. See isolation_test.go.
	handler http.Handler
	// rooms is the DEFAULT project's fake — the one every single-project test asserts on.
	// Multi-project tests reach for h.pool instead.
	rooms *fakeRooms
	// pool is every project the server was given, so a test can disable one, delete one, or
	// make one refuse rooms.
	pool   *fakePool
	client *http.Client
	// The store, for putting a fixture into a state directly. Used by goLive below;
	// anything that is testing an HTTP contract must go through the HTTP surface.
	store *store.Store
	/* Where the disk storage backend writes. Exposed so a test can assert about FILES rather
	 * than about rows — "deleting a webinar takes its recordings with it" is a claim about
	 * bytes, and every version of that claim checked against the database alone would have
	 * passed while leaving the files on disk for ever. */
	recordingsDir string
}

// newHarness builds a server against the test database. `tweak` adjusts the
// configuration before the server is constructed, for the settings whose whole
// point is to change behaviour — variadic so every existing caller is unaffected.
/* fakePool is the SFUPool the tests run against.
 *
 * Ordered rather than a bare map, because Candidates() order is load-bearing: it decides which
 * project a new room lands on, and a map would make that answer depend on Go's hash seed.
 */
type fakePool struct {
	ids      []string
	projects map[string]*fakeRooms
	// enabled mirrors the `disabled` flag in LIVEKIT_PROJECTS. A disabled project still
	// serves the webinars pinned to it; it just stops taking new ones.
	enabled map[string]bool
}

func newFakePool(projects ...*fakeRooms) *fakePool {
	p := &fakePool{projects: map[string]*fakeRooms{}, enabled: map[string]bool{}}
	for _, r := range projects {
		p.ids = append(p.ids, r.project)
		p.projects[r.project] = r
		p.enabled[r.project] = true
	}
	return p
}

func (p *fakePool) Get(id string) (api.RoomManager, error) {
	if r, ok := p.projects[id]; ok {
		return r, nil
	}
	// Wrapped so errors.Is(err, lk.ErrUnknownProject) holds, which is what the handlers
	// switch on to decide between a repin and a 503.
	return nil, fmt.Errorf("%w %q", lk.ErrUnknownProject, id)
}

func (p *fakePool) Candidates() []string {
	out := []string{}
	for _, id := range p.ids {
		if p.enabled[id] {
			out = append(out, id)
		}
	}
	return out
}

func (p *fakePool) IDs() []string { return append([]string{}, p.ids...) }

func (p *fakePool) KeyProvider() lkauth.KeyProvider {
	return fakeKeyProvider{}
}

type fakeKeyProvider struct{}

func (fakeKeyProvider) GetSecret(key string) string { return "secret_" + key }
func (fakeKeyProvider) NumKeys() int                { return 1 }

// forget removes a project entirely, which is what an operator deleting it from
// LIVEKIT_PROJECTS does. Distinct from disabling: a forgotten project cannot serve even the
// webinars already pinned to it.
func (p *fakePool) forget(id string) {
	delete(p.projects, id)
	delete(p.enabled, id)
	kept := p.ids[:0]
	for _, existing := range p.ids {
		if existing != id {
			kept = append(kept, existing)
		}
	}
	p.ids = kept
}

func newHarness(t *testing.T, tweak ...func(*config.Config)) *harness {
	t.Helper()
	return newHarnessWith(t, nil, tweak...)
}

/* newHarnessWith is newHarness plus additional LiveKit projects, in priority order after the
 * default one.
 *
 * A second constructor rather than an option on the first, because Go allows one variadic and
 * the ~90 existing callers all use it for config tweaks. Everything about the server is
 * otherwise identical, so a multi-project test differs from a single-project one in exactly the
 * thing it is testing.
 */
func newHarnessWith(
	t *testing.T, extraProjects []*fakeRooms, tweak ...func(*config.Config),
) *harness {
	t.Helper()

	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration tests")
	}

	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	st, err := store.Open(ctx, dsn, log)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(st.Close)

	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := truncateAll(ctx, dsn); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	hash, err := auth.HashPassword("webcast-dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SeedDev(ctx, hash); err != nil {
		t.Fatalf("seed: %v", err)
	}

	cfg := config.Config{
		Env:           "development",
		SessionSecret: "test-secret-test-secret-test-secret-32",
		SessionTTL:    time.Hour,
		TokenTTL:      time.Hour,
		MaxAttendees:  500,
		// Mirrors the production default. Left at zero, every webinar created without an
		// explicit limit got attendee_limit 0 and refused its first registrant.
		DefaultAttendeeLimit: 50,
		RegisterPerMin:       1000, // don't let the rate limiter interfere
		JoinPerMin:           1000,
		CORSOrigins:          []string{"http://localhost:3000"},
		AppName:              "Webcast Test",
		WebBaseURL:           "http://localhost:3000",
		SignupOpen:           true,
		// Small enough that the size cap can be exercised in a test without
		// generating megabytes of fake video.
		RecordingsEnabled: true,
		MaxRecordingMB:    1,
		// The production floor rather than the relaxed development one, so the rule
		// under test is the one a real deployment applies.
		MinPasswordLength: 10,
	}
	for _, fn := range tweak {
		fn(&cfg)
	}

	// Real disk storage in a temp directory the test framework removes: the
	// interesting failures in the recording path are about files, and a fake
	// storage backend would not have any of them.
	recordingsDir := t.TempDir()
	recordings, err := media.NewDisk(recordingsDir)
	if err != nil {
		t.Fatalf("recording storage: %v", err)
	}

	rooms := newFakeRooms()
	/* One project unless the test says otherwise.
	 *
	 * Passed through the config tweak like everything else that changes behaviour, so the
	 * ~90 existing tests are unaffected: they get a single-project pool whose one member is
	 * h.rooms, which is exactly what they were given before the pool existed.
	 */
	pool := newFakePool(rooms)
	for _, extra := range extraProjects {
		pool.ids = append(pool.ids, extra.project)
		pool.projects[extra.project] = extra
		pool.enabled[extra.project] = true
	}
	/* The handler is kept as well as the server it is wrapped in, because one test needs to
	 * ENUMERATE the routes rather than call them: see isolation_test.go, which walks the real
	 * route table so that a host route added tomorrow is covered without anyone remembering
	 * to add it to a list. */
	handler := api.NewServer(cfg, st, pool, recordings, log).Routes()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	// A cookie jar so the session persists across requests, like a browser.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{
		t: t, srv: srv, handler: handler, rooms: rooms, pool: pool,
		client: &http.Client{Jar: jar}, store: st,
		recordingsDir: recordingsDir,
	}
}

func (h *harness) do(method, path string, body any) (*http.Response, []byte) {
	h.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rdr)
	if err != nil {
		h.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

// doRaw sends bytes rather than JSON, for the recording chunk upload. Optional
// headers cover the one caller that needs a Range request.
func (h *harness) doRaw(
	method, path, contentType string, body []byte, headers map[string]string,
) (*http.Response, []byte) {
	h.t.Helper()
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rdr)
	if err != nil {
		h.t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

func (h *harness) decode(raw []byte, dst any) {
	h.t.Helper()
	if err := json.Unmarshal(raw, dst); err != nil {
		h.t.Fatalf("decode %s: %v", string(raw), err)
	}
}

func (h *harness) login(email string) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{
		Email: email, Password: "webcast-dev",
	})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("login as %s: status %d body %s", email, res.StatusCode, raw)
	}
}

// signup creates an account and leaves its session in the cookie jar.
//
// wantsHost here means "does this test want the resulting account to be
// able to host" — it is the caller's request about the fixture, not (only)
// the wire field of the same name sent to the API.
func (h *harness) signup(name, email string, wantsHost bool) types.Account {
	h.t.Helper()
	// Same password as the seeded accounts so h.login works for either.
	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: name, Email: email, Password: "webcast-dev", WantsHost: wantsHost,
	})
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("signup %s: status %d body %s", email, res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)

	/* Every signup grants hosting unconditionally now — see handleSignup — so
	 * acct.CanHost is true here regardless of what wantsHost (the parameter,
	 * or the wire field of the same name, which the server ignores either
	 * way) said. A test that wants a fixture WITHOUT hosting is the one case
	 * that now needs an explicit extra step: revoke it through the store, the
	 * same write an admin's PATCH performs — an admin taking hosting away is
	 * still the only way an account ends up without it after signup.
	 *
	 * Done in the harness rather than in the ~90 tests that call it, because
	 * those tests are about what a host can or cannot DO, not about how the
	 * fixture account came to have (or not have) the capability. The grant
	 * and revoke paths themselves are tested directly in admin_test.go.
	 *
	 * No re-login needed either way: authenticate() re-reads the account from
	 * the database on every request, so a capability change here applies to
	 * the very next call.
	 */
	if !acct.CanHost {
		h.t.Fatalf("signup did not grant hosting to %s; the automatic-hosting policy is broken", email)
	}
	if !wantsHost {
		if _, err := h.store.SetHostCapability(context.Background(), acct.ID, false); err != nil {
			h.t.Fatalf("revoke hosting from %s: %v", email, err)
		}
		acct.CanHost = false
	}
	return acct
}

func (h *harness) logout() {
	h.t.Helper()
	if res, raw := h.do(http.MethodPost, "/api/auth/logout", nil); res.StatusCode != http.StatusOK {
		h.t.Fatalf("logout: status %d body %s", res.StatusCode, raw)
	}
}

// newWebinar schedules a webinar as the currently signed-in host and returns it.
func (h *harness) newWebinar(topic string, mutate func(*types.WebinarInput)) types.Webinar {
	h.t.Helper()
	in := types.WebinarInput{
		Topic: topic,
		/* Five minutes out, not an hour.
		 *
		 * Inside the join window (see joinGrace in join.go), because most tests here
		 * register and then immediately join, and an attendee joining a session that is
		 * still an hour away is not a scenario any of them mean to exercise — it is a
		 * fixture accident that used to be invisible because there was no window at all.
		 * Tests that care about the window set their own time; see joinwindow_test.go. */
		StartsAt:             time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339),
		Duration:             60,
		TimeZone:             "UTC",
		Kind:                 types.KindLive,
		Status:               types.StatusScheduled,
		RegistrationRequired: true,
		Approval:             types.ApprovalAutomatic,
		AttendeeLimit:        100,
		Controls: types.SessionControls{
			HideAttendees: true, MuteOnEntry: true, AllowUnmute: true,
			ChatEnabled: true, QAEnabled: true, RaiseHandEnabled: true,
			ReactionsEnabled: true, PollsEnabled: true,
		},
	}
	if mutate != nil {
		mutate(&in)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}

/* seedPasscode is the passcode on the seeded webinar most tests register for.
 *
 * It is sent by both register helpers, and it has to be, because the passcode is now
 * actually enforced — it used to be stored and never compared, so every test here
 * registered for a passcode-protected webinar without one and nobody noticed. A webinar
 * with no passcode ignores the field, so sending it unconditionally is harmless and keeps
 * the helpers from needing to know which fixture they are pointed at.
 *
 * Tests that are ABOUT the gate do not use these helpers — see passcode_test.go. */
const seedPasscode = "228104"

/* A valid number for the helpers, since registration now requires one.
 *
 * Tests that are ABOUT the number supply their own — see passcode_test.go. Everything else just
 * needs the form to be complete, the same way it needs an email address. */
const testPhone = "+919876543210"

/* goLive puts a fixture into the state an attendee can actually join.
 *
 * Straight through the store rather than POST /start, and deliberately: the tests that use
 * this are about tokens, capacity and approval, and routing through the host endpoint would
 * make each of them log in as whichever seeded account happens to own the fixture, then log
 * back in as whoever they were. That is session juggling in service of a precondition.
 *
 * It exists because the seeded webinars are scheduled weeks out, and an attendee cannot
 * join a webinar weeks early any more — see joinGrace in join.go. Before that window
 * existed these tests passed by accident.
 */
func (h *harness) goLive(slug string) {
	h.t.Helper()
	if _, err := h.store.SetStatus(context.Background(), slug, types.StatusLive); err != nil {
		h.t.Fatalf("goLive %s: %v", slug, err)
	}
}

func (h *harness) registerAs(slug, email string) types.Registration {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/register", types.RegisterRequest{
		FirstName: "Test", LastName: "User", Email: email, Consent: true,
		Passcode: seedPasscode,
		Phone:    testPhone,
		Answers:  map[string]string{"stack": "Postgres", "scale": "Under 100"},
	})
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		h.t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	return reg
}

// registerAsGuest registers with no cookies at all, which is the path someone
// coming from an emailed link takes. Using a separate client keeps the
// harness's own session out of it, so the test cannot accidentally assert on
// the signed-in behaviour instead.
func (h *harness) registerAsGuest(slug, email string) types.Registration {
	h.t.Helper()
	body, err := json.Marshal(types.RegisterRequest{
		FirstName: "Guest", LastName: "User", Email: email, Consent: true,
		Passcode: seedPasscode,
		Phone:    testPhone,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	res, err := (&http.Client{}).Post(
		h.srv.URL+"/api/webinars/"+slug+"/register", "application/json", bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		h.t.Fatalf("guest register: status %d body %s", res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	return reg
}

func (h *harness) acceptStage(slug, joinKey string) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/stage-invite",
		map[string]any{"joinKey": joinKey, "accept": true})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("accept stage: status %d body %s", res.StatusCode, raw)
	}
}

// truncateAll gives each test a clean database. CASCADE handles the FK order.
func truncateAll(ctx context.Context, dsn string) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	_, err = pool.Exec(ctx,
		`TRUNCATE recordings, registrations, custom_questions, webinar_panelists, webinars, users CASCADE`)
	return err
}

// ------------------------------------------------------------------- tests

/* The list is private, and a draft is still not addressable by strangers.
 *
 * This replaced TestBrowseHidesDraftsAndPast, which asserted that an OPEN catalogue hid
 * drafts and ended sessions. That contract is gone: there is no open catalogue, so there
 * is nothing to hide things from. Filtering by status was only ever a proxy for "do not
 * show a stranger a half-written webinar", and scoping the list to people already involved
 * says it directly — while letting a host see their own drafts and history, which the
 * status filter wrongly took away from them.
 *
 * What has NOT changed, and is the reason the second half of this test survives verbatim:
 * a draft must 404 when addressed directly by slug, because that endpoint is still public.
 */
func TestWebinarListRequiresASessionAndIsScoped(t *testing.T) {
	h := newHarness(t)

	// Anonymous: 401, not an empty list. The two mean different things and the UI shows
	// different screens for them.
	res, raw := h.do(http.MethodGet, "/api/webinars", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous list: status %d body %s, want 401", res.StatusCode, raw)
	}

	// Signed in: only what this account hosts, presents, or registered for.
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodGet, "/api/webinars", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("signed-in list: status %d body %s", res.StatusCode, raw)
	}
	var list []types.Webinar
	h.decode(raw, &list)
	if len(list) == 0 {
		t.Fatal("signed-in host sees nothing; the scope is too narrow")
	}
	for _, w := range list {
		// simulive-playbook is Lucía's and Neeraj is not on it.
		if w.ID == "simulive-playbook" {
			t.Errorf("list leaked another host's webinar %q", w.ID)
		}
	}
	// He hosts this one and presents on that one, so both must be present.
	var hasOwn, hasPanelist bool
	for _, w := range list {
		switch w.ID {
		case "scaling-webrtc-10k":
			hasOwn = true
		case "postgres-event-platforms":
			hasPanelist = true
		}
	}
	if !hasOwn {
		t.Error("list omits a webinar the caller hosts")
	}
	if !hasPanelist {
		t.Error("list omits a webinar the caller is a panelist on")
	}

	// A draft must 404 even when addressed directly — that endpoint is still public.
	res, _ = h.do(http.MethodGet, "/api/webinars/webrtc-mobile-safari", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("draft detail: status %d, want 404", res.StatusCode)
	}
}

/* A registration link must still open for somebody with no account.
 *
 * This is the risk the private list creates, so it gets its own test. If GET
 * /api/webinars/{slug} ever ends up behind a session, every invitation already sent stops
 * working and nobody can sign up — a far worse outcome than the leak that was being fixed.
 */
func TestRegistrationLinkWorksWithoutASession(t *testing.T) {
	h := newHarness(t)

	res, raw := h.do(http.MethodGet, "/api/webinars/simulive-playbook", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("anonymous webinar page: status %d body %s, want 200", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if wb.ID != "simulive-playbook" {
		t.Fatalf("wrong webinar: %q", wb.ID)
	}

	// And registering, still anonymously, all the way to a join key. simulive-playbook
	// rather than a passcoded fixture: what is under test is that no SESSION is needed,
	// not that no passcode is.
	res, raw = h.do(http.MethodPost, "/api/webinars/simulive-playbook/register",
		types.RegisterRequest{
			FirstName: "No", LastName: "Account",
			Email: "no-account@test.dev", Phone: "+919876500002", Consent: true,
		})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("anonymous register: status %d body %s, want 201", res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	if reg.JoinKey == "" {
		t.Error("registered but got no join key; the guest has no way back in")
	}
}

func TestRegisterValidatesAndIsIdempotent(t *testing.T) {
	h := newHarness(t)

	// Missing everything.
	res, raw := h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/register",
		types.RegisterRequest{})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status %d body %s, want 422", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	// No lastName and no phone: the form asks for a full name in one field and treats the
	// number as optional, so requiring either here would be requiring something the form
	// does not ask for.
	for _, field := range []string{"firstName", "email", "consent", "stack"} {
		if _, ok := apiErr.Fields[field]; !ok {
			t.Errorf("expected a validation message for %q, got %v", field, apiErr.Fields)
		}
	}

	// Bad email shape.
	res, _ = h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/register",
		types.RegisterRequest{FirstName: "A", LastName: "B", Email: "not-an-email", Consent: true, Phone: testPhone,
			Answers: map[string]string{"stack": "x"}})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("bad email: status %d, want 422", res.StatusCode)
	}

	// Happy path, twice: same join key both times.
	first := h.registerAs("scaling-webrtc-10k", "dup@test.dev")
	second := h.registerAs("scaling-webrtc-10k", "DUP@test.dev") // case-insensitive
	if first.JoinKey != second.JoinKey {
		t.Errorf("re-registering created a new key: %q then %q", first.JoinKey, second.JoinKey)
	}
	if first.State != types.RegApproved {
		t.Errorf("state = %q, want approved on an automatic-approval webinar", first.State)
	}
}

func TestManualApprovalBlocksJoinUntilApproved(t *testing.T) {
	h := newHarness(t)
	h.goLive("postgres-event-platforms")

	reg := h.registerAs("postgres-event-platforms", "pending@test.dev")
	if reg.State != types.RegPending {
		t.Fatalf("state = %q, want pending on a manual-approval webinar", reg.State)
	}

	// Cannot join while pending.
	res, raw := h.do(http.MethodPost, "/api/webinars/postgres-event-platforms/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("join while pending: status %d body %s, want 403", res.StatusCode, raw)
	}

	// The webinar's host approves.
	h.login("marco@streamline.io")
	_, raw = h.do(http.MethodGet, "/api/host/webinars/postgres-event-platforms/registrants", nil)
	var rows []types.RegistrantRow
	h.decode(raw, &rows)

	var id string
	for _, r := range rows {
		if r.Email == "pending@test.dev" {
			id = r.ID
		}
	}
	if id == "" {
		t.Fatal("registrant not visible to the host")
	}
	res, raw = h.do(http.MethodPatch, "/api/host/registrations/"+id,
		map[string]string{"state": "approved"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approve: status %d body %s", res.StatusCode, raw)
	}

	// Now the join succeeds, as an attendee.
	res, raw = h.do(http.MethodPost, "/api/webinars/postgres-event-platforms/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join after approval: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if join.Role != types.RoleAttendee {
		t.Errorf("role = %q, want attendee", join.Role)
	}
	if join.CanPublish {
		t.Error("attendee join response claims canPublish")
	}
	if join.StartedAt == "" {
		t.Error("join response missing startedAt for a live webinar")
	}
}

func TestJoinKeyIsScopedToOneWebinar(t *testing.T) {
	h := newHarness(t)
	reg := h.registerAs("scaling-webrtc-10k", "scoped@test.dev")

	// Valid key, wrong webinar.
	res, raw := h.do(http.MethodPost, "/api/webinars/coturn-hostile-networks/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("cross-webinar join: status %d body %s, want 401", res.StatusCode, raw)
	}

	// Nonexistent key.
	res, _ = h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/join",
		types.JoinRequest{JoinKey: "ZZZZZZZZZZZZ"})
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("bogus key: status %d, want 401", res.StatusCode)
	}

	// Empty key.
	res, _ = h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/join",
		types.JoinRequest{JoinKey: ""})
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("empty key: status %d, want 401", res.StatusCode)
	}
}

func TestAttendeeJoinNeverGrantsPublish(t *testing.T) {
	h := newHarness(t)
	h.goLive("scaling-webrtc-10k")
	reg := h.registerAs("scaling-webrtc-10k", "viewer@test.dev")

	res, raw := h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s", res.StatusCode, raw)
	}

	if got := h.rooms.lastSpec.Role; got != types.RoleAttendee {
		t.Fatalf("minted a %q token on the attendee path", got)
	}
	// The identity must be derived from the join key, not client-supplied.
	if !strings.HasPrefix(h.rooms.lastSpec.Identity, "att_") {
		t.Errorf("identity = %q, want att_ prefix", h.rooms.lastSpec.Identity)
	}
	if h.rooms.lastSpec.Room != lk.RoomName("scaling-webrtc-10k") {
		t.Errorf("room = %q", h.rooms.lastSpec.Room)
	}

	// And the grant the role maps to really denies publishing.
	grant, err := lk.GrantFor(h.rooms.lastSpec)
	if err != nil {
		t.Fatal(err)
	}
	if grant.CanPublish == nil || *grant.CanPublish {
		t.Error("attendee grant permits publishing")
	}
}

func TestRoomCapacityIsEnforcedAtJoin(t *testing.T) {
	h := newHarness(t)
	h.goLive("scaling-webrtc-10k")
	reg := h.registerAs("scaling-webrtc-10k", "late@test.dev")

	// Pretend the room is already full.
	h.rooms.mu.Lock()
	h.rooms.count = 500
	h.rooms.mu.Unlock()

	res, raw := h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("join a full room: status %d body %s, want 409", res.StatusCode, raw)
	}

	// The room must have been created with a hard ceiling, not unbounded.
	h.rooms.mu.Lock()
	max := h.rooms.created[lk.RoomName("scaling-webrtc-10k")]
	h.rooms.mu.Unlock()
	if max == 0 || max > 505 {
		t.Errorf("room max participants = %d, want a bounded value <= 505", max)
	}
}

func TestHostEndpointsRequireAuth(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/host/webinars"},
		{http.MethodGet, "/api/host/webinars/scaling-webrtc-10k/registrants"},
		{http.MethodPost, "/api/host/webinars/scaling-webrtc-10k/join"},
		{http.MethodGet, "/api/auth/me"},
	} {
		res, _ := h.do(tc.method, tc.path, nil)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s: status %d, want 401", tc.method, tc.path, res.StatusCode)
		}
	}
}

func TestHostCannotTouchAnotherHostsWebinar(t *testing.T) {
	h := newHarness(t)
	// Lucía hosts simulive-playbook; Neeraj hosts scaling-webrtc-10k and is not
	// a panelist on hers.
	h.login("neeraj@acme.dev")

	res, raw := h.do(http.MethodGet, "/api/host/webinars/simulive-playbook/registrants", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("foreign registrants: status %d body %s, want 404", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/host/webinars/simulive-playbook/join", nil)
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("foreign join: status %d body %s, want 403", res.StatusCode, raw)
	}

	// His own list must not include her webinars.
	_, raw = h.do(http.MethodGet, "/api/host/webinars", nil)
	var mine []types.Webinar
	h.decode(raw, &mine)
	for _, w := range mine {
		if w.ID == "simulive-playbook" {
			t.Error("host list leaked another host's webinar")
		}
	}
}

func TestPanelistGetsPublishButNotAdmin(t *testing.T) {
	h := newHarness(t)
	// Neeraj is seeded as a panelist on Marco's postgres-event-platforms.
	h.login("neeraj@acme.dev")

	res, raw := h.do(http.MethodPost, "/api/host/webinars/postgres-event-platforms/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("panelist join: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)

	if join.Role != types.RolePanelist {
		t.Fatalf("role = %q, want panelist", join.Role)
	}
	if !join.CanPublish {
		t.Error("panelist cannot publish")
	}
	grant, err := lk.GrantFor(lk.Spec{Role: join.Role, Room: join.Room})
	if err != nil {
		t.Fatal(err)
	}
	if grant.RoomAdmin {
		t.Error("panelist grant carries RoomAdmin; only the host should")
	}
}

func TestHostJoinGrantsAdmin(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	res, raw := h.do(http.MethodPost, "/api/host/webinars/scaling-webrtc-10k/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if join.Role != types.RoleHost || !join.CanPublish {
		t.Fatalf("role=%q canPublish=%v", join.Role, join.CanPublish)
	}
	grant, err := lk.GrantFor(lk.Spec{Role: join.Role, Room: join.Room})
	if err != nil {
		t.Fatal(err)
	}
	if !grant.RoomAdmin {
		t.Error("host grant lacks RoomAdmin")
	}
}

func TestLookupOnlyReturnsHeldKeys(t *testing.T) {
	h := newHarness(t)
	mine := h.registerAs("scaling-webrtc-10k", "mine@test.dev")
	theirs := h.registerAs("coturn-hostile-networks", "theirs@test.dev")

	res, raw := h.do(http.MethodPost, "/api/registrations/lookup",
		types.LookupRequest{JoinKeys: []string{mine.JoinKey, "NOPENOPENOPE"}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	// RegisteredWebinar, not Registration: the lookup now carries the webinar with each
	// row, because a guest with no account has no catalogue left to resolve it against.
	var got []types.RegisteredWebinar
	h.decode(raw, &got)

	if len(got) != 1 {
		t.Fatalf("returned %d registrations, want 1 (unknown keys must be skipped)", len(got))
	}
	if got[0].Registration.JoinKey != mine.JoinKey {
		t.Errorf("returned the wrong registration: %q", got[0].Registration.JoinKey)
	}
	if got[0].Registration.JoinKey == theirs.JoinKey {
		t.Error("lookup leaked a key the caller does not hold")
	}
	// The attached webinar is what makes the response self-contained.
	if got[0].Webinar.ID != "scaling-webrtc-10k" {
		t.Errorf("webinar not attached, or wrong one: %q", got[0].Webinar.ID)
	}
	if got[0].Webinar.Topic == "" {
		t.Error("webinar attached but empty; /my-webinars would render nothing")
	}
	// Still redacted: holding a join key proves you registered, not that you own it.
	if got[0].Webinar.Passcode != "" {
		t.Error("lookup leaked the passcode to a registrant")
	}
}

func TestBodyLimitsAndUnknownFields(t *testing.T) {
	h := newHarness(t)

	// Unknown field is rejected rather than silently dropped.
	req, _ := http.NewRequest(http.MethodPost,
		h.srv.URL+"/api/webinars/scaling-webrtc-10k/register",
		strings.NewReader(`{"firstName":"A","lastName":"B","email":"x@y.dev","consent":true,"isAdmin":true}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown field: status %d, want 400", res.StatusCode)
	}

	// Oversized body.
	big := fmt.Sprintf(`{"firstName":%q,"lastName":"B","email":"x@y.dev","consent":true}`,
		strings.Repeat("A", 2<<20))
	req, _ = http.NewRequest(http.MethodPost,
		h.srv.URL+"/api/webinars/scaling-webrtc-10k/register", strings.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	res, err = h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusCreated {
		t.Error("a 2 MiB body was accepted; the limit is not enforced")
	}
}

// ------------------------------------------------------------------ accounts

func TestSignupValidatesAndSignsIn(t *testing.T) {
	h := newHarness(t)

	// Everything missing, plus a password that is too short.
	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{Password: "short"})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("empty signup: status %d body %s, want 422", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	for _, field := range []string{"name", "email", "password"} {
		if _, ok := apiErr.Fields[field]; !ok {
			t.Errorf("no validation message for %q: %v", field, apiErr.Fields)
		}
	}

	// The happy path signs the new account in, so /auth/me works immediately
	// without a second round trip through login.
	acct := h.signup("Ada Lovelace", "ada@test.dev", false)
	if acct.CanHost {
		t.Error("an account that did not ask to host was given the capability")
	}
	if acct.Initials != "AL" {
		t.Errorf("initials = %q, want AL (derived, not asked for)", acct.Initials)
	}
	if acct.Hue == "" {
		t.Error("no avatar colour was derived")
	}

	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me after signup: status %d body %s", res.StatusCode, raw)
	}

	// A second signup on the same address must not create a shadow account.
	h.logout()
	res, raw = h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Someone Else", Email: "ADA@test.dev", Password: "a-long-enough-password",
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("duplicate signup: status %d body %s, want 422", res.StatusCode, raw)
	}
}

// Hosting is a capability on the account, so an attendee account with a
// perfectly valid session must still be refused everywhere under /api/host.
func TestAttendeeAccountCannotReachHostEndpoints(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Plain Attendee", "plain@test.dev", false)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/host/webinars"},
		{http.MethodPost, "/api/host/webinars"},
		{http.MethodGet, "/api/host/webinars/scaling-webrtc-10k/participants"},
		{http.MethodPost, "/api/host/webinars/scaling-webrtc-10k/mute-all"},
	} {
		res, raw := h.do(tc.method, tc.path, nil)
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s: status %d body %s, want 403", tc.method, tc.path, res.StatusCode, raw)
		}
	}

	/* Turning hosting on from the profile endpoint used to be THE supported route, and this
	 * test asserted it took effect. That is the assertion, inverted.
	 *
	 * Being able to grant yourself the ability to create webinars and start collecting
	 * strangers' names, emails and phone numbers is not a feature; it is what a public form
	 * should never do. The field is still accepted so an older cached bundle can save the name
	 * change it was really submitting — see store.UpdateProfile — and it no longer writes
	 * can_host. */
	yes := true
	res, raw := h.do(http.MethodPatch, "/api/auth/me", types.ProfilePatch{WantsHost: &yes})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch: status %d body %s — the field must be ignored, not rejected",
			res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodGet, "/api/host/webinars", nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("host list after self-service attempt: status %d body %s, want 403",
			res.StatusCode, raw)
	}

	// The grant is the only route in, and it does work. Applied through the store, which is
	// the same write PATCH /api/admin/users/{id}/host performs.
	if _, err := h.store.SetHostCapability(context.Background(), acct.ID, true); err != nil {
		t.Fatalf("grant hosting: %v", err)
	}
	if res, raw := h.do(http.MethodGet, "/api/host/webinars", nil); res.StatusCode != http.StatusOK {
		t.Errorf("host list after an admin grant: status %d body %s, want 200", res.StatusCode, raw)
	}
}

// ------------------------------------------------------------ webinar writes

func TestCreateWebinarPersistsAndValidates(t *testing.T) {
	h := newHarness(t)
	h.signup("New Host", "newhost@test.dev", true)

	// Rejects the things that would produce a broken schedule.
	res, raw := h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "", StartsAt: "not-a-date", Duration: 0, TimeZone: "Mars/Olympus",
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid input: status %d body %s, want 422", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	for _, field := range []string{"topic", "startsAt", "durationMin", "timeZone"} {
		if _, ok := apiErr.Fields[field]; !ok {
			t.Errorf("no validation message for %q: %v", field, apiErr.Fields)
		}
	}

	wb := h.newWebinar("Scaling Postgres to 10k Writes", func(in *types.WebinarInput) {
		in.Track = "Data"
		in.AttendeeLimit = 5000 // above MaxAttendees; must be clamped, not rejected
		in.CustomQuestions = []types.CustomQuestion{
			{Label: "Which database?", Type: "short", Required: true},
		}
	})

	if wb.ID != "scaling-postgres-to-10k-writes" {
		t.Errorf("slug = %q, want it derived from the topic", wb.ID)
	}
	if wb.AttendeeLimit != 500 {
		t.Errorf("attendeeLimit = %d, want it clamped to MaxAttendees (500)", wb.AttendeeLimit)
	}
	if wb.WebinarID == "" {
		t.Error("no human-readable webinar id was minted")
	}
	if len(wb.CustomQuestions) != 1 || wb.CustomQuestions[0].ID != "which-database" {
		t.Errorf("custom questions not persisted with a derived key: %+v", wb.CustomQuestions)
	}

	// It has to be readable back through the public endpoint, which is the part
	// that proves it was persisted rather than echoed.
	res, raw = h.do(http.MethodGet, "/api/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public read of a new webinar: status %d body %s", res.StatusCode, raw)
	}

	// A second webinar with the same topic must not collide on the slug.
	other := h.newWebinar("Scaling Postgres to 10k Writes", nil)
	if other.ID == wb.ID {
		t.Errorf("two webinars share the slug %q", other.ID)
	}

	// And updating replaces the editable fields.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, types.WebinarInput{
		Topic: "Renamed", StartsAt: wb.StartsAt, Duration: 45, TimeZone: "Europe/London",
		Kind: types.KindLive, Status: types.StatusScheduled,
		Approval: types.ApprovalManual, AttendeeLimit: 50,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("update: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Webinar
	h.decode(raw, &updated)
	if updated.Topic != "Renamed" || updated.Duration != 45 || updated.Approval != types.ApprovalManual {
		t.Errorf("update did not apply: %+v", updated)
	}
	if updated.ID != wb.ID {
		t.Errorf("slug changed on rename: %q -> %q; existing links would break", wb.ID, updated.ID)
	}
}

func TestStartAndEndWebinar(t *testing.T) {
	h := newHarness(t)
	h.signup("Runner", "runner@test.dev", true)
	wb := h.newWebinar("Live Session", nil)
	room := lk.RoomName(wb.ID)

	// Registered before the webinar ends, because registration for an ended
	// webinar is refused — which is the behaviour the last assertion relies on
	// having a valid key to test against.
	reg := h.registerAsGuest(wb.ID, "late@test.dev")

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	var started types.Webinar
	h.decode(raw, &started)
	if started.Status != types.StatusLive {
		t.Errorf("status = %q, want live", started.Status)
	}
	if started.StartedAt == "" {
		t.Error("startedAt was not stamped")
	}
	// Starting must create the room before any browser connects, so the first
	// attendee never races room creation.
	h.rooms.mu.Lock()
	_, created := h.rooms.created[room]
	h.rooms.mu.Unlock()
	if !created {
		t.Error("start did not create the SFU room")
	}
	if meta := h.rooms.roomMeta(t, room); meta.Status != types.StatusLive {
		t.Errorf("room metadata status = %q, want live", meta.Status)
	} else if meta.StartedAt == "" {
		t.Error("room metadata startedAt was not stamped")
	} else if meta.StartedAt != started.StartedAt {
		t.Errorf("room metadata startedAt = %q, want %q", meta.StartedAt, started.StartedAt)
	}

	// Ending has to tear the room down. Disconnecting the host alone would leave
	// the audience watching a dead stage.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	deleted := append([]string{}, h.rooms.deleted...)
	h.rooms.mu.Unlock()
	if len(deleted) != 1 || deleted[0] != room {
		t.Errorf("deleted rooms = %v, want [%s]", deleted, room)
	}

	// An ended webinar is not joinable, even with a key that was valid minutes
	// earlier.
	res, _ = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusConflict {
		t.Errorf("join an ended webinar: status %d, want 409", res.StatusCode)
	}
}

// ------------------------------------------------------- hiding the audience

// The privacy guarantee has to be enforced at the SFU, not by the UI: an
// attendee token must carry hidden=true so no other client is ever sent their
// participant record.
func TestHideAttendeesMintsHiddenTokens(t *testing.T) {
	h := newHarness(t)
	h.signup("Privacy Host", "privacy@test.dev", true)

	hidden := h.newWebinar("Hidden Audience", func(in *types.WebinarInput) {
		in.Controls.HideAttendees = true
	})
	visible := h.newWebinar("Visible Audience", func(in *types.WebinarInput) {
		in.Controls.HideAttendees = false
	})
	h.logout()

	regHidden := h.registerAsGuest(hidden.ID, "a@test.dev")
	res, raw := h.do(http.MethodPost, "/api/webinars/"+hidden.ID+"/join",
		types.JoinRequest{JoinKey: regHidden.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if !join.Hidden {
		t.Error("join response does not report the attendee as hidden")
	}
	if !h.rooms.lastSpec.Hidden {
		t.Error("attendee token was minted WITHOUT hidden; attendees could enumerate each other")
	}
	if !join.Controls.HideAttendees {
		t.Error("join response does not carry the session controls")
	}

	regVisible := h.registerAsGuest(visible.ID, "b@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+visible.ID+"/join",
		types.JoinRequest{JoinKey: regVisible.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("join: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Hidden {
		t.Error("attendee was hidden on a webinar where hiding is off")
	}

	// The host must never be hidden — they would be invisible to their own
	// audience, which looks like a broken camera rather than a permission bug.
	h.login("privacy@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+hidden.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("host join: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Hidden {
		t.Error("the HOST was minted hidden on a hide-attendees webinar")
	}
	if h.rooms.lastSpec.Role != types.RoleHost {
		t.Errorf("host join minted a %q token", h.rooms.lastSpec.Role)
	}
}

// Toggling visibility mid-session has to reach the attendees already connected,
// not just the ones who join next.
func TestHideAttendeesToggleAppliesToTheLiveRoom(t *testing.T) {
	h := newHarness(t)
	h.signup("Toggle Host", "toggle@test.dev", true)
	wb := h.newWebinar("Toggle Session", func(in *types.WebinarInput) {
		in.Controls.HideAttendees = false
	})

	off := false
	on := true
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{HideAttendees: &on})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("controls: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Webinar
	h.decode(raw, &updated)
	if !updated.Controls.HideAttendees {
		t.Error("the control was not persisted")
	}

	h.rooms.mu.Lock()
	calls := append([]hideCall{}, h.rooms.hideAllCall...)
	h.rooms.mu.Unlock()
	if len(calls) != 1 || calls[0].role != types.RoleAttendee || !calls[0].hidden {
		t.Fatalf("HideAll calls = %+v, want one {attendee, true}", calls)
	}
	// Only the audience: hiding panelists would silence the stage.
	for _, c := range calls {
		if c.role != types.RoleAttendee {
			t.Errorf("visibility change applied to role %q", c.role)
		}
	}

	// And every connected browser has to be told, which is what room metadata is for.
	if meta := h.rooms.roomMeta(t, lk.RoomName(wb.ID)); !meta.Controls.HideAttendees {
		t.Error("the control change was not pushed into room metadata")
	}

	// Turning it back off must reach the room too.
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{HideAttendees: &off}); res.StatusCode != http.StatusOK {
		t.Fatalf("controls off: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	last := h.rooms.hideAllCall[len(h.rooms.hideAllCall)-1]
	h.rooms.mu.Unlock()
	if last.hidden {
		t.Error("turning hiding off did not un-hide the live attendees")
	}
}

// A partial patch must leave the controls it did not mention alone. This is why
// ControlsPatch is pointers rather than plain bools.
func TestControlsPatchIsPartial(t *testing.T) {
	h := newHarness(t)
	h.signup("Partial Host", "partial@test.dev", true)
	wb := h.newWebinar("Partial", func(in *types.WebinarInput) {
		in.Controls.ChatEnabled = true
		in.Controls.QAEnabled = true
		in.Controls.HideAttendees = true
	})

	off := false
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{ChatEnabled: &off})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("controls: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Webinar
	h.decode(raw, &updated)
	if updated.Controls.ChatEnabled {
		t.Error("chatEnabled was not turned off")
	}
	if !updated.Controls.QAEnabled || !updated.Controls.HideAttendees {
		t.Errorf("an unmentioned control was reset: %+v", updated.Controls)
	}
}

// ------------------------------------------------------------- moderation

func TestMuteAllSkipsTheHostAndLatchesTheRoom(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Mute Host", "mute@test.dev", true)
	wb := h.newWebinar("Mute Session", func(in *types.WebinarInput) {
		in.Controls.AllowUnmute = true
	})

	hostIdentity := "user_" + acct.ID
	h.rooms.setRoster(
		types.LiveParticipant{Identity: hostIdentity, Role: types.RoleHost, AudioMuted: false},
		types.LiveParticipant{Identity: "user_panelist", Role: types.RolePanelist, AudioMuted: false},
		types.LiveParticipant{Identity: "att_LOUD", Role: types.RolePanelist, AudioMuted: false},
	)

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/mute-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("mute all: status %d body %s", res.StatusCode, raw)
	}
	var out types.MuteAllResponse
	h.decode(raw, &out)
	if out.Muted != 2 {
		t.Errorf("muted = %d, want 2 (everyone but the host)", out.Muted)
	}

	// Muting yourself with the "mute everyone" button is the kind of surprise
	// that ends with someone presenting in silence.
	h.rooms.mu.Lock()
	keep := h.rooms.muteAllKeep
	h.rooms.mu.Unlock()
	if len(keep) != 1 || !keep[0][hostIdentity] {
		t.Errorf("host was not exempted from mute-all: %v", keep)
	}

	// "Mute all" has to mean more than "mute whoever is here right now", so it
	// latches the room for anyone who joins a moment later.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reload: status %d body %s", res.StatusCode, raw)
	}
	var reloaded types.Webinar
	h.decode(raw, &reloaded)
	if !reloaded.Controls.MuteOnEntry {
		t.Error("mute-all did not latch muteOnEntry")
	}
	if reloaded.Controls.AllowUnmute {
		t.Error("mute-all left allowUnmute on, so panelists could immediately unmute")
	}
}

func TestParticipantsRosterAndRemoval(t *testing.T) {
	h := newHarness(t)
	h.signup("Roster Host", "roster@test.dev", true)
	wb := h.newWebinar("Roster Session", nil)

	// Hidden attendees are excluded from every *client's* roster, so the host's
	// own browser cannot see them. Moderation has to be answered from the SFU's
	// server API, which does include them — otherwise a host could hide people
	// and then be unable to remove them.
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_1", Role: types.RoleHost, CanPublish: true},
		types.LiveParticipant{Identity: "att_ONE", Role: types.RoleAttendee, Hidden: true},
		types.LiveParticipant{Identity: "att_TWO", Role: types.RoleAttendee, Hidden: true},
	)

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("participants: status %d body %s", res.StatusCode, raw)
	}
	var live types.LiveRoom
	h.decode(raw, &live)
	if live.Attendees != 2 || live.OnStage != 1 {
		t.Errorf("attendees=%d onStage=%d, want 2 and 1", live.Attendees, live.OnStage)
	}
	if len(live.Participants) != 3 {
		t.Fatalf("roster hid a participant from the host: %+v", live.Participants)
	}

	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/participants/att_ONE", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("remove: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	removed := append([]string{}, h.rooms.removed...)
	h.rooms.mu.Unlock()
	if len(removed) != 1 || removed[0] != "att_ONE" {
		t.Errorf("removed = %v, want [att_ONE]", removed)
	}
}

// A promoted attendee must come back on stage after a reconnect, or a panelist
// who loses their wifi silently drops to the audience.
func TestPromotionSurvivesRejoin(t *testing.T) {
	h := newHarness(t)
	h.signup("Stage Host", "stage@test.dev", true)
	wb := h.newWebinar("Stage Session", nil)

	reg := h.registerAsGuest(wb.ID, "raised@test.dev")
	identity := "att_" + reg.JoinKey

	res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("promote: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)
	h.rooms.mu.Lock()
	changes := append([]lk.Spec{}, h.rooms.roleChanges...)
	h.rooms.mu.Unlock()
	if len(changes) != 1 || changes[0].Role != types.RolePanelist {
		t.Fatalf("role changes = %+v", changes)
	}
	// Someone on the stage cannot stay hidden — a voice from an empty tile.
	if changes[0].Hidden {
		t.Error("a promoted attendee was left hidden")
	}

	// Rejoining now mints a panelist token.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Role != types.RolePanelist {
		t.Errorf("rejoin minted %q, want panelist", h.rooms.lastSpec.Role)
	}

	// Demoting puts them back in the audience, including after a reconnect.
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RoleAttendee}); res.StatusCode != http.StatusOK {
		t.Fatalf("demote: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin after demote: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Role != types.RoleAttendee {
		t.Errorf("rejoin after demote minted %q, want attendee", h.rooms.lastSpec.Role)
	}

	// The host must not be demotable through this endpoint: their token carries
	// RoomAdmin, so stripping publish would leave someone who can moderate but
	// not present.
	res, _ = h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/user_abc/stage",
		types.StageRequest{Role: types.RoleAttendee})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("demoting a user_ identity: status %d, want 422", res.StatusCode)
	}
}

// "Allow to talk" is the common case when a host takes a live question: the
// attendee gets a microphone and nothing else. A full promotion would put their
// camera and desktop one click from the whole audience.
func TestAllowToTalkGrantsMicrophoneOnly(t *testing.T) {
	h := newHarness(t)
	h.signup("Talk Host", "talk@test.dev", true)
	wb := h.newWebinar("Q and A Session", nil)

	reg := h.registerAsGuest(wb.ID, "asker@test.dev")
	identity := "att_" + reg.JoinKey

	res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist, AudioOnly: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("allow to talk: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)

	h.rooms.mu.Lock()
	changes := append([]lk.Spec{}, h.rooms.roleChanges...)
	h.rooms.mu.Unlock()
	if len(changes) != 1 {
		t.Fatalf("role changes = %+v, want one", changes)
	}
	if !changes[0].AudioOnly {
		t.Error("the SFU was told to give a full stage grant, not audio only")
	}
	if changes[0].Hidden {
		t.Error("somebody allowed to talk was left hidden — a voice from nowhere")
	}

	// And it survives a reconnect with the same scope. Coming back with a camera
	// the host never granted would be worse than losing the grant.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Role != types.RolePanelist {
		t.Errorf("rejoin minted %q, want panelist", h.rooms.lastSpec.Role)
	}
	if !h.rooms.lastSpec.AudioOnly {
		t.Error("rejoin after allow-to-talk minted a FULL stage token — camera and screen share included")
	}

	// A full promotion must not be narrowed.
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist, AudioOnly: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("full promote: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.AudioOnly {
		t.Error("a full stage grant was minted as audio-only")
	}

	// Sending them back to the audience clears it entirely.
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RoleAttendee}); res.StatusCode != http.StatusOK {
		t.Fatalf("demote: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Role != types.RoleAttendee || h.rooms.lastSpec.AudioOnly {
		t.Errorf("after demotion: role=%q audioOnly=%v",
			h.rooms.lastSpec.Role, h.rooms.lastSpec.AudioOnly)
	}
}

func TestLockedWebinarRefusesNewAttendees(t *testing.T) {
	h := newHarness(t)
	h.signup("Lock Host", "lock@test.dev", true)
	wb := h.newWebinar("Lock Session", nil)
	reg := h.registerAsGuest(wb.ID, "shut-out@test.dev")

	locked := true
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{Locked: &locked}); res.StatusCode != http.StatusOK {
		t.Fatalf("lock: status %d body %s", res.StatusCode, raw)
	}

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusConflict {
		t.Errorf("join a locked webinar: status %d body %s, want 409", res.StatusCode, raw)
	}

	// The host can always get in, or they could lock themselves out of their
	// own webinar.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Errorf("host join while locked: status %d body %s", res.StatusCode, raw)
	}
}

// A signed-in account joins from its session, so it never has to hold a join
// key — that is the whole point of having accounts.
func TestSignedInAttendeeJoinsWithoutAJoinKey(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "owner@test.dev", true)
	wb := h.newWebinar("Account Session", nil)
	h.logout()

	h.signup("Session Attendee", "sess@test.dev", false)

	// Not registered yet: refused, and told why.
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("join before registering: status %d body %s, want 403", res.StatusCode, raw)
	}

	/* Registering while signed in prefills from the account.
	 *
	 * The phone is still supplied: accounts do not carry one, so there is nothing to prefill
	 * it from and it is the one field a signed-in person still has to fill in. */
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register",
		types.RegisterRequest{Consent: true, Phone: testPhone})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register while signed in: status %d body %s", res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	if reg.Email != "sess@test.dev" {
		t.Errorf("email = %q, want it taken from the account", reg.Email)
	}

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join with a session: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if join.Role != types.RoleAttendee || join.CanPublish {
		t.Errorf("role=%q canPublish=%v", join.Role, join.CanPublish)
	}

	// And the registration is on the account, not in a browser's localStorage.
	res, raw = h.do(http.MethodGet, "/api/me/registrations", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("my registrations: status %d body %s", res.StatusCode, raw)
	}
	var mine []types.RegisteredWebinar
	h.decode(raw, &mine)
	if len(mine) != 1 || mine[0].Webinar.ID != wb.ID {
		t.Errorf("account registrations = %+v, want the one webinar", mine)
	}
}

// A host mute has to hold.
//
// Muting a published track alone does not stop the participant from unmuting
// themselves a second later — verified against a live SFU, which happily accepts
// the unmute. So the microphone leaves their grant as well, and the latch is
// recorded, because a reload would otherwise be the way around it.
func TestHostMuteHolds(t *testing.T) {
	h := newHarness(t)
	h.signup("Mute Latch Host", "latch@test.dev", true)
	wb := h.newWebinar("Question Time", nil)

	reg := h.registerAsGuest(wb.ID, "speaker@test.dev")
	identity := "att_" + reg.JoinKey

	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist, AudioOnly: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("allow to speak: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.setRoster(
		types.LiveParticipant{Identity: "user_1", Role: types.RoleHost, CanPublish: true, CanSpeak: true},
		types.LiveParticipant{
			Identity: identity, Role: types.RolePanelist,
			CanPublish: true, CanSpeak: true, Publishing: []string{"AUDIO/MICROPHONE"},
		},
	)

	// ---- mute ------------------------------------------------------------
	if res, raw := h.do(http.MethodPatch,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/mute",
		types.MutePatch{Muted: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("mute: status %d body %s", res.StatusCode, raw)
	}

	h.rooms.mu.Lock()
	muted := append([]string{}, h.rooms.muted...)
	speaking := append([]string{}, h.rooms.speakingCalls...)
	h.rooms.mu.Unlock()
	// Both halves: silence what is live, and stop them sending more.
	if !slices.Contains(muted, identity+"=true") {
		t.Errorf("the live track was not muted: %v", muted)
	}
	if !slices.Contains(speaking, identity+"=true") {
		t.Errorf("the microphone was left in their grant, so they can just unmute: %v", speaking)
	}

	// What the host's own panel shows afterwards has to distinguish a silenced
	// speaker from an ordinary attendee, or the only action offered is "promote".
	var live types.LiveRoom
	_, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil)
	h.decode(raw, &live)
	row := findParticipant(t, live, identity)
	if row.CanSpeak {
		t.Error("a muted speaker still reports canSpeak")
	}
	if !row.MutedByHost {
		t.Error("the roster does not say the host muted them, so they read as audience")
	}

	// ---- and a reload does not undo it -----------------------------------
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if !h.rooms.lastSpec.MutedByHost {
		t.Error("rejoining minted a token with the microphone back — a reload undoes the mute")
	}
	if !h.rooms.lastSpec.AudioOnly || h.rooms.lastSpec.Role != types.RolePanelist {
		t.Errorf("the mute cost them their grant: %+v", h.rooms.lastSpec)
	}

	// ---- letting them speak again ----------------------------------------
	if res, raw := h.do(http.MethodPatch,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/mute",
		types.MutePatch{Muted: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("unmute: status %d body %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	speaking = append([]string{}, h.rooms.speakingCalls...)
	h.rooms.mu.Unlock()
	if !slices.Contains(speaking, identity+"=false") {
		t.Errorf("the microphone was never restored to their grant: %v", speaking)
	}
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.MutedByHost {
		t.Error("the latch outlived the host lifting it")
	}

	// ---- muting somebody who is not a speaker ----------------------------
	h.rooms.setRoster(types.LiveParticipant{Identity: "att_AUDIENCE", Role: types.RoleAttendee})
	res, _ := h.do(http.MethodPatch,
		"/api/host/webinars/"+wb.ID+"/participants/att_AUDIENCE/mute",
		types.MutePatch{Muted: true})
	if res.StatusCode != http.StatusConflict {
		t.Errorf("muting an attendee: status %d, want 409 — there is no microphone to mute",
			res.StatusCode)
	}

	// ---- and the host muting their own microphone ------------------------
	// A convenience on their own roster row. There is no latch to apply — they can
	// unmute themselves by right — so the track mute is the whole action, and the
	// endpoint must not report the missing latch as a failure.
	h.rooms.setRoster(types.LiveParticipant{
		Identity: "user_1", Role: types.RoleHost,
		CanPublish: true, CanSpeak: true, Publishing: []string{"AUDIO/MICROPHONE"},
	})
	for _, muted := range []bool{true, false} {
		res, raw := h.do(http.MethodPatch,
			"/api/host/webinars/"+wb.ID+"/participants/user_1/mute",
			types.MutePatch{Muted: muted})
		if res.StatusCode != http.StatusOK {
			t.Errorf("host self-mute (muted=%v): status %d body %s, want 200",
				muted, res.StatusCode, raw)
		}
	}
	h.rooms.mu.Lock()
	hostRow := h.rooms.roster[0]
	h.rooms.mu.Unlock()
	if hostRow.MutedByHost || !hostRow.CanSpeak {
		t.Errorf("the host's own permissions were rewritten: %+v", hostRow)
	}
}

// "Mute everyone" has to include the people the host individually allowed to
// speak. Their grant overrides the room-wide self-unmute control, so without a
// per-participant latch they are the one person it does not apply to.
func TestMuteAllLatchesAllowedSpeakers(t *testing.T) {
	h := newHarness(t)
	acct := h.signup("Sweep Host", "sweep@test.dev", true)
	wb := h.newWebinar("Busy Room", nil)

	reg := h.registerAsGuest(wb.ID, "chatty@test.dev")
	identity := "att_" + reg.JoinKey
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist, AudioOnly: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("allow to speak: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)

	host := "user_" + acct.ID
	h.rooms.setRoster(
		types.LiveParticipant{Identity: host, Role: types.RoleHost, CanPublish: true, CanSpeak: true},
		types.LiveParticipant{
			Identity: identity, Role: types.RolePanelist, CanPublish: true, CanSpeak: true,
		},
	)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/mute-all", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("mute all: status %d body %s", res.StatusCode, raw)
	}

	var live types.LiveRoom
	_, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/participants", nil)
	h.decode(raw, &live)
	if row := findParticipant(t, live, identity); row.CanSpeak || !row.MutedByHost {
		t.Errorf("mute-all left an allowed speaker able to unmute: %+v", row)
	}
	// The host presenting into silence is the failure mode this exemption exists
	// for, and it must survive the latch being added.
	if row := findParticipant(t, live, host); !row.CanSpeak || row.MutedByHost {
		t.Errorf("mute-all silenced the host: %+v", row)
	}

	// Persisted too, so a rejoin does not hand the microphone back.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: status %d body %s", res.StatusCode, raw)
	}
	if !h.rooms.lastSpec.MutedByHost {
		t.Error("rejoining after mute-all minted a token with the microphone back")
	}
}

// Being invited to speak on somebody else's webinar is not the same capability as
// running your own.
//
// A guest speaker signs up as an ordinary account — the signup form's default —
// and the host adds them by email. If reaching the stage needed the hosting
// capability, that invitation would lead to a 403 and there would be nothing in
// the product to explain it.
func TestPanelistWithoutHostingReachesTheStage(t *testing.T) {
	h := newHarness(t)
	guest := h.signup("Guest Speaker", "guest-speaker@test.dev", false)
	if guest.CanHost {
		t.Fatal("this test needs an account that cannot host")
	}

	h.signup("Inviting Host", "inviting@test.dev", true)
	wb := h.newWebinar("Guest Slot", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "guest-speaker@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}

	h.login("guest-speaker@test.dev")

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("panelist join: status %d body %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	if join.Role != types.RolePanelist || !join.CanPublish {
		t.Errorf("role=%q canPublish=%v, want a publishing panelist", join.Role, join.CanPublish)
	}

	// And they can find the room without the host sending them a link.
	_, raw = h.do(http.MethodGet, "/api/host/stage", nil)
	var stage []types.Webinar
	h.decode(raw, &stage)
	if len(stage) != 1 || stage[0].ID != wb.ID {
		t.Errorf("stage list = %+v, want just %s", stage, wb.ID)
	}

	// The boundary still holds: speaking on a webinar is not moderating it, and it
	// is certainly not hosting one of your own.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/host/webinars"},
		{http.MethodPost, "/api/host/webinars"},
		{http.MethodGet, "/api/host/webinars/" + wb.ID + "/participants"},
		{http.MethodPost, "/api/host/webinars/" + wb.ID + "/mute-all"},
	} {
		res, raw := h.do(tc.method, tc.path, nil)
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s: status %d body %s, want 403",
				tc.method, tc.path, res.StatusCode, raw)
		}
	}
}

// A scheduled panelist has no stage grant to hang a mute on — they speak by right,
// from the panelist list. Muting one still has to hold across a reload, or
// refreshing the page is how a muted panelist starts talking again.
func TestPanelistMuteSurvivesRejoin(t *testing.T) {
	h := newHarness(t)
	panelist := h.signup("Pan Elist", "panelist@test.dev", false)
	h.signup("Panel Host", "panelhost@test.dev", true)
	wb := h.newWebinar("Panel Show", nil)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "panelist@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}

	identity := "user_" + panelist.ID
	h.rooms.setRoster(types.LiveParticipant{
		Identity: identity, Role: types.RolePanelist,
		CanPublish: true, CanSpeak: true, Publishing: []string{"AUDIO/MICROPHONE"},
	})

	if res, raw := h.do(http.MethodPatch,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/mute",
		types.MutePatch{Muted: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("mute panelist: status %d body %s", res.StatusCode, raw)
	}

	h.login("panelist@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("panelist rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.Role != types.RolePanelist {
		t.Fatalf("rejoin minted %q, want panelist", h.rooms.lastSpec.Role)
	}
	if !h.rooms.lastSpec.MutedByHost {
		t.Error("a muted panelist reloaded their way back to a microphone")
	}

	// Lifting it has to reach the same place.
	h.login("panelhost@test.dev")
	if res, raw := h.do(http.MethodPatch,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/mute",
		types.MutePatch{Muted: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("unmute panelist: status %d body %s", res.StatusCode, raw)
	}
	h.login("panelist@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("panelist rejoin: status %d body %s", res.StatusCode, raw)
	}
	if h.rooms.lastSpec.MutedByHost {
		t.Error("the latch outlived the host lifting it")
	}
	// And the mute must never have narrowed their stage grant to audio only.
	if h.rooms.lastSpec.AudioOnly {
		t.Error("a muted panelist came back without their camera")
	}
}

func findParticipant(t *testing.T, live types.LiveRoom, identity string) types.LiveParticipant {
	t.Helper()
	for _, p := range live.Participants {
		if p.Identity == identity {
			return p
		}
	}
	t.Fatalf("%s is not in the roster: %+v", identity, live.Participants)
	return types.LiveParticipant{}
}

// ------------------------------------------------------------------ recording

// The whole recording lifecycle, against real files on disk.
//
// The interesting failures here are all about files and permissions — a chunk
// appended out of order, a download that cannot be scrubbed, an attendee reaching
// the endpoint — so the storage backend is the real one and only LiveKit is faked.
func TestRecordingLifecycle(t *testing.T) {
	h := newHarness(t)
	h.signup("Rec Host", "rechost@test.dev", true)
	wb := h.newWebinar("Recorded Session", nil)

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start webinar: status %d body %s", res.StatusCode, raw)
	}

	// ---- start ------------------------------------------------------------
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: `video/webm;codecs="vp9,opus"`})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if rec.ID == "" || rec.Status != types.RecordingActive {
		t.Fatalf("recording = %+v", rec)
	}
	if rec.Ext != "webm" {
		t.Errorf("ext = %q, want webm", rec.Ext)
	}
	if rec.StartedBy != "Rec Host" {
		t.Errorf("startedBy = %q, want the host's name", rec.StartedBy)
	}

	// Everyone in the room has to be told, which means it goes into room metadata
	// rather than staying in the recorder's own browser.
	if meta := h.rooms.roomMeta(t, lk.RoomName(wb.ID)); !meta.Recording {
		t.Error("room metadata does not say the session is being recorded")
	}

	// One at a time, enforced by the database rather than by a check-then-insert.
	res, _ = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusConflict {
		t.Errorf("second recording: status %d, want 409", res.StatusCode)
	}

	// ---- chunks -----------------------------------------------------------
	chunkPath := "/api/host/webinars/" + wb.ID + "/recordings/" + rec.ID + "/chunks"
	first := []byte("first-chunk-")
	second := []byte("second-chunk")
	for _, chunk := range [][]byte{first, second} {
		res, raw := h.doRaw(http.MethodPost, chunkPath, "application/octet-stream", chunk, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("upload chunk: status %d body %s", res.StatusCode, raw)
		}
	}

	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	var list []types.Recording
	h.decode(raw, &list)
	if len(list) != 1 {
		t.Fatalf("recordings = %+v, want one", list)
	}
	if want := int64(len(first) + len(second)); list[0].SizeBytes != want {
		t.Errorf("sizeBytes = %d, want %d — chunks are appended, not replaced",
			list[0].SizeBytes, want)
	}

	// ---- complete ---------------------------------------------------------
	res, raw = h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/complete?durationMs=8000", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("complete: status %d body %s", res.StatusCode, raw)
	}
	var done types.StatusResponse
	h.decode(raw, &done)
	if done.Status != string(types.RecordingReady) {
		t.Errorf("status = %q, want ready", done.Status)
	}
	if meta := h.rooms.roomMeta(t, lk.RoomName(wb.ID)); meta.Recording {
		t.Error("the room still says it is being recorded after the recording finished")
	}

	// A late chunk must not extend a finished file.
	res, _ = h.doRaw(http.MethodPost, chunkPath, "application/octet-stream", []byte("late"), nil)
	if res.StatusCode != http.StatusConflict {
		t.Errorf("late chunk: status %d, want 409", res.StatusCode)
	}

	// ---- download ---------------------------------------------------------
	filePath := "/api/host/webinars/" + wb.ID + "/recordings/" + rec.ID + "/file"
	res, raw = h.doRaw(http.MethodGet, filePath, "", nil, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("download: status %d", res.StatusCode)
	}
	if got, want := string(raw), string(first)+string(second); got != want {
		t.Errorf("downloaded %q, want %q", got, want)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "video/webm") {
		t.Errorf("Content-Type = %q, want the container that was recorded", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "Recorded Session") ||
		!strings.Contains(cd, ".webm") {
		t.Errorf("Content-Disposition = %q, want a named webm attachment", cd)
	}
	// Range support is what makes a recording scrubbable in a browser. Without it
	// a 40-minute video can only be played from the beginning.
	res, raw = h.doRaw(http.MethodGet, filePath, "", nil, map[string]string{"Range": "bytes=6-10"})
	if res.StatusCode != http.StatusPartialContent {
		t.Errorf("range request: status %d, want 206", res.StatusCode)
	}
	if got := string(raw); got != "chunk" {
		t.Errorf("range body = %q, want %q", got, "chunk")
	}

	// Stop-then-record-again is a second take on the same session, not a second
	// recording in the list.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("second take: status %d body %s", res.StatusCode, raw)
	}
	var take types.Recording
	h.decode(raw, &take)
	if take.ID == rec.ID {
		t.Fatal("second take reused the first row; chunks would overwrite the first file")
	}
	chunkPath2 := "/api/host/webinars/" + wb.ID + "/recordings/" + take.ID + "/chunks"
	if res, raw := h.doRaw(http.MethodPost, chunkPath2, "application/octet-stream", []byte("take-two"), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("second take chunk: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/recordings/"+take.ID+"/complete?durationMs=4000", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("second take complete: status %d body %s", res.StatusCode, raw)
	}
	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	h.decode(raw, &list)
	if len(list) != 1 {
		t.Fatalf("after two takes, recordings = %d, want one session", len(list))
	}
	if list[0].ID != rec.ID {
		t.Errorf("session id = %s, want the first take %s", list[0].ID, rec.ID)
	}
	if len(list[0].Parts) != 2 {
		t.Fatalf("parts = %d, want 2", len(list[0].Parts))
	}

	// ---- delete -----------------------------------------------------------
	if res, raw := h.do(http.MethodDelete,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}
	if res, _ := h.doRaw(http.MethodGet, filePath, "", nil, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("download after delete: status %d, want 404", res.StatusCode)
	}
}

// Recording is a publishing act, so it follows the same line as publishing: the
// stage may, the audience may not.
func TestRecordingIsForTheStageOnly(t *testing.T) {
	h := newHarness(t)
	h.signup("Rec Panelist", "recpanel@test.dev", false)
	h.signup("Bystander", "bystander@test.dev", true) // hosts, but not this webinar
	h.signup("Rec Owner", "recowner@test.dev", true)
	wb := h.newWebinar("Guarded Recording", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "recpanel@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}

	// Signed in, hosts their own webinars, but has nothing to do with this one.
	h.login("bystander@test.dev")
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("outsider recording: status %d body %s, want 403", res.StatusCode, raw)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("outsider listing: status %d, want 403", res.StatusCode)
	}

	// The panelist can record and can take the file. That is the requirement: the
	// people on the stage own what the stage produced.
	h.login("recpanel@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/mp4"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("panelist recording: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if rec.StartedBy != "Rec Panelist" {
		t.Errorf("startedBy = %q, want the panelist", rec.StartedBy)
	}
	if rec.Ext != "mp4" {
		t.Errorf("ext = %q, want mp4 — Safari records MP4 and the server stores what it is given", rec.Ext)
	}
	if res, raw := h.doRaw(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/chunks",
		"application/octet-stream", []byte("panelist-bytes"), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("panelist chunk: status %d body %s", res.StatusCode, raw)
	}
	if res, _ := h.doRaw(http.MethodGet,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/file", "", nil, nil); res.StatusCode != http.StatusOK {
		t.Errorf("panelist download: status %d, want 200", res.StatusCode)
	}

	// Deleting the record of a session is the owner's call, not a guest's.
	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID, nil)
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("panelist delete: status %d body %s, want 403", res.StatusCode, raw)
	}
	h.login("recowner@test.dev")
	if res, _ := h.do(http.MethodDelete,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID, nil); res.StatusCode != http.StatusOK {
		t.Errorf("host delete: status %d, want 200", res.StatusCode)
	}

	// And an attendee — no account at all — cannot reach any of it.
	h.logout()
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("anonymous listing: status %d, want 401", res.StatusCode)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"}); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("anonymous recording: status %d, want 401", res.StatusCode)
	}
}

// A recording that nobody stops must not be able to fill the disk, and the format
// the browser claims must not be able to end up in a response header unchecked.
func TestRecordingLimitsAndValidation(t *testing.T) {
	h := newHarness(t)
	h.signup("Limit Host", "limits@test.dev", true)
	wb := h.newWebinar("Bounded Recording", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}

	for _, mime := range []string{"", "application/zip", "text/html", strings.Repeat("a", 200)} {
		res, _ := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
			types.StartRecordingRequest{Mime: mime})
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("mime %q: status %d, want 422", mime, res.StatusCode)
		}
	}

	// A codec parameter that is not a codec parameter is dropped rather than
	// reflected: this value becomes a Content-Type header.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm;codecs=\"vp9\"\r\nX-Evil: 1"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if strings.ContainsAny(rec.Mime, "\r\n") {
		t.Errorf("mime %q kept a header injection", rec.Mime)
	}

	// The harness caps recordings at 1 MB. One chunk over the line is accepted —
	// the limit is checked before a chunk, not halfway through one — and the next
	// is refused with the recording closed.
	chunkPath := "/api/host/webinars/" + wb.ID + "/recordings/" + rec.ID + "/chunks"
	big := bytes.Repeat([]byte("x"), (1<<20)+1)
	if res, raw := h.doRaw(http.MethodPost, chunkPath, "application/octet-stream", big, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("first chunk: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.doRaw(http.MethodPost, chunkPath, "application/octet-stream", []byte("more"), nil)
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunk past the limit: status %d body %s, want 413", res.StatusCode, raw)
	}

	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	var list []types.Recording
	h.decode(raw, &list)
	if len(list) != 1 || list[0].Status != types.RecordingReady {
		t.Errorf("recording after the cap = %+v, want it closed as ready", list)
	}
	// Closed means a new one can start, rather than the slot being stuck.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"}); res.StatusCode != http.StatusCreated {
		t.Errorf("start after the cap closed one: status %d body %s", res.StatusCode, raw)
	}
}

// Ending the webinar has to close whatever was still recording: the room is gone,
// so no more chunks are coming, and a row left open blocks the next session's
// recording and never becomes a file anyone can download.
func TestEndingTheWebinarFinalisesRecordings(t *testing.T) {
	h := newHarness(t)
	h.signup("Ending Host", "ending@test.dev", true)
	wb := h.newWebinar("Ends While Recording", nil)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	if res, raw := h.doRaw(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/chunks",
		"application/octet-stream", []byte("some-video"), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("chunk: status %d body %s", res.StatusCode, raw)
	}

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}

	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	var list []types.Recording
	h.decode(raw, &list)
	if len(list) != 1 || list[0].Status != types.RecordingReady {
		t.Fatalf("recording after the webinar ended = %+v, want ready", list)
	}
	// The bytes that did arrive are still there.
	res, raw = h.doRaw(http.MethodGet,
		"/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/file", "", nil, nil)
	if res.StatusCode != http.StatusOK || string(raw) != "some-video" {
		t.Errorf("download after the end: status %d body %q", res.StatusCode, raw)
	}

	// And an ended webinar cannot start a new one: there is no room left to record.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/webm"})
	if res.StatusCode != http.StatusConflict {
		t.Errorf("recording an ended webinar: status %d body %s, want 409", res.StatusCode, raw)
	}
}

func TestConfigIsServedToTheFrontend(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodGet, "/api/config", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("config: status %d body %s", res.StatusCode, raw)
	}
	var cfg types.AppConfig
	h.decode(raw, &cfg)
	if cfg.MaxAttendees != 500 {
		t.Errorf("maxAttendees = %d, want the server's configured ceiling", cfg.MaxAttendees)
	}
	if cfg.Tracks == nil {
		t.Error("tracks must be a list, not null — the UI maps over it")
	}
}

func TestHealthAndReadiness(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"/healthz", "/readyz"} {
		res, raw := h.do(http.MethodGet, p, nil)
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d body %s", p, res.StatusCode, raw)
		}
	}
}

// Recording belongs to the host and the panelists, and the join response has to
// say so — the button is drawn from CanRecord, so a wrong answer here is either a
// control nobody can use or a missing one.
//
// The case that matters is the promoted attendee. They publish exactly like a
// panelist, so anything derived from publish permission says yes, and every
// request they make is refused: requireStage wants an ACCOUNT on the stage roster
// and a promotion is not one.
func TestCanRecordFollowsTheStageRosterNotPublishPermission(t *testing.T) {
	h := newHarness(t)
	h.signup("Recording Host", "rec-host@test.dev", true)
	wb := h.newWebinar("Who May Record", nil)

	// The host.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host join: status %d body %s", res.StatusCode, raw)
	}
	var host types.JoinResponse
	h.decode(raw, &host)
	if !host.CanRecord {
		t.Error("the host cannot record their own webinar")
	}

	// An invited panelist: an account on the roster, so yes.
	h.signup("Invited Panelist", "rec-panelist@test.dev", false)
	h.login("rec-host@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists",
		types.PanelistRequest{Email: "rec-panelist@test.dev"}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: status %d body %s", res.StatusCode, raw)
	}
	h.login("rec-panelist@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("panelist join: status %d body %s", res.StatusCode, raw)
	}
	var panelist types.JoinResponse
	h.decode(raw, &panelist)
	if !panelist.CanRecord {
		t.Error("an invited panelist cannot record the section they are presenting")
	}

	// A plain attendee.
	reg := h.registerAsGuest(wb.ID, "rec-attendee@test.dev")
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("attendee join: status %d body %s", res.StatusCode, raw)
	}
	var attendee types.JoinResponse
	h.decode(raw, &attendee)
	if attendee.CanRecord {
		t.Error("an attendee was told they may record")
	}

	// Now the host brings them on stage, fully. They publish, and they still may
	// not record.
	h.login("rec-host@test.dev")
	identity := "att_" + reg.JoinKey
	if res, raw := h.do(http.MethodPost,
		"/api/host/webinars/"+wb.ID+"/participants/"+identity+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("promote: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("promoted rejoin: status %d body %s", res.StatusCode, raw)
	}
	var promoted types.JoinResponse
	h.decode(raw, &promoted)
	if promoted.Role != types.RolePanelist || !promoted.CanPublish {
		t.Fatalf("promotion did not take: role=%q canPublish=%v",
			promoted.Role, promoted.CanPublish)
	}
	if promoted.CanRecord {
		t.Error("a promoted attendee was told they may record — the endpoints refuse them, " +
			"so this is a button that 401s on every press")
	}

	// And the endpoints agree, which is the claim CanRecord is making. No cookies
	// at all: the promoted attendee has no account to authenticate with.
	req, err := http.NewRequest(http.MethodPost,
		h.srv.URL+"/api/host/webinars/"+wb.ID+"/recordings",
		strings.NewReader(`{"mime":"video/mp4"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	anon, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer anon.Body.Close()
	if anon.StatusCode != http.StatusUnauthorized {
		body, _ := io.ReadAll(anon.Body)
		t.Errorf("anonymous start recording: status %d body %s, want 401",
			anon.StatusCode, body)
	}
}

/* Seats: an omitted limit gets the DEFAULT, not every seat on the server.
 *
 * It used to get s.cfg.MaxAttendees, so any request that said nothing about capacity was
 * provisioned for the biggest audience the operator had ever configured. The scheduling form
 * now offers 50/100/200/300/400/500 and defaults to 50; this is the API half of that, so a
 * caller who omits the field is not silently more generous than the UI.
 */
func TestAttendeeLimitDefaultsAndClamps(t *testing.T) {
	h := newHarness(t)
	h.signup("Seat Host", "seats@test.dev", true)

	// Omitted → the default, not MaxAttendees (500 in the test config).
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "No limit given", "startsAt": soon(), "durationMin": 30, "status": "scheduled",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if wb.AttendeeLimit != 50 {
		t.Errorf("omitted limit = %d, want the 50 default (not the 500 ceiling)", wb.AttendeeLimit)
	}

	// Each dropdown value is accepted verbatim.
	for _, want := range []int{50, 100, 200, 300, 400, 500} {
		res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
			"topic": fmt.Sprintf("Limit %d", want), "startsAt": soon(),
			"durationMin": 30, "status": "scheduled", "attendeeLimit": want,
		})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create with %d: status %d body %s", want, res.StatusCode, raw)
		}
		h.decode(raw, &wb)
		if wb.AttendeeLimit != want {
			t.Errorf("attendeeLimit %d came back as %d", want, wb.AttendeeLimit)
		}
	}

	/* Above the ceiling is CLAMPED, not rejected. A coach asking for too many seats wants a
	 * webinar, not a validation error — and the clamp is what makes the dropdown's ceiling
	 * honest rather than advisory. */
	res, raw = h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Too many", "startsAt": soon(), "durationMin": 30,
		"status": "scheduled", "attendeeLimit": 5000,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create with 5000: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &wb)
	if wb.AttendeeLimit != 500 {
		t.Errorf("5000 seats came back as %d, want the 500 ceiling", wb.AttendeeLimit)
	}
}
