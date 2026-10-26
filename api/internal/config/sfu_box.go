package config

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

/* SFUBox is the on-demand DigitalOcean video server (api/internal/api/sfu_box.go,
 * deploy/digitalocean/README.md): a droplet the API creates from the newest snapshot when a
 * session on Project needs it and deletes when nothing has for IdleGrace. The data volume and
 * the reserved IP outlive it, so every droplet comes up with the same keys, certificates,
 * caption models and address.
 *
 * Off unless SFU_BOX_PROJECT and DO_API_TOKEN are both set. Every other field has a default
 * that matches deploy/digitalocean/README.md. */
type SFUBox struct {
	// Project is the LiveKit project id the box serves (SFU_BOX_PROJECT, e.g. do-blr).
	Project string
	// Token is the DigitalOcean API token (DO_API_TOKEN, a secret).
	Token string
	// Name of the droplet (SFU_BOX_NAME, default sfu-blr-1).
	Name string
	// Region and Size (SFU_BOX_REGION blr1, SFU_BOX_SIZE c-4).
	Region string
	Size   string
	// SnapshotTag picks the image: the newest snapshot with this tag (SFU_BOX_SNAPSHOT_TAG,
	// default webinar-sfu-image), else the newest named "<tag>-…".
	SnapshotTag string
	// Volume is the data volume's name (SFU_BOX_VOLUME, default sfu-data).
	Volume string
	// ReservedIP is the address the box answers on (SFU_BOX_RESERVED_IP).
	ReservedIP string
	/* Tags go on the droplet (SFU_BOX_TAGS, default webinar-sfu: the sfu-media firewall and the
	 * monitoring alerts apply by it). ManagedTag is added as well and is how the manager
	 * recognises its own droplet: it never touches one without it. */
	Tags       []string
	ManagedTag string
	// SSHKeys are DigitalOcean key ids or fingerprints added at create (SFU_BOX_SSH_KEYS).
	SSHKeys []string
	// VPCUUID optionally pins the VPC (SFU_BOX_VPC_UUID); empty is the region's default.
	VPCUUID string
	// ParkDroplet is a droplet name (SFU_BOX_PARK_DROPLET, e.g. ops-blr-1) the reserved IP is
	// moved to while the box is down: an unassigned reserved IP bills $5/month, an assigned
	// one is free. Empty leaves it unassigned.
	ParkDroplet string
	// Repo and Ref are where the box fetches the deploy files at boot (SFU_BOX_REPO
	// netesh3/webinar, SFU_BOX_REF main).
	Repo string
	Ref  string
	// TurnHost is checked for a TLS certificate as part of readiness (SFU_BOX_TURN_HOST,
	// default turn.<livekit host>; "-" skips the check).
	TurnHost string

	// WarmLead: up this long before a scheduled start (SFU_BOX_WARM_LEAD, default 15m).
	WarmLead time.Duration
	// IdleGrace: down this long after the last need (SFU_BOX_IDLE_GRACE, default 40m).
	IdleGrace time.Duration
	// BootTimeout: a droplet not ready this long after create counts as failed
	// (SFU_BOX_BOOT_TIMEOUT, default 12m).
	BootTimeout time.Duration
	// MaxFailures before admins are alerted and hosts are shown an error (SFU_BOX_MAX_FAILURES, 3).
	MaxFailures int
	// AlwaysOn keeps the box up whatever the demand (SFU_BOX_ALWAYS_ON=true): the rollback.
	AlwaysOn bool

	/* Grafana is the box's Grafana Cloud settings for Alloy (deploy/livekit-hetzner/README.md,
	 * "Grafana Cloud"), passed to every droplet in its user data so it reports from first boot
	 * without the deploy workflow (which skips while the box is down). All five or none. */
	Grafana BoxGrafana

	// Captions is the captions droplet made and deleted with this box (captions_box.go).
	Captions CaptionsBox

	/* Area is the part of the world the box serves (SFU_BOX_AREA, default "in"): a session's
	 * region picks among the boxes of its area (api/internal/api/sfu_pool.go). Capacity is
	 * how many points of sessions it carries (SFU_BOX_CAPACITY, default 100 for a c-4,
	 * headroom included; BoxPoints says what a session costs). */
	Area     string
	Capacity int

	/* Slots are the further boxes of the pool (SFU_BOX_SLOTS, a JSON list; empty is the one box
	 * above, as before). Each is declared ahead, with its own droplet name, data volume and
	 * reserved IP, which the operator provisions (deploy/digitalocean/README.md "More video
	 * servers"): the API only ever creates and deletes the droplet of a declared slot, never a
	 * volume, an IP or anything else that bills. Only the primary carries Slots. */
	Slots []SFUBox

	// Points is what each kind of session costs a box (SFU_BOX_POINTS); only the primary's is read.
	Points BoxPoints
}

