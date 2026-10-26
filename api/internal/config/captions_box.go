package config

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

/* CaptionsBox is the on-demand captions droplet (api/internal/api/captions_box.go,
 * deploy/digitalocean/README.md "Captions box"): a small droplet that runs only the caption
 * agent, created with the video box and deleted with it, so the video box's CPU goes to LiveKit
 * and the edge mix. One per video box (keyed by SFUBox.Project), shared by every room on it.
 *
 * Off unless CAPTIONS_BOX_ENABLED=true (and the video box manager and CAPTIONS_SECRET are on).
 * Region, VPC, SSH keys and the repo ref come from SFUBox. */
type CaptionsBox struct {
	// On is CAPTIONS_BOX_ENABLED (default false until it has been tried on a live session).
	On bool
	// Name of the droplet (CAPTIONS_BOX_NAME, default captions-blr-1).
	Name string
	// Size is the droplet size (CAPTIONS_BOX_SIZE, default s-4vcpu-8gb).
	Size string
	// SnapshotTag picks the image: the newest snapshot tagged CAPTIONS_BOX_IMAGE (default
	// webinar-captions-image, built by .github/workflows/sfu-snapshot.yml), else named "<tag>-…".
	SnapshotTag string
	/* Tags go on the droplet (CAPTIONS_BOX_TAGS, default webinar-captions: the captions-box
	 * firewall applies by it; NOT webinar-sfu, which carries the media firewall and the video
	 * box's alerts). ManagedTag is added and is how the manager finds its own droplets. */
	Tags       []string
	ManagedTag string
	// CPUs is the agent's CPU cap and decoder threads (CAPTIONS_BOX_CPUS, default the size's vCPUs).
	CPUs int
	// MaxRooms is how many rooms the agent takes at once (CAPTIONS_BOX_MAX_ROOMS, default
	// one per 2 vCPUs, at least 1); a room beyond it keeps on-device captions.
	MaxRooms int
	// Model is the live model (CAPTIONS_BOX_MODEL, default base.en).
	Model string
	// APIURL is where the agent posts lines (CAPTIONS_BOX_API_URL, default https://webinarliv.com).
	APIURL string
	/* LiveKitURL is what the agent connects to (CAPTIONS_BOX_LIVEKIT_URL); empty is the video
	 * box project's own URL (the reserved IP's hostname, through Caddy). */
	LiveKitURL string
	// BootTimeout: a droplet not active this long after create is replaced (CAPTIONS_BOX_BOOT_TIMEOUT, 10m).
	BootTimeout time.Duration

	/* Provider is who transcribes live (CAPTIONS_PROVIDER: local, the box's Whisper models;
	 * deepgram, Deepgram's streaming API, deploy/captions/webcaptions/provider.py). Default
	 * local. With deepgram, DeepgramKey (DEEPGRAM_API_KEY) goes to the box in its env file like
	 * the LiveKit secret, and FallbackLocal (CAPTIONS_FALLBACK_LOCAL, default true) keeps the
	 * local models loaded to take over a room when Deepgram keeps failing. */
	Provider         string
	DeepgramKey      string
	DeepgramModel    string // CAPTIONS_DEEPGRAM_MODEL, default nova-3
	DeepgramLanguage string // CAPTIONS_DEEPGRAM_LANGUAGE, default multi (English + Hindi code-switching)
	FallbackLocal    bool
}

// CaptionsProviderDeepgram is CAPTIONS_PROVIDER for Deepgram's streaming live captions.
const CaptionsProviderDeepgram = "deepgram"

/* Deepgram does the transcribing, so without the local fallback the box only moves audio: a
 * 1-vCPU box carries many rooms (the socket per speaker is the cost, not CPU). With the
 * fallback loaded, the box keeps its local size so it can take a room over. */
const (
	captionsDeepgramSize         = "s-1vcpu-2gb"
	captionsDeepgramRoomsPerVCPU = 8
)

// captionsBoxManagedTag marks the droplets the captions manager owns.
const captionsBoxManagedTag = "webinar-captions-ondemand"

// CaptionsBoxManagedTag is the tag on every captions droplet the API creates.
func CaptionsBoxManagedTag() string { return captionsBoxManagedTag }

var sizeVCPU = []*regexp.Regexp{
	regexp.MustCompile(`(\d+)vcpu`),               // s-2vcpu-4gb, c2-2vcpu-4gb, g-2vcpu-8gb
	regexp.MustCompile(`^(?:c|c2|m|g|gd)-(\d+)$`), // c-2, c-4
}

