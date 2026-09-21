package yt

import (
	"context"
	"net/url"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/streamdest"
)

const (
	PrivacyPublic   = "public"
	PrivacyUnlisted = "unlisted"
	PrivacyPrivate  = "private"
)

// Live is one YouTube broadcast this server created, ready for RTMP ingest.
type Live struct {
	BroadcastID string
	StreamID    string
	IngestURL   string
	WatchURL    string
}

func Privacy(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case PrivacyPublic:
		return PrivacyPublic
	case PrivacyPrivate:
		return PrivacyPrivate
	default:
		return PrivacyUnlisted
	}
}

/* StartLive creates a broadcast on the connected channel, bound to a reusable
 * encoder stream, and returns the RTMP URL LiveKit should push.
 *
 * streamID is the YouTube liveStreams resource we created last time (empty on
 * the first connect). Reusing it means YouTube Studio shows one encoder rather
 * than a new key every session. A missing/deleted stream is recreated. */
func (c *Client) StartLive(ctx context.Context, refresh, title, privacy, streamID string) (Live, Token, error) {
	if !c.Enabled() {
		return Live{}, Token{}, ErrNotConfigured
	}
	tok, err := c.Refresh(ctx, refresh)
	if err != nil {
		return Live{}, Token{}, err
	}

	streamID, ingest, err := c.ensureStream(ctx, tok.AccessToken, streamID)
	if err != nil {
		return Live{}, tok, err
	}

	title = strings.TrimSpace(title)
	if title == "" {
		title = "Webinar Liv"
	}
	if len([]rune(title)) > 100 {
		title = string([]rune(title)[:100])
	}

	start := time.Now().UTC().Add(30 * time.Second).Format(time.RFC3339)
	var created struct {
		ID string `json:"id"`
	}
	err = c.api(ctx, tok.AccessToken, "POST",
		"/liveBroadcasts?part=snippet,status,contentDetails",
		map[string]any{
			"snippet": map[string]any{
				"title":              title,
				"scheduledStartTime": start,
			},
			"status": map[string]any{
				"privacyStatus":           Privacy(privacy),
				"selfDeclaredMadeForKids": false,
			},
			"contentDetails": map[string]any{
				"enableAutoStart": true,
				"enableAutoStop":  true,
				"enableDvr":       true,
			},
		}, &created)
	if err != nil {
		return Live{}, tok, err
	}

	var bound struct {
		ID      string `json:"id"`
		Snippet struct {
			Title string `json:"title"`
		} `json:"snippet"`
	}
	q := url.Values{
		"id":       {created.ID},
		"streamId": {streamID},
		"part":     {"id,snippet,contentDetails,status"},
	}
	if err := c.api(ctx, tok.AccessToken, "POST", "/liveBroadcasts/bind?"+q.Encode(), nil, &bound); err != nil {
		return Live{}, tok, err
	}

	watch := "https://www.youtube.com/watch?v=" + created.ID
	if canon, err := streamdest.WatchURL(watch); err == nil {
		watch = canon
	}

	return Live{
		BroadcastID: created.ID,
		StreamID:    streamID,
		IngestURL:   ingest,
		WatchURL:    watch,
	}, tok, nil
}

func (c *Client) Complete(ctx context.Context, refresh, broadcastID string) error {
	broadcastID = strings.TrimSpace(broadcastID)
	if broadcastID == "" {
		return nil
	}
	tok, err := c.Refresh(ctx, refresh)
	if err != nil {
		return err
	}
	q := url.Values{
		"id":              {broadcastID},
		"broadcastStatus": {"complete"},
		"part":            {"status"},
	}
	err = c.api(ctx, tok.AccessToken, "POST", "/liveBroadcasts/transition?"+q.Encode(), nil, nil)
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "redundant") {
		return err
	}
	return nil
}

func (c *Client) ensureStream(ctx context.Context, access, streamID string) (id, ingest string, err error) {
	if streamID != "" {
		id, ingest, err = c.streamIngest(ctx, access, streamID)
		if err == nil && ingest != "" {
			return id, ingest, nil
		}
	}
	var created struct {
		ID  string `json:"id"`
		CDN struct {
			IngestionInfo struct {
				IngestionAddress string `json:"ingestionAddress"`
				StreamName       string `json:"streamName"`
			} `json:"ingestionInfo"`
		} `json:"cdn"`
	}
	err = c.api(ctx, access, "POST", "/liveStreams?part=snippet,cdn", map[string]any{
		"snippet": map[string]any{"title": "Webinar Liv encoder"},
		"cdn": map[string]any{
			"frameRate":     "30fps",
			"ingestionType": "rtmp",
			"resolution":    "1080p",
		},
	}, &created)
	if err != nil {
		return "", "", err
	}
	ingest, err = ingestURL(created.CDN.IngestionInfo.IngestionAddress, created.CDN.IngestionInfo.StreamName)
	if err != nil {
		return "", "", err
	}
	return created.ID, ingest, nil
}

func (c *Client) streamIngest(ctx context.Context, access, id string) (string, string, error) {
	var out struct {
		Items []struct {
			ID  string `json:"id"`
			CDN struct {
				IngestionInfo struct {
					IngestionAddress string `json:"ingestionAddress"`
					StreamName       string `json:"streamName"`
				} `json:"ingestionInfo"`
			} `json:"cdn"`
		} `json:"items"`
	}
	q := url.Values{"part": {"cdn"}, "id": {id}}
	if err := c.api(ctx, access, "GET", "/liveStreams?"+q.Encode(), nil, &out); err != nil {
		return "", "", err
	}
	if len(out.Items) == 0 {
		return "", "", nil
	}
	info := out.Items[0].CDN.IngestionInfo
	ingest, err := ingestURL(info.IngestionAddress, info.StreamName)
	if err != nil {
		return "", "", err
	}
	return out.Items[0].ID, ingest, nil
}

func ingestURL(address, name string) (string, error) {
	address = strings.TrimRight(strings.TrimSpace(address), "/")
	name = strings.TrimSpace(name)
	if address == "" || name == "" {
		return "", ErrLiveDisabled
	}
	// YouTube still returns rtmp://; LiveKit and YouTube both speak rtmps on
	// the same path, and we already use rtmps for pasted keys.
	if strings.HasPrefix(address, "rtmp://") {
		address = "rtmps://" + strings.TrimPrefix(address, "rtmp://")
	}
	return streamdest.IngestURL(name, address)
}
