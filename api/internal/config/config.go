package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/push"
	"github.com/netkumar/webcast/api/types"
)

// Config is read once at startup. Everything has a development default except
// the secrets, which must be supplied explicitly when Env != "development" —
// shipping a known signing key is how staging environments get taken over.
type Config struct {
	Env  string
	Addr string

	DatabaseURL string

	/* Every LiveKit deployment this server may put rooms on, in priority order.
	 *
	 * A list rather than one address because a LiveKit Cloud project has a monthly
	 * allowance: when it runs out, new sessions have to move to another project without a
	 * deploy and without disturbing the sessions already running. See livekit.go for the
	 * format, and for why the ids in it are permanent.
	 *
	 * Never empty — validate() refuses to start otherwise — so nothing downstream has to
	 * handle the no-SFU case.
	 */
	LiveKitProjects []LiveKitProject

	SessionSecret string
	SessionTTL    time.Duration
	CookieSecure  bool
	CORSOrigins   []string
	MaxAttendees  int
	TokenTTL      time.Duration
	ShutdownGrace time.Duration

	// Rate limits, per client IP per minute.
	//
	// The join limit has to be generous, and that is not a compromise. Attendees
	// arrive at the top of the hour, and a corporate audience arrives from ONE
	// egress IP — so a limit sized for "one person retrying" locks out an entire
	// office. The credential is checked on every request anyway, so a high
	// ceiling here still refuses everyone without a valid registration; it exists
	// as a flood backstop, not as the authorization boundary.
	RegisterPerMin int
	JoinPerMin     int

	/* DefaultAttendeeLimit is what a webinar gets when the request does not say.
	 *
	 * It used to be MaxAttendees, so every webinar created without an explicit limit was
	 * provisioned for the largest audience the operator had ever configured — 500 here —
	 * whether or not anybody expected one. That is the wrong default in the direction that
	 * costs money and quality: seats are a capacity commitment, and this box's sustained
	 * egress runs out long before 500 (docs/CAPACITY.md).
	 *
	 * 50, matching the first option in the scheduling form's dropdown. Clamped to MaxAttendees
	 * where it is used, so an operator who lowers the ceiling below it does not end up handing
	 * out more seats than they configured.
	 */
	DefaultAttendeeLimit int
	// DefaultMaxMeetingMin is the default maximum duration for meetings in minutes (default 180 = 3h).
	DefaultMaxMeetingMin int
	// EmptyRoomCloseMin ends a live webinar that has had nobody in it for this
	// many minutes, once its scheduled start has passed. A host who closes the
	// tab instead of pressing End otherwise leaves the room live, the meeting
	// limit counting, and any Egress still encoding. 0 turns the sweep off.
	EmptyRoomCloseMin int
	/* TickSecret switches on POST /api/internal/tick, which runs one pass of the background
	 * job (reminders, drips, bots, outboxes, meeting limits) inside the request.
	 *
	 * For Cloud Run scaled to zero, where no background goroutine runs between requests:
	 * Cloud Scheduler calls it every minute with the secret in X-Tick-Secret (see
	 * deploy/cloud-scheduler-tick.sh). Empty means the endpoint does not exist, which is
	 * right for an always-on process whose own ticker is enough. At least 32 characters. */
	TickSecret string

	/* VAPID identity for Web Push (api/internal/push). All three set turns push on: the
	 * browser opt-ins, GET /api/push/public-key and the notifications the tick sends. All
	 * three empty is off, and the UI offers nothing push-shaped; a partial set is refused at
	 * boot. Generate the pair with `npx web-push generate-vapid-keys`. VAPIDSubject is a
	 * mailto: or https: contact the push services can reach. */
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string

	/* CaptionsSecret switches on server-side live captions (deploy/captions): the shared
	 * secret the caption agent sends in X-Captions-Secret to POST /api/internal/captions,
	 * /captions/status and /transcripts. Empty means those endpoints do not exist and
	 * POST /api/host/webinars/{slug}/captions/server answers 503, so the browsers keep
	 * captioning on-device. At least 32 characters. */
	CaptionsSecret string
	/* MixRecSecret switches on recording from the audience mix (api/mixrec.go): the shared
	 * secret between this API and the mix recorder on each SFU box
	 * (deploy/livekit-box/mixrec), sent both ways in X-Mixrec-Secret. Empty means a
	 * recording started while an edge mix runs is its own compositor, as before. At least 32
	 * characters. */
	MixRecSecret string
	/* MixRecURL is where the mix recorder answers, when it is not the live origin's
	 * /mixrec (the box's own Caddy, see MixRecorderURLFor). A project's mixRecorderUrl wins. */
	MixRecURL string
	// CaptionsAgentName is the LiveKit agent name the caption agent registers under
	// (CAPTIONS_AGENT_NAME on both sides). Default "webinar-captions".
	CaptionsAgentName string
	// CaptionsProvider is who transcribes them: Deepgram from the video box, or the local
	// models on the captions box (captions_provider.go).
	CaptionsProvider CaptionsProvider

	// Recording.
	//
	// RecordingsBackend is the storage seam: "disk", or "s3" for an
	// S3-compatible bucket (Backblaze B2 in practice — it speaks the S3 API
	// directly). It is validated at boot rather than falling back silently,
	// because "recording is on" and "recordings are being kept somewhere"
	// have to be the same statement.
	RecordingsEnabled bool
	RecordingsBackend string
	// RecordingsDir is the local disk backend's own store when
	// RecordingsBackend is "disk" — and, when it is "s3", the local STAGING
	// area every recording still passes through before Finalize uploads it
	// (see media.S3's own comment for why an S3-family bucket cannot be
	// appended to in place the way this whole feature otherwise assumes).
	// Both backends need it writable; only the meaning of what ends up there
	// permanently differs.
	RecordingsDir string
	// MaxRecordingMB caps a single recording. A forgotten one otherwise fills the
	// disk and takes the API down with it — the recording is not the thing that
	// matters most on that machine. Doubles, for the "s3" backend, as the size
	// a single recording occupies on local disk for the whole session before
	// Finalize ever uploads it — see RecordingsDir.
	MaxRecordingMB int
	// RecordingsRetentionDays is how long a finished recording is kept in object
	// storage. After that the sweeper deletes the row and the bytes. 0 disables
	// automatic deletion. The UI uses the same number so hosts know to download.
	RecordingsRetentionDays int
	// MediaQuotaDefaultMB is how much a host may keep in the WhatsApp media library
	// (template headers and cards), counted after images are converted. An admin can
	// set a different limit per account. 0 or less is the built-in default (10).
	MediaQuotaDefaultMB int

	// RecordingsS3* configure the "s3" backend. Required only when
	// RecordingsBackend is "s3" — left empty and unused for "disk", so a
	// deployment that never turns this on need not set them at all.
	RecordingsS3Bucket    string
	RecordingsS3Endpoint  string
	RecordingsS3Region    string
	RecordingsS3AccessKey string
	RecordingsS3SecretKey string

	// RecordingsMode: "egress" (server-side via LiveKit Egress) or "client" (browser composite).
	RecordingsMode string
	// RecordingsEgressTemplateURL is the web template URL loaded by LiveKit Egress.
	RecordingsEgressTemplateURL string
	// RecordingsEgressPreset: "1080p" (default) or "720p".
	RecordingsEgressPreset string
	// RecordingsCDNBaseURL: Cloudflare CDN URL for serving recordings (e.g. https://recordings.webinarliv.com).
	RecordingsCDNBaseURL string

	/* BroadcastRTMPBase / BroadcastHLSBase are the live origin for Edge delivery: Egress
	 * pushes RTMP to MediaMTX on the SFU box (BroadcastRTMPBase, a loopback address there),
	 * and BroadcastHLSBase is that box's public /live, where its LL-HLS is served — the
	 * Edge playback URL when no CDN pull zone is set (EdgePlaybackURLFor).
	 *
	 * Both must be set together: RTMP with no public origin encodes a feed nobody can
	 * fetch, and an origin with no RTMP has nothing on it. (This was also the WHEP path of
	 * the retired CDN Broadcast mode, 2026-10-20.) */
	BroadcastRTMPBase string
	BroadcastHLSBase  string
	/* EdgePlaybackBase is where an Edge-delivery audience plays the LL-HLS feed:
	 * <base>/<slug>/index.m3u8. Empty derives it from the live origin
	 * (the per-project or global BroadcastHLSBase, whose /live/* route MediaMTX's LL-HLS
	 * already sits behind). Point it at a CDN pull zone that mirrors that origin (Bunny)
	 * and nothing else changes. See docs/edge-delivery.md. */
	EdgePlaybackBase string
	/* OpsAlertEmails get operator alerts that need a person: the Edge egress pool is full,
	 * or GCP could not start a worker. Empty sends them to the admin accounts. */
	OpsAlertEmails []string
	/* EdgeDebugClock overlays a server-synced wall clock on an edge webinar's composite
	 * (the egress loads the template at <template>/clock) and on the edge player, so
	 * glass-to-glass latency can be read off a screenshot. Off by default; a test aid. */
	EdgeDebugClock bool
	/* DebugGoroutines turns on GET /api/admin/debug/goroutines, this instance's goroutine
	 * profile for an admin (api/debug_goroutines.go). Off by default (DEBUG_GOROUTINES). */
	DebugGoroutines bool
	/* EdgeNearCountries turns on delivery by where the viewer is (EDGE_NEAR_COUNTRIES, ISO
	 * country codes, e.g. "IN"). A viewer in one of them, or of unknown country, plays the
	 * box itself (the project's broadcastHlsBase, else BROADCAST_HLS_BASE); everyone else plays
	 * the CDN pull zone (edgePlaybackBase, else EDGE_PLAYBACK_BASE), which serves them from an
	 * edge near them. Each is offered the other as a fallback (EdgePlaybackChoiceFor). Empty
	 * keeps the old rule: the CDN when there is one, for everybody. */
	EdgeNearCountries []string
	/* EdgeEncoding is the mix encoding for edge webinars' egress only: EDGE_ENCODING_WIDTH /
	 * _HEIGHT (default 1280x720), EDGE_ENCODING_FPS (DefaultEdgeEncodingFPS, 25),
	 * EDGE_VIDEO_BITRATE_KBPS (DefaultEdgeVideoBitrateKbps, 1500), EDGE_AUDIO_BITRATE_KBPS
	 * (AAC, 128) and EDGE_H264_PROFILE (baseline|main|high, default baseline). The keyframe
	 * interval stays 1s whatever the frame rate (LiveKit takes it in seconds). 25 fps rather
	 * than the broadcast preset's 30 is a sixth fewer frames for the egress to composite and
	 * encode; raise anything only where the egress box can carry it (docs/edge-delivery.md).
	 * Validated at load. */
	EdgeEncodingWidth    int
	EdgeEncodingHeight   int
	EdgeEncodingFPS      int
	EdgeVideoBitrateKbps int
	EdgeAudioBitrateKbps int
	EdgeH264Profile      string

	// Branding and public URLs are served to the frontend over /api/config so
	// the bundle carries no build-time constants for things an operator sets.
	// Share links in particular must not be baked in: a link that points at
	// someone else's domain is worse than no link.
	AppName      string
	WebBaseURL   string
	SupportEmail string
	SignupOpen   bool

	/* AdminEmails is who may grant the hosting capability, and the only way in.
	 *
	 * Deliberately outside the database's control surface. Hosting used to be self-service, so
	 * the fix is only worth anything if the privilege that grants it cannot itself be granted
	 * through the API — otherwise taking over one admin account recreates the original problem
	 * with extra steps. Reconciled at boot in both directions: an address removed from here is
	 * demoted on the next restart, because a config value should say who the admins ARE.
	 */
	AdminEmails []string

	/* AdminPassword bootstraps a MISSING admin account, and nothing else.
	 *
	 * Without it, ADMIN_EMAILS on a fresh database names somebody who has to sign up through
	 * the public form before they can administer anything — a chicken-and-egg problem on every
	 * new deployment, and again every time the data is cleared.
	 *
	 * Used only to CREATE. An account that already exists is never touched, including its
	 * password: otherwise an admin who rotated theirs would have it silently reverted by the
	 * next deploy, and this value would be a permanent back door into a live account rather
	 * than a bootstrap.
	 *
	 * Unset means no account is created — a warning, not an invented password. Held to the
	 * MinPasswordLength floor (see its own doc comment) even though regular signup no longer
	 * is, because a short one here is worse: it is on the account that grants every other
	 * privilege.
	 */
	AdminPassword string

	/* Outbound email, for approval invitations. Entirely optional.
	 *
	 * Unset, the workflow still works: a host sees pending registrations in the app and gets
	 * an in-app alert, and every message that would have been emailed is recorded as
	 * 'skipped' with the reason rather than lost. Set SMTPHost and SMTPFrom and the same
	 * messages start being delivered, with no other change.
	 *
	 * Deliberately not defaulted to a real server. A half-configured mail path that errors
	 * on every approval makes a working feature look broken, and teaches whoever is on call
	 * to ignore the log line that will one day be a genuine delivery failure.
	 *
	 * Host, port, username, password and From all come from the environment. No provider
	 * is named in code. Production sets SMTP_HOST to smtp.gmail.com. Gmail accepts From
	 * only when it is the authenticated account or a verified "Send mail as" alias, and
	 * it rewrites or rejects anything else — so a per-host address such as
	 * gsp@webinarliv.com is Reply-To only (notify.InboxAddress), never SMTP_FROM.
	 * Gmail will not take the account's normal password: SMTP_PASSWORD has to be an app
	 * password on a 2FA account. OAuth is the other way in; this client speaks SMTP AUTH.
	 */
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	SMTPFrom     string
	/* InboxWebhookSecret authenticates the Cloudflare email worker's POST to
	 * /api/webhooks/email. Empty means that route refuses every request. */
	InboxWebhookSecret string

	/* The welcome email sent once to every new account (see notify.WelcomeEmail).
	 *
	 * ContactEmail / ContactPhone are what the email tells a new customer to use to reach
	 * the team. Separate from SupportEmail, which is served to the web app and is the
	 * SMTP_FROM fallback: the people who answer a new customer are not necessarily the
	 * address mail is sent from. Defaults are the team's current details so a deployment
	 * that sets nothing still sends a message somebody can reply to.
	 *
	 * WelcomeEmail turns the whole thing off. Nothing is queued while it is off, and turning
	 * it back on does not email the accounts created in between.
	 */
	ContactEmail string
	ContactPhone string
	WelcomeEmail bool
	/* Google Drive, for picking a video to share into a session.
	 *
	 * Client ID and API key are public values by design — the OAuth client id
	 * identifies the app to Google and the API key is restricted by HTTP
	 * referrer, so serving them to the browser is how the Picker is meant to
	 * be used. GoogleClientSecret is NOT for the picker: it is the YouTube
	 * Live authorization-code grant, server-side only.
	 *
	 * Unset client id means the Drive source is offered as unavailable rather
	 * than as a button that opens a Google error page.
	 */
	GoogleClientID string
	GoogleAPIKey   string
	/* GoogleClientSecret is the Web OAuth client's secret. Used for first-party
	 * Google sign-in (authorization-code grant) and for YouTube Live (offline
	 * access). Never served to the browser. Unset means Continue with Google and
	 * Connect YouTube are hidden; pasted stream keys still work. */
	GoogleClientSecret string

	/* YouTubeAPIURL / YouTubeTokenURL override Google's endpoints. Empty in
	 * production. Tests point them at httptest.Server. */
	YouTubeAPIURL   string
	YouTubeTokenURL string

	/* Zoom is per-host OAuth against an unpublished development app.
	 *
	 * All four of client id, secret, redirect URL, and a 32-byte token key
	 * are required before Connect is offered. A partial set leaves the card
	 * on "Zoom is not configured" rather than a button that cannot finish.
	 * The webhook secret signs POST /api/webhooks/zoom. Unset, that route
	 * refuses the body. None of these values are logged. */
	ZoomClientID      string
	ZoomClientSecret  string
	ZoomRedirectURL   string
	ZoomTokenKey      string
	ZoomWebhookSecret string
	/* ZoomAPIURL / ZoomOAuthURL override Zoom's hosts. Empty in production.
	 * Tests point them at httptest.Server. */
	ZoomAPIURL   string
	ZoomOAuthURL string

	/* Razorpay — self-serve plans. See internal/billing.
	 *
	 * The key id and secret together turn on checkout; one without the other is
	 * refused at boot. The key id is public (Checkout needs it in the browser),
	 * the secret signs every payment the browser reports and never leaves the API.
	 * The webhook secret is the one set on the Razorpay dashboard's webhook; unset,
	 * POST /api/webhooks/razorpay refuses every body and only the browser's own
	 * callback fulfils orders. Use rzp_test_ keys until the flow is checked.
	 *
	 * BillingGSTPercent is added to INR prices at checkout (default 18). 0 means
	 * prices are quoted without tax. RazorpayAPIURL overrides api.razorpay.com for
	 * tests.
	 */
	RazorpayKeyID         string
	RazorpayKeySecret     string
	RazorpayWebhookSecret string
	RazorpayAPIURL        string
	BillingGSTPercent     int
	/* TrialHashSalt salts the hashes that make the free trial once per person
	 * (store.TrialDigest). The monthly trial is offered only when billing is on and
	 * this is set; without it the pricing page offers pay-now only. Never change it
	 * once trials have started: every earlier claim would stop matching. */
	TrialHashSalt string

	/* Meta WhatsApp Cloud API — Connect WhatsApp, via Meta Embedded Signup.
	 *
	 * MetaAppID and MetaWhatsAppConfigID are public values by design, the same way
	 * GoogleClientID is: the browser needs both to open Meta's Embedded Signup
	 * dialog at all. MetaAppSecret is not — it signs the code exchange and
	 * verifies every webhook body — and stays on the API.
	 *
	 * All three unset means Connect WhatsApp is not offered. That default is
	 * deliberate and it is about money, not tidiness: the host's own WhatsApp
	 * Business Account is billed for every conversation, so an instance must not
	 * imply it can send on somebody's behalf until an operator has actually set
	 * this up. validate() refuses a partial set.
	 */
	MetaAppID            string
	MetaAppSecret        string
	MetaWhatsAppConfigID string
	/* MetaWebhookVerifyToken is the string Meta echoes back once, when the
	 * webhook subscription is first confirmed (GET /api/webhooks/whatsapp).
	 *
	 * It says nothing about the authenticity of later payloads — that is the app
	 * secret's HMAC, see wa.Client.VerifySignature — so it only needs to be
	 * unguessable enough that nobody else can complete our subscription.
	 */
	MetaWebhookVerifyToken string
	/* WhatsAppGraphURL overrides Meta's Graph host, including its version
	 * segment. Empty in production, where the pinned wa.DefaultGraph applies.
	 * Tests point it at an httptest.Server, like YouTubeAPIURL. */
	WhatsAppGraphURL string
	/* WhatsAppRates overrides the built-in per-country Meta rate card used when a
	 * status callback names a category but not an amount. Micros of a rupee
	 * (1_000_000 = ₹1): "IN:utility=130000,US=40000". Empty keeps the built-in card. */
	WhatsAppRates string

	/* Supabase Auth — unused for browser login (first-party Google OAuth uses
	 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Kept so POST /api/auth/supabase
	 * still verifies tokens if an old client posts one.
	 *
	 * The Postgres DATABASE_URL may already point at the same Supabase project.
	 */
	SupabaseURL        string
	SupabaseProjectURL string
	SupabaseAnonKey    string
	SupabaseJWTSecret  string

	// MinPasswordLength now governs AdminPassword only — regular signup no
	// longer enforces a floor (see validateSignup). Kept for the bootstrap
	// admin account specifically: that one password grants every other
	// privilege, and a low bar there is worth guarding even while the
	// ordinary signup form asks for none.
	//
	// Development defaults low; outside development the floor is enforced at
	// boot, so a value chosen for convenience cannot follow the deployment
	// into production.
	MinPasswordLength int

	// SeedDev fills an empty development database with demo hosts and webinars.
	//
	// On by default because a fresh clone with nothing in it looks broken, and off
	// is what you want the moment the instance is yours: the seed fires whenever
	// `users` is empty, so without this, deleting the demo accounts silently
	// recreates them on the next restart. Never runs outside development either
	// way — a known password in a real database is a breach.
	SeedDev bool

	// AuthBypass turns off authentication entirely.
	//
	// With it on, a request without a session does not get a 401 — it gets a brand
	// new account, host-capable, with the session cookie set on the way out. Every
	// browser that opens the site becomes a distinct real user immediately, so there
	// is no sign-in page, no registration form, and nothing to remember. Joining a
	// webinar somebody else started registers the caller automatically.
	//
	// Distinct accounts rather than one shared one, deliberately: a LiveKit identity
	// must be unique or the SFU disconnects the older session when a duplicate
	// joins, so a single shared login would mean each laptop kicking the last one
	// out of the room.
	//
	// This is a demo switch. It hands hosting rights — start, end, mute, remove — to
	// anyone who finds the URL, so it is off unless explicitly set, and the boot log
	// says so loudly when it is on.
	AuthBypass bool

	/* TelemetryEnabled turns on POST /api/telemetry and the token-issuance
	 * timing log in issueToken. Off by default: for a specific performance-test
	 * window, not a standing feature. The frontend's own poller (see
	 * web/lib/telemetry.ts) is gated on this same flag, round-tripped through
	 * AppConfig — one switch turns the whole path on or off, front and back.
	 */
	TelemetryEnabled bool

	/* AV1Publish is the server-side switch for AV1 publishing in the browser (AV1_PUBLISH),
	 * read by every client through /api/config before it joins a room. Changing the env var
	 * on the Cloud Run service turns AV1 off for the next join; no web deploy needed.
	 *
	 *   off       (default) cameras VP8, shares VP9/H264, as before AV1 existed.
	 *   meetings  AV1 only in meeting rooms.
	 *   on        AV1 wherever the device can afford it, except rooms with an edge mix.
	 *
	 * Off by default since the 2026-10-24 incident: a subscriber that cannot take AV1 (the
	 * edge-mix egress Chrome always) makes livekit-server regress the track to its backup
	 * codec, and the backup stream reached the mix late or not at all. See
	 * web/lib/codec-policy.ts (av1RoomVerdict). */
	AV1Publish string

	/* AIProviders is the model chain for the AI features, in the order tried. Empty means
	 * the AI features are off. See ai.go in this package for the two ways to set it. */
	AIProviders []AIProvider

	/* AIMonthlyUSD and AIHostMonthlyUSD cap what the AI features may spend in a calendar
	 * month (UTC), estimated from token counts (internal/ai/price.go): AIMonthlyUSD for the
	 * whole instance (AI_MONTHLY_USD, default 20), AIHostMonthlyUSD for one host
	 * (AI_HOST_MONTHLY_USD, default 2). Past either, an AI feature answers "AI limit
	 * reached for this month" instead of calling a model. Free providers cost $0, so a
	 * chain with no paid provider never reaches them. 0 means no AI spend at all. */
	AIMonthlyUSD     float64
	AIHostMonthlyUSD float64

	/* AIModelHighlights is the OpenAI model for the clip features: picking a recording's
	 * highlights, planning reels, their hook titles and the suggested post text
	 * (AI_MODEL_HIGHLIGHTS, default gpt-5-mini). Choosing moments is judgement over a whole
	 * transcript, where the small default model is weakest; every other feature stays on
	 * OPENAI_MODEL. Only OpenAI's own API is asked for it (ai.Request.Model); set it to the
	 * same value as OPENAI_MODEL to keep the clip features on that model too. */
	AIModelHighlights string
	/* AIGroqModelQuality and AIGroqModelFast are the Groq models per kind of task, when the
	 * answer comes from Groq (AI_PROVIDER, config/ai.go). Quality (AI_GROQ_MODEL_QUALITY,
	 * default openai/gpt-oss-120b) is for writing that a host reads and keeps: the recap, the
	 * follow-ups, repurposed posts, highlights and reels, lead reasons, webinar setup, the Q&A
	 * clusters. Fast (AI_GROQ_MODEL_FAST, default openai/gpt-oss-20b) is for the short,
	 * frequent calls inside a live session or a page load: the sales chat, chat spam, the
	 * Q&A answers and drafts. Both take strict json_schema on Groq. GROQ_MODEL stays the
	 * provider's own model, asked when a tier model is refused. */
	AIGroqModelQuality string
	AIGroqModelFast    string

	/* AIEmbeddings is the endpoint the AI knowledge embeds its chunks and questions with
	 * (text-embedding-3-small): OpenAI's, from OPENAI_API_KEY or the AI_PROVIDERS entry on
	 * api.openai.com. Nil means no embeddings: retrieval is full-text search alone. */
	AIEmbeddings *AIProvider

	/* SFUBox is the on-demand DigitalOcean video server (sfu_box.go in this package): off
	 * unless SFU_BOX_PROJECT and DO_API_TOKEN are set. */
	SFUBox SFUBox
}

