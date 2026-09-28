package integrations

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Registry is the list Settings renders, in the order the page shows them. */
type Registry struct {
	store *store.Store
	order []Provider
	byID  map[string]Provider
}

func New(st *store.Store, oauth bool, revoke YouTubeRevoke) *Registry {
	list := []Provider{
		whatsappProvider(),
		telegramProvider(),
		youtubeProvider{oauth: oauth, revoke: revoke, store: st},
		linkedinProvider(),
	}
	list = append(list, comingSoon()...)
	by := make(map[string]Provider, len(list))
	r := &Registry{store: st, order: list, byID: by}
	return r
}

func (r *Registry) index() map[string]Provider {
	if len(r.byID) == len(r.order) && len(r.byID) > 0 {
		return r.byID
	}
	for _, p := range r.order {
		card, err := p.Status(context.Background(), store.User{})
		if err != nil {
			continue
		}
		r.byID[card.ID] = p
	}
	return r.byID
}

/* List is every card for this account. Interest flags are filled from the
 * table and the "Notify me" action is dropped once they have asked. */
func (r *Registry) List(ctx context.Context, user store.User) ([]types.IntegrationCard, error) {
	var asked map[string]bool
	if r.store != nil && user.ID != "" {
		var err error
		asked, err = r.store.IntegrationInterests(ctx, user.ID)
		if err != nil {
			return nil, err
		}
	}
	out := make([]types.IntegrationCard, 0, len(r.order))
	for _, p := range r.order {
		card, err := p.Status(ctx, user)
		if err != nil {
			return nil, err
		}
		if asked[card.ID] {
			card.Interested = true
			kept := make([]types.IntegrationAction, 0, len(card.Actions))
			for _, a := range card.Actions {
				if a.Kind == types.IntegrationActionInterest {
					continue
				}
				kept = append(kept, a)
			}
			card.Actions = kept
		}
		out = append(out, card)
	}
	return out, nil
}

func (r *Registry) get(ctx context.Context, user store.User, id string) (Provider, types.IntegrationCard, error) {
	p := r.index()[id]
	if p == nil {
		return nil, types.IntegrationCard{}, ErrNotFound
	}
	card, err := p.Status(ctx, user)
	if err != nil {
		return nil, types.IntegrationCard{}, err
	}
	return p, card, nil
}

/* ConnectURL is the provider's connect target. Empty means there is nothing
 * to open (a stream-key card, or a coming-soon one). */
func (r *Registry) ConnectURL(ctx context.Context, user store.User, id string) (string, error) {
	p, _, err := r.get(ctx, user, id)
	if err != nil {
		return "", err
	}
	return p.ConnectURL(ctx, user)
}

func (r *Registry) Disconnect(ctx context.Context, user store.User, id string) error {
	p, _, err := r.get(ctx, user, id)
	if err != nil {
		return err
	}
	return p.Disconnect(ctx, user)
}

/* RecordInterest stores a "notify me" for a provider whose card offers it. */
func (r *Registry) RecordInterest(ctx context.Context, user store.User, id string) error {
	_, card, err := r.get(ctx, user, id)
	if err != nil {
		return err
	}
	ok := false
	for _, a := range card.Actions {
		if a.Kind == types.IntegrationActionInterest {
			ok = true
			break
		}
	}
	if !ok {
		return ErrUnavailable
	}
	if r.store == nil {
		return ErrUnavailable
	}
	return r.store.RecordIntegrationInterest(ctx, user.ID, id)
}
