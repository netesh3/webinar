package api

import (
	"context"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Engage is everything the webinar product tells the WhatsApp CRM, and the only way it
 * reaches it.
 *
 * The CRM lives in its own package (internal/engage) and this package does not import it.
 * The webinar side calls these methods at the moments listed below; what happens next —
 * a contact upserted, a confirmation queued, a drip enrolled — is the CRM's business. A
 * deployment with no CRM wires NoEngage and every webinar feature still works.
 *
 * Every method is fire-and-forget from the caller's point of view: the webinar action it
 * follows (a registration, an approval, the end of a session) has already committed, and
 * nothing the CRM does may turn it into a failure. Implementations log their own errors.
 *
 * The contract is written down in docs/engage/MODULES.md. Adding a method here is a
 * change to that contract, not a convenience.
 */
type Engage interface {
	/* Mount registers the CRM's HTTP routes. public carries no session (Meta's webhook);
	 * host already requires a signed-in account with the hosting capability, under /api. */
	Mount(public, host chi.Router)
	// ConnectEnabled reports whether this deployment can connect WhatsApp at all, for /config.
	ConnectEnabled() bool

	// OnRegistered follows a committed registration, pending or approved.
	OnRegistered(ctx context.Context, wb types.Webinar, reg types.Registration, whatsappOptIn bool)
	// OnRegistrationsDecided follows a batch of approve/decline decisions on one webinar.
	OnRegistrationsDecided(ctx context.Context, slug string, declinedRegistrationIDs []string)
	// OnRescheduled follows a change to a webinar's start time.
	OnRescheduled(ctx context.Context, slug string, startsAt time.Time)
	// OnEnded follows the end of a session, after attendance has its final answer.
	OnEnded(ctx context.Context, wb types.Webinar)
	// OnRecordingPublished follows a recording being made public, for a host who has replay links on.
	OnRecordingPublished(ctx context.Context, wb types.Webinar, host store.User, replayURL string)

	// DecorateRegistrants fills the CRM columns (WhatsApp status, last reply) on a roster.
	DecorateRegistrants(ctx context.Context, host store.User, slug string, rows []types.RegistrantRow)

	// Tick is the CRM's share of the 30-second sweeper: drips, bots, the WhatsApp outbox.
	Tick(ctx context.Context)
}

// NoEngage is a deployment without the CRM: no routes, no messages, no columns.
type NoEngage struct{}

func (NoEngage) Mount(chi.Router, chi.Router) {}
func (NoEngage) ConnectEnabled() bool         { return false }
func (NoEngage) OnRegistered(context.Context, types.Webinar, types.Registration, bool) {
}
func (NoEngage) OnRegistrationsDecided(context.Context, string, []string)                {}
func (NoEngage) OnRescheduled(context.Context, string, time.Time)                        {}
func (NoEngage) OnEnded(context.Context, types.Webinar)                                  {}
func (NoEngage) OnRecordingPublished(context.Context, types.Webinar, store.User, string) {}
func (NoEngage) DecorateRegistrants(context.Context, store.User, string, []types.RegistrantRow) {
}
func (NoEngage) Tick(context.Context) {}

/* UseEngage plugs the CRM in. Called once, by main (and the test harness), before Routes.
 * A nil argument means NoEngage. */
func (s *Server) UseEngage(e Engage) {
	if e == nil {
		e = NoEngage{}
	}
	s.engage = e
}
