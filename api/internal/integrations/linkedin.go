package integrations

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* LinkedIn has no OAuth grant. Connect stays a stream key the host pastes when
 * a webinar goes live, and the card says so instead of offering a sign-in that
 * does not exist. */
func linkedinProvider() Provider { return linkedin{} }

type linkedin struct{}

func (linkedin) Status(context.Context, store.User) (types.IntegrationCard, error) {
	return types.IntegrationCard{
		ID:       "linkedin",
		Name:     "LinkedIn Live",
		Tagline:  "Go live on your profile or page",
		Category: types.IntegrationCategoryStreaming,
		Status:   types.IntegrationStatusOff,
		Detail:   "Stream your webinar to LinkedIn, so your network can watch without registering. LinkedIn has not approved an app connection, so this stays a stream key you paste when you go live.",
		WhoNote:  "Paste a stream key when you go live",
		Text:     "in",
		Tone:     "li",
		Actions: []types.IntegrationAction{{
			ID:     "connect",
			Label:  "Connect",
			Kind:   types.IntegrationActionInfo,
			Detail: "LinkedIn has not approved a sign-in connection. When you go live, paste the stream key from LinkedIn Live — the same kind of key YouTube Studio gives you. Nothing on this page connects your profile.",
		}},
	}, nil
}

func (linkedin) ConnectURL(context.Context, store.User) (string, error) { return "", nil }

func (linkedin) Disconnect(context.Context, store.User) error { return ErrUnavailable }
