/*
Package engage is the WhatsApp CRM: contacts, threads, templates, reminders, broadcasts,
drips, bots, tags and notes, and the Meta webhook that feeds them.

It is a separate module from the webinar product (package api) and the two do not import
each other. The webinar side defines the api.Engage interface and calls it at a handful of
moments — somebody registered, a seat was decided, a webinar ended, a recording went up.
Module implements that interface, which Go checks structurally, so the only file that knows
both packages is cmd/server/main.go.

What this package may use: store (the shared Postgres handle, reading webinar tables but
writing only its own), wa (the Meta client), types (wire types), httpx, authctx, config.
The boundary is enforced by boundary_test.go and written down in docs/engage/MODULES.md.
*/
package engage

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/wa"
	"github.com/netkumar/webcast/api/types"
)

// Module is the CRM. Build one with New and hand it to api.Server.UseEngage.
type Module struct {
	cfg config.Config
	// store is the CRM's own SQL, with the core store embedded for webinar and user reads.
	store *crmstore.Store
	log   *slog.Logger
	/* whatsapp is nil unless all three META_* values are set, and the handlers say so
	 * rather than offering a Connect button that dead-ends. Every method on it tolerates a
	 * nil receiver, which is what lets the webhook and the connect endpoint check Enabled()
	 * without a separate nil test everywhere.
	 *
	 * One client for the app, not per host: it holds this deployment's Meta app
	 * credentials, while the token that actually sends belongs to each host's own WABA and
	 * is read from their user row at send time. */
	whatsapp *wa.Client
}

func New(cfg config.Config, st *store.Store, log *slog.Logger) *Module {
	var whatsapp *wa.Client
	if cfg.WhatsAppConnectEnabled() {
		whatsapp = wa.New(cfg.MetaAppID, cfg.MetaAppSecret, cfg.MetaWhatsAppConfigID)
		if cfg.WhatsAppGraphURL != "" {
			whatsapp.Graph = strings.TrimRight(cfg.WhatsAppGraphURL, "/")
		}
		// The verify token is separately optional, and its absence is the one way to end up
		// with a Connect button that works and a webhook Meta can never confirm — so it is
		// said out loud at boot rather than discovered in the app dashboard.
		if strings.TrimSpace(cfg.MetaWebhookVerifyToken) == "" {
			log.Warn("whatsapp connect enabled without META_WEBHOOK_VERIFY_TOKEN: Meta cannot verify the webhook subscription, so no inbound message or delivery status will arrive")
		}
		log.Info("whatsapp connect enabled", "graph", whatsapp.Graph)
	}
	return &Module{cfg: cfg, store: crmstore.New(st), log: log, whatsapp: whatsapp}
}

/* featureAllowed is the CRM's copy of the webinar API's per-account switch check: 403
 * rather than 404, named in the error code, because the route exists and the answer is
 * "not for this account" — which a host can ask to have changed. */
func (s *Module) featureAllowed(w http.ResponseWriter, user store.User, key string) bool {
	if user.HasFeature(key) {
		return true
	}
	label := key
	for _, f := range types.Features {
		if f.Key == key {
			label = f.Label
		}
	}
	httpx.Error(w, http.StatusForbidden, "feature_off", label+" isn't switched on for this account.")
	return false
}

/* fail logs an unexpected error and answers with the same generic 500 the webinar API
 * uses, so a client cannot tell the two modules apart by their failures. */
func (s *Module) fail(w http.ResponseWriter, r *http.Request, op string, err error) {
	s.log.Error(op, "error", err, "path", r.URL.Path)
	httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
}

func (s *Module) ConnectEnabled() bool { return s.whatsapp.Enabled() }

