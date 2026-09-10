package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

/* Which LiveKit deployments this server may put rooms on, and how an operator swaps between
 * them.
 *
 * There used to be exactly one, named by LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET. That
 * is fine for a self-hosted SFU, where the only reason to change it is a migration, and wrong
 * for LiveKit Cloud, where a project has a monthly allowance that runs out. When it does, the
 * operator needs to move NEW sessions onto a different project without touching the code and
 * without disturbing sessions already in flight.
 *
 * So the configuration is a LIST, in priority order:
 *
 *   LIVEKIT_PROJECTS=[
 *     {"id":"cloud-1","url":"wss://webinar-abc.livekit.cloud","key":"API…","secret":"…",
 *      "disabled":true},
 *     {"id":"cloud-2","url":"wss://webinar-def.livekit.cloud","key":"API…","secret":"…"}
 *   ]
 *
 * New rooms go to the first ENABLED project. Retiring one is `"disabled": true`, which is one
 * edit and a restart; nothing has to be deleted, so the credentials stay on hand if the
 * allowance resets next month.
 *
 * WHY THE OPERATOR DECLARES EXHAUSTION RATHER THAN US DETECTING IT. Reading a project's
 * remaining allowance needs LiveKit's management API, separate credentials per account, and a
 * polling loop whose failure mode is refusing to start webinars. The signal an operator
 * already has — a billing email, a dashboard — is more reliable than anything this process
 * could infer. What IS automatic is failover at room-creation time: see lk.Pool.
 *
 * WHY THE IDS ARE LOAD-BEARING. Every webinar records the project id its room lives on, in
 * the database, because a room exists on exactly one project and every participant of one
 * webinar has to be sent to the same place — two halves of an audience on two projects is two
 * separate rooms that cannot see or hear each other. Renaming an id therefore orphans every
 * webinar pinned to it. Add and disable freely; do not rename.
 */

// LiveKitProject is one LiveKit deployment: self-hosted, or a LiveKit Cloud project.
type LiveKitProject struct {
	/* ID is written into the database, so it is permanent.
	 *
	 * Kept to a short slug rather than a free string: it appears in logs, in a webinar row
	 * and in an operator's head, and "wss://webinar-ettgvpwn.livekit.cloud (billing account
	 * #2)" is none of those things.
	 */
	ID string `json:"id"`

	// URL is the ws(s):// address handed to browsers.
	URL string `json:"url"`

	/* HTTPURL is where THIS process reaches the room API, when that differs from where the
	 * browser reaches signalling. Defaults to URL with the scheme swapped.
	 *
	 * It differs in Kubernetes, where the browser gets a public hostname terminated by an
	 * ingress and using that from inside the cluster hairpins every mute and permission
	 * change out to the internet and back. For LiveKit Cloud it is always the default and
	 * should be left unset.
	 */
	HTTPURL string `json:"httpUrl,omitempty"`

	Key    string `json:"key"`
	Secret string `json:"secret"`

	/* Disabled retires a project without deleting it.
	 *
	 * Negative rather than an `enabled` flag deliberately: JSON's zero value for a bool is
	 * false, so `enabled` would mean the minimal, obvious config — an id, a url, a key and a
	 * secret — parsed as a project nobody may use. A footgun that silently takes the whole
	 * service down is not worth the nicer word.
	 *
	 * A disabled project is still LOADED, and still serves the webinars already pinned to
	 * it. It only stops receiving new ones. Turning off a project mid-session would end the
	 * session; that is what deleting it from the list is for, and even then only sessions
	 * that have not started yet can be moved.
	 */
	Disabled bool `json:"disabled,omitempty"`
}

func (p LiveKitProject) Enabled() bool { return !p.Disabled }

// legacyProjectID is the id given to a project configured the old way, with the three bare
// LIVEKIT_* variables. Fixed and documented because it lands in the database: an operator who
// later moves to LIVEKIT_PROJECTS must keep one entry called "default" for every webinar that
// was pinned before the move, or those rooms have nowhere to go.
const legacyProjectID = "default"

// devSecret is the development signing key, refused outside development.
const devSecret = "devsecretdevsecretdevsecretdevsecret"

/* projectID bounds what may become a database value and a log field.
 *
 * Lower-case so two ids cannot differ only by case — the pin is compared exactly, and
 * "Cloud-1" silently failing to match "cloud-1" is a webinar nobody can join.
 */
var projectID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

/* loadLiveKitProjects reads the list, or synthesises one from the legacy variables.
 *
 * Both forms exist because the legacy three are what every existing deployment, the
 * development stack, the e2e probes and the local `livekit-server` all set. Supporting them as
 * a documented shorthand for a one-element list means there is still exactly one code path
 * downstream — a list — and nothing outside this function knows there were ever two spellings.
 *
 * LIVEKIT_PROJECTS wins when both are set, and the legacy values are then ignored rather than
 * merged. Merging would ask what a bare LIVEKIT_URL means when the list already has three
 * entries, and there is no answer to that which an operator would predict.
 */
