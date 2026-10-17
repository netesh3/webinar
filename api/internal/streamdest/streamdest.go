// Package streamdest turns a host's pasted YouTube (or other RTMP) details
// into the two URLs the encoder and the recordings tab actually use.
package streamdest

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

/* DefaultYouTubeIngest is YouTube's primary RTMPS ingest. Used when the host
 * pastes only a stream key, which is what Studio copies for them.
 *
 * Note the host: RTMPS is a.rtmps.youtube.com on 443, a different name from
 * the RTMP one (a.rtmp.youtube.com on 1935). They are not the same server with
 * two schemes — pointing rtmps:// at the RTMP host connects to nothing, and the
 * only symptom is a live that sits on "waiting to start" forever. */
const DefaultYouTubeIngest = "rtmps://a.rtmps.youtube.com/live2"

var (
	ErrNeedKey   = errors.New("paste the stream key from YouTube Studio")
	ErrNeedWatch = errors.New("paste the YouTube link for this live so it can show up in Recordings")
	ErrBadWatch  = errors.New("that doesn't look like a YouTube video link")
	ErrBadIngest = errors.New("the ingest URL must begin with rtmp:// or rtmps://")
)

var youtubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// IngestURL builds the RTMP(S) URL LiveKit Egress will push to.
//
// Three things a host actually pastes, all accepted:
//   - just the stream key (xxxx-xxxx-xxxx-xxxx) — we prefix YouTube's ingest
//   - a full rtmp(s):// URL, key already on the path
//   - a key plus a different ingest (LinkedIn, a custom restreamer)
func IngestURL(key, ingest string) (string, error) {
	key = strings.TrimSpace(key)
	ingest = strings.TrimRight(strings.TrimSpace(ingest), "/")

	if strings.HasPrefix(key, "rtmp://") || strings.HasPrefix(key, "rtmps://") {
		return strings.TrimRight(key, "/"), nil
	}
	if key == "" {
		return "", ErrNeedKey
	}
	if strings.ContainsAny(key, " \t\n") {
		return "", ErrNeedKey
	}
	if ingest == "" {
		ingest = DefaultYouTubeIngest
	}
	if !strings.HasPrefix(ingest, "rtmp://") && !strings.HasPrefix(ingest, "rtmps://") {
		return "", ErrBadIngest
	}
	return ingest + "/" + key, nil
}

// WatchURL canonicalises a YouTube watch/live/share/studio link to
// https://www.youtube.com/watch?v=ID so the recordings tab has one shape to
// render and Copy can offer.
func WatchURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ErrNeedWatch
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", ErrBadWatch
	}
	host := strings.ToLower(u.Hostname())
	host = strings.TrimPrefix(host, "www.")
	host = strings.TrimPrefix(host, "m.")

	var id string
	switch {
	case host == "youtu.be":
		id = strings.Trim(u.Path, "/")
		if i := strings.IndexByte(id, '/'); i >= 0 {
			id = id[:i]
		}
	case host == "youtube.com" || host == "youtube-nocookie.com" || strings.HasSuffix(host, ".youtube.com"):
		id = u.Query().Get("v")
		if id == "" {
			id = youtubePathID(u.Path)
		}
	default:
		return "", ErrBadWatch
	}
	if !youtubeID.MatchString(id) {
		return "", ErrBadWatch
	}
	return "https://www.youtube.com/watch?v=" + id, nil
}

func youtubePathID(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	// /live/ID, /embed/ID, /shorts/ID, /video/ID/livestreaming (Studio)
	for i, p := range parts {
		if p == "live" || p == "embed" || p == "shorts" || p == "v" || p == "video" {
			if i+1 < len(parts) {
				return parts[i+1]
			}
		}
	}
	return ""
}

/* FieldError is a pasted Stream URL or key that cannot be used, with the form
 * field it belongs to ("streamUrl" or "streamKey") and a message to show. */
type FieldError struct {
	Field   string
	Message string
}

func (e *FieldError) Error() string { return e.Message }

/* RTMPIngest joins what a platform (LinkedIn, Instagram, Facebook) shows under
 * "Stream URL" and "Stream key" into the address the encoder pushes to.
 *
 * Unlike YouTube there is no default server to fall back on: each hands out
 * its own URL, so it is required. So is the key: LinkedIn's URL already ends
 * in /live/<id>, so a URL alone cannot be told apart from one with the key
 * pasted onto it. platform is only used in the messages. */
func RTMPIngest(platform, streamURL, key string) (string, error) {
	needURL := &FieldError{Field: "streamUrl", Message: "Paste the Stream URL from " + platform + " — it begins with rtmps://"}
	needKey := &FieldError{Field: "streamKey", Message: "Paste the Stream key from " + platform}
	u := strings.TrimRight(strings.TrimSpace(streamURL), "/")
	key = strings.Trim(strings.TrimSpace(key), "/")
	if u == "" {
		return "", needURL
	}
	if !strings.HasPrefix(u, "rtmp://") && !strings.HasPrefix(u, "rtmps://") {
		return "", needURL
	}
	parsed, err := url.Parse(u)
	if err != nil || parsed.Host == "" || strings.ContainsAny(u, " \t\n") {
		return "", needURL
	}
	if key == "" || strings.ContainsAny(key, " \t\n") {
		return "", needKey
	}
	/* LinkedIn's Stream URL can already end with the key (".../live/<key>"),
	 * with the same key shown again under Stream Key. Appending it a second
	 * time pushes to ".../live/<key>/<key>", which LinkedIn never receives, so
	 * Go live stays greyed out. */
	if strings.HasSuffix(u, "/"+key) {
		return u, nil
	}
	return u + "/" + key, nil
}

// LinkedInIngest is RTMPIngest for LinkedIn Live.
func LinkedInIngest(streamURL, key string) (string, error) {
	return RTMPIngest("LinkedIn", streamURL, key)
}

/* FixDoubledKey repairs an ingest saved before LinkedInIngest knew LinkedIn's
 * Stream URL can already carry the key: ".../live/<key>/<key>" becomes
 * ".../live/<key>". Anything else is returned unchanged. */
func FixDoubledKey(ingest string) string {
	i := strings.LastIndexByte(ingest, '/')
	if i <= 0 {
		return ingest
	}
	last := ingest[i+1:]
	head := ingest[:i]
	if last != "" && strings.HasSuffix(head, "/"+last) {
		return head
	}
	return ingest
}

/* Hint is what the Settings card shows for a saved ingest without echoing the
 * key: the server, and the last four characters of the key. */
func Hint(ingest string) string {
	parsed, err := url.Parse(ingest)
	if err != nil || parsed.Host == "" {
		return ""
	}
	// Facebook and Instagram keys carry a query string (?s_bl=1&…); the
	// hint is the key itself.
	path := strings.Trim(parsed.Path, "/")
	tail := path
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		tail = path[i+1:]
	}
	if r := []rune(tail); len(r) > 4 {
		tail = string(r[len(r)-4:])
	}
	return parsed.Hostname() + " · key ending " + tail
}
