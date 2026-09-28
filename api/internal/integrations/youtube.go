package integrations

import (
	"context"
	"net/url"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const youtubeReturn = "/settings#integrations"

/* YouTubeRevoke drops the refresh token at Google. Nil when OAuth is off. */
type YouTubeRevoke func(ctx context.Context, refresh string) error

type youtubeProvider struct {
	oauth  bool
	revoke YouTubeRevoke
	store  *store.Store
}

func (p youtubeProvider) card(user store.User) types.IntegrationCard {
	c := types.IntegrationCard{
		ID:       "youtube",
		Name:     "YouTube",
		Tagline:  "Go live on your channel too",
		Category: types.IntegrationCategoryStreaming,
		Status:   types.IntegrationStatusOff,
		Detail:   "Go live on YouTube at the same time, automatically. The watch link lands in the webinar's Recording tab.",
		Mark:     "smart_display",
		Tone:     "yt",
	}
	if user.YouTubeRefresh != "" {
		title := user.YouTubeChannelTitle
		if title == "" {
			title = "your channel"
		}
		c.Status = types.IntegrationStatusConnected
		c.Who = title
		c.WhoNote = "New lives start as Unlisted"
		c.Actions = []types.IntegrationAction{{
			ID:     "disconnect",
			Label:  "Disconnect",
			Href:   "/api/host/youtube",
			Method: "DELETE",
			Kind:   types.IntegrationActionDelete,
		}}
		return c
	}
	if p.oauth {
		c.WhoNote = "Takes about a minute"
		c.Actions = []types.IntegrationAction{{
			ID:    "connect",
			Label: "Connect",
			Href:  "/api/host/youtube/connect?return=" + url.QueryEscape(youtubeReturn),
			Kind:  types.IntegrationActionRedirect,
		}}
		return c
	}
	c.Detail = "YouTube sign-in is not set up on this instance. Paste a stream key from YouTube Studio when you go live."
	c.WhoNote = "Paste a stream key in the room"
	c.Actions = []types.IntegrationAction{{
		ID:     "info",
		Label:  "How to connect",
		Kind:   types.IntegrationActionInfo,
		Detail: "This instance has no YouTube sign-in. In the room, open Stream and paste the stream key and watch link from YouTube Studio.",
	}}
	return c
}

func (p youtubeProvider) Status(_ context.Context, user store.User) (types.IntegrationCard, error) {
	return p.card(user), nil
}

func (p youtubeProvider) ConnectURL(context.Context, store.User) (string, error) {
	if !p.oauth {
		return "", nil
	}
	return "/api/host/youtube/connect?return=" + url.QueryEscape(youtubeReturn), nil
}

func (p youtubeProvider) Disconnect(ctx context.Context, user store.User) error {
	if p.revoke != nil && user.YouTubeRefresh != "" {
		/* A revoke that fails (Google down, token already dead) must not trap
		 * the grant on our side. The existing /youtube route logs the same case. */
		_ = p.revoke(ctx, user.YouTubeRefresh)
	}
	if p.store == nil {
		return nil
	}
	return p.store.SetUserYouTube(ctx, user.ID, "", "", "", "")
}
