package config

import (
	"strings"
	"testing"
)

/* The settings worth a test are the ones where a convenient value is a dangerous
 * one. A short password floor is exactly that: it makes local testing pleasant and
 * it makes a real deployment guessable, so the boundary between those two cases is
 * the thing to pin down. */

func TestPasswordFloorIsRelaxedInDevelopmentOnly(t *testing.T) {
	t.Run("development defaults to something typeable", func(t *testing.T) {
		c := load(t, map[string]string{})
		if c.MinPasswordLength != devPasswordFloor {
			t.Errorf("MinPasswordLength = %d, want the development default %d",
				c.MinPasswordLength, devPasswordFloor)
		}
	})

	t.Run("production defaults to the real floor", func(t *testing.T) {
		c := load(t, productionEnv(nil))
		if c.MinPasswordLength != passwordFloor {
			t.Errorf("MinPasswordLength = %d, want %d", c.MinPasswordLength, passwordFloor)
		}
	})

	t.Run("development accepts an explicit short floor", func(t *testing.T) {
		c := load(t, map[string]string{"MIN_PASSWORD_LENGTH": "1"})
		if c.MinPasswordLength != 1 {
			t.Errorf("MinPasswordLength = %d, want 1", c.MinPasswordLength)
		}
	})

	t.Run("production refuses one", func(t *testing.T) {
		// The whole point: a value chosen to make testing bearable must not be able
		// to follow the deployment into production.
		setEnv(t, productionEnv(map[string]string{"MIN_PASSWORD_LENGTH": "4"}))
		if _, err := Load(); err == nil {
			t.Fatal("a 4-character password floor was accepted outside development")
		} else if !strings.Contains(err.Error(), "MIN_PASSWORD_LENGTH") {
			t.Errorf("error does not name the setting: %v", err)
		}
	})

	t.Run("zero is refused everywhere", func(t *testing.T) {
		setEnv(t, map[string]string{"MIN_PASSWORD_LENGTH": "0"})
		if _, err := Load(); err == nil {
			t.Error("a zero-length password floor was accepted")
		}
	})
}

// The dev seed writes accounts with a known password, so it must never be able to
// run against a real database.
func TestSeedIsDevelopmentOnly(t *testing.T) {
	if c := load(t, map[string]string{}); !c.SeedDev {
		t.Error("SeedDev is off by default in development; a fresh clone would look empty")
	}
	if c := load(t, map[string]string{"SEED_DEV": "false"}); c.SeedDev {
		t.Error("SEED_DEV=false was ignored, so deleting the demo accounts would not stick")
	}
	// cmd/server gates on IsDev() as well as this flag; that is the belt to this
	// braces, and the reason the flag alone is not the whole guarantee.
	if c := load(t, productionEnv(nil)); c.IsDev() {
		t.Error("a production environment reported itself as development")
	}
}

func TestRecordingBackendMustExist(t *testing.T) {
	setEnv(t, map[string]string{"RECORDINGS_BACKEND": "s3"})
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "RECORDINGS_S3_BUCKET is required") {
		t.Errorf("RECORDINGS_BACKEND=s3 without credentials error = %v, want missing bucket error", err)
	}

	setEnv(t, map[string]string{"RECORDINGS_BACKEND": "gcs"})
	if _, err := Load(); err == nil {
		t.Error("an unknown recording backend was accepted")
	}

	// Turning recording off means the backend is nobody's problem.
	setEnv(t, map[string]string{"RECORDINGS_BACKEND": "s3", "RECORDINGS_ENABLED": "false"})
	if _, err := Load(); err != nil {
		t.Errorf("recording disabled should not care about the backend: %v", err)
	}
}

/* The browser's SFU address and this process's SFU address are the same thing
 * right up until they are not, and the deployment where they diverge — an ingress
 * in front of a cluster Service — is the one where getting it wrong is invisible:
 * the hairpin out to the public load balancer usually works, just slowly, so the
 * mistake surfaces as latency on every mute rather than as an error. */
