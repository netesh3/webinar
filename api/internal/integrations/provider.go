/* Package integrations is the Settings registry: one small interface per app
 * Webinar Liv can connect, and one list the Settings page renders without
 * knowing which app is which.
 *
 * Credentials stay where they already live (users.youtube_*, users.whatsapp_*).
 * This package reads them. It does not import the CRM: WhatsApp's connect
 * dialog and the webhook unsubscribe stay in engage, and the card points at
 * those routes. */
package integrations

import (
	"context"
	"errors"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

var (
	ErrNotFound     = errors.New("unknown integration")
	ErrUnavailable  = errors.New("integration cannot do that")
	ErrManagedByCRM = errors.New("whatsapp disconnect is owned by the CRM")
)

/* Provider is one app on the Integrations page.
 *
 * Status is the card. ConnectURL is where Connect sends the browser, empty
 * when there is nothing to open. Disconnect drops a grant this package owns
 * (YouTube). WhatsApp returns ErrManagedByCRM: clearing the token without
 * unsubscribing the webhook is the CRM's job, and the card's action calls
 * that route. */
type Provider interface {
	Status(ctx context.Context, user store.User) (types.IntegrationCard, error)
	ConnectURL(ctx context.Context, user store.User) (string, error)
	Disconnect(ctx context.Context, user store.User) error
}

func unavailable(card types.IntegrationCard) Provider {
	return staticProvider{card: card}
}

type staticProvider struct {
	card     types.IntegrationCard
	interest bool
}

func (p staticProvider) Status(context.Context, store.User) (types.IntegrationCard, error) {
	c := p.card
	if p.interest {
		c.WhoNote = "We'll email you the day it's ready."
		c.Actions = []types.IntegrationAction{{
			ID:    "notify",
			Label: "Notify me",
			Kind:  types.IntegrationActionInterest,
		}}
	}
	return c, nil
}

func (p staticProvider) ConnectURL(context.Context, store.User) (string, error) {
	return "", nil
}

func (staticProvider) Disconnect(context.Context, store.User) error {
	return ErrUnavailable
}