/* BoxPoints is the capacity model of the box pool: what a session costs a box, against
 * SFUBox.Capacity. One place, on purpose. These are ESTIMATES from the 24 Oct 2026 load test
 * (one c-4: a camera mix ~0.5–1 core, up to ~1.8 with a share and a recording; ~0.6 core per
 * 100 viewers served from the box; ~8–10 ten-person meetings) and must be calibrated against
 * the real-browser test before anyone relies on them. SFU_BOX_POINTS overrides any of them:
 * {"mix":20,"extra":10,"viewersPerPoint":10,"meetingBase":4,"meetingBaseSize":10,"meetingPeoplePerPoint":2,"simulive":0}. */
type BoxPoints struct {
	// Mix is a webinar's composite (the egress Chrome).
	Mix int `json:"mix"`
	/* Extra is a webinar's screen share or recording on top of the mix. Whether a share will
	 * happen cannot be known ahead, so every webinar is charged it. */
	Extra int `json:"extra"`
	// ViewersPerPoint: a webinar costs one point per this many seats (its max attendees).
	ViewersPerPoint int `json:"viewersPerPoint"`
	// MeetingBase covers a meeting of up to MeetingBaseSize people; each MeetingPeoplePerPoint more add one.
	MeetingBase           int `json:"meetingBase"`
	MeetingBaseSize       int `json:"meetingBaseSize"`
	MeetingPeoplePerPoint int `json:"meetingPeoplePerPoint"`
	/* Simulive is a simulive's cost. Its audience plays the recording file, not the box, and
	 * nothing is mixed, so the default is 0; the room the host team drops into is negligible. */
	Simulive int `json:"simulive"`
}

// DefaultBoxPoints is BoxPoints before SFU_BOX_POINTS.
func DefaultBoxPoints() BoxPoints {
	return BoxPoints{Mix: 20, Extra: 10, ViewersPerPoint: 10, MeetingBase: 4, MeetingBaseSize: 10,
		MeetingPeoplePerPoint: 2, Simulive: 0}
}

// Webinar is the points of a webinar of seats max attendees.
func (p BoxPoints) Webinar(seats int) int {
	return p.Mix + p.Extra + ceilDiv(max(0, seats), max(1, p.ViewersPerPoint))
}

// Meeting is the points of a meeting of up to size people.
func (p BoxPoints) Meeting(size int) int {
	return p.MeetingBase + ceilDiv(max(0, size-p.MeetingBaseSize), max(1, p.MeetingPeoplePerPoint))
}

func ceilDiv(a, b int) int { return int(math.Ceil(float64(a) / float64(b))) }

// DefaultBoxArea is a box's area, and a session's region, when none is set.
const DefaultBoxArea = "in"

// boxSlotSpec is one entry of SFU_BOX_SLOTS. Unset fields take the primary's value, except the
// ones that make a box itself (project, name, volume, reserved IP), which are required.
type boxSlotSpec struct {
	Project      string `json:"project"`
	Name         string `json:"name"`
	Area         string `json:"area"`
	Region       string `json:"region"`
	Size         string `json:"size"`
	Volume       string `json:"volume"`
	ReservedIP   string `json:"reservedIp"`
	Capacity     int    `json:"capacity"`
	SnapshotTag  string `json:"snapshotTag"`
	ParkDroplet  string `json:"parkDroplet"`
	TurnHost     string `json:"turnHost"`
	VPCUUID      string `json:"vpcUuid"`
	CaptionsName string `json:"captionsName"`
}

/* parseBoxSlots reads SFU_BOX_SLOTS against the primary. A slot's droplets carry a managed tag
 * of their own ("<primary tag>-<name>"), as do its captions droplets: each manager adopts and
 * deletes only droplets with its tag, so two slots never take each other's. The primary keeps
 * today's tags, so a pool of one is exactly the box as it was. */