func loadLiveKitProjects() ([]LiveKitProject, error) {
	raw := strings.TrimSpace(os.Getenv("LIVEKIT_PROJECTS"))
	if raw == "" {
		return []LiveKitProject{{
			ID:      legacyProjectID,
			URL:     env("LIVEKIT_URL", "ws://localhost:7880"),
			HTTPURL: env("LIVEKIT_HTTP_URL", ""),
			Key:     env("LIVEKIT_API_KEY", "devkey"),
			Secret:  env("LIVEKIT_API_SECRET", devSecret),
		}}, nil
	}

	var list []LiveKitProject
	dec := json.NewDecoder(strings.NewReader(raw))
	// Unknown fields are an error, not a shrug: a typo like "secrets" or "URL" would
	// otherwise parse into an empty credential and fail at the first join with an
	// authentication error nobody would connect back to the config.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&list); err != nil {
		return nil, fmt.Errorf("LIVEKIT_PROJECTS is not a valid JSON array of projects: %w", err)
	}
	return list, nil
}

// normaliseLiveKitProjects trims, lower-cases the ids and fills in each HTTPURL.
func normaliseLiveKitProjects(list []LiveKitProject) []LiveKitProject {
	out := make([]LiveKitProject, 0, len(list))
	for _, p := range list {
		p.ID = strings.ToLower(strings.TrimSpace(p.ID))
		p.URL = strings.TrimSpace(p.URL)
		p.Key = strings.TrimSpace(p.Key)
		p.Secret = strings.TrimSpace(p.Secret)
		p.HTTPURL = strings.TrimSpace(p.HTTPURL)
		if p.HTTPURL == "" {
			p.HTTPURL = httpFromWS(p.URL)
		}
		out = append(out, p)
	}
	return out
}

/* validateLiveKitProjects rejects a list that would fail later, at a join, in front of an
 * audience.
 *
 * Every check here is something that produced a real failure with no useful message: an empty
 * secret authenticates as nobody, a ws:// URL is blocked as mixed content on an https page and
 * looks like a hang, and a duplicate id means two sets of credentials claim the same database
 * pin and which one a webinar gets depends on map ordering.
 */
func validateLiveKitProjects(list []LiveKitProject, dev bool) error {
	if len(list) == 0 {
		return errors.New("LIVEKIT_PROJECTS is empty: there is nowhere to put a room")
	}

	var errs []error
	seen := map[string]int{}
	enabled := 0

	for i, p := range list {
		// Indexed as well as named, because the id is one of the things that can be wrong.
		where := fmt.Sprintf("LIVEKIT_PROJECTS[%d]", i)
		if p.ID != "" {
			where = fmt.Sprintf("%s (%q)", where, p.ID)
		}

		switch {
		case p.ID == "":
			errs = append(errs, fmt.Errorf("%s: id is required", where))
		case !projectID.MatchString(p.ID):
			errs = append(errs, fmt.Errorf(
				"%s: id must be 1-32 characters of a-z, 0-9, _ or -, starting with a letter "+
					"or digit — it is stored in the database and printed in logs", where))
		default:
			if first, dup := seen[p.ID]; dup {
				errs = append(errs, fmt.Errorf(
					"%s: duplicate id, already used by LIVEKIT_PROJECTS[%d]", where, first))
			} else {
				seen[p.ID] = i
			}
		}

		if p.URL == "" {
			errs = append(errs, fmt.Errorf("%s: url is required", where))
		} else if !dev && !strings.HasPrefix(p.URL, "wss://") {
			errs = append(errs, fmt.Errorf(
				"%s: url must be wss:// outside development (ws:// is blocked as mixed "+
					"content on an https page, and the failure looks like a hang)", where))
		}
		if p.Key == "" {
			errs = append(errs, fmt.Errorf("%s: key is required", where))
		}
		switch {
		case p.Secret == "":
			errs = append(errs, fmt.Errorf("%s: secret is required", where))
		case !dev && p.Secret == devSecret:
			errs = append(errs, fmt.Errorf("%s: secret must not be the development default", where))
		}

		if p.Enabled() {
			enabled++
		}
	}

	/* At least one project has to be able to take a new room.
	 *
	 * This is the state an operator lands in by disabling an exhausted project and
	 * forgetting to add the replacement — so it fails at boot, with the reason, rather than
	 * at the first join with a 500. Existing webinars would still work, which is exactly why
	 * it would otherwise go unnoticed until somebody scheduled a new one.
	 */
	if enabled == 0 && len(errs) == 0 {
		errs = append(errs, errors.New(
			"every LiveKit project is disabled: no new webinar can be given a room. "+
				"Add a project, or clear \"disabled\" on one of them"))
	}

	return errors.Join(errs...)
}

// EnabledLiveKitProjects is the list new rooms may be placed on, in priority order.
func (c Config) EnabledLiveKitProjects() []LiveKitProject {
	out := make([]LiveKitProject, 0, len(c.LiveKitProjects))
	for _, p := range c.LiveKitProjects {
		if p.Enabled() {
			out = append(out, p)
		}
	}
	return out
}

/* describeLiveKitProjects is the boot-log summary: ids and state, never a secret.
 *
 * "cloud-1(off) cloud-2" — enough for an operator to confirm the swap they just made took
 * effect, which is the question they have at exactly this moment.
 */
func describeLiveKitProjects(list []LiveKitProject) string {
	parts := make([]string, 0, len(list))
	for _, p := range list {
		if p.Enabled() {
			parts = append(parts, p.ID)
		} else {
			parts = append(parts, p.ID+"(off)")
		}
	}
	return strings.Join(parts, ",")
}
