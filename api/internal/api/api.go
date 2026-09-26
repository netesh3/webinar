// Package api wires HTTP routes to the store and LiveKit.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/yt"
	"github.com/netkumar/webcast/api/types"
)

// RoomManager is the slice of LiveKit this package needs. Declaring it as an
// interface here (rather than depending on *lk.Client) lets the authorization
// tests exercise the join path without a running SFU — the part worth testing is
// who gets which role, not whether LiveKit works.
type RoomManager interface {
	URL() string
	Token(spec lk.Spec) (string, error)
	EnsureRoom(ctx context.Context, room string, maxParticipants, emptyTimeoutSec uint32, metadata string) (participants int, known bool, err error)
	SetMetadata(ctx context.Context, room, metadata string) error
	SendData(ctx context.Context, room, topic string, data []byte, to []string) error
	ParticipantCount(ctx context.Context, room string) (int, error)
	Participants(ctx context.Context, room string) ([]types.LiveParticipant, error)
	MuteTrack(ctx context.Context, room, identity string, source livekit.TrackSource, muted bool) error
	MuteAll(ctx context.Context, room string, keep map[string]bool) (int, error)
	SetRole(ctx context.Context, spec lk.Spec) error
	SetSpeaking(ctx context.Context, room, identity string, blocked bool) error
	BlockSpeakingAll(ctx context.Context, room string, keep map[string]bool) (int, error)
	AllowAllToSpeak(ctx context.Context, room string, hideAttendees bool) ([]string, error)
	BringAllOnStage(ctx context.Context, room string, hideAttendees bool) ([]string, error)
	RevokeAllSpeaking(ctx context.Context, room string, hideAttendees bool) ([]string, error)
	HideAll(ctx context.Context, room string, role types.Role, hidden bool) (int, error)
	RemoveParticipant(ctx context.Context, room, identity string) error
	DeleteRoom(ctx context.Context, room string) error
	StartRoomCompositeEgress(ctx context.Context, roomName string, storageKey string, s3Opts lk.EgressS3Options, templateURL string, preset livekit.EncodingOptionsPreset) (*livekit.EgressInfo, error)
	StartBroadcastEgress(ctx context.Context, roomName string, templateURL string, preset livekit.EncodingOptionsPreset, rtmpURL string, extraURLs []string) (*livekit.EgressInfo, error)
	StartCombinedEgress(ctx context.Context, roomName string, templateURL string, preset livekit.EncodingOptionsPreset, rtmpURL string, storageKey string, s3Opts lk.EgressS3Options, extraURLs []string) (*livekit.EgressInfo, error)
	UpdateStream(ctx context.Context, egressID string, add, remove []string) (*livekit.EgressInfo, error)
	StopEgress(ctx context.Context, egressID string) (*livekit.EgressInfo, error)
	ListEgress(ctx context.Context, roomName string) ([]*livekit.EgressInfo, error)
}

// Compile-time proof the real client satisfies it.
var _ RoomManager = (*lk.Client)(nil)

/* SFUPool is every LiveKit project this server may use, keyed by the id recorded on a webinar.
 *
 * An interface for the same reason RoomManager is one: the authorization tests need a join path
 * that does not require a running SFU, and now also need to make a project REFUSE a room so the
 * failover can be exercised. There is no way to arrange that against LiveKit Cloud from a test.
 */
type SFUPool interface {
	// Get returns the client for a recorded project id, or an error when that project is no
	// longer configured.
	Get(id string) (RoomManager, error)
	// Candidates is the priority order a new room may be placed in — enabled projects only.
	Candidates() []string
	// IDs is every configured project, for logs and diagnostics.
	IDs() []string
	// KeyProvider provides API keys/secrets for webhook verification.
	KeyProvider() lkauth.KeyProvider
}

/* sfuPool adapts *lk.Pool to SFUPool.
 *
 * Needed because Go interfaces are not covariant in their return types: a Get returning
 * *lk.Client does not satisfy one returning RoomManager, even though *lk.Client is a
 * RoomManager. Three lines here beats making the lk package import this one.
 */
type sfuPool struct{ pool *lk.Pool }

func (a sfuPool) Get(id string) (RoomManager, error) {
	c, err := a.pool.Get(id)
	if err != nil {
		// Explicitly nil, not `return c, err`. A typed nil *lk.Client inside a RoomManager
		// is an interface that is NOT nil, so every `if rm == nil` guard downstream would
		// pass and the next method call would panic.
		return nil, err
	}
	return c, nil
}

