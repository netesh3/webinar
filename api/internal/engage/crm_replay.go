package engage

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* enqueueWhatsAppReplay is the WhatsApp half of "the recording is up".
 *
 * The email half is the webinar product's own (see enqueueReplay); this one goes only to
 * registrants who gave a number, ticked the box, and whose host has chosen an approved
 * template for it — three conditions, because the message costs the host money and lands
 * on a phone. Once per person per webinar for ever, enforced by the 0049 dedupe index on
 * (registration, kind). Every failure is logged and dropped.
 */
// maxReplayRecipients matches the email side's cap: one webinar's registrants, not a mailing list.
const maxReplayRecipients = 5000

func (s *Module) enqueueWhatsAppReplay(ctx context.Context, wb types.Webinar, host store.User, url string) {
	if host.WhatsAppToken == "" || host.WhatsAppPhoneNumberID == "" {
		return
	}
	reminder, hasTemplate, err := s.store.ReminderTemplate(ctx, host.ID, types.NotifyWhatsAppReplay)
	if err != nil {
		s.log.Error("replay: reminder template", "host", host.ID, "error", err)
		return
	}
	if !hasTemplate {
		return
	}
	people, err := s.store.WhatsAppReplayRecipients(ctx, wb.ID, maxReplayRecipients)
	if err != nil {
		s.log.Error("replay: could not list whatsapp recipients", "webinar", wb.ID, "error", err)
		return
	}

	var messages int
	for _, p := range people {
		if p.Phone == "" || !p.OptIn {
			continue
		}
		/* A contact built from what the recipients query already returned, rather than
		 * loaded per person: mergeValue reads the name off it, and five thousand single-row
		 * lookups to get a name we are holding would be the whole cost of this function. */
		contact := types.CRMContact{ID: p.ContactID, Name: p.Name, Phone: p.Phone, Email: p.Email}
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Kind:             types.NotifyWhatsAppReplay,
			Channel:          "whatsapp",
			ContactID:        p.ContactID,
			WebinarSlug:      wb.ID,
			RegistrationID:   p.RegistrationID,
			TemplateName:     reminder.Template,
			TemplateLanguage: reminder.Language,
			TemplateParams:   resolveMergeFields(reminder.Params, contact, wb, url),
		}); err != nil {
			s.log.Error("replay: could not queue whatsapp", "webinar", wb.ID,
				"contact", p.ContactID, "error", err)
		} else {
			messages++
		}
	}
	s.log.Info("replay whatsapp queued", "host", host.ID, "webinar", wb.ID, "whatsapp", messages)
}