func parseBoxSlots(raw string, primary SFUBox) ([]SFUBox, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var specs []boxSlotSpec
	if err := json.Unmarshal([]byte(raw), &specs); err != nil {
		return nil, fmt.Errorf("SFU_BOX_SLOTS is not a JSON list of slots: %w", err)
	}
	out := make([]SFUBox, 0, len(specs))
	for _, sp := range specs {
		b := primary
		b.Slots, b.Points = nil, BoxPoints{}
		b.Project = strings.TrimSpace(sp.Project)
		b.Name = strings.TrimSpace(sp.Name)
		b.Volume = strings.TrimSpace(sp.Volume)
		b.ReservedIP = strings.TrimSpace(sp.ReservedIP)
		b.ManagedTag = primary.ManagedTag + "-" + b.Name
		b.ParkDroplet = strings.TrimSpace(sp.ParkDroplet)
		b.TurnHost = strings.TrimSpace(sp.TurnHost)
		pick := func(v, def string) string {
			if v = strings.TrimSpace(v); v != "" {
				return v
			}
			return def
		}
		b.Area = strings.ToLower(pick(sp.Area, primary.Area))
		b.Region = pick(sp.Region, primary.Region)
		b.Size = pick(sp.Size, primary.Size)
		b.SnapshotTag = pick(sp.SnapshotTag, primary.SnapshotTag)
		// The primary's VPC only exists in the primary's region.
		b.VPCUUID = strings.TrimSpace(sp.VPCUUID)
		if b.VPCUUID == "" && b.Region == primary.Region {
			b.VPCUUID = primary.VPCUUID
		}
		if sp.Capacity > 0 {
			b.Capacity = sp.Capacity
		}
		c := primary.Captions
		c.Name = pick(sp.CaptionsName, "captions-"+b.Name)
		c.ManagedTag = primary.Captions.ManagedTag + "-" + b.Name
		c.LiveKitURL = "" // the slot's own LiveKit (its project's URL)
		b.Captions = c
		out = append(out, b)
	}
	return out, nil
}

// SFUBoxes is the pool: the primary box first, then its slots. Empty when the box is off.
func (c Config) SFUBoxes() []SFUBox {
	if !c.SFUBox.Enabled() {
		return nil
	}
	out := []SFUBox{c.SFUBox}
	for _, s := range c.SFUBox.Slots {
		s.Token = c.SFUBox.Token
		out = append(out, s)
	}
	return out
}