func TestLiveKitHTTPURLDefaultsToTheBrowserAddress(t *testing.T) {
	// The bare LIVEKIT_* variables are still supported, as a shorthand for a one-element
	// LIVEKIT_PROJECTS list — so these read the first project rather than a Config field.
	only := func(t *testing.T, c Config) LiveKitProject {
		t.Helper()
		if len(c.LiveKitProjects) != 1 {
			t.Fatalf("got %d projects, want 1", len(c.LiveKitProjects))
		}
		return c.LiveKitProjects[0]
	}

	t.Run("derived from wss", func(t *testing.T) {
		p := only(t, load(t, productionEnv(nil)))
		if want := "https://sfu.example.com"; p.HTTPURL != want {
			t.Errorf("HTTPURL = %q, want %q", p.HTTPURL, want)
		}
	})

	t.Run("derived from ws", func(t *testing.T) {
		p := only(t, load(t, map[string]string{"LIVEKIT_URL": "ws://localhost:7880"}))
		if want := "http://localhost:7880"; p.HTTPURL != want {
			t.Errorf("HTTPURL = %q, want %q", p.HTTPURL, want)
		}
	})

	t.Run("an explicit internal address wins and the browser one is untouched", func(t *testing.T) {
		p := only(t, load(t, productionEnv(map[string]string{
			"LIVEKIT_URL":      "wss://events.example.com/app/sfu",
			"LIVEKIT_HTTP_URL": "http://webcast-livekit:7880",
		})))
		if want := "http://webcast-livekit:7880"; p.HTTPURL != want {
			t.Errorf("HTTPURL = %q, want %q", p.HTTPURL, want)
		}
		if want := "wss://events.example.com/app/sfu"; p.URL != want {
			t.Errorf("URL = %q, want %q — the browser's URL must not be rewritten", p.URL, want)
		}
	})

	// The legacy id is fixed and documented, because it is written to the database: an
	// operator moving to LIVEKIT_PROJECTS has to keep an entry called "default" or every
	// webinar pinned before the move has nowhere to go.
	t.Run("the legacy form is a project called default", func(t *testing.T) {
		if got := only(t, load(t, productionEnv(nil))).ID; got != "default" {
			t.Errorf("legacy project id = %q, want %q", got, "default")
		}
	})
}

func TestListenAddrHonorsCloudRunPORT(t *testing.T) {
	t.Run("default when neither is set", func(t *testing.T) {
		c := load(t, map[string]string{})
		if c.Addr != ":8080" {
			t.Errorf("Addr = %q, want :8080", c.Addr)
		}
	})

	t.Run("PORT alone becomes a listen address", func(t *testing.T) {
		c := load(t, map[string]string{"PORT": "8080"})
		if c.Addr != ":8080" {
			t.Errorf("Addr = %q, want :8080 from PORT", c.Addr)
		}
	})

	t.Run("ADDR wins over PORT", func(t *testing.T) {
		c := load(t, map[string]string{"ADDR": ":9090", "PORT": "8080"})
		if c.Addr != ":9090" {
			t.Errorf("Addr = %q, want ADDR to win", c.Addr)
		}
	})

	t.Run("PORT may already include a colon", func(t *testing.T) {
		c := load(t, map[string]string{"PORT": ":7777"})
		if c.Addr != ":7777" {
			t.Errorf("Addr = %q, want :7777", c.Addr)
		}
	})
}

// ------------------------------------------------------------------- helpers

// productionEnv is the minimum a non-development config needs to be valid, so a
// test can assert on one rule without tripping the others.
func productionEnv(extra map[string]string) map[string]string {
	env := map[string]string{
		"APP_ENV":            "production",
		"SESSION_SECRET":     "a-real-session-secret-of-at-least-32-bytes",
		"LIVEKIT_API_SECRET": "a-real-livekit-secret",
		"LIVEKIT_URL":        "wss://sfu.example.com",
		"COOKIE_SECURE":      "true",
		"CORS_ORIGINS":       "https://events.example.com",
	}
	for k, v := range extra {
		env[k] = v
	}
	return env
}