func (s *Module) Mount(public, host chi.Router) {
	/* Meta's webhook, and the handshake that registers it. Public like the LiveKit one:
	 * the caller is another server with no session, authenticated by a signature over the
	 * raw body in handleWhatsAppWebhook. The GET is the one-off subscription check. */
	public.Get("/webhooks/whatsapp", s.handleWhatsAppWebhookVerify)
	public.Post("/webhooks/whatsapp", s.handleWhatsAppWebhook)

	/* Connect WhatsApp. A POST callback rather than a GET one, because Embedded Signup
	 * hands the code to the page that opened the dialog instead of redirecting back here. */
	host.Get("/whatsapp/connect", s.handleWhatsAppConnect)
	host.Post("/whatsapp/callback", s.handleWhatsAppCallback)
	host.Post("/whatsapp/register", s.handleWhatsAppRegister)
	host.Delete("/whatsapp", s.handleWhatsAppDisconnect)

	/* The lead CRM. Outside the per-webinar subtree: a contact is a person, not an
	 * attendee of one session, and outlives the webinar they first registered for. */
	host.Get("/crm/setup", s.handleCRMSetup)
	host.Get("/crm/contacts", s.handleCRMContacts)
	host.Get("/crm/contacts/{id}", s.handleCRMThread)
	host.Post("/crm/contacts/{id}/opt-out", s.handleCRMOptOut)
	host.Get("/crm/templates", s.handleCRMTemplates)
	host.Post("/crm/contacts/{id}/send", s.handleCRMSend)
	host.Get("/crm/reminders", s.handleCRMReminders)
	host.Put("/crm/reminders", s.handleSetCRMReminders)
	host.Get("/crm/audience", s.handleCRMAudience)
	host.Get("/crm/broadcasts", s.handleCRMBroadcasts)
	host.Post("/crm/broadcasts", s.handleCreateCRMBroadcast)
	host.Get("/crm/broadcasts/{id}", s.handleCRMBroadcast)
	host.Post("/crm/broadcasts/{id}/cancel", s.handleCancelCRMBroadcast)
	host.Get("/crm/drips", s.handleCRMDrips)
	host.Post("/crm/drips", s.handleCreateCRMDrip)
	host.Get("/crm/drips/{id}", s.handleCRMDrip)
	host.Put("/crm/drips/{id}", s.handleUpdateCRMDrip)
	host.Delete("/crm/drips/{id}", s.handleDeleteCRMDrip)
	host.Post("/crm/drips/{id}/enrollments", s.handleEnrollCRMDrip)
	host.Delete("/crm/drips/{id}/enrollments/{enrollmentId}", s.handleRemoveCRMDripEnrollment)
	host.Get("/crm/bots", s.handleCRMBots)
	host.Post("/crm/bots", s.handleCreateCRMBot)
	host.Get("/crm/bots/{id}", s.handleCRMBot)
	host.Put("/crm/bots/{id}", s.handleUpdateCRMBot)
	host.Delete("/crm/bots/{id}", s.handleDeleteCRMBot)
	host.Put("/crm/contacts/{id}/bot", s.handleCRMContactBot)
	host.Get("/crm/tags", s.handleCRMTags)
	host.Post("/crm/tags", s.handleCreateCRMTag)
	host.Patch("/crm/tags/{id}", s.handleRenameCRMTag)
	host.Delete("/crm/tags/{id}", s.handleDeleteCRMTag)
	host.Post("/crm/contacts/{id}/tags", s.handleAddCRMContactTag)
	host.Delete("/crm/contacts/{id}/tags/{tagId}", s.handleRemoveCRMContactTag)
	host.Get("/crm/contacts/{id}/notes", s.handleCRMNotes)
	host.Post("/crm/contacts/{id}/notes", s.handleCreateCRMNote)
	host.Delete("/crm/notes/{id}", s.handleDeleteCRMNote)
}

/* OnRegistered files a registrant in the host's CRM.
 *
 * After the registration is committed rather than inside it: a CRM the host may not even
 * have looked at yet must not be able to fail somebody's registration. Done on every
 * registration and not only on approval — a lead waiting for a manual approval is still
 * a lead. ErrNotFound is the documented answer for a registrant with neither a phone nor
 * an email (a guest) and is not logged as a problem.
 */
