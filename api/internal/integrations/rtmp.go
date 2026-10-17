package integrations

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/streamdest"
	"github.com/netkumar/webcast/api/types"
)

/* Live streaming to platforms that hand out an RTMP Stream URL and key:
 * LinkedIn Live, Instagram Live and Facebook Live.
 *
 * None of them offers this app a sign-in that could start a live for the host
 * (their live APIs are limited to approved partners), so the host pastes the
 * two values the platform shows. They are saved on the account
 * (store.StreamDestination), and every webinar the host takes live pushes the
 * mix to each saved platform from the compositor already encoding it — see
 * Server.mixDestinations. The key never goes back to the browser.
 *
 * Every platform still wants Go live pressed on its own side once the preview
 * arrives; nothing here can do that. */

// RTMPPlatform is one such destination.
type RTMPPlatform struct {
	// ID names the store columns and the room routes (/webinars/{slug}/{ID}).
	ID string
	// CardID is the Settings card, and the save route
	// (/api/host/integrations/{CardID}). Differs from ID only for Instagram,
	// whose "instagram" card is the coming-soon messaging one.
	CardID  string
	Name    string
	Tagline string
	Detail  string
	Text    string
	Tone    string
	Steps   []types.IntegrationStep
}

// SaveHref is where the card's form sends the Stream URL and key (PUT).
func (p RTMPPlatform) SaveHref() string { return "/api/host/integrations/" + p.CardID }

// RTMPPlatforms is every RTMP destination, in the order the room and Settings show them.
var RTMPPlatforms = []RTMPPlatform{
	{
		ID: "linkedin", CardID: "linkedin", Name: "LinkedIn Live",
		Tagline: "Go live on your profile or page",
		Detail:  "Stream your webinar to LinkedIn at the same time, so your network can watch without registering. Paste the stream key from LinkedIn; it goes live with you automatically.",
		Text:    "in", Tone: "li",
		Steps: []types.IntegrationStep{
			{Title: "Open LinkedIn Live", Body: "On LinkedIn, create a Live event on your profile or page (Post → Event → LinkedIn Live), then in Live Studio click “Prepare to go live”."},
			{Title: "Copy two values", Body: "Pick your region and click Get URL. Copy the Stream URL (it begins with rtmps://) and the Stream key."},
			{Title: "Paste, then Go live", Body: "Paste them here. When the preview shows in Live Studio, click Go live there. LinkedIn usually gives a new key for each event."},
		},
	},
	{
		ID: "instagram", CardID: "instagram-live", Name: "Instagram Live",
		Tagline: "Go live on your Instagram",
		Detail:  "Stream your webinar to Instagram Live at the same time. Needs a Professional (Creator or Business) account. Instagram shows landscape video with bars above and below.",
		Text:    "IG", Tone: "ig",
		Steps: []types.IntegrationStep{
			{Title: "Start a live on desktop", Body: "On instagram.com on a computer, click Create (+) → Live video, add a title and audience, then click Next."},
			{Title: "Copy two values", Body: "Instagram shows a Stream URL and a Stream key. Copy both. The key changes for every new Instagram Live."},
			{Title: "Paste, then Go live", Body: "Paste them here. When the preview shows on Instagram, click Go live there. Instagram Live can run up to 4 hours."},
		},
	},
	{
		ID: "facebook", CardID: "facebook-live", Name: "Facebook Live",
		Tagline: "Go live on your profile, page or group",
		Detail:  "Stream your webinar to Facebook at the same time. Use a persistent stream key in Facebook's Live Producer and you only paste it once.",
		Text:    "f", Tone: "fb",
		Steps: []types.IntegrationStep{
			{Title: "Open Live Producer", Body: "Go to facebook.com/live/producer, choose where to post (profile, page or group), and pick “Streaming software” as the video source."},
			{Title: "Copy two values", Body: "Copy the Server URL (rtmps://live-api-s.facebook.com:443/rtmp/) and the Stream key. Turn on “Use a persistent stream key” to reuse it."},
			{Title: "Paste, then Go live", Body: "Paste them here. When the preview shows in Live Producer, click Go live there."},
		},
	},
}

// RTMPPlatformByID finds a platform by ID or CardID.
func RTMPPlatformByID(id string) (RTMPPlatform, bool) {
	for _, p := range RTMPPlatforms {
		if p.ID == id || p.CardID == id {
			return p, true
		}
	}
	return RTMPPlatform{}, false
}

func rtmpProvider(st *store.Store, p RTMPPlatform) Provider { return rtmpCard{store: st, p: p} }

type rtmpCard struct {
	store *store.Store
	p     RTMPPlatform
}

func (c rtmpCard) Status(ctx context.Context, user store.User) (types.IntegrationCard, error) {
	card := types.IntegrationCard{
		ID:       c.p.CardID,
		Name:     c.p.Name,
		Tagline:  c.p.Tagline,
		Category: types.IntegrationCategoryStreaming,
		Status:   types.IntegrationStatusOff,
		Detail:   c.p.Detail + " Paste the stream key once you have it.",
		WhoNote:  "Paste a stream key",
		Text:     c.p.Text,
		Tone:     c.p.Tone,
		Actions: []types.IntegrationAction{{
			ID: "setup", Label: "Set up", Href: c.p.SaveHref(), Method: "PUT",
			Kind: types.IntegrationActionStreamKey, Steps: c.p.Steps,
		}},
	}
	if c.store == nil || user.ID == "" {
		return card, nil
	}
	ingest, _, err := c.store.StreamDestination(ctx, user.ID, c.p.ID)
	if err != nil || ingest == "" {
		return card, nil
	}
	card.Status = types.IntegrationStatusConnected
	card.Detail = c.p.Detail
	card.Who = streamdest.Hint(ingest)
	card.WhoNote = "Streams automatically when you go live"
	card.Actions = []types.IntegrationAction{
		{
			ID: "change", Label: "Change key", Href: c.p.SaveHref(), Method: "PUT",
			Kind: types.IntegrationActionStreamKey, Steps: c.p.Steps,
		},
		{
			ID: "remove", Label: "Remove", Href: c.p.SaveHref(), Method: "DELETE",
			Kind: types.IntegrationActionDelete, Menu: true,
			Confirm: "Your webinars will stop streaming to " + c.p.Name + ". You can add the stream key again any time.",
		},
	}
	return card, nil
}

func (rtmpCard) ConnectURL(context.Context, store.User) (string, error) { return "", nil }

func (c rtmpCard) Disconnect(ctx context.Context, user store.User) error {
	if c.store == nil {
		return nil
	}
	return c.store.SetStreamDestination(ctx, user.ID, c.p.ID, "")
}