func (a sfuPool) Candidates() []string            { return a.pool.Candidates() }
func (a sfuPool) IDs() []string                   { return a.pool.IDs() }
func (a sfuPool) KeyProvider() lkauth.KeyProvider { return a.pool }

// NewSFUPool wraps the real pool for NewServer.
func NewSFUPool(p *lk.Pool) SFUPool { return sfuPool{pool: p} }

type Server struct {
	cfg   config.Config
	store *store.Store
	/* sfu is the POOL, not a client. There is no such thing as "the" SFU any more.
	 *
	 * Every handler that talks to LiveKit resolves the client for the webinar it is acting
	 * on, through sfuFor. Holding a single client here is what the old code did and is
	 * exactly the bug this replaces: it would send a mute for webinar A to whichever project
	 * happened to be configured first.
	 */
	sfu SFUPool
	// youtube is nil when GOOGLE_CLIENT_SECRET is unset. Pasted stream keys
	// still work; Connect YouTube and viaYouTube do not.
	youtube *yt.Client
	// recordings is nil when recording is turned off for this instance, which the
	// handlers check — an operator who disables it gets a clear 503 rather than a
	// button that appears to work and drops the bytes.
	recordings media.Store
	sessions   *auth.Sessions
	log        *slog.Logger
	// sayLimit is keyed on the sender, not on their IP, so it lives here rather
	// than in the middleware stack. See sayPerMin.
	sayLimit *httpx.RateLimiter
	/* How approval emails leave, if they leave at all.
	 *
	 * Derived from config inside NewServer rather than passed in, which keeps the
	 * constructor signature stable for every existing caller — including the tests, which
	 * set no SMTP values and therefore get the discarding transport without asking. That
	 * is the behaviour a test wants: the outbox row is still written and asserted, and
	 * nothing tries to reach a mail server from CI.
	 */
	mail notify.Transport

	invitesMu sync.Mutex
	invites   map[string]pendingStage

	// engage is the WhatsApp CRM, or NoEngage. See engage.go; set by UseEngage.
	engage Engage
}

