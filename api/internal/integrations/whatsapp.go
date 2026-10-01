package integrations

import (
	"context"
	"fmt"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const whatsappManage = "/host/crm"
const whatsappSetup = "/host/crm?view=setup"

func whatsappProvider() Provider { return whatsapp{} }

type whatsapp struct{}

func (whatsapp) Status(_ context.Context, user store.User) (types.IntegrationCard, error) {
	c := types.IntegrationCard{
		ID:       "whatsapp",
		Name:     "WhatsApp Business",
		Tagline:  "Messages to your attendees",
		Category: types.IntegrationCategoryMessaging,
		Status:   types.IntegrationStatusOff,
		Detail:   "Confirmations, reminders and follow-ups on WhatsApp, from your own business number.",
		Mark:     "chat",
		Tone:     "wa",
	}
	if user.WhatsAppToken == "" {
		c.WhoNote = "Takes about a minute"
		c.Actions = []types.IntegrationAction{{
			ID:     "connect",
			Label:  "Connect",
			Href:   whatsappSetup,
			Kind:   types.IntegrationActionSignup,
			Detail: "Meta charges each message to your WhatsApp Business account. We never charge for messages.",
			Steps: []types.IntegrationStep{
				{Title: "Sign in with Facebook", Body: "Use the Facebook account that runs your business page."},
				{Title: "Pick your number", Body: "Choose your WhatsApp Business number, or add a new one."},
				{Title: "Done", Body: "Confirmations and reminders then go from your number. The WhatsApp page finishes the connection."},
			},
		}}
		return c, nil
	}

	c.Status = types.IntegrationStatusConnected
	c.Who = user.WhatsAppDisplayPhone
	if c.Who == "" {
		c.Who = "your number"
	}
	c.WhoNote = user.WhatsAppVerifiedName
	if user.WhatsAppTokenRejectedAt != nil {
		c.Warn = "Needs reconnecting"
	} else if user.WhatsAppTokenExpiresAt != nil {
		days := int(time.Until(*user.WhatsAppTokenExpiresAt).Hours() / 24)
		if days >= 0 && days <= 60 {
			c.Warn = fmt.Sprintf("Reconnect in %d days", days)
		}
	}
	c.Actions = []types.IntegrationAction{
		/* Number & billing, where the connected number lives. /host/crm with no
		 * view is the WhatsApp page, and that page opens on Metrics. */
		{ID: "manage", Label: "Manage", Href: whatsappSetup, Kind: types.IntegrationActionNavigate},
		{ID: "open", Label: "Open the WhatsApp page", Href: whatsappManage, Kind: types.IntegrationActionNavigate, Menu: true},
		{ID: "reconnect", Label: "Reconnect now", Href: whatsappSetup, Kind: types.IntegrationActionNavigate, Menu: true},
		{
			ID:     "charges",
			Label:  "See what Meta charges",
			Kind:   types.IntegrationActionInfo,
			Menu:   true,
			Detail: "Meta charges each message to your WhatsApp Business account — about ₹0.13 each. We never charge for messages.",
		},
		{
			ID:     "disconnect",
			Label:  "Disconnect",
			Href:   "/api/host/whatsapp",
			Method: "DELETE",
			Kind:   types.IntegrationActionDelete,
			Menu:   true,
		},
	}
	return c, nil
}

func (whatsapp) ConnectURL(context.Context, store.User) (string, error) {
	return whatsappSetup, nil
}

/* Disconnect refuses. The CRM unsubscribes the webhook and then clears the
 * columns; doing only the second half here would leave Meta delivering to a
 * number we had forgotten. The card's Disconnect action calls that route. */
func (whatsapp) Disconnect(context.Context, store.User) error {
	return ErrManagedByCRM
}
