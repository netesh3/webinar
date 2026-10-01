package integrations

import (
	"context"
	"net/url"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const zoomReturn = "/settings#integrations"

const zoomLicenseNote = "Zoom Webinars need the Webinar add-on. Meetings need a paid Zoom license."

/* ZoomHooks is how the card reads one host's connection. Lookup returns the
 * email on that host's row only. */
type ZoomHooks struct {
	Configured bool
	Lookup     func(ctx context.Context, user store.User) (email string, invalid bool, err error)
	Disconnect func(ctx context.Context, user store.User) error
}

type zoomProvider struct {
	hooks ZoomHooks
}

func (p zoomProvider) Status(ctx context.Context, user store.User) (types.IntegrationCard, error) {
	c := types.IntegrationCard{
		ID:       "zoom",
		Name:     "Zoom",
		Tagline:  "Run the session in Zoom",
		Category: types.IntegrationCategoryMeetings,
		Status:   types.IntegrationStatusOff,
		Detail:   "A host can run a webinar in Zoom. " + zoomLicenseNote,
		Mark:     "videocam",
		Tone:     "zm",
	}
	if !p.hooks.Configured {
		c.Detail = "Zoom is not configured."
		c.WhoNote = "Ask whoever runs this app to finish the Zoom app setup."
		c.Actions = []types.IntegrationAction{{
			ID:     "info",
			Label:  "Zoom is not configured",
			Kind:   types.IntegrationActionInfo,
			Detail: "Zoom is not configured on this instance, so Connect is unavailable.",
		}}
		return c, nil
	}
	var email string
	var invalid bool
	if p.hooks.Lookup != nil && user.ID != "" {
		var err error
		email, invalid, err = p.hooks.Lookup(ctx, user)
		if err != nil {
			return types.IntegrationCard{}, err
		}
	}
	if email != "" && !invalid {
		c.Status = types.IntegrationStatusConnected
		c.Who = email
		c.WhoNote = "Zoom account"
		c.Detail = zoomLicenseNote
		c.Actions = []types.IntegrationAction{{
			ID:      "disconnect",
			Label:   "Disconnect",
			Href:    "/api/host/integrations/zoom",
			Method:  "DELETE",
			Kind:    types.IntegrationActionDelete,
			Confirm: "Disconnect Zoom? Webinars already created in Zoom stay on that Zoom account.",
		}}
		return c, nil
	}
	if invalid {
		c.Warn = "Zoom needs to be connected again."
	}
	c.WhoNote = "Takes about a minute"
	c.Actions = []types.IntegrationAction{{
		ID:    "connect",
		Label: "Connect Zoom",
		Href:  "/api/host/zoom/connect?return=" + url.QueryEscape(zoomReturn),
		Kind:  types.IntegrationActionRedirect,
	}}
	return c, nil
}

func (p zoomProvider) ConnectURL(_ context.Context, user store.User) (string, error) {
	if !user.HasFeature(types.FeatureZoom) || !p.hooks.Configured {
		return "", nil
	}
	return "/api/host/zoom/connect?return=" + url.QueryEscape(zoomReturn), nil
}

func (p zoomProvider) Disconnect(ctx context.Context, user store.User) error {
	if !user.HasFeature(types.FeatureZoom) || p.hooks.Disconnect == nil {
		return ErrUnavailable
	}
	return p.hooks.Disconnect(ctx, user)
}