func NewServer(cfg config.Config, st *store.Store, sfu SFUPool, rec media.Store, log *slog.Logger) *Server {
	var mail notify.Transport = notify.Discard{Log: log}
	if smtp := (notify.SMTP{
		Host: cfg.SMTPHost, Port: cfg.SMTPPort,
		Username: cfg.SMTPUsername, Password: cfg.SMTPPassword,
		From: cfg.SMTPFrom, Log: log,
	}); smtp.Configured() {
		mail = smtp
		log.Info("email enabled", "host", cfg.SMTPHost, "port", cfg.SMTPPort, "from", cfg.SMTPFrom)
	} else {
		log.Info("email disabled: set SMTP_HOST and SMTP_FROM to send approval invitations")
	}

	log.Info("livekit projects", "configured", sfu.IDs(), "accepting_new_rooms", sfu.Candidates())

	var youtube *yt.Client
	if cfg.YouTubeOAuthEnabled() {
		youtube = yt.New(cfg.GoogleClientID, cfg.GoogleClientSecret)
		if cfg.YouTubeAPIURL != "" {
			youtube.API = strings.TrimRight(cfg.YouTubeAPIURL, "/")
		}
		if cfg.YouTubeTokenURL != "" {
			youtube.TokenURL = cfg.YouTubeTokenURL
		}
		log.Info("youtube oauth enabled")
	}

	srv := &Server{
		cfg:        cfg,
		store:      st,
		sfu:        sfu,
		youtube:    youtube,
		recordings: rec,
		sessions:   auth.NewSessions(cfg.SessionSecret, cfg.SessionTTL, cfg.CookieSecure),
		log:        log,
		sayLimit:   httpx.NewRateLimiter(sayPerMin, time.Minute),
		mail:       mail,
		invites:    map[string]pendingStage{},
		engage:     NoEngage{},
	}
	return srv
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(httpx.Recoverer(s.log))
	r.Use(httpx.Logger(s.log))
	r.Use(httpx.SecurityHeaders)
	r.Use(middleware.Compress(5))
	// Streaming a recording is exempt: see httpx.Timeout. Everything else gets a
	// deadline, because a request that cannot finish in twenty seconds is a request
	// that is not going to finish.
	// The tick is exempt too: it bounds itself (tickBudget) and a pass cut at 20 s would
	// leave the rest of the outbox for a minute later.
	r.Use(httpx.Timeout(20*time.Second, "/recordings/", "/api/internal/tick"))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: s.cfg.CORSOrigins,
		AllowedMethods: []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"Content-Type", "Accept", "Range"},
		// Without this, JavaScript on the frontend origin cannot read either header
		// on a recording download — the browser hides everything but a handful of
		// simple ones — so a client saving the file has no name to give it.
		ExposedHeaders:   []string{"Content-Disposition", "Content-Length", "Content-Range"},
		AllowCredentials: true, // the session cookie must travel
		MaxAge:           300,
	}))

	// Liveness: is the process up. Readiness: can it serve traffic.
	// A load balancer needs both, and conflating them causes restart loops.
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
	})
	r.Get("/readyz", s.handleReady)

	// Rate limits are per client IP. The budgets differ because the paths differ
	// in what abuse of them costs and in how many legitimate people share one IP.
	//
	// Registration creates rows, so it is the tightest. Joining and looking up a
	// registration are checked against a credential on every call and are hit by
	// an entire audience at once — from one egress IP, for a corporate audience —
	// so a tight limit there locks out the room rather than protecting it.
	registerLimit := httpx.NewRateLimiter(s.cfg.RegisterPerMin, time.Minute)
	joinLimit := httpx.NewRateLimiter(s.cfg.JoinPerMin, time.Minute)
	loginLimit := httpx.NewRateLimiter(10, time.Minute)
	// Signup is cheaper to abuse than login and creates rows, so it gets its own
	// tighter bucket rather than sharing the login one.
	signupLimit := httpx.NewRateLimiter(5, time.Minute)
	// Sized like joinLimit: this creates no rows and every participant in a
	// live performance test polls it every ~10s, from what may be a shared
	// corporate IP the same way a join burst is. A backstop against a flood,
	// not the reason this endpoint is safe — TelemetryEnabled is.
	telemetryLimit := httpx.NewRateLimiter(600, time.Minute)

	r.Route("/api", func(r chi.Router) {
		// ---------------- public ----------------
		publicAPI := r
		r.Get("/config", s.handleConfig)
		r.Post("/webhooks/livekit", s.handleLiveKitWebhook)
		/* The background job, run on request, for a deployment that scales to zero. Not
		 * mounted without a secret. See tick.go. */
		if s.cfg.TickSecret != "" {
			r.Post("/internal/tick", s.handleInternalTick)
		}

		/* One webinar BY SLUG stays public; the LIST does not.
		 *
		 * The asymmetry is the whole access rule. A registration link is meant to be
		 * forwarded to people who have no account, so this page has to answer a caller
		 * with no session or nobody can ever sign up. But answering "here is everything
		 * on this server" to the same caller is what let one host read another host's
		 * sessions, so the list now requires a session and returns only what that
		 * account hosts, presents, or has registered for.
		 *
		 * Knowing a slug is therefore the price of seeing a webinar. That is a weak
		 * secret and it is the intended one — it is how every "you're invited" link on
		 * the internet works. What it is not is enumerable, which the list was.
		 */
		r.Get("/webinars/{slug}", s.handleGetWebinar)
		// The cover image, same reasoning as the slug lookup above: a registration or
		// browse page has to render it for a caller with no session. Unlike chat media
		// there is no credential to resolve — a cover image is public the moment the
		// webinar is, which handleWebinarImage checks by loading the webinar itself.
		r.Get("/webinars/{slug}/image", s.handleWebinarImage)
		r.Get("/webinars/{slug}/recordings/{id}/public", s.handlePublicRecording)
		r.Get("/webinars/{slug}/recordings/{id}/stream", s.handlePublicStreamRecording)

		r.Group(func(r chi.Router) {
			r.Use(s.requireUser)
			r.Get("/webinars", s.handleListWebinars)
		})

		r.With(registerLimit.Middleware).
			Post("/webinars/{slug}/register", s.handleRegister)

		r.Group(func(r chi.Router) {
			r.Use(joinLimit.Middleware)
			r.Post("/webinars/{slug}/join", s.handleAttendeeJoin)

			/* The guest door: a name, and in.
			 *
			 * Inside joinLimit rather than registerLimit, because that is what it is. It
			 * mints a credential and goes straight to a token, so it belongs in the bucket
			 * sized for the join burst at the top of the hour — and it must not spend the
			 * registration allowance a real audience needs to sign up.
			 *
			 * It creates a row, so it is also the cheapest thing on this server to abuse.
			 * The rate limiter is the whole of the defence and it is per-IP; the attendee
			 * ceiling is what stops the room filling up.
			 */
			r.Post("/webinars/{slug}/guest-join", s.handleGuestJoin)
			// A POST only because it carries a list of keys in the body; it reads
			// nothing else and writes nothing.
			r.Post("/registrations/lookup", s.handleLookup)
		})

		// The audience's chat, questions, raised hands and reactions.
		//
		// Public in the same sense join is: the credential travels in the body and the
		// handler resolves it before doing anything else. Attendees cannot publish on
		// the data channel at all — see lk.GrantFor — so this is the only way their
		// messages reach the room, and it is where the host's chat destination is
		// applied.
		//
		// Deliberately outside joinLimit, with a per-sender budget of its own: an
		// audience chatting must not spend the allowance that same audience needs in
		// order to get in.
		r.Post("/webinars/{slug}/say", s.handleSay)

		// Polls, as the audience sees them: no drafts, no unshared tallies and no
		// answer to a quiz that is still open. Same credential as /say, and the
		// narrowing is done server-side — the answers to a live quiz must not be in
		// five hundred browsers waiting to be read out of a response.
		r.Get("/webinars/{slug}/polls", s.handleAudiencePolls)
		r.Post("/webinars/{slug}/polls/{id}/vote", s.handleVote)
		r.Post("/webinars/{slug}/stage-invite", s.handleStageInviteRespond)
		r.Post("/webinars/{slug}/captions", s.handleAppendCaption)

		// Chat history. The same request answers "catch up after a dropped connection" and
		// "what was said before I arrived" — one is a cursor of zero — and the backlog is
		// filtered by the same audience rule live delivery used.
		r.Get("/webinars/{slug}/chat", s.handleChatBacklog)
		// An image and the message carrying it, in one request: an upload endpoint that
		// hands back a handle for a second call leaves orphaned bytes every time the second
		// call does not happen.
		r.Post("/webinars/{slug}/chat/image", s.handleChatImage)
		// Served from here rather than as a bucket URL, so it stays behind the same
		// credential as the room instead of being a link that outlives the session.
		r.Get("/webinars/{slug}/chat/media/{id}", s.handleChatMedia)
		// Moderation: host, co-host or panelist removing an attendee's message. Same
		// credential path as the rest of this group (resolveSender) rather than
		// requireUser, since a panelist reaches this without a full session too.
		r.Delete("/webinars/{slug}/chat/{id}", s.handleDeleteChat)

		// ---------------- auth ----------------
		r.With(signupLimit.Middleware).Post("/auth/signup", s.handleSignup)
		r.With(loginLimit.Middleware).Post("/auth/login", s.handleLogin)
		// Same budget as login: exchanging a Google token is a sign-in attempt.
		r.With(loginLimit.Middleware).Post("/auth/supabase", s.handleSupabaseAuth)
		r.Post("/auth/logout", s.handleLogout)
		r.With(s.requireUser).Get("/auth/me", s.handleMe)
		r.With(s.requireUser).Patch("/auth/me", s.handleUpdateProfile)

		// ---------------- telemetry (off unless TelemetryEnabled; see handleTelemetry) ----------------
		r.With(telemetryLimit.Middleware).Post("/telemetry", s.handleTelemetry)

		// ---------------- signed-in account ----------------
		r.Route("/me", func(r chi.Router) {
			r.Use(s.requireUser)
			r.Get("/registrations", s.handleMyRegistrations)
		})

		// ---------------- host and stage ----------------
		/* Administration. One privilege to administer: who may host.
		 *
		 * A sibling of /host rather than a branch of it, because an admin is not
		 * necessarily interested in hosting and a host is definitely not an admin.
		 * Nothing in here creates another admin — see ADMIN_EMAILS. */
		r.Route("/admin", func(r chi.Router) {
			r.Use(s.requireAdmin)

			r.Get("/users", s.handleAdminUsers)
			r.Patch("/users/{id}/host", s.handleSetHostCapability)
			r.Patch("/users/{id}/max-duration", s.handleSetUserMaxDuration)
			r.Patch("/users/{id}/cdn-broadcast", s.handleSetCdnBroadcastCapability)
			r.Patch("/users/{id}/features", s.handleSetFeature)
			r.Delete("/users/{id}", s.handleAdminDeleteUser)

			r.Get("/webinars", s.handleAdminWebinars)
			r.Delete("/webinars/{slug}", s.handleAdminDeleteWebinar)
		})

		r.Get("/host/youtube/callback", s.handleYouTubeCallback)

		r.Route("/host", func(r chi.Router) {
			r.Use(s.requireUser)

			// These two are for the stage, not for hosting, and they must NOT
			// require the hosting capability. A panelist is invited by name to
			// somebody else's webinar; asking them to turn on hosting first would
			// mean a guest speaker cannot reach the room they were invited to.
			// Both handlers authorize themselves: join checks owner-or-panelist,
			// and the stage list only ever returns the caller's own rows.
			r.Post("/webinars/{slug}/join", s.handleHostJoin)
			r.Get("/stage", s.handleStageWebinars)

			// ---- recording: the host AND the panelists ----
			//
			// requireStage rather than requireOwnership: a panelist presenting a
			// section should be able to record it and take the file. The audience
			// cannot reach any of this, which is the same rule as their token —
			// recording is a publishing act.
			//
			// Registered as explicit patterns rather than a nested Route, because
			// the ownership-scoped subtree below is already mounted at
			// /webinars/{slug} and two mounts on one path do not coexist.
			r.Group(func(r chi.Router) {
				r.Use(s.requireStage)

				r.Get("/webinars/{slug}/recordings", s.handleListRecordings)
				r.Post("/webinars/{slug}/recordings", s.handleStartRecording)
				r.Post("/webinars/{slug}/recordings/{id}/chunks", s.handleRecordingChunk)
				r.Post("/webinars/{slug}/recordings/{id}/complete", s.handleCompleteRecording)
				r.Get("/webinars/{slug}/recordings/{id}/file", s.handleDownloadRecording)
				r.Patch("/webinars/{slug}/recordings/{id}/share", s.handleUpdateRecordingShare)
				r.Delete("/webinars/{slug}/recordings/{id}", s.handleDeleteRecording)
			})

			// Everything below needs the hosting capability, so an ordinary
			// attendee account cannot reach it even with a valid session.
			r.Group(func(r chi.Router) {
				r.Use(s.requireHost)

				r.Get("/webinars", s.handleHostWebinars)
				r.Post("/webinars", s.handleCreateWebinar)
				r.Get("/recordings", s.handleHostRecordingLibrary)

				r.Get("/youtube/connect", s.handleYouTubeConnect)
				r.Delete("/youtube", s.handleYouTubeDisconnect)

				// The WhatsApp CRM's routes, mounted by the CRM itself. See Engage.Mount.
				s.engage.Mount(publicAPI, r)

				/* The notification bell. Outside the per-webinar subtree on purpose:
				 * an alert's whole job is to tell a host about a webinar they are NOT
				 * currently looking at, so it cannot be scoped to one slug. Scoped to
				 * the caller's user id in SQL instead. */
				r.Get("/alerts", s.handleHostAlerts)
				r.Post("/alerts/read", s.handleReadHostAlerts)
				r.Patch("/registrations/{id}", s.handleSetRegistrationState)

				// Everything below is scoped to one webinar the caller owns.
				r.Route("/webinars/{slug}", func(r chi.Router) {
					r.Use(s.requireOwnership)

					r.Get("/", s.handleHostWebinar)
					r.Patch("/", s.handleUpdateWebinar)
					r.Patch("/stream", s.handleSetStream)

					// Deleting the webinar and handing it to someone else stay with the
					// account actually listed as its host — see requireTrueOwner. Every
					// other host action in this subtree, a co-host may also take.
					r.Group(func(r chi.Router) {
						r.Use(s.requireTrueOwner)
						r.Delete("/", s.handleDeleteWebinar)
						r.Post("/transfer-host", s.handleTransferHost)
					})

					r.Post("/start", s.handleStartWebinar)
					r.Post("/end", s.handleEndWebinar)
					r.Patch("/controls", s.handleUpdateControls)

					// The cover image. Client-compressed and cropped before it gets here —
					// see web/lib/webinar-image.ts — so this is a plain replace, not an
					// edit-in-place: uploading again overwrites whatever was there.
					r.Post("/image", s.handleUploadWebinarImage)
					r.Delete("/image", s.handleDeleteWebinarImage)

					// ---- polls and quizzes ----
					//
					// The host's view: every question including the drafts, every
					// tally, and the correct answer to every quiz.
					// The chat archive. Unfiltered, including the panelists-only lines
					// the audience never saw, with the stats a report would otherwise
					// recompute by reading the whole transcript. ?format=csv for a
					// spreadsheet, JSON for a pipeline.
					r.Get("/chat", s.handleChatTranscript)
					r.Get("/chat/stats", s.handleChatStats)

					r.Get("/polls", s.handleListPolls)
					r.Post("/polls", s.handleCreatePoll)
					r.Post("/polls/{id}/open", s.handleOpenPoll)
					r.Post("/polls/{id}/close", s.handleClosePoll)
					r.Delete("/polls/{id}", s.handleDeletePoll)

					r.Get("/registrants", s.handleHostRegistrants)
					r.Get("/registrants.csv", s.handleExportRegistrants)
					r.Get("/report", s.handleSessionReport)
					r.Get("/report.csv", s.handleExportReport)
					r.Get("/transcript.txt", s.handleTranscript)
					r.Patch("/questions/{id}", s.handlePatchQuestion)
					r.Post("/registrants/approve-all", s.handleApproveAll)

					/* The approval queue, and a selective batch decision on it.
					 *
					 * GET returns only the rows awaiting a decision; /registrants
					 * returns everybody in every state and is what the roster tab
					 * uses. PATCH takes a chosen set of ids and one state for all
					 * of them, which is the difference between reviewing forty
					 * strangers and approving all forty. */
					r.Get("/approvals", s.handlePendingApprovals)
					r.Patch("/approvals", s.handleApprovals)

					r.Post("/panelists", s.handleAddPanelist)
					r.Delete("/panelists/{userID}", s.handleRemovePanelist)
					r.Patch("/panelists/{userID}/co-host", s.handleSetCoHost)

					// ---- in-session moderation ----
					r.Get("/participants", s.handleParticipants)
					r.Post("/mute-all", s.handleMuteAll)
					r.Post("/participants/allow-all", s.handleAllowAllToSpeak)
					r.Post("/participants/stage-all", s.handleBringAllOnStage)
					r.Post("/participants/revoke-all", s.handleRevokeAllSpeaking)
					r.Patch("/participants/{identity}/mute", s.handleMuteOne)
					r.Post("/participants/{identity}/stage", s.handleSetStage)
					r.Delete("/participants/{identity}", s.handleRemoveParticipant)
				})
			})
		})
	})

	return r
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		s.log.Error("readiness: database unreachable", "error", err)
		httpx.Error(w, http.StatusServiceUnavailable, "not_ready", "Database unavailable.")
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ready"})
}

