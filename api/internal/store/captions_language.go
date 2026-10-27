package store

import (
	"context"
	"strings"
	"sync/atomic"

	"github.com/netkumar/webcast/api/types"
)

// defaultCaptionsLanguage is CAPTIONS_DEFAULT_LANGUAGE, set once at boot
// (SetDefaultCaptionsLanguage); a webinar without a chosen language reads as it.
var defaultCaptionsLanguage atomic.Value

// SetDefaultCaptionsLanguage sets the language a webinar without one reads as. An unknown code
// is ignored (config validation refuses it before this is called).
func SetDefaultCaptionsLanguage(code string) {
	if types.ValidCaptionLanguage(code) {
		defaultCaptionsLanguage.Store(strings.TrimSpace(code))
	}
}

// DefaultCaptionsLanguage is the server's default captions language (en-IN unless configured).
func DefaultCaptionsLanguage() string {
	if v, ok := defaultCaptionsLanguage.Load().(string); ok && v != "" {
		return v
	}
	return types.DefaultCaptionsLanguage
}

/* CaptionsLanguageOf is a webinar's captions language, for the caption agent's dispatch
 * metadata: one indexed read instead of the whole webinar. The default when it was never set. */
func (s *Store) CaptionsLanguageOf(ctx context.Context, slug string) (string, error) {
	var code *string
	err := s.pool.QueryRow(ctx, `SELECT options->>'captionsLanguage' FROM webinars WHERE slug = $1`, slug).Scan(&code)
	if noRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	v := ""
	if code != nil {
		v = *code
	}
	return types.CaptionLanguageOrDefault(v, DefaultCaptionsLanguage()), nil
}