func (s *Module) OnRegistered(ctx context.Context, wb types.Webinar, reg types.Registration, optIn bool) {
	contact, err := s.store.ContactFromRegistration(ctx, wb.ID, reg, optIn)
	if errors.Is(err, store.ErrNotFound) {
		return
	}
	if err != nil {
		s.log.Error("crm contact from registration", "error", err, "webinar", wb.ID)
		return
	}
	s.log.Info("crm contact", "webinar", wb.ID, "contact", contact.ID,
		"whatsapp_opt_in", contact.WhatsAppOptIn)

	/* Queue their WhatsApp messages, including for a pending registration: the outbox
	 * sweep requires an approved registration, so the confirmation waits for the host's
	 * decision. A declined seat retires the rows instead (OnRegistrationsDecided). */
	s.enqueueWhatsAppInvite(ctx, wb, contact, reg.ID)
	// The `registered` drip trigger. Nothing is sent here; the next sweep queues step one.
	s.enrollDripsOnRegistration(ctx, wb, contact)
	// Sent now rather than on the next tick: a confirmation half a minute late reads as unsure.
	s.flushWhatsAppOutbox(ctx)
}

/* OnRegistrationsDecided is the WhatsApp side of an approval batch. A confirmation queued
 * at registration is held until the seat is approved, so this press is the moment it
 * becomes sendable — waiting for the ticker would make the fastest channel the slowest. */
func (s *Module) OnRegistrationsDecided(ctx context.Context, slug string, declined []string) {
	/* A declined seat's WhatsApp confirmation and reminders are retired first, so the
	 * flush below cannot send them. */
	if err := s.store.SkipWhatsAppForRegistrations(ctx, declined); err != nil {
		s.log.Warn("crm: could not skip whatsapp for declined", "slug", slug, "error", err)
	}
	s.flushWhatsAppOutbox(ctx)
}

// OnRescheduled moves the WhatsApp 24h/1h reminders with the webinar, as the webinar side moves the email ones.
func (s *Module) OnRescheduled(ctx context.Context, slug string, startsAt time.Time) {
	if err := s.store.RescheduleWhatsAppReminders(ctx, slug, startsAt); err != nil {
		s.log.Warn("crm: could not reschedule whatsapp reminders", "slug", slug, "error", err)
	}
}

/* OnEnded retires the WhatsApp reminders for a session that is over, then starts the
 * follow-up sequences: the `attended`, `no_show` and `ended` triggers. Called for a
 * webinar the sweeper closes on the meeting limit too, and after the room is gone, so who
 * attended has its final answer. */
func (s *Module) OnEnded(ctx context.Context, wb types.Webinar) {
	if err := s.store.SkipWhatsAppForEndedWebinar(ctx, wb.ID); err != nil {
		s.log.Warn("crm: could not skip whatsapp for ended webinar", "slug", wb.ID, "error", err)
	}
	s.enrollDripsOnWebinarEnd(ctx, wb)
}

func (s *Module) OnRecordingPublished(ctx context.Context, wb types.Webinar, host store.User, url string) {
	s.enqueueWhatsAppReplay(ctx, wb, host, url)
}

/* DecorateRegistrants adds the two CRM columns to a roster. Skipped for a host who has not
 * connected WhatsApp; a failure is logged, since a roster without the columns is still the
 * roster the host asked for. */
func (s *Module) DecorateRegistrants(ctx context.Context, host store.User, slug string, rows []types.RegistrantRow) {
	if host.WhatsAppToken == "" {
		return
	}
	if err := s.store.AttachRegistrantWhatsApp(ctx, slug, rows); err != nil {
		s.log.Warn("registrants: whatsapp", "error", err, "slug", slug)
	}
}

/* Tick is the CRM's share of the sweeper. Drip steps are queued before the outbox is
 * flushed, so a step that came due in the last thirty seconds goes out on this tick; bots
 * go after drips so a flow that enrols somebody and then waits is not a tick behind. */
func (s *Module) Tick(ctx context.Context) {
	s.AdvanceDrips(ctx)
	s.AdvanceBots(ctx)
	s.flushWhatsAppOutbox(ctx)
}