func TestBroadcastURLsStayEmptyUntilBothBasesAreSet(t *testing.T) {
	c := Config{}
	if c.BroadcastHLSURL("slug") != "" || c.BroadcastRTMPURL("slug") != "" {
		t.Fatal("empty bases should produce empty URLs")
	}
	c.BroadcastHLSBase = "https://live.example.com/live"
	c.BroadcastRTMPBase = "rtmp://127.0.0.1:1935/live"
	if got, want := c.BroadcastHLSURL("slug"), "https://live.example.com/live/slug/index.m3u8"; got != want {
		t.Errorf("BroadcastHLSURL = %q, want %q", got, want)
	}
	if got, want := c.BroadcastRTMPURL("slug"), "rtmp://127.0.0.1:1935/live/slug"; got != want {
		t.Errorf("BroadcastRTMPURL = %q, want %q", got, want)
	}
}

func TestBroadcastBasesMustBePaired(t *testing.T) {
	setEnv(t, productionEnv(map[string]string{
		"BROADCAST_RTMP_BASE": "rtmp://127.0.0.1:1935/live",
	}))
	if _, err := Load(); err == nil {
		t.Fatal("RTMP without HLS was accepted")
	}
	c := load(t, productionEnv(map[string]string{
		"BROADCAST_RTMP_BASE": "rtmp://127.0.0.1:1935/live",
		"BROADCAST_HLS_BASE":  "https://sfu.example.com/live",
	}))
	if c.BroadcastHLSBase != "https://sfu.example.com/live" {
		t.Errorf("BroadcastHLSBase = %q", c.BroadcastHLSBase)
	}
}


func TestRecordingsRetentionDaysDefaultsToThirty(t *testing.T) {
	c := load(t, map[string]string{})
	if c.RecordingsRetentionDays != 30 {
		t.Errorf("RecordingsRetentionDays = %d, want 30", c.RecordingsRetentionDays)
	}
	c = load(t, map[string]string{"RECORDINGS_RETENTION_DAYS": "0"})
	if c.RecordingsRetentionDays != 0 {
		t.Errorf("RECORDINGS_RETENTION_DAYS=0 = %d, want 0", c.RecordingsRetentionDays)
	}
}

// The empty-room sweep ends live webinars, so both its default and its off
// switch are worth pinning: an accidental 0 leaves abandoned rooms running, and
// an accidental small number could close a room during a reconnect.
func TestEmptyRoomCloseMinDefaultsToTenAndCanBeDisabled(t *testing.T) {
	if c := load(t, map[string]string{}); c.EmptyRoomCloseMin != 10 {
		t.Errorf("EmptyRoomCloseMin = %d, want 10", c.EmptyRoomCloseMin)
	}
	if c := load(t, map[string]string{"EMPTY_ROOM_CLOSE_MIN": "0"}); c.EmptyRoomCloseMin != 0 {
		t.Error("EMPTY_ROOM_CLOSE_MIN=0 did not turn the sweep off")
	}
	setEnv(t, map[string]string{"EMPTY_ROOM_CLOSE_MIN": "-1"})
	if _, err := Load(); err == nil {
		t.Error("a negative EMPTY_ROOM_CLOSE_MIN was accepted")
	}
}

func load(t *testing.T, env map[string]string) Config {
	t.Helper()
	setEnv(t, env)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return c
}

/* Every variable this package claims to read is actually read.
 *
 * This exists because of a bug that reached production. Config.AdminPassword was declared,
 * documented, plumbed through docker-compose and set correctly in the container — and never
 * assigned in Load(), because the edit that was supposed to add it silently matched nothing.
 * Everything looked right from the outside: the env var was in `docker inspect`, and the API
 * logged "ADMIN_PASSWORD is not set". A field that exists but is never populated is invisible
 * to the compiler, to vet and to every other test.
 *
 * So this asserts the wiring itself: set a distinctive value, load, and check it arrived. Cheap
 * to extend, and the only kind of test that catches a declaration with nothing behind it.
 */