// httpFromWS converts the browser-facing ws(s) URL into the http(s) form the
// server-side LiveKit room API client needs.
func httpFromWS(u string) string {
	switch {
	case strings.HasPrefix(u, "wss://"):
		return "https://" + strings.TrimPrefix(u, "wss://")
	case strings.HasPrefix(u, "ws://"):
		return "http://" + strings.TrimPrefix(u, "ws://")
	default:
		return u
	}
}

func Load() (Config, error) {
	c := Config{
		Env:  env("APP_ENV", "development"),
		Addr: listenAddr(),
		// 5432 to match start.sh and the Makefile. Both set DATABASE_URL
		// explicitly, so this default only matters when running the binary by
		// hand — which is exactly when a disagreeing port wastes ten minutes.
		DatabaseURL:    env("DATABASE_URL", "postgres://webcast:webcast@localhost:5432/webcast?sslmode=disable"),
		SessionSecret:  env("SESSION_SECRET", "dev-session-secret-not-for-production-use"),
		SessionTTL:     envDuration("SESSION_TTL", 24*time.Hour),
		TokenTTL:       envDuration("LIVEKIT_TOKEN_TTL", 2*time.Hour),
		ShutdownGrace:  envDuration("SHUTDOWN_GRACE", 15*time.Second),
		MaxAttendees:   envInt("MAX_ATTENDEES", 500),
		RegisterPerMin: envInt("REGISTER_RATE_PER_MIN", 30),
		// Sized so a full house behind a single NAT can all get in within a
		// minute, with headroom for reconnects.
		JoinPerMin:           envInt("JOIN_RATE_PER_MIN", 1200),
		DefaultAttendeeLimit: envInt("DEFAULT_ATTENDEE_LIMIT", 50),
		CORSOrigins:          splitAndTrim(env("CORS_ORIGINS", "http://localhost:3000")),
		AppName:              env("APP_NAME", "Webinar Liv"),
		SupportEmail:         env("SUPPORT_EMAIL", ""),
		DefaultMaxMeetingMin: envInt("DEFAULT_MAX_MEETING_MIN", 180),
		EmptyRoomCloseMin:    envInt("EMPTY_ROOM_CLOSE_MIN", 10),
		TickSecret:           strings.TrimSpace(env("TICK_SECRET", "")),
		VAPIDPublicKey:       strings.TrimSpace(env("VAPID_PUBLIC_KEY", "")),
		VAPIDPrivateKey:      strings.TrimSpace(env("VAPID_PRIVATE_KEY", "")),
		VAPIDSubject:         strings.TrimSpace(env("VAPID_SUBJECT", "")),
		CaptionsSecret:       strings.TrimSpace(env("CAPTIONS_SECRET", "")),
		CaptionsAgentName:    strings.TrimSpace(env("CAPTIONS_AGENT_NAME", "webinar-captions")),
		CaptionsProvider:     loadCaptionsProvider(),
		MixRecSecret:         strings.TrimSpace(env("MIXREC_SECRET", "")),
		MixRecURL:            strings.TrimRight(strings.TrimSpace(env("MIXREC_URL", "")), "/"),
		AdminEmails:          splitAndTrim(env("ADMIN_EMAILS", "")),
		AdminPassword:        env("ADMIN_PASSWORD", ""),
		SMTPHost:             env("SMTP_HOST", ""),
		// 587 is submission-with-STARTTLS, which is what a hosted provider expects.
		SMTPPort:     envInt("SMTP_PORT", 587),
		SMTPUsername: env("SMTP_USERNAME", ""),
		SMTPPassword: env("SMTP_PASSWORD", ""),
		// Falls back to SUPPORT_EMAIL, because an operator who has already said where mail
		// comes from should not have to say it twice.
		SMTPFrom:                env("SMTP_FROM", env("SUPPORT_EMAIL", "")),
		InboxWebhookSecret:      strings.TrimSpace(env("INBOX_WEBHOOK_SECRET", "")),
		ContactEmail:            strings.TrimSpace(env("CONTACT_EMAIL", "webinarliv@gmail.com")),
		ContactPhone:            strings.TrimSpace(env("CONTACT_PHONE", "+91-9852411280")),
		GoogleClientID:          env("GOOGLE_CLIENT_ID", ""),
		GoogleAPIKey:            env("GOOGLE_API_KEY", ""),
		GoogleClientSecret:      env("GOOGLE_CLIENT_SECRET", ""),
		ZoomClientID:            strings.TrimSpace(env("ZOOM_CLIENT_ID", "")),
		ZoomClientSecret:        strings.TrimSpace(env("ZOOM_CLIENT_SECRET", "")),
		ZoomRedirectURL:         strings.TrimSpace(env("ZOOM_REDIRECT_URL", "")),
		ZoomTokenKey:            strings.TrimSpace(env("ZOOM_TOKEN_KEY", "")),
		ZoomWebhookSecret:       strings.TrimSpace(env("ZOOM_WEBHOOK_SECRET", "")),
		ZoomAPIURL:              strings.TrimRight(env("ZOOM_API_URL", ""), "/"),
		ZoomOAuthURL:            strings.TrimRight(env("ZOOM_OAUTH_URL", ""), "/"),
		RazorpayKeyID:           strings.TrimSpace(env("RAZORPAY_KEY_ID", "")),
		RazorpayKeySecret:       strings.TrimSpace(env("RAZORPAY_KEY_SECRET", "")),
		RazorpayWebhookSecret:   strings.TrimSpace(env("RAZORPAY_WEBHOOK_SECRET", "")),
		RazorpayAPIURL:          strings.TrimRight(env("RAZORPAY_API_URL", ""), "/"),
		BillingGSTPercent:       envInt("BILLING_GST_PERCENT", 18),
		TrialHashSalt:           strings.TrimSpace(env("TRIAL_HASH_SALT", "")),
		MetaAppID:               env("META_APP_ID", ""),
		MetaAppSecret:           env("META_APP_SECRET", ""),
		MetaWhatsAppConfigID:    env("META_WHATSAPP_CONFIG_ID", ""),
		MetaWebhookVerifyToken:  env("META_WEBHOOK_VERIFY_TOKEN", ""),
		WhatsAppGraphURL:        strings.TrimRight(env("WHATSAPP_GRAPH_URL", ""), "/"),
		WhatsAppRates:           env("WHATSAPP_RATES", ""),
		SupabaseURL:             strings.TrimRight(env("SUPABASE_URL", ""), "/"),
		SupabaseProjectURL:      strings.TrimRight(env("SUPABASE_PROJECT_URL", ""), "/"),
		SupabaseAnonKey:         env("SUPABASE_ANON_KEY", ""),
		SupabaseJWTSecret:       env("SUPABASE_JWT_SECRET", ""),
		RecordingsBackend:       strings.ToLower(env("RECORDINGS_BACKEND", "disk")),
		RecordingsDir:           env("RECORDINGS_DIR", "./.data/recordings"),
		MaxRecordingMB:          envInt("MAX_RECORDING_MB", 4096),
		RecordingsRetentionDays: envInt("RECORDINGS_RETENTION_DAYS", 30),
		MediaQuotaDefaultMB:     envInt("MEDIA_QUOTA_DEFAULT_MB", types.DefaultMediaQuotaMB),
		RecordingsS3Bucket:      env("RECORDINGS_S3_BUCKET", ""),
		RecordingsS3Endpoint:    env("RECORDINGS_S3_ENDPOINT", ""),
		// us-east-1 as the fallback rather than empty: an S3-compatible
		// provider that ignores region (many do) still gets something
		// syntactically valid, and one that requires it (B2 does — the
		// region is embedded in its own endpoint host, e.g.
		// s3.eu-central-003.backblazeb2.com) is documented well enough that
		// an operator setting RECORDINGS_S3_ENDPOINT is expected to set this
		// to match.
		RecordingsS3Region:          env("RECORDINGS_S3_REGION", "us-east-1"),
		RecordingsS3AccessKey:       env("RECORDINGS_S3_ACCESS_KEY", ""),
		RecordingsS3SecretKey:       env("RECORDINGS_S3_SECRET_KEY", ""),
		RecordingsMode:              strings.ToLower(env("RECORDINGS_MODE", "")),
		RecordingsEgressTemplateURL: strings.TrimRight(env("RECORDINGS_EGRESS_TEMPLATE_URL", ""), "/"),
		RecordingsEgressPreset:      strings.ToLower(env("RECORDINGS_EGRESS_PRESET", "1080p")),
		RecordingsCDNBaseURL:        strings.TrimRight(env("RECORDINGS_CDN_BASE_URL", ""), "/"),
		BroadcastRTMPBase:           strings.TrimRight(env("BROADCAST_RTMP_BASE", ""), "/"),
		BroadcastHLSBase:            strings.TrimRight(env("BROADCAST_HLS_BASE", ""), "/"),
		EdgePlaybackBase:            strings.TrimRight(env("EDGE_PLAYBACK_BASE", ""), "/"),
		OpsAlertEmails:              splitAndTrim(env("OPS_ALERT_EMAILS", "")),
		EdgeDebugClock:              strings.EqualFold(strings.TrimSpace(env("EDGE_DEBUG_CLOCK", "")), "true"),
		DebugGoroutines:             strings.EqualFold(strings.TrimSpace(env("DEBUG_GOROUTINES", "")), "true"),
		EdgeNearCountries:           countryList(env("EDGE_NEAR_COUNTRIES", "")),
		EdgeEncodingWidth:           envIntStrict("EDGE_ENCODING_WIDTH", 1280),
		EdgeEncodingHeight:          envIntStrict("EDGE_ENCODING_HEIGHT", 720),
		EdgeEncodingFPS:             envIntStrict("EDGE_ENCODING_FPS", DefaultEdgeEncodingFPS),
		EdgeVideoBitrateKbps:        envIntStrict("EDGE_VIDEO_BITRATE_KBPS", DefaultEdgeVideoBitrateKbps),
		EdgeAudioBitrateKbps:        envIntStrict("EDGE_AUDIO_BITRATE_KBPS", 128),
		EdgeH264Profile:             strings.ToLower(strings.TrimSpace(env("EDGE_H264_PROFILE", "baseline"))),
	}
	if c.RecordingsMode == "" {
		if c.RecordingsBackend == "s3" {
			c.RecordingsMode = "egress"
		} else {
			c.RecordingsMode = "client"
		}
	}
	c.CookieSecure = envBool("COOKIE_SECURE", c.Env != "development")
	c.SignupOpen = envBool("SIGNUP_OPEN", true)
	c.WelcomeEmail = envBool("WELCOME_EMAIL", true)
	c.RecordingsEnabled = envBool("RECORDINGS_ENABLED", true)
	c.SeedDev = envBool("SEED_DEV", true)
	c.AuthBypass = envBool("AUTH_BYPASS", false)
	c.TelemetryEnabled = envBool("TELEMETRY_ENABLED", false)
	c.AV1Publish = AV1PublishMode(os.Getenv("AV1_PUBLISH"))
	c.MinPasswordLength = envInt("MIN_PASSWORD_LENGTH", passwordFloorFor(c.Env))

	/* The SFU list, parsed before validate() so a malformed one is a boot error.
	 *
	 * A JSON syntax error is returned immediately rather than collected: with no list at
	 * all, every other LiveKit check below would report a second, misleading failure about
	 * a missing url.
	 */
	projects, err := loadLiveKitProjects()
	if err != nil {
		return Config{}, err
	}
	c.LiveKitProjects = normaliseLiveKitProjects(projects)
	c.SFUBox = loadSFUBox()

	// The AI providers, parsed here for the same reason: a malformed list is a boot error.
	aiProviders, err := loadAIProviders()
	if err != nil {
		return Config{}, err
	}
	c.AIProviders = aiProviders
	c.AIEmbeddings = embeddingsProvider(aiProviders)
	c.AIMonthlyUSD = envFloatStrict("AI_MONTHLY_USD", 20)
	c.AIHostMonthlyUSD = envFloatStrict("AI_HOST_MONTHLY_USD", 2)
	c.AIModelHighlights = env("AI_MODEL_HIGHLIGHTS", "gpt-5-mini")
	c.AIGroqModelQuality = env("AI_GROQ_MODEL_QUALITY", "openai/gpt-oss-120b")
	c.AIGroqModelFast = env("AI_GROQ_MODEL_FAST", "openai/gpt-oss-20b")

	// Default the public URL to the first allowed origin. That is already the
	// frontend's address in every correct deployment, so share links are right
	// without a second variable to forget.
	fallbackWeb := ""
	if len(c.CORSOrigins) > 0 {
		fallbackWeb = c.CORSOrigins[0]
	}
	c.WebBaseURL = strings.TrimSuffix(env("WEB_BASE_URL", fallbackWeb), "/")

	if err := c.validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

func (c Config) IsDev() bool { return c.Env == "development" }

// GoogleAuthEnabled is true when first-party Google sign-in can be offered.
// The browser talks to Google through webinarliv.com / Cloud Run; it never
// needs to reach *.supabase.co. Needs the Web client id AND secret.
func (c Config) GoogleAuthEnabled() bool {
	return strings.TrimSpace(c.GoogleClientID) != "" && strings.TrimSpace(c.GoogleClientSecret) != ""
}

// YouTubeOAuthEnabled is the Connect YouTube / create-a-live path. Needs the
// Web client id AND secret; the picker-only client id is not enough.
func (c Config) YouTubeOAuthEnabled() bool {
	return strings.TrimSpace(c.GoogleClientID) != "" && strings.TrimSpace(c.GoogleClientSecret) != ""
}

/* ZoomEnabled is Connect, create, and registrant push. The token key is
 * checked again at startup; a key that is not 32 bytes leaves this false. */
func (c Config) ZoomEnabled() bool {
	return c.ZoomClientID != "" && c.ZoomClientSecret != "" && c.ZoomRedirectURL != "" && c.ZoomTokenKey != ""
}

// BillingEnabled is self-serve checkout: both Razorpay keys are set.
func (c Config) BillingEnabled() bool {
	return c.RazorpayKeyID != "" && c.RazorpayKeySecret != ""
}

// TrialEnabled is the monthly free trial: billing is on and claims can be hashed.
func (c Config) TrialEnabled() bool {
	return c.BillingEnabled() && c.TrialHashSalt != ""
}

/* WhatsAppConnectEnabled is the Connect WhatsApp path: Embedded Signup, and the
 * CRM sends that ride on the grant it produces.
 *
 * Needs the app id, the app secret AND the Embedded Signup config id. Two of the
 * three is not a degraded mode, it is a Connect button that cannot finish — so
 * the frontend is told the feature is off, and validate() has already refused to
 * boot on a partial set. */
// MediaQuotaDefaultBytes is the media library limit for an account without its own.
func (c Config) MediaQuotaDefaultBytes() int64 {
	if c.MediaQuotaDefaultMB > 0 {
		return int64(c.MediaQuotaDefaultMB) << 20
	}
	return int64(types.DefaultMediaQuotaMB) << 20
}

func (c Config) WhatsAppConnectEnabled() bool {
	return strings.TrimSpace(c.MetaAppID) != "" &&
		strings.TrimSpace(c.MetaAppSecret) != "" &&
		strings.TrimSpace(c.MetaWhatsAppConfigID) != ""
}

// passwordFloor is the shortest password a real deployment may accept. Ten
// characters is the modern advice: long enough to matter, short enough that
// people do not write it on a sticky note.
const passwordFloor = 10

// devPasswordFloor keeps a local instance usable by whoever is building it. Four
// characters is not a security posture, it is a keystroke budget — and validate()
// refuses to let it out of development.
const devPasswordFloor = 4

func passwordFloorFor(env string) int {
	if env == "development" {
		return devPasswordFloor
	}
	return passwordFloor
}

func (c Config) validate() error {
	var errs []error
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}
	if c.MaxAttendees < 1 {
		errs = append(errs, errors.New("MAX_ATTENDEES must be >= 1"))
	}
	/* A zero here is not harmless: it becomes the attendee_limit of every webinar created
	 * without one, and a webinar with no seats refuses the first registrant. Caught at boot
	 * rather than at the first schedule, which is the difference between a config error and a
	 * coach wondering why nobody can sign up. */
	if c.DefaultAttendeeLimit < 1 {
		errs = append(errs, errors.New("DEFAULT_ATTENDEE_LIMIT must be >= 1"))
	}
	if c.DefaultMaxMeetingMin < 1 {
		errs = append(errs, errors.New("DEFAULT_MAX_MEETING_MIN must be >= 1"))
	}
	if c.EmptyRoomCloseMin < 0 {
		errs = append(errs, errors.New("EMPTY_ROOM_CLOSE_MIN must be >= 0"))
	}
	// Short secrets are refused: this endpoint is public and triggers sends.
	if c.CaptionsSecret != "" && len(c.CaptionsSecret) < 32 {
		errs = append(errs, errors.New("CAPTIONS_SECRET must be at least 32 characters (openssl rand -hex 32)"))
	}
	if c.MixRecSecret != "" && len(c.MixRecSecret) < 32 {
		errs = append(errs, errors.New("MIXREC_SECRET must be at least 32 characters (openssl rand -hex 32)"))
	}
	if c.TickSecret != "" && len(c.TickSecret) < 32 {
		errs = append(errs, errors.New("TICK_SECRET must be at least 32 characters (openssl rand -hex 32)"))
	}
	if c.RegisterPerMin < 1 {
		errs = append(errs, errors.New("REGISTER_RATE_PER_MIN must be >= 1"))
	}
	// A join limit below the attendee ceiling means a full audience behind one
	// NAT cannot get in, which presents as "the webinar is broken".
	if c.JoinPerMin < c.MaxAttendees {
		errs = append(errs, fmt.Errorf(
			"JOIN_RATE_PER_MIN (%d) must be at least MAX_ATTENDEES (%d): attendees behind one NAT share an IP",
			c.JoinPerMin, c.MaxAttendees))
	}
	if c.RecordingsEnabled {
		switch c.RecordingsBackend {
		case "disk":
			if strings.TrimSpace(c.RecordingsDir) == "" {
				errs = append(errs, errors.New("RECORDINGS_DIR is required when RECORDINGS_BACKEND=disk"))
			}
		case "s3":
			// RecordingsDir is required here too — it is the local staging
			// area every recording still passes through before Finalize
			// uploads it; see media.S3's own comment for why.
			if strings.TrimSpace(c.RecordingsDir) == "" {
				errs = append(errs, errors.New("RECORDINGS_DIR is required when RECORDINGS_BACKEND=s3 (it stages a recording locally before uploading it)"))
			}
			if strings.TrimSpace(c.RecordingsS3Bucket) == "" {
				errs = append(errs, errors.New("RECORDINGS_S3_BUCKET is required when RECORDINGS_BACKEND=s3"))
			}
			if strings.TrimSpace(c.RecordingsS3Endpoint) == "" {
				errs = append(errs, errors.New("RECORDINGS_S3_ENDPOINT is required when RECORDINGS_BACKEND=s3"))
			}
			if strings.TrimSpace(c.RecordingsS3AccessKey) == "" {
				errs = append(errs, errors.New("RECORDINGS_S3_ACCESS_KEY is required when RECORDINGS_BACKEND=s3"))
			}
			if strings.TrimSpace(c.RecordingsS3SecretKey) == "" {
				errs = append(errs, errors.New("RECORDINGS_S3_SECRET_KEY is required when RECORDINGS_BACKEND=s3"))
			}
		default:
			errs = append(errs, fmt.Errorf("RECORDINGS_BACKEND=%q is not a known backend (disk, s3)", c.RecordingsBackend))
		}
		if c.MaxRecordingMB < 1 {
			errs = append(errs, errors.New("MAX_RECORDING_MB must be >= 1"))
		}
		if c.RecordingsRetentionDays < 0 {
			errs = append(errs, errors.New("RECORDINGS_RETENTION_DAYS must be >= 0"))
		}
		if c.RecordingsMode != "egress" && c.RecordingsMode != "client" {
			errs = append(errs, fmt.Errorf("RECORDINGS_MODE=%q is not a known mode (egress, client)", c.RecordingsMode))
		}
		if c.RecordingsMode == "egress" && c.RecordingsBackend != "s3" {
			errs = append(errs, errors.New("RECORDINGS_BACKEND must be 's3' when RECORDINGS_MODE is 'egress'"))
		}
		if c.RecordingsCDNBaseURL != "" && !strings.HasPrefix(c.RecordingsCDNBaseURL, "http://") && !strings.HasPrefix(c.RecordingsCDNBaseURL, "https://") {
			errs = append(errs, fmt.Errorf("RECORDINGS_CDN_BASE_URL must begin with http:// or https://: %q", c.RecordingsCDNBaseURL))
		}
	}
	/* Embedded Signup: all three, or none.
	 *
	 * Caught at boot because the failure it prevents is invisible until somebody
	 * tries to use it. With the app id and config id but no secret, a host
	 * completes Meta's dialog — granting us access to their business, with their
	 * payment method behind it — and the exchange that would have stored the grant
	 * fails afterwards. That is a worse outcome than no button at all, and the
	 * operator who forgot the secret should hear about it from the boot log rather
	 * than from the host.
	 */
	metaSet := map[string]string{
		"META_APP_ID":             c.MetaAppID,
		"META_APP_SECRET":         c.MetaAppSecret,
		"META_WHATSAPP_CONFIG_ID": c.MetaWhatsAppConfigID,
	}
	var metaMissing []string
	for name, v := range metaSet {
		if strings.TrimSpace(v) == "" {
			metaMissing = append(metaMissing, name)
		}
	}
	// Sorted so the message is stable — map iteration order is not.
	sort.Strings(metaMissing)
	if n := len(metaMissing); n > 0 && n < len(metaSet) {
		errs = append(errs, fmt.Errorf(
			"Connect WhatsApp is half-configured: %s missing. Set all three or none",
			strings.Join(metaMissing, ", ")))
	}

	// Razorpay: both keys or neither. A key id alone would open Checkout, take the
	// money, and then fail to verify the payment it just took.
	if (c.RazorpayKeyID == "") != (c.RazorpayKeySecret == "") {
		errs = append(errs, errors.New("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together"))
	}
	if c.BillingGSTPercent < 0 || c.BillingGSTPercent > 100 {
		errs = append(errs, fmt.Errorf("BILLING_GST_PERCENT must be between 0 and 100: %d", c.BillingGSTPercent))
	}

	if (c.BroadcastRTMPBase == "") != (c.BroadcastHLSBase == "") {
		errs = append(errs, errors.New("BROADCAST_RTMP_BASE and BROADCAST_HLS_BASE must be set together (RTMP ingest and the public live origin)"))
	}
	if c.BroadcastRTMPBase != "" && !strings.HasPrefix(c.BroadcastRTMPBase, "rtmp://") && !strings.HasPrefix(c.BroadcastRTMPBase, "rtmps://") {
		errs = append(errs, fmt.Errorf("BROADCAST_RTMP_BASE must begin with rtmp:// or rtmps://: %q", c.BroadcastRTMPBase))
	}
	if c.BroadcastHLSBase != "" && !strings.HasPrefix(c.BroadcastHLSBase, "http://") && !strings.HasPrefix(c.BroadcastHLSBase, "https://") {
		errs = append(errs, fmt.Errorf("BROADCAST_HLS_BASE must begin with http:// or https://: %q", c.BroadcastHLSBase))
	}

	if c.MinPasswordLength < 1 {
		errs = append(errs, errors.New("MIN_PASSWORD_LENGTH must be >= 1"))
	}
	errs = append(errs, c.edgeEncodingErrors()...)

	if !c.IsDev() {
		// A relaxed floor is a development convenience. Letting it reach production
		// would turn "easier to test" into "every account is guessable".
		if c.MinPasswordLength < passwordFloor {
			errs = append(errs, fmt.Errorf(
				"MIN_PASSWORD_LENGTH (%d) must be at least %d outside development",
				c.MinPasswordLength, passwordFloor))
		}
		// Fail loudly rather than silently running production on dev secrets.
		if strings.HasPrefix(c.SessionSecret, "dev-") || len(c.SessionSecret) < 32 {
			errs = append(errs, errors.New("SESSION_SECRET must be set to >=32 random bytes outside development"))
		}
		if !c.CookieSecure {
			errs = append(errs, errors.New("COOKIE_SECURE must be true outside development"))
		}
		if c.WebBaseURL == "" {
			errs = append(errs, errors.New("WEB_BASE_URL (or CORS_ORIGINS) is required outside development: share links are built from it"))
		}
	}
	// Checked in every environment, because half of these are wrong in development too —
	// an empty secret or a duplicate id is not a production-only mistake.
	errs = append(errs, validateLiveKitProjects(c.LiveKitProjects, c.IsDev()))
	errs = append(errs, validateAIProviders(c.AIProviders, c.IsDev()))
	errs = append(errs, c.Push().Validate())
	if c.AIMonthlyUSD < 0 {
		errs = append(errs, errors.New("AI_MONTHLY_USD must be a number of US dollars, >= 0"))
	}
	if c.AIHostMonthlyUSD < 0 {
		errs = append(errs, errors.New("AI_HOST_MONTHLY_USD must be a number of US dollars, >= 0"))
	}
	errs = append(errs, c.validateSFUBox()...)
	errs = append(errs, c.validateCaptionsProvider()...)

	return errors.Join(errs...)
}

