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

	// A broadcast left over from a session that did not finish cleanly still owns
	// this stream, and YouTube will not hand it to a second one.
	c.releaseStream(ctx, tok.AccessToken, streamID)

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
				/* Off, and this is the difference between a live that works and
				 * one that silently does not.
				 *
				 * monitorStream defaults to ON. With it on, a broadcast whose
				 * encoder connects goes to "testing", not "live": the frames
				 * arrive, YouTube is happy, Studio's control room previews them
				 * — and the public watch page stays empty until somebody presses
				 * "Go live" there by hand. enableAutoStart does not override it.
				 * Nothing in the ingest logs looks wrong, because nothing about
				 * the ingest is wrong.
				 *
				 * With no monitor stream there is no testing state to sit in, so
				 * enableAutoStart means what it says and the broadcast goes live
				 * on the first frames. We have no use for a review step nobody
				 * is watching for. */
				"monitorStream": map[string]any{
					"enableMonitorStream": false,
				},
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
	return c.complete(ctx, tok.AccessToken, broadcastID)
}

/* complete ends a broadcast, and makes sure it stops holding the stream either
 * way.
 *
 * "complete" is only reachable from "live", so a broadcast that never aired
 * cannot be completed at all. Treating that refusal as nothing to do — which is
 * what this did — leaves it sitting on the reusable stream forever, and the next
 * session is then refused the key it needs. Delete it instead: it aired nothing,
 * so there is nothing to keep, and the stream comes free. */
func (c *Client) complete(ctx context.Context, access, broadcastID string) error {
	q := url.Values{
		"id":              {broadcastID},
		"broadcastStatus": {"complete"},
		"part":            {"status"},
	}
	err := c.api(ctx, access, "POST", "/liveBroadcasts/transition?"+q.Encode(), nil, nil)
	switch {
	case err == nil, matches(err, "redundant"):
		// Ended, or enableAutoStop got there first when ingest stopped.
		return nil
	case matches(err, "invalidtransition", "invalid transition", "streaminactive"):
		return c.deleteBroadcast(ctx, access, broadcastID)
	default:
		return err
	}
}

func (c *Client) deleteBroadcast(ctx context.Context, access, broadcastID string) error {
	return c.api(ctx, access, "DELETE",
		"/liveBroadcasts?"+url.Values{"id": {broadcastID}}.Encode(), nil, nil)
}

/* releaseStream detaches the reusable stream from anything still holding it.
 *
 * YouTube assigns a stream to one unfinished broadcast at a time. A session whose
 * broadcast never reached "complete" keeps that assignment, and the next one is
 * then refused: the control room says "Stream key is currently assigned", the new
 * broadcast sits on "Preparing stream", and it does so with the encoder connected
 * and sending the entire time — which is why nothing in the ingest logs ever
 * looked wrong. One stuck broadcast blocks every session after it.
 *
 * So clear the way before each new live rather than trusting the last one to have
 * tidied up after itself. Upcoming broadcasts never aired and are deleted; an
 * active one is an earlier session still marked live and is completed. Failures
 * are ignored on purpose — this is housekeeping, and it must not be what stops a
 * host going live. */
func (c *Client) releaseStream(ctx context.Context, access, streamID string) {
	if streamID == "" {
		return
	}
	for _, status := range []string{"upcoming", "active"} {
		var out struct {
			Items []struct {
				ID             string `json:"id"`
				ContentDetails struct {
					BoundStreamID string `json:"boundStreamId"`
				} `json:"contentDetails"`
			} `json:"items"`
		}
		q := url.Values{
			"part":            {"id,contentDetails"},
			"broadcastStatus": {status},
			"broadcastType":   {"all"},
			"maxResults":      {"50"},
		}
		if err := c.api(ctx, access, "GET", "/liveBroadcasts?"+q.Encode(), nil, &out); err != nil {
			continue
		}
		for _, b := range out.Items {
			if b.ID == "" || b.ContentDetails.BoundStreamID != streamID {
				continue
			}
			if status == "upcoming" {
				_ = c.deleteBroadcast(ctx, access, b.ID)
				continue
			}
			_ = c.complete(ctx, access, b.ID)
		}
	}
}

// matches reports whether the API error mentions any of these reasons.
func matches(err error, reasons ...string) bool {
	msg := strings.ToLower(err.Error())
	for _, reason := range reasons {
		if strings.Contains(msg, reason) {
			return true
		}
	}
	return false
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
			IngestionInfo ingestionInfo `json:"ingestionInfo"`
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
	ingest, err = created.CDN.IngestionInfo.url()
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
				IngestionInfo ingestionInfo `json:"ingestionInfo"`
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
	ingest, err := out.Items[0].CDN.IngestionInfo.url()
	if err != nil {
		return "", "", err
	}
	return out.Items[0].ID, ingest, nil
}

// ingestionInfo is where YouTube puts the encoder's address and key.
type ingestionInfo struct {
	IngestionAddress string `json:"ingestionAddress"`
	// RTMPSIngestionAddress is a different host from IngestionAddress, not the
	// same one with a different scheme: a.rtmps.youtube.com on 443 against
	// a.rtmp.youtube.com on 1935.
	RTMPSIngestionAddress string `json:"rtmpsIngestionAddress"`
	StreamName            string `json:"streamName"`
}

/* url is the address LiveKit Egress should push to, key included.
 *
 * Prefer the RTMPS address YouTube gives us. Deriving one by swapping rtmp for
 * rtmps on the plain address is what the first cut did, and it produced a URL
 * pointing at a host that answers nothing on 443 — the encoder failed to
 * connect and the broadcast sat on "waiting to start" with no error anywhere a
 * host could see it. */
func (i ingestionInfo) url() (string, error) {
	address := strings.TrimRight(strings.TrimSpace(i.RTMPSIngestionAddress), "/")
	if address == "" {
		address = strings.TrimRight(strings.TrimSpace(i.IngestionAddress), "/")
	}
	name := strings.TrimSpace(i.StreamName)
	if address == "" || name == "" {
		return "", ErrLiveDisabled
	}
	return streamdest.IngestURL(name, address)
}
