package config

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

/* CaptionsProvider is who transcribes server-side live captions (CAPTIONS_PROVIDER,
 * docs/decisions/2026-10-27-captions-providers.md):
 *
 *   - deepgram (the default when DEEPGRAM_API_KEY is set): a light worker on each video box
 *     (deploy/captions/webcaptions/stage_agent.py, the captions-worker compose service) streams
 *     the stage speakers' microphones to Deepgram only while they speak. The API passes it
 *     its settings in the box's user data (boxUserData); no captions droplet is ever made.
 *   - local (the default without a key): the Whisper models on the separate captions box,
 *     retired from production on 2026-10-27 and kept only as a fallback. Its droplet is made
 *     only with CAPTIONS_PROVIDER=local set explicitly AND CAPTIONS_BOX_ENABLED=true
 *     (captionsBoxOn).
 */
type CaptionsProvider struct {
	Name string
	// Explicit: CAPTIONS_PROVIDER was set, not defaulted from the key.
	Explicit         bool
	DeepgramKey      string
	DeepgramModel    string // CAPTIONS_DEEPGRAM_MODEL, default nova-3
	DeepgramLanguage string // CAPTIONS_DEEPGRAM_LANGUAGE, default multi (English + Hindi code-switching)
	// APIURL is where the video box worker posts lines (CAPTIONS_API_URL, default https://webinarliv.com).
	APIURL string
}

const (
	CaptionsProviderLocal    = "local"
	CaptionsProviderDeepgram = "deepgram"
)

func loadCaptionsProvider() CaptionsProvider {
	key := strings.TrimSpace(env("DEEPGRAM_API_KEY", ""))
	name := strings.ToLower(strings.TrimSpace(env("CAPTIONS_PROVIDER", "")))
	p := CaptionsProvider{
		Name:             name,
		Explicit:         name != "",
		DeepgramKey:      key,
		DeepgramModel:    strings.TrimSpace(env("CAPTIONS_DEEPGRAM_MODEL", "nova-3")),
		DeepgramLanguage: strings.TrimSpace(env("CAPTIONS_DEEPGRAM_LANGUAGE", "multi")),
		APIURL:           strings.TrimRight(strings.TrimSpace(env("CAPTIONS_API_URL", "https://webinarliv.com")), "/"),
	}
	if p.Name == "" {
		p.Name = CaptionsProviderLocal
		if key != "" {
			p.Name = CaptionsProviderDeepgram
		}
	}
	return p
}

// OnVideoBox is whether captions run on the video box itself (the deepgram worker).
func (p CaptionsProvider) OnVideoBox() bool {
	return p.Name == CaptionsProviderDeepgram && p.DeepgramKey != ""
}

// ExplicitLocal is CAPTIONS_PROVIDER=local, set: the only provider the captions box serves.
func (p CaptionsProvider) ExplicitLocal() bool {
	return p.Explicit && p.Name == CaptionsProviderLocal
}

/* CaptionsBoxOn is the captions droplet's switch: CAPTIONS_BOX_ENABLED=true AND
 * CAPTIONS_PROVIDER=local set explicitly. Anything else (deepgram, or local only by default)
 * never makes the droplet, whatever CAPTIONS_BOX_ENABLED says. */
func (c Config) CaptionsBoxOn() bool {
	return c.SFUBox.Captions.On && c.CaptionsProvider.ExplicitLocal()
}

// captionsDeepgramKey is what a Deepgram API key looks like: a plain token, safe in an env file.
var captionsDeepgramKey = regexp.MustCompile(`^[A-Za-z0-9_-]{20,128}$`)

// validateCaptionsProvider reports a provider that cannot work. The key is never in an error.
func (c Config) validateCaptionsProvider() []error {
	p := c.CaptionsProvider
	var errs []error
	switch p.Name {
	case CaptionsProviderLocal:
	case CaptionsProviderDeepgram:
		// The key goes into the video box's env file: it must be a plain token.
		if !captionsDeepgramKey.MatchString(p.DeepgramKey) {
			errs = append(errs, fmt.Errorf("CAPTIONS_PROVIDER=deepgram needs DEEPGRAM_API_KEY (a plain token)"))
		}
		for _, kv := range [][2]string{{"CAPTIONS_DEEPGRAM_MODEL", p.DeepgramModel}, {"CAPTIONS_DEEPGRAM_LANGUAGE", p.DeepgramLanguage}} {
			if !captionsBoxPlain.MatchString(kv[1]) {
				errs = append(errs, fmt.Errorf("%s must be a plain name, got %q", kv[0], kv[1]))
			}
		}
		if u, err := url.Parse(p.APIURL); err != nil || u.Scheme != "https" || u.Host == "" || !boxGrafanaSafe.MatchString(p.APIURL) {
			errs = append(errs, fmt.Errorf("CAPTIONS_API_URL must be an https:// URL, got %q", p.APIURL))
		}
	default:
		errs = append(errs, fmt.Errorf("CAPTIONS_PROVIDER must be local or deepgram, got %q", p.Name))
	}
	return errs
}