// Push is the Web Push identity; Enabled() is false when the VAPID variables are unset.
func (c Config) Push() push.Config {
	return push.Config{PublicKey: c.VAPIDPublicKey, PrivateKey: c.VAPIDPrivateKey, Subject: c.VAPIDSubject}
}

// listenAddr prefers ADDR; if unset, honors Cloud Run's PORT (a bare number).
func listenAddr() string {
	if v := strings.TrimSpace(os.Getenv("ADDR")); v != "" {
		return v
	}
	if p := strings.TrimSpace(os.Getenv("PORT")); p != "" {
		if strings.HasPrefix(p, ":") {
			return p
		}
		return ":" + p
	}
	return ":8080"
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

/* envFloatStrict is envIntStrict for a decimal: anything set but not a finite number
 * reads as -1, which the validation rejects with the variable's name. */
func envFloatStrict(key string, def float64) float64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return -1
	}
	return f
}

/* envIntStrict is envInt for a value that must not fall back silently: anything set but not a
 * whole number reads as -1, which the validation rejects with the variable's name. */
func envIntStrict(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return -1
	}
	return n
}

/* The edge mix's frame rate and video bitrate when EDGE_ENCODING_FPS / EDGE_VIDEO_BITRATE_KBPS
 * are unset: 720p at 25 fps, with the broadcast preset's 1700 kbps scaled to the frame rate
 * (1700 x 25/30, rounded down to 1500) so each frame keeps about the same bits. */
