package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
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

	// RecordingsS3* configure the "s3" backend. Required only when
	// RecordingsBackend is "s3" — left empty and unused for "disk", so a
	// deployment that never turns this on need not set them at all.
	RecordingsS3Bucket    string
	RecordingsS3Endpoint  string
	RecordingsS3Region    string
	RecordingsS3AccessKey string
	RecordingsS3SecretKey string

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
	 */
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	SMTPFrom     string

	/* Google Drive, for picking a video to share into a session.
	 *
	 * Both are public values by design — the OAuth client id identifies the app to
	 * Google and the API key is restricted by HTTP referrer, so serving them to the
	 * browser is how the Picker is meant to be used. There is no client SECRET
	 * here and there must never be: the picker flow is entirely browser-side and a
	 * secret in the bundle is a secret you have published.
	 *
	 * Unset means the Drive source is offered as unavailable rather than as a
	 * button that opens a Google error page.
	 */
	GoogleClientID string
	GoogleAPIKey   string

	/* Supabase Auth — Google sign-in / sign-up.
	 *
	 * The Postgres DATABASE_URL may already point at the same Supabase project;
	 * these three are specifically for Auth. URL + anon key are public (served
	 * to the browser via /api/config). JWT secret verifies access tokens server-side
	 * and must never leave Cloud Run.
	 *
	 * Unset means Continue with Google is off; password login still works.
	 */
	SupabaseURL       string
	SupabaseAnonKey   string
	SupabaseJWTSecret string

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
		AdminEmails:          splitAndTrim(env("ADMIN_EMAILS", "")),
		AdminPassword:        env("ADMIN_PASSWORD", ""),
		SMTPHost:             env("SMTP_HOST", ""),
		// 587 is submission-with-STARTTLS, which is what a hosted provider expects.
		SMTPPort:     envInt("SMTP_PORT", 587),
		SMTPUsername: env("SMTP_USERNAME", ""),
		SMTPPassword: env("SMTP_PASSWORD", ""),
		// Falls back to SUPPORT_EMAIL, because an operator who has already said where mail
		// comes from should not have to say it twice.
		SMTPFrom:          env("SMTP_FROM", env("SUPPORT_EMAIL", "")),
		GoogleClientID:    env("GOOGLE_CLIENT_ID", ""),
		GoogleAPIKey:      env("GOOGLE_API_KEY", ""),
		SupabaseURL:       strings.TrimRight(env("SUPABASE_URL", ""), "/"),
		SupabaseAnonKey:   env("SUPABASE_ANON_KEY", ""),
		SupabaseJWTSecret: env("SUPABASE_JWT_SECRET", ""),
		RecordingsBackend:     strings.ToLower(env("RECORDINGS_BACKEND", "disk")),
		RecordingsDir:         env("RECORDINGS_DIR", "./.data/recordings"),
		MaxRecordingMB:        envInt("MAX_RECORDING_MB", 4096),
		RecordingsS3Bucket:    env("RECORDINGS_S3_BUCKET", ""),
		RecordingsS3Endpoint:  env("RECORDINGS_S3_ENDPOINT", ""),
		// us-east-1 as the fallback rather than empty: an S3-compatible
		// provider that ignores region (many do) still gets something
		// syntactically valid, and one that requires it (B2 does — the
		// region is embedded in its own endpoint host, e.g.
		// s3.eu-central-003.backblazeb2.com) is documented well enough that
		// an operator setting RECORDINGS_S3_ENDPOINT is expected to set this
		// to match.
		RecordingsS3Region:    env("RECORDINGS_S3_REGION", "us-east-1"),
		RecordingsS3AccessKey: env("RECORDINGS_S3_ACCESS_KEY", ""),
		RecordingsS3SecretKey: env("RECORDINGS_S3_SECRET_KEY", ""),
	}
	c.CookieSecure = envBool("COOKIE_SECURE", c.Env != "development")
	c.SignupOpen = envBool("SIGNUP_OPEN", true)
	c.RecordingsEnabled = envBool("RECORDINGS_ENABLED", true)
	c.SeedDev = envBool("SEED_DEV", true)
	c.AuthBypass = envBool("AUTH_BYPASS", false)
	c.TelemetryEnabled = envBool("TELEMETRY_ENABLED", false)
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

// GoogleAuthEnabled is true when Supabase Auth Google can be offered end-to-end.
// Tokens are verified via JWKS (ES256) and/or the legacy HS256 JWT secret.
func (c Config) GoogleAuthEnabled() bool {
	return c.SupabaseURL != "" && c.SupabaseAnonKey != ""
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
	}

	if c.MinPasswordLength < 1 {
		errs = append(errs, errors.New("MIN_PASSWORD_LENGTH must be >= 1"))
	}

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

	return errors.Join(errs...)
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

func (c Config) String() string {
	// Never log secrets.
	recordings := "off"
	if c.RecordingsEnabled {
		recordings = fmt.Sprintf("%s(max %dMB)", c.RecordingsBackend, c.MaxRecordingMB)
	}
	// authBypass is in the boot line because it is the setting here that removes
	// a security boundary rather than adjusting one. telemetryEnabled doesn't,
	// but it's worth seeing at boot too — it's easy to flip on for a test window
	// and forget, and the boot log is the cheapest place to notice that.
	return fmt.Sprintf("env=%s addr=%s livekit=[%s] maxAttendees=%d recordings=%s seed=%v authBypass=%v telemetryEnabled=%v googleAuth=%v cors=%v",
		c.Env, c.Addr, describeLiveKitProjects(c.LiveKitProjects), c.MaxAttendees, recordings,
		c.SeedDev, c.AuthBypass, c.TelemetryEnabled, c.GoogleAuthEnabled(), c.CORSOrigins)
}
