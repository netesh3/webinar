package integrations

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func emailInboxProvider(st *store.Store) Provider { return emailInbox{store: st} }

type emailInbox struct{ store *store.Store }

func (p emailInbox) Status(ctx context.Context, user store.User) (types.IntegrationCard, error) {
	c := types.IntegrationCard{
		ID:       "email",
		Name:     "Email",
		Tagline:  "Your reply inbox",
		Category: types.IntegrationCategoryMessaging,
		Status:   types.IntegrationStatusConnected,
		Detail:   "Replies to your webinars arrive here. Outbound mail is still sent from the shared Gmail account, with this address as Reply-To.",
		Mark:     "mail",
		Tone:     "mail",
		Actions: []types.IntegrationAction{{
			ID:    "open",
			Label: "Open inbox",
			Href:  "/host/email",
			Kind:  types.IntegrationActionNavigate,
		}},
	}
	if p.store == nil || user.ID == "" {
		c.Who = "Assigned when you open Settings"
		c.WhoNote = "You can change it once"
		return c, nil
	}
	inbox, err := p.store.EnsureInbox(ctx, user.ID, user.Name)
	if err != nil {
		return types.IntegrationCard{}, err
	}
	c.Who = inbox.Address
	if inbox.Renamed {
		c.WhoNote = "Contact support to change this address"
		if inbox.Alias != "" {
			c.Detail = "Mail to " + inbox.Alias + "@webinarliv.com still reaches you. Further changes need support."
		}
	} else {
		c.WhoNote = "You can change this address once"
	}
	return c, nil
}

func (emailInbox) ConnectURL(context.Context, store.User) (string, error) { return "", nil }

func (emailInbox) Disconnect(context.Context, store.User) error { return ErrUnavailable }