const (
	DefaultEdgeEncodingFPS      = 25
	DefaultEdgeVideoBitrateKbps = 1500
)

// edgeEncodingErrors checks the edge egress encoding is something an H.264 encoder accepts.
func (c Config) edgeEncodingErrors() []error {
	var errs []error
	check := func(name string, v, lo, hi int, even bool) {
		if v < lo || v > hi || (even && v%2 != 0) {
			msg := fmt.Sprintf("%s must be a whole number from %d to %d", name, lo, hi)
			if even {
				msg += ", and even"
			}
			errs = append(errs, fmt.Errorf("%s (got %d)", msg, v))
		}
	}
	check("EDGE_ENCODING_WIDTH", c.EdgeEncodingWidth, 320, 3840, true)
	check("EDGE_ENCODING_HEIGHT", c.EdgeEncodingHeight, 180, 2160, true)
	check("EDGE_ENCODING_FPS", c.EdgeEncodingFPS, 10, 60, false)
	check("EDGE_VIDEO_BITRATE_KBPS", c.EdgeVideoBitrateKbps, 300, 20000, false)
	check("EDGE_AUDIO_BITRATE_KBPS", c.EdgeAudioBitrateKbps, 32, 320, false)
	switch c.EdgeH264Profile {
	case "baseline", "main", "high":
	default:
		errs = append(errs, fmt.Errorf("EDGE_H264_PROFILE must be baseline, main or high: %q", c.EdgeH264Profile))
	}
	return errs
}

