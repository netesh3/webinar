package config

import (
	"fmt"
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
	}
	return b
}

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
	// A token alone is fine (the same repo secret serves the image workflow): the box is simply
	// not managed. Deleting SFU_BOX_PROJECT is how the manager is switched off.
	if b.Project == "" {
		return nil
	}
	var errs []error
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
	return errs
}