/* SizeVCPUs reads the vCPU count out of a DigitalOcean size slug (s-2vcpu-4gb → 2, c-4 → 4),
 * 0 when it cannot tell. */
func SizeVCPUs(size string) int {
	for _, re := range sizeVCPU {
		if m := re.FindStringSubmatch(size); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

/* CaptionsVCPUsPerRoom is the default capacity: one room for every two vCPUs (2 → 1, 4 → 2,
 * 8 → 4), at least one.
 *
 * It was 2 rooms a vCPU, from base.en at ~0.3–0.4 of a core per active speaker. Measured on
 * 2026-10-26 (browser load test, Grafana): ONE room of continuous speech held the captions
 * container at 1.2–1.6 cores on an s-2vcpu-4gb (60–83% of the box) and caption delay p90 went
 * to 7.8–8.7 s, because the live model, the partials and the speaker's VAD all share the CPU.
 * A real presenter pauses, but two such rooms on two vCPUs are already over. One room per two
 * vCPUs keeps a room's decode on its own cores, with room for the after-session pass to run
 * niced in the gaps (docs/decisions/2026-10-27-captions-box-size.md). */
const CaptionsVCPUsPerRoom = 2

// CaptionsRoomsFor is the default room limit for a box with vcpus vCPUs.
func CaptionsRoomsFor(vcpus int) int {
	if vcpus <= 0 {
		return 0
	}
	if r := vcpus / CaptionsVCPUsPerRoom; r > 0 {
		return r
	}
	return 1
}

func loadCaptionsBox() CaptionsBox {
	provider := strings.ToLower(strings.TrimSpace(env("CAPTIONS_PROVIDER", "local")))
	fallback := envBool("CAPTIONS_FALLBACK_LOCAL", true)
	defaultSize := "s-4vcpu-8gb"
	if provider == CaptionsProviderDeepgram && !fallback {
		defaultSize = captionsDeepgramSize
	}
	b := CaptionsBox{
		On:          envBool("CAPTIONS_BOX_ENABLED", false),
		Name:        strings.TrimSpace(env("CAPTIONS_BOX_NAME", "captions-blr-1")),
		Size:        strings.TrimSpace(env("CAPTIONS_BOX_SIZE", defaultSize)),
		SnapshotTag: strings.TrimSpace(env("CAPTIONS_BOX_IMAGE", "webinar-captions-image")),
		Tags:        splitAndTrim(env("CAPTIONS_BOX_TAGS", "webinar-captions")),
		ManagedTag:  captionsBoxManagedTag,
		CPUs:        envIntStrict("CAPTIONS_BOX_CPUS", 0),
		MaxRooms:    envIntStrict("CAPTIONS_BOX_MAX_ROOMS", 0),
		Model:       strings.TrimSpace(env("CAPTIONS_BOX_MODEL", "base.en")),
		APIURL:      strings.TrimRight(strings.TrimSpace(env("CAPTIONS_BOX_API_URL", "https://webinarliv.com")), "/"),
		LiveKitURL:  strings.TrimSpace(env("CAPTIONS_BOX_LIVEKIT_URL", "")),
		BootTimeout: envDuration("CAPTIONS_BOX_BOOT_TIMEOUT", 10*time.Minute),

		Provider:         provider,
		DeepgramKey:      strings.TrimSpace(env("DEEPGRAM_API_KEY", "")),
		DeepgramModel:    strings.TrimSpace(env("CAPTIONS_DEEPGRAM_MODEL", "nova-3")),
		DeepgramLanguage: strings.TrimSpace(env("CAPTIONS_DEEPGRAM_LANGUAGE", "multi")),
		FallbackLocal:    fallback,
	}
	return b.withDefaults()
}

// withDefaults fills CPUs and MaxRooms from the size where they were left unset.
func (b CaptionsBox) withDefaults() CaptionsBox {
	vcpus := SizeVCPUs(b.Size)
	if b.CPUs == 0 && vcpus > 0 {
		b.CPUs = vcpus
	}
	if b.MaxRooms == 0 && b.CPUs > 0 {
		if b.Provider == CaptionsProviderDeepgram && !b.FallbackLocal {
			b.MaxRooms = captionsDeepgramRoomsPerVCPU * b.CPUs
		} else {
			b.MaxRooms = CaptionsRoomsFor(b.CPUs)
		}
	}
	if b.Provider == "" {
		b.Provider = "local"
	}
	if b.ManagedTag == "" {
		b.ManagedTag = captionsBoxManagedTag
	}
	if b.BootTimeout <= 0 {
		b.BootTimeout = 10 * time.Minute
	}
	return b
}

// WithDefaults is withDefaults for a config built by hand (tests).
func (b CaptionsBox) WithDefaults() CaptionsBox { return b.withDefaults() }

// captionsDeepgramKey is what a Deepgram API key looks like: a plain token, safe in the env file.
var captionsDeepgramKey = regexp.MustCompile(`^[A-Za-z0-9_-]{20,128}$`)

// captionsBoxPlain is a name or value written into the droplet's user data and .env.
var captionsBoxPlain = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// validateCaptionsBox reports a captions box that is switched on but cannot work.
func (c Config) validateCaptionsBox() []error {
	b := c.SFUBox.Captions
	if !b.On {
		return nil
	}
	var errs []error
	if !c.SFUBox.Enabled() {
		errs = append(errs, fmt.Errorf("CAPTIONS_BOX_ENABLED=true needs the video box manager (SFU_BOX_PROJECT and DO_API_TOKEN)"))
	}
	if len(c.CaptionsSecret) < 32 {
		errs = append(errs, fmt.Errorf("CAPTIONS_BOX_ENABLED=true needs CAPTIONS_SECRET (32+ characters)"))
	}
	for _, kv := range [][2]string{{"CAPTIONS_BOX_NAME", b.Name}, {"CAPTIONS_BOX_SIZE", b.Size},
		{"CAPTIONS_BOX_IMAGE", b.SnapshotTag}, {"CAPTIONS_BOX_MODEL", b.Model}} {
		if !captionsBoxPlain.MatchString(kv[1]) {
			errs = append(errs, fmt.Errorf("%s must be a plain name (letters, digits, . _ -), got %q", kv[0], kv[1]))
		}
	}
	if b.CPUs < 1 || b.CPUs > 64 {
		errs = append(errs, fmt.Errorf("CAPTIONS_BOX_CPUS must be 1-64 (set it: the vCPUs of %q could not be read from the size)", b.Size))
	}
	if b.MaxRooms < 1 || b.MaxRooms > 100 {
		errs = append(errs, fmt.Errorf("CAPTIONS_BOX_MAX_ROOMS must be 1-100"))
	}
	switch b.Provider {
	case "local":
	case CaptionsProviderDeepgram:
		// The key goes into the box's env file: it must be a plain token (never echoed here).
		if !captionsDeepgramKey.MatchString(b.DeepgramKey) {
			errs = append(errs, fmt.Errorf("CAPTIONS_PROVIDER=deepgram needs DEEPGRAM_API_KEY (a plain token)"))
		}
		for _, kv := range [][2]string{{"CAPTIONS_DEEPGRAM_MODEL", b.DeepgramModel}, {"CAPTIONS_DEEPGRAM_LANGUAGE", b.DeepgramLanguage}} {
			if !captionsBoxPlain.MatchString(kv[1]) {
				errs = append(errs, fmt.Errorf("%s must be a plain name, got %q", kv[0], kv[1]))
			}
		}
	default:
		errs = append(errs, fmt.Errorf("CAPTIONS_PROVIDER must be local or deepgram, got %q", b.Provider))
	}
	if u, err := url.Parse(b.APIURL); err != nil || u.Scheme != "https" || u.Host == "" || !boxGrafanaSafe.MatchString(b.APIURL) {
		errs = append(errs, fmt.Errorf("CAPTIONS_BOX_API_URL must be an https:// URL, got %q", b.APIURL))
	}
	if b.LiveKitURL != "" {
		if u, err := url.Parse(b.LiveKitURL); err != nil || (u.Scheme != "wss" && u.Scheme != "ws") || u.Host == "" || !boxGrafanaSafe.MatchString(b.LiveKitURL) {
			errs = append(errs, fmt.Errorf("CAPTIONS_BOX_LIVEKIT_URL must be a ws:// or wss:// URL, got %q", b.LiveKitURL))
		}
	}
	for _, t := range b.Tags {
		if !captionsBoxPlain.MatchString(t) {
			errs = append(errs, fmt.Errorf("CAPTIONS_BOX_TAGS: %q is not a plain tag", t))
		}
		// The video box's tags: its firewall and alerts, and the manager's own marker, which
		// would make the video manager adopt (and later delete) the captions droplet.
		if t == c.SFUBox.ManagedTag || t == "webinar-sfu-ondemand" || containsString(c.SFUBox.Tags, t) {
			errs = append(errs, fmt.Errorf("CAPTIONS_BOX_TAGS must not include the video box's tag %q", t))
		}
	}
	if b.BootTimeout < 2*time.Minute {
		errs = append(errs, fmt.Errorf("CAPTIONS_BOX_BOOT_TIMEOUT must be at least 2m"))
	}
	return errs
}

func containsString(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