// BoxAreas is the areas the pool serves, the primary's first. Empty when the box is off.
func (c Config) BoxAreas() []string {
	var out []string
	seen := map[string]bool{}
	for _, b := range c.SFUBoxes() {
		a := b.Area
		if a == "" {
			a = DefaultBoxArea
		}
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	return out
}

/* BoxGrafana is GRAFANA_CLOUD_PROM_URL, _PROM_USER, _LOKI_URL, _LOKI_USER (repo variables) and
 * GRAFANA_CLOUD_TOKEN (a secret: a write-only access policy token). The token never goes in a log. */
type BoxGrafana struct {
	PromURL, PromUser, LokiURL, LokiUser, Token string
}

// Pairs is the settings as .env lines' keys and values, in a fixed order.
func (g BoxGrafana) Pairs() [][2]string {
	return [][2]string{
		{"GRAFANA_CLOUD_PROM_URL", g.PromURL},
		{"GRAFANA_CLOUD_PROM_USER", g.PromUser},
		{"GRAFANA_CLOUD_LOKI_URL", g.LokiURL},
		{"GRAFANA_CLOUD_LOKI_USER", g.LokiUser},
		{"GRAFANA_CLOUD_TOKEN", g.Token},
	}
}

// Set is all five present.
func (g BoxGrafana) Set() bool {
	for _, p := range g.Pairs() {
		if p[1] == "" {
			return false
		}
	}
	return true
}

// Usable is all five present and each one safe to write into the box's .env.
func (g BoxGrafana) Usable() bool { return g.Set() && len(g.validate()) == 0 }

func (g BoxGrafana) any() bool {
	for _, p := range g.Pairs() {
		if p[1] != "" {
			return true
		}
	}
	return false
}

/* boxGrafanaSafe is what a value may hold: it is written into a shell heredoc and an .env line
 * (redeploy.sh reads them with cut, and drops quotes), so no whitespace, quotes, backslash, $ or
 * backtick. URLs, instance numbers and Grafana tokens (glc_ + base64) all fit. */
var boxGrafanaSafe = regexp.MustCompile(`^[A-Za-z0-9._:/@+=%?&,~-]+$`)

// Enabled is a box the API manages.
func (b SFUBox) Enabled() bool { return b.Project != "" && b.Token != "" }

func loadSFUBox() SFUBox {
	b := SFUBox{
		Project:     strings.TrimSpace(env("SFU_BOX_PROJECT", "")),
		Token:       strings.TrimSpace(env("DO_API_TOKEN", "")),
		Name:        strings.TrimSpace(env("SFU_BOX_NAME", "sfu-blr-1")),
		Region:      strings.TrimSpace(env("SFU_BOX_REGION", "blr1")),
		Size:        strings.TrimSpace(env("SFU_BOX_SIZE", "c-4")),
		SnapshotTag: strings.TrimSpace(env("SFU_BOX_SNAPSHOT_TAG", "webinar-sfu-image")),
		Volume:      strings.TrimSpace(env("SFU_BOX_VOLUME", "sfu-data")),
		ReservedIP:  strings.TrimSpace(env("SFU_BOX_RESERVED_IP", "152.42.156.192")),
		Tags:        splitAndTrim(env("SFU_BOX_TAGS", "webinar-sfu")),
		ManagedTag:  "webinar-sfu-ondemand",
		SSHKeys:     splitAndTrim(env("SFU_BOX_SSH_KEYS", "")),
		VPCUUID:     strings.TrimSpace(env("SFU_BOX_VPC_UUID", "")),
		ParkDroplet: strings.TrimSpace(env("SFU_BOX_PARK_DROPLET", "")),
		Repo:        strings.TrimSpace(env("SFU_BOX_REPO", "netesh3/webinar")),
		Ref:         strings.TrimSpace(env("SFU_BOX_REF", "main")),
		TurnHost:    strings.TrimSpace(env("SFU_BOX_TURN_HOST", "")),
		WarmLead:    envDuration("SFU_BOX_WARM_LEAD", 15*time.Minute),
		IdleGrace:   envDuration("SFU_BOX_IDLE_GRACE", 40*time.Minute),
		BootTimeout: envDuration("SFU_BOX_BOOT_TIMEOUT", 12*time.Minute),
		MaxFailures: envInt("SFU_BOX_MAX_FAILURES", 3),
		AlwaysOn:    envBool("SFU_BOX_ALWAYS_ON", false),
		Grafana: BoxGrafana{
			PromURL:  strings.TrimSpace(env("GRAFANA_CLOUD_PROM_URL", "")),
			PromUser: strings.TrimSpace(env("GRAFANA_CLOUD_PROM_USER", "")),
			LokiURL:  strings.TrimSpace(env("GRAFANA_CLOUD_LOKI_URL", "")),
			LokiUser: strings.TrimSpace(env("GRAFANA_CLOUD_LOKI_USER", "")),
			Token:    strings.TrimSpace(env("GRAFANA_CLOUD_TOKEN", "")),
		},
		Captions: loadCaptionsBox(),
		Area:     strings.ToLower(strings.TrimSpace(env("SFU_BOX_AREA", DefaultBoxArea))),
		Capacity: envInt("SFU_BOX_CAPACITY", 100),
		Points:   DefaultBoxPoints(),
	}
	if raw := strings.TrimSpace(env("SFU_BOX_POINTS", "")); raw != "" {
		// Unknown or bad JSON keeps the defaults; validateSFUBox reports it.
		_ = json.Unmarshal([]byte(raw), &b.Points)
	}
	slots, err := parseBoxSlots(env("SFU_BOX_SLOTS", ""), b)
	boxSlotsErr = err
	b.Slots = slots
	return b
}

// boxSlotsErr is SFU_BOX_SLOTS failing to parse, reported by validateSFUBox.
var boxSlotsErr error

/* validate is all five GRAFANA_CLOUD_* or none, each a plain value. The messages name the
 * variable, never the value (the token is a secret). */
func (g BoxGrafana) validate() []error {
	if !g.any() {
		return nil
	}
	var errs []error
	var missing []string
	for _, p := range g.Pairs() {
		switch {
		case p[1] == "":
			missing = append(missing, p[0])
		case !boxGrafanaSafe.MatchString(p[1]):
			errs = append(errs, fmt.Errorf("%s has a character the box's .env cannot carry (whitespace, quote, backslash, $ or backtick)", p[0]))
		}
	}
	if len(missing) > 0 {
		errs = append(errs, fmt.Errorf("the video server's Grafana Cloud settings need all five GRAFANA_CLOUD_* or none; missing %s", strings.Join(missing, ", ")))
	}
	return errs
}

// validateSFUBox reports a box that is switched on but cannot work.
func (c Config) validateSFUBox() []error {
	b := c.SFUBox
	errs := c.validateCaptionsBox()
	// A token alone is fine (the same repo secret serves the image workflow): the box is simply
	// not managed. Deleting SFU_BOX_PROJECT is how the manager is switched off.
	if b.Project == "" {
		return errs
	}
	if b.Token == "" {
		errs = append(errs, fmt.Errorf("SFU_BOX_PROJECT=%s needs DO_API_TOKEN", b.Project))
	}
	if _, ok := c.LiveKitProjectByID(b.Project); !ok {
		errs = append(errs, fmt.Errorf("SFU_BOX_PROJECT=%s is not in LIVEKIT_PROJECTS", b.Project))
	}
	if b.ReservedIP == "" || b.Volume == "" || b.Region == "" || b.Size == "" || b.SnapshotTag == "" {
		errs = append(errs, fmt.Errorf("SFU_BOX_RESERVED_IP, SFU_BOX_VOLUME, SFU_BOX_REGION, SFU_BOX_SIZE and SFU_BOX_SNAPSHOT_TAG must not be empty"))
	}
	if b.WarmLead < time.Minute || b.IdleGrace < time.Minute || b.BootTimeout < 2*time.Minute {
		errs = append(errs, fmt.Errorf("SFU_BOX_WARM_LEAD and SFU_BOX_IDLE_GRACE must be at least 1m, SFU_BOX_BOOT_TIMEOUT at least 2m"))
	}
	if b.MaxFailures < 1 {
		errs = append(errs, fmt.Errorf("SFU_BOX_MAX_FAILURES must be >= 1"))
	}
	errs = append(errs, b.Grafana.validate()...)
	errs = append(errs, c.validateBoxPool()...)
	return errs
}

// validateBoxPool reports slots that would collide with each other or are not configured.
func (c Config) validateBoxPool() []error {
	var errs []error
	if boxSlotsErr != nil {
		errs = append(errs, boxSlotsErr)
	}
	if raw := strings.TrimSpace(env("SFU_BOX_POINTS", "")); raw != "" {
		var p BoxPoints
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			errs = append(errs, fmt.Errorf("SFU_BOX_POINTS is not valid JSON: %w", err))
		}
	}
	seen := map[string]string{}
	claim := func(kind, v, slot string) {
		if v == "" {
			return
		}
		key := kind + "=" + v
		if other, ok := seen[key]; ok {
			errs = append(errs, fmt.Errorf("video servers %s and %s share the %s %s", other, slot, kind, v))
			return
		}
		seen[key] = slot
	}
	for i, b := range c.SFUBoxes() {
		slot := b.Name
		if slot == "" {
			slot = fmt.Sprintf("#%d", i+1)
		}
		if i > 0 {
			if b.Project == "" || b.Name == "" || b.Volume == "" || b.ReservedIP == "" {
				errs = append(errs, fmt.Errorf("SFU_BOX_SLOTS entry %d needs project, name, volume and reservedIp", i))
				continue
			}
			if !boxSafe.MatchString(b.Name) {
				errs = append(errs, fmt.Errorf("SFU_BOX_SLOTS name %q must be a plain name", b.Name))
			}
			if _, ok := c.LiveKitProjectByID(b.Project); !ok {
				errs = append(errs, fmt.Errorf("SFU_BOX_SLOTS project %s is not in LIVEKIT_PROJECTS", b.Project))
			}
		}
		if b.Capacity < 1 {
			errs = append(errs, fmt.Errorf("video server %s needs a capacity of at least 1 (SFU_BOX_CAPACITY or the slot's capacity)", slot))
		}
		claim("project", b.Project, slot)
		claim("droplet name", b.Name, slot)
		claim("volume", b.Volume, slot)
		claim("reserved IP", b.ReservedIP, slot)
		claim("captions droplet name", b.Captions.Name, slot)
	}
	return errs
}

// boxSafe is a value safe in a droplet name or shell line.
var boxSafe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
