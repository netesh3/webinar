package config

import (
	"os"
	"strings"
	"testing"
)

/* The project list, which is how an operator moves off an exhausted LiveKit Cloud allowance.
 *
 * Most of these are about REFUSING a configuration, because the failure mode of a bad one is
 * awful: the process starts, everything looks healthy, and the first person to join a webinar
 * gets an authentication error from a service nobody has looked at. The whole point of parsing
 * this at boot is to turn that into a line in the startup log.
 */

// projectsEnv is a production config whose SFU list is given the modern way.
func projectsEnv(json string, extra map[string]string) map[string]string {
	env := map[string]string{
		"APP_ENV":            "production",
		"SESSION_SECRET":     "a-real-session-secret-of-at-least-32-bytes",
		"COOKIE_SECURE":      "true",
		"CORS_ORIGINS":       "https://events.example.com",
		"LIVEKIT_PROJECTS":   json,
		"LIVEKIT_URL":        "",
		"LIVEKIT_API_KEY":    "",
		"LIVEKIT_API_SECRET": "",
	}
	for k, v := range extra {
		env[k] = v
	}
	return env
}

const twoProjects = `[
  {"id":"cloud-1","url":"wss://one.livekit.cloud","key":"API1","secret":"s1"},
  {"id":"cloud-2","url":"wss://two.livekit.cloud","key":"API2","secret":"s2"}
]`

func loadErr(t *testing.T, env map[string]string) error {
	t.Helper()
	setEnv(t, env)
	_, err := Load()
	if err == nil {
		t.Fatal("Load succeeded, want an error")
	}
	return err
}

func TestLiveKitProjectsAreLoadedInOrder(t *testing.T) {
	c := load(t, projectsEnv(twoProjects, nil))

	if len(c.LiveKitProjects) != 2 {
		t.Fatalf("got %d projects, want 2", len(c.LiveKitProjects))
	}
	first, second := c.LiveKitProjects[0], c.LiveKitProjects[1]
	if first.ID != "cloud-1" || second.ID != "cloud-2" {
		t.Fatalf("order is %q,%q — configuration order decides where a new room goes",
			first.ID, second.ID)
	}
	if first.URL != "wss://one.livekit.cloud" || first.Key != "API1" || first.Secret != "s1" {
		t.Errorf("first project = %+v", first)
	}
	// Derived, so LiveKit Cloud needs no httpUrl in the config at all.
	if want := "https://one.livekit.cloud"; first.HTTPURL != want {
		t.Errorf("HTTPURL = %q, want %q", first.HTTPURL, want)
	}
}

// The list wins outright. Merging the two spellings would raise the question of what a bare
// LIVEKIT_URL means when the list already has entries, and there is no answer an operator would
// predict.
func TestLiveKitProjectsWinsOverTheLegacyVariables(t *testing.T) {
	c := load(t, projectsEnv(twoProjects, map[string]string{
		"LIVEKIT_URL":        "wss://ignored.example.com",
		"LIVEKIT_API_KEY":    "IGNORED",
		"LIVEKIT_API_SECRET": "ignored-secret",
	}))

	if len(c.LiveKitProjects) != 2 {
		t.Fatalf("got %d projects, want 2 — the legacy variables were merged in", len(c.LiveKitProjects))
	}
	for _, p := range c.LiveKitProjects {
		if strings.Contains(p.URL, "ignored") || p.Key == "IGNORED" {
			t.Errorf("legacy variables leaked into %+v", p)
		}
	}
}

func TestEnabledLiveKitProjectsSkipsTheDisabledOnes(t *testing.T) {
	c := load(t, projectsEnv(`[
	  {"id":"spent","url":"wss://a.livekit.cloud","key":"A","secret":"a","disabled":true},
	  {"id":"live","url":"wss://b.livekit.cloud","key":"B","secret":"b"}
	]`, nil))

	// Both are LOADED: a disabled project still has to serve the webinars already pinned to
	// it, or retiring one would end sessions in progress.
	if len(c.LiveKitProjects) != 2 {
		t.Fatalf("got %d loaded projects, want 2 — a disabled project must still be usable "+
			"for the rooms already on it", len(c.LiveKitProjects))
	}
	enabled := c.EnabledLiveKitProjects()
	if len(enabled) != 1 || enabled[0].ID != "live" {
		t.Fatalf("enabled = %+v, want just \"live\"", enabled)
	}
}

// Omitting the flag must mean enabled. This is why the field is `disabled` and not `enabled`:
// with the positive spelling, JSON's zero value would make the minimal, obvious configuration
// parse as a project nobody may use, and the service would refuse every new webinar.
func TestAProjectIsEnabledUnlessItSaysOtherwise(t *testing.T) {
	c := load(t, projectsEnv(
		`[{"id":"only","url":"wss://a.livekit.cloud","key":"A","secret":"a"}]`, nil))
	if !c.LiveKitProjects[0].Enabled() {
		t.Fatal("a project with no \"disabled\" key parsed as disabled")
	}
}

func TestLiveKitProjectIDsAreLowerCased(t *testing.T) {
	c := load(t, projectsEnv(
		`[{"id":"Cloud-1","url":"wss://a.livekit.cloud","key":"A","secret":"a"}]`, nil))
	// The pin is compared exactly. Two ids differing only in case would be a webinar that
	// resolves to nothing.
	if got := c.LiveKitProjects[0].ID; got != "cloud-1" {
		t.Errorf("id = %q, want %q", got, "cloud-1")
	}
}

