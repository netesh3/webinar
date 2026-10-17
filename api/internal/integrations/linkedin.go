package integrations

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/streamdest"
	"github.com/netkumar/webcast/api/types"
)

/* LinkedIn Live.
 *
 * LinkedIn has no sign-in an app like this can use to start a live for someone
 * (its Live API is limited to approved partners), so the host saves the
 * Stream URL and Stream key LinkedIn shows them, once. From then on every
 * webinar they take live is pushed to LinkedIn automatically, from the same
 * compositor that feeds YouTube — see Server.mixDestinations. The key is
 * stored in users.linkedin_ingest and never sent back to the browser. */
func linkedinProvider(st *store.Store) Provider { return linkedin{store: st} }

type linkedin struct{ store *store.Store }

// LinkedInSaveHref is where the card's form sends the details (PUT).
const LinkedInSaveHref = "/api/host/integrations/linkedin"

var linkedinSteps = []types.IntegrationStep{
	{Title: "Open LinkedIn Live", Body: "On LinkedIn, create a Live event (Post → Event → LinkedIn Live) on your profile or page, and choose “Custom stream (RTMP)” as the streaming tool."},
	{Title: "Copy two values", Body: "LinkedIn shows a Stream URL (it begins with rtmps://) and a Stream key. Copy both."},
	{Title: "Paste them here", Body: "We save them and stream to LinkedIn every time you go live. You can pause it in any room."},
}

func (p linkedin) Status(ctx context.Context, user store.User) (types.IntegrationCard, error) {
	c := types.IntegrationCard{
		ID:       "linkedin",
		Name:     "LinkedIn Live",
		Tagline:  "Go live on your profile or page",
		Category: types.IntegrationCategoryStreaming,
		Status:   types.IntegrationStatusOff,
		Detail:   "Stream your webinar to LinkedIn at the same time, so your network can watch without registering. Save the stream key from LinkedIn once; it goes live with you automatically.",
		WhoNote:  "Paste your stream key once",
		Text:     "in",
		Tone:     "li",
		Actions: []types.IntegrationAction{{
			ID:     "setup",
			Label:  "Set up",
			Href:   LinkedInSaveHref,
			Method: "PUT",
			Kind:   types.IntegrationActionStreamKey,
			Steps:  linkedinSteps,
		}},
	}
	if p.store == nil || user.ID == "" {
		return c, nil
	}
	ingest, _, err := p.store.LinkedInDestination(ctx, user.ID)
	if err != nil || ingest == "" {
		return c, nil
	}
	c.Status = types.IntegrationStatusConnected
	c.Who = streamdest.Hint(ingest)
	c.WhoNote = "Streams automatically when you go live"
	c.Actions = []types.IntegrationAction{
		{
			ID:     "change",
			Label:  "Change key",
			Href:   LinkedInSaveHref,
			Method: "PUT",
			Kind:   types.IntegrationActionStreamKey,
			Steps:  linkedinSteps,
		},
		{
			ID:      "remove",
			Label:   "Remove",
			Href:    LinkedInSaveHref,
			Method:  "DELETE",
			Kind:    types.IntegrationActionDelete,
			Menu:    true,
			Confirm: "Your webinars will stop streaming to LinkedIn. You can add the stream key again any time.",
		},
	}
	return c, nil
}

func (linkedin) ConnectURL(context.Context, store.User) (string, error) { return "", nil }

func (p linkedin) Disconnect(ctx context.Context, user store.User) error {
	if p.store == nil {
		return nil
	}
	return p.store.SetLinkedInDestination(ctx, user.ID, "")
}
