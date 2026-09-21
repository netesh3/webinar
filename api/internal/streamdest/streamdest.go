// Package streamdest turns a host's pasted YouTube (or other RTMP) details
// into the two URLs the encoder and the recordings tab actually use.
package streamdest

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// DefaultYouTubeIngest is YouTube's primary RTMPS ingest. Used when the host
// pastes only a stream key, which is what Studio copies for them.
const DefaultYouTubeIngest = "rtmps://a.rtmp.youtube.com/live2"

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