func TestBadLiveKitProjectsAreRefusedAtBoot(t *testing.T) {
	cases := []struct {
		name  string
		json  string
		wants string
	}{
		{
			"not json",
			`{"id":"a"}`,
			"valid JSON array",
		},
		{
			// The reason DisallowUnknownFields is on: "secrets" would otherwise parse as an
			// empty secret and fail at the first join with an authentication error nobody
			// would trace back to a typo in the config.
			"a misspelled field",
			`[{"id":"a","url":"wss://a.livekit.cloud","key":"A","secrets":"a"}]`,
			"secrets",
		},
		{
			"empty list",
			`[]`,
			"nowhere to put a room",
		},
		{
			"no id",
			`[{"url":"wss://a.livekit.cloud","key":"A","secret":"a"}]`,
			"id is required",
		},
		{
			"an id with a comma in it",
			`[{"id":"a,b","url":"wss://a.livekit.cloud","key":"A","secret":"a"}]`,
			"id must be",
		},
		{
			"duplicate ids",
			`[{"id":"a","url":"wss://a.livekit.cloud","key":"A","secret":"a"},
			  {"id":"a","url":"wss://b.livekit.cloud","key":"B","secret":"b"}]`,
			"duplicate id",
		},
		{
			"no url",
			`[{"id":"a","key":"A","secret":"a"}]`,
			"url is required",
		},
		{
			"no key",
			`[{"id":"a","url":"wss://a.livekit.cloud","secret":"a"}]`,
			"key is required",
		},
		{
			"no secret",
			`[{"id":"a","url":"wss://a.livekit.cloud","key":"A"}]`,
			"secret is required",
		},
		{
			// Blocked as mixed content on an https page, and the failure looks like a hang.
			"ws:// in production",
			`[{"id":"a","url":"ws://a.example.com","key":"A","secret":"a"}]`,
			"must be wss://",
		},
		{
			"the development secret in production",
			`[{"id":"a","url":"wss://a.livekit.cloud","key":"A",` +
				`"secret":"devsecretdevsecretdevsecretdevsecret"}]`,
			"development default",
		},
		{
			// The state an operator lands in after disabling an exhausted project and
			// forgetting the replacement. Existing webinars would still work, which is
			// exactly why it has to fail loudly at boot rather than at the next schedule.
			"every project disabled",
			`[{"id":"a","url":"wss://a.livekit.cloud","key":"A","secret":"a","disabled":true}]`,
			"every LiveKit project is disabled",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := loadErr(t, projectsEnv(tc.json, nil))
			if !strings.Contains(err.Error(), tc.wants) {
				t.Errorf("error %q does not mention %q", err, tc.wants)
			}
		})
	}
}

// A duplicate has to name both entries. "duplicate id" on its own sends an operator hunting
// through a list they cannot see the indices of.
func TestADuplicateProjectIDNamesBothEntries(t *testing.T) {
	err := loadErr(t, projectsEnv(`[
	  {"id":"a","url":"wss://a.livekit.cloud","key":"A","secret":"a"},
	  {"id":"b","url":"wss://b.livekit.cloud","key":"B","secret":"b"},
	  {"id":"a","url":"wss://c.livekit.cloud","key":"C","secret":"c"}
	]`, nil))

	msg := err.Error()
	for _, want := range []string{"[2]", "[0]", `"a"`} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention %s", msg, want)
		}
	}
}

// Development is allowed everything production is not, because the local stack runs a plain
// ws:// server on the development key.
func TestDevelopmentAllowsTheLocalSFU(t *testing.T) {
	c := load(t, map[string]string{
		"APP_ENV": "development",
		"LIVEKIT_PROJECTS": `[{"id":"local","url":"ws://localhost:7880","key":"devkey",` +
			`"secret":"devsecretdevsecretdevsecretdevsecret"}]`,
	})
	if len(c.LiveKitProjects) != 1 {
		t.Fatalf("got %d projects, want 1", len(c.LiveKitProjects))
	}
}

/* The boot log must never print a secret.
 *
 * Config.String() goes into the startup line, which ends up in CloudWatch, in a terminal
 * scrollback, and in whatever an operator pastes into a bug report. It already had a
 * "never log secrets" comment; now that there can be several of them in one field, the comment
 * needs a test behind it.
 */
func TestTheBootLineNeverPrintsALiveKitSecret(t *testing.T) {
	c := load(t, projectsEnv(`[
	  {"id":"cloud-1","url":"wss://one.livekit.cloud","key":"API1","secret":"top-secret-one"},
	  {"id":"cloud-2","url":"wss://two.livekit.cloud","key":"API2","secret":"top-secret-two",
	   "disabled":true}
	]`, nil))

	line := c.String()
	for _, secret := range []string{"top-secret-one", "top-secret-two"} {
		if strings.Contains(line, secret) {
			t.Fatalf("the boot line contains a LiveKit secret: %s", line)
		}
	}
	// It does have to say which projects there are and which are off — that is the question
	// an operator has immediately after editing the list.
	for _, want := range []string{"cloud-1", "cloud-2(off)"} {
		if !strings.Contains(line, want) {
			t.Errorf("the boot line %q does not mention %q", line, want)
		}
	}
}

// Setting LIVEKIT_PROJECTS to whitespace is the same as not setting it: an operator who cleared
// the variable gets the legacy behaviour, not a parse error about an empty string.
func TestBlankLiveKitProjectsFallsBackToTheLegacyForm(t *testing.T) {
	env := productionEnv(map[string]string{"LIVEKIT_PROJECTS": "   "})
	c := load(t, env)
	if len(c.LiveKitProjects) != 1 || c.LiveKitProjects[0].ID != legacyProjectID {
		t.Fatalf("projects = %+v, want the single legacy project", c.LiveKitProjects)
	}
	if os.Getenv("LIVEKIT_PROJECTS") == "" {
		t.Fatal("the test did not actually set LIVEKIT_PROJECTS")
	}
}