func TestEveryConfiguredValueIsActuallyRead(t *testing.T) {
	setEnv(t, map[string]string{
		"APP_ENV":                "production",
		"SESSION_SECRET":         "test-secret-test-secret-test-secret-32",
		"LIVEKIT_API_SECRET":     "secret-secret-secret-secret-secret-32",
		"WEB_BASE_URL":           "https://example.test",
		"LIVEKIT_URL":            "wss://sfu.example.test",
		"ADMIN_EMAILS":           "one@example.test, two@example.test",
		"ADMIN_PASSWORD":         "bootstrap-password-1234",
		"SMTP_HOST":              "smtp.example.test",
		"SMTP_PORT":              "2525",
		"SMTP_USERNAME":          "mailer",
		"SMTP_PASSWORD":          "mail-secret",
		"SMTP_FROM":              "webinars@example.test",
		"REGISTER_RATE_PER_MIN":  "300",
		"DEFAULT_ATTENDEE_LIMIT": "120",
	})

	c, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if len(c.AdminEmails) != 2 || c.AdminEmails[0] != "one@example.test" {
		t.Errorf("AdminEmails = %#v, want the two addresses, trimmed", c.AdminEmails)
	}
	// The one that was broken.
	if c.AdminPassword != "bootstrap-password-1234" {
		t.Errorf("AdminPassword = %q — declared but not read from ADMIN_PASSWORD", c.AdminPassword)
	}
	if c.SMTPHost != "smtp.example.test" || c.SMTPPort != 2525 {
		t.Errorf("SMTP host/port = %q/%d", c.SMTPHost, c.SMTPPort)
	}
	if c.SMTPUsername != "mailer" || c.SMTPPassword != "mail-secret" {
		t.Errorf("SMTP credentials not read: %q / %q", c.SMTPUsername, c.SMTPPassword)
	}
	if c.SMTPFrom != "webinars@example.test" {
		t.Errorf("SMTPFrom = %q", c.SMTPFrom)
	}
	if c.RegisterPerMin != 300 {
		t.Errorf("RegisterPerMin = %d, want 300", c.RegisterPerMin)
	}
	if c.DefaultAttendeeLimit != 120 {
		t.Errorf("DefaultAttendeeLimit = %d, want 120", c.DefaultAttendeeLimit)
	}
}

/* SMTPFrom falls back to SUPPORT_EMAIL, so an operator who has already said where mail comes
 * from does not have to say it twice. Asserted because a fallback that quietly stops working
 * turns into "email is configured and nothing sends". */
func TestSMTPFromFallsBackToSupportEmail(t *testing.T) {
	setEnv(t, map[string]string{
		"APP_ENV":            "production",
		"SESSION_SECRET":     "test-secret-test-secret-test-secret-32",
		"LIVEKIT_API_SECRET": "secret-secret-secret-secret-secret-32",
		"WEB_BASE_URL":       "https://example.test",
		"LIVEKIT_URL":        "wss://sfu.example.test",
		"SUPPORT_EMAIL":      "help@example.test",
	})
	c, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if c.SMTPFrom != "help@example.test" {
		t.Errorf("SMTPFrom = %q, want the SUPPORT_EMAIL fallback", c.SMTPFrom)
	}
}

// setEnv clears every variable this package reads before applying the ones the
// test wants, so a value left over from the developer's own shell cannot change
// the result. t.Setenv restores everything afterwards.
func setEnv(t *testing.T, env map[string]string) {
	t.Helper()
	for _, key := range []string{
		"APP_ENV", "ADDR", "PORT", "DATABASE_URL", "LIVEKIT_URL", "LIVEKIT_API_KEY",
		"LIVEKIT_API_SECRET", "SESSION_SECRET", "SESSION_TTL", "LIVEKIT_TOKEN_TTL",
		"SHUTDOWN_GRACE", "MAX_ATTENDEES", "REGISTER_RATE_PER_MIN", "JOIN_RATE_PER_MIN",
		"CORS_ORIGINS", "APP_NAME", "SUPPORT_EMAIL", "WEB_BASE_URL", "COOKIE_SECURE",
		"SIGNUP_OPEN", "RECORDINGS_ENABLED", "RECORDINGS_BACKEND", "RECORDINGS_DIR",
		"MAX_RECORDING_MB", "SEED_DEV", "MIN_PASSWORD_LENGTH", "LIVEKIT_HTTP_URL",
		"ADMIN_EMAILS", "ADMIN_PASSWORD",
		"DEFAULT_ATTENDEE_LIMIT",
		"SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM",
		"LIVEKIT_PROJECTS", "AUTH_BYPASS", "GOOGLE_CLIENT_ID", "GOOGLE_API_KEY",
		"SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET",
		"BROADCAST_RTMP_BASE", "BROADCAST_HLS_BASE",
	} {
		t.Setenv(key, "")
	}
	for k, v := range env {
		t.Setenv(k, v)
	}
}