// AV1 publish modes (AV1_PUBLISH).
const (
	AV1PublishOff      = "off"
	AV1PublishMeetings = "meetings"
	AV1PublishOn       = "on"
)

// AV1PublishMode normalises AV1_PUBLISH. Anything unrecognised is "off": a typo fails safe.
func AV1PublishMode(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case AV1PublishOn, "true", "1":
		return AV1PublishOn
	case AV1PublishMeetings:
		return AV1PublishMeetings
	default:
		return AV1PublishOff
	}
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func splitAndTrim(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

/* BroadcastRTMPURL is the RTMP ingest LiveKit Egress pushes, on the SFU box.
 *
 * Empty when the live origin is not configured. The slug is the MediaMTX path
 * that also appears in the matching playback URL. */
func (c Config) BroadcastRTMPURL(slug string) string {
	if c.BroadcastRTMPBase == "" || strings.TrimSpace(slug) == "" {
		return ""
	}
	return c.BroadcastRTMPBase + "/" + strings.TrimSpace(slug)
}

/* EdgePlaybackURLFor is the HLS playlist an Edge-delivery audience plays under the old rule
 * (the CDN when there is one); EdgePlaybackChoiceFor chooses per viewer.
 *
 * Empty when there is no live origin (no BROADCAST_RTMP_BASE): the egress has nowhere to
 * push, so there is nothing to play, and join keeps the audience on standard delivery. */
func (c Config) EdgePlaybackURLFor(projectID, slug string) string {
	slug = strings.TrimSpace(slug)
	if c.BroadcastRTMPBase == "" || slug == "" {
		return ""
	}
	p, ok := c.liveKitProject(projectID)
	base := ""
	switch {
	case ok && p.EdgePlaybackBase != "":
		base = p.EdgePlaybackBase
	case c.EdgePlaybackBase != "":
		base = c.EdgePlaybackBase
	case ok && p.BroadcastHLSBase != "":
		base = p.BroadcastHLSBase
	default:
		base = c.BroadcastHLSBase
	}
	if base == "" {
		return ""
	}
	return base + "/" + slug + "/index.m3u8"
}

/* The two ways a viewer can get the stream, in the order EdgePlaybackChoiceFor uses them. */
const (
	EdgePathDirect = "direct"
	EdgePathCDN    = "cdn"
)

/* EdgePlaybackChoice is the playlist one viewer plays, which path that is (EdgePathDirect,
 * EdgePathCDN, or "" under the old rule), and the other path to fall back to, if any. */
type EdgePlaybackChoice struct {
	URL      string
	Path     string
	Fallback string
}

/* EdgePlaybackChoiceFor picks the playlist for a viewer in country (ISO code from the edge,
 * "" when unknown).
 *
 * With EDGE_NEAR_COUNTRIES set and both a box origin and a CDN base configured, a viewer near
 * the box (or of unknown country) plays it directly and everyone else plays the CDN, each with
 * the other as Fallback. The box is where the stream has always played cleanly; the CDN is
 * where a viewer far from it gets an edge near them (2026-10-25: the audience moved to plain
 * HLS, which a CDN serves from cache). Anything else is the old rule, EdgePlaybackURLFor. */
func (c Config) EdgePlaybackChoiceFor(projectID, slug, country string) EdgePlaybackChoice {
	legacy := c.EdgePlaybackURLFor(projectID, slug)
	if legacy == "" || len(c.EdgeNearCountries) == 0 {
		return EdgePlaybackChoice{URL: legacy}
	}
	direct := ""
	if p, ok := c.liveKitProject(projectID); ok && p.BroadcastHLSBase != "" {
		direct = p.BroadcastHLSBase
	} else {
		direct = c.BroadcastHLSBase
	}
	if direct == "" {
		return EdgePlaybackChoice{URL: legacy}
	}
	directURL := direct + "/" + strings.TrimSpace(slug) + "/index.m3u8"
	if directURL == legacy {
		// No CDN in front: there is only the one path.
		return EdgePlaybackChoice{URL: legacy, Path: EdgePathDirect}
	}
	if c.nearCountry(country) {
		return EdgePlaybackChoice{URL: directURL, Path: EdgePathDirect, Fallback: legacy}
	}
	return EdgePlaybackChoice{URL: legacy, Path: EdgePathCDN, Fallback: directURL}
}

/* nearCountry reports whether a viewer in country plays the box directly. Unknown counts as
 * near: the box is the path that has always worked, and Cloudflare's own markers for "no
 * country" (XX) and Tor (T1) say nothing about distance. */
func (c Config) nearCountry(country string) bool {
	country = strings.ToUpper(strings.TrimSpace(country))
	if country == "" || country == "XX" || country == "T1" {
		return true
	}
	for _, n := range c.EdgeNearCountries {
		if n == country {
			return true
		}
	}
	return false
}

// countryList parses EDGE_NEAR_COUNTRIES: comma- or space-separated codes, upper-cased.
func countryList(v string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
		if f = strings.ToUpper(strings.TrimSpace(f)); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// LiveKitProjectByID is the configured project with that id.
func (c Config) LiveKitProjectByID(id string) (LiveKitProject, bool) { return c.liveKitProject(id) }

/* MixRecorderURLFor is the mix recorder on the SFU box a project's rooms live on: the
 * sidecar that records the edge mix from MediaMTX (deploy/livekit-box/mixrec). Empty
 * when record-from-mix is off (no MIXREC_SECRET) or there is no live origin to find it by.
 *
 * The project's mixRecorderUrl, else MIXREC_URL, else the box's own Caddy: the live origin
 * (broadcastHlsBase, else BROADCAST_HLS_BASE) with /live replaced by /mixrec. That origin is
 * the box MediaMTX runs on, which is where the recording's files are written. */
func (c Config) MixRecorderURLFor(projectID string) string {
	if c.MixRecSecret == "" {
		return ""
	}
	p, ok := c.liveKitProject(projectID)
	switch {
	case ok && p.MixRecorderURL != "":
		return p.MixRecorderURL
	case c.MixRecURL != "":
		return c.MixRecURL
	}
	base := c.BroadcastHLSBase
	if ok && p.BroadcastHLSBase != "" {
		base = p.BroadcastHLSBase
	}
	if base == "" {
		return ""
	}
	return strings.TrimSuffix(base, "/live") + "/mixrec"
}

/* MixRecRTMPURL is the second push a running mix is given while it is recorded: the same
 * MediaMTX as BroadcastRTMPURL (loopback, or the SFU box's VPC address in remote-egress
 * mode), on path rec/{slug}, which MediaMTX records (mediamtx.yml.template). */
func (c Config) MixRecRTMPURL(slug string) string {
	slug = strings.TrimSpace(slug)
	if c.BroadcastRTMPBase == "" || slug == "" {
		return ""
	}
	u, err := url.Parse(c.BroadcastRTMPBase)
	if err != nil || u.Host == "" {
		return ""
	}
	u.Path = "/rec/" + slug
	u.RawQuery = ""
	return u.String()
}

func (c Config) liveKitProject(id string) (LiveKitProject, bool) {
	for _, p := range c.LiveKitProjects {
		if p.ID == id {
			return p, true
		}
	}
	return LiveKitProject{}, false
}

func (c Config) String() string {
	// Never log secrets.
	recordings := "off"
	if c.RecordingsEnabled {
		recordings = fmt.Sprintf("%s(max %dMB, keep %dd)", c.RecordingsBackend, c.MaxRecordingMB, c.RecordingsRetentionDays)
	}
	// authBypass is in the boot line because it is the setting here that removes
	// a security boundary rather than adjusting one. telemetryEnabled doesn't,
	// but it's worth seeing at boot too — it's easy to flip on for a test window
	// and forget, and the boot log is the cheapest place to notice that.
	emptyRoom := "off"
	if c.EmptyRoomCloseMin > 0 {
		emptyRoom = fmt.Sprintf("%dm", c.EmptyRoomCloseMin)
	}
	// whatsAppConnect is here for the same reason googleAuth is: it is a whole
	// surface that silently does not exist when its credentials are unset, and the
	// boot line is the cheapest place to find that out.
	return fmt.Sprintf("env=%s addr=%s livekit=[%s] ai=[%s] maxAttendees=%d recordings=%s emptyRoomClose=%s seed=%v authBypass=%v telemetryEnabled=%v googleAuth=%v whatsAppConnect=%v cors=%v",
		c.Env, c.Addr, describeLiveKitProjects(c.LiveKitProjects), describeAIProviders(c.AIProviders), c.MaxAttendees, recordings, emptyRoom,
		c.SeedDev, c.AuthBypass, c.TelemetryEnabled, c.GoogleAuthEnabled(), c.WhatsAppConnectEnabled(), c.CORSOrigins)
}
