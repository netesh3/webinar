package api

import (
	"context"
	"errors"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* crmHooks implements Engage with the CRM code that still lives in this package.
 *
 * Transitional: the next step moves every crm_*.go and whatsapp.go file into
 * internal/engage, and this adapter goes with them. Until then it is the single file where
 * the webinar side and the CRM side meet, which is the property the move preserves. */
type crmHooks struct{ s *Server }

func (h crmHooks) ConnectEnabled() bool { return h.s.whatsapp.Enabled() }

func (h crmHooks) Mount(public, host chi.Router) {
	s := h.s
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
func (h crmHooks) OnRegistered(ctx context.Context, wb types.Webinar, reg types.Registration, optIn bool) {
	s := h.s
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
func (h crmHooks) OnRegistrationsDecided(ctx context.Context, slug string, declined []string) {
	h.s.flushWhatsAppOutbox(ctx)
}

// OnRescheduled: the webinar store still moves both channels' reminders (split next step).
func (h crmHooks) OnRescheduled(context.Context, string, time.Time) {}

/* OnEnded starts the follow-up sequences: the `attended`, `no_show` and `ended` triggers.
 * Called for a webinar the sweeper closes on the meeting limit too, and after the room is
 * gone, so who attended has its final answer. */
func (h crmHooks) OnEnded(ctx context.Context, wb types.Webinar) {
	h.s.enrollDripsOnWebinarEnd(ctx, wb)
}

func (h crmHooks) OnRecordingPublished(ctx context.Context, wb types.Webinar, host store.User, url string) {
	h.s.enqueueWhatsAppReplay(ctx, wb, host, url)
}

/* DecorateRegistrants adds the two CRM columns to a roster. Skipped for a host who has not
 * connected WhatsApp; a failure is logged, since a roster without the columns is still the
 * roster the host asked for. */
func (h crmHooks) DecorateRegistrants(ctx context.Context, host store.User, slug string, rows []types.RegistrantRow) {
	if host.WhatsAppToken == "" {
		return
	}
	if err := h.s.store.AttachRegistrantWhatsApp(ctx, slug, rows); err != nil {
		h.s.log.Warn("registrants: whatsapp", "error", err, "slug", slug)
	}
}

/* Tick is the CRM's share of the sweeper. Drip steps are queued before the outbox is
 * flushed, so a step that came due in the last thirty seconds goes out on this tick; bots
 * go after drips so a flow that enrols somebody and then waits is not a tick behind. */
func (h crmHooks) Tick(ctx context.Context) {
	h.s.AdvanceDrips(ctx)
	h.s.AdvanceBots(ctx)
	h.s.flushWhatsAppOutbox(ctx)
}