// handleConfig is what removes build-time constants from the frontend bundle.
// The product name, the public URL used to build share links and the attendee
// ceiling are all operator settings, so the UI asks for them.
func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	tracks, err := s.store.Tracks(r.Context())
	if err != nil {
		// Suggestions are a nicety. Losing them must not blank the app.
		s.log.Warn("config: could not load tracks", "error", err)
		tracks = []string{}
	}
	httpx.JSON(w, http.StatusOK, types.AppConfig{
		AppName:                 s.cfg.AppName,
		WebBaseURL:              s.cfg.WebBaseURL,
		SupportEmail:            s.cfg.SupportEmail,
		MaxAttendees:            s.cfg.MaxAttendees,
		SignupOpen:              s.cfg.SignupOpen,
		DefaultMaxMeetingMin:    s.cfg.DefaultMaxMeetingMin,
		Tracks:                  tracks,
		GoogleClientID:          s.cfg.GoogleClientID,
		GoogleAPIKey:            s.cfg.GoogleAPIKey,
		YouTubeOAuth:            s.cfg.YouTubeOAuthEnabled(),
		WhatsAppConnect:         s.engage.ConnectEnabled(),
		SupabaseURL:             s.cfg.SupabaseURL,
		SupabaseAnonKey:         s.cfg.SupabaseAnonKey,
		GoogleAuth:              s.cfg.GoogleAuthEnabled(),
		CloudRecordingEnabled:   s.recordings != nil,
		RecordingMode:           s.cfg.RecordingsMode,
		RecordingsRetentionDays: s.cfg.RecordingsRetentionDays,
		EmailConfigured:         s.mail.Configured(),
		TelemetryEnabled:        s.cfg.TelemetryEnabled,
		// The admin screen renders one switch per entry, so the list of switches
		// travels with the operator settings rather than with the accounts.
		FeatureCatalogue: types.Features,
	})
}
