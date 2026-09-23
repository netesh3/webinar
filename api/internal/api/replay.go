package api

import (
	"context"
	"strings"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Telling people the recording is up.
 *
 * Everything else in this application that sends a message is about something that has
 * not happened yet. This is the only one that fires after the event, and it was the
 * gap the CRM left: a host would record a session, publish it, and then have no way to
 * tell the four hundred people who registered — the addresses were all in the product
 * already, and the product did nothing with them.
 *
 * Two channels from one trigger, and the difference between them is the interesting
 * part. Email goes to everyone who was approved, because they gave an address in order
 * to be sent things about this webinar and this is one of them. WhatsApp goes only to
 * the subset who also gave a number, ticked the box, and whose host has chosen an
 * approved template for it — three conditions, because that message costs the host
 * money and lands on a phone.
 *
 * Sent once per person per webinar, for ever, and that is enforced in the database
 * rather than here: the dedupe indexes in 0049 cover (registration, kind) for both
 * channels, so a host who switches the recording to private and public again — or
 * publishes a second take of the same session — does not send anybody a second copy.
 */

/* maxReplayRecipients bounds one publish.
 *
 * The same order of magnitude as a broadcast and for the same reason, except that this
 * one is not the host asking to spend anything: a webinar with more registrants than
 * this is a support conversation, not a silent truncation. Logged when it bites.
 */
const maxReplayRecipients = 5000

/* enqueueReplay queues the replay message for a webinar's registrants.
 *
 * Called from the share handler, after the recording is already public. Every failure
 * in here is logged and dropped: the host pressed a switch to publish a recording, that
 * has happened, and a notification that could not be written must not report the
 * publish as a failure the host will try again.
 */
func (s *Server) enqueueReplay(ctx context.Context, slug string, rec types.Recording) {
	hostID, err := s.store.HostIDFor(ctx, slug)
	if err != nil {
		s.log.Error("replay: could not resolve host", "webinar", slug, "error", err)
		return
	}
	host, err := s.store.UserByID(ctx, hostID)
	if err != nil {
		s.log.Error("replay: could not load host", "webinar", slug, "error", err)
		return
	}
	/* The switch, checked here rather than in the handler, because this is the only
	 * thing it governs: a host without it can still publish recordings and copy the
	 * link themselves, which is what the product did before this existed. */
	if !host.HasFeature(types.FeatureReplayLinks) {
		return
	}

	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.log.Error("replay: could not load webinar", "webinar", slug, "error", err)
		return
	}
	people, err := s.store.ReplayRecipients(ctx, slug, maxReplayRecipients)
	if err != nil {
		s.log.Error("replay: could not list recipients", "webinar", slug, "error", err)
		return
	}
	if len(people) == 0 {
		return
	}
	if len(people) == maxReplayRecipients {
		// Not a failure, but the one case where somebody was left out, so it is said
		// plainly in the log rather than inferred later from a count that looks round.
		s.log.Warn("replay: recipient list truncated", "webinar", slug,
			"limit", maxReplayRecipients)
	}

	url := s.replayURL(slug, rec.ID)
	passcode := strings.TrimSpace(rec.Passcode)
	if passcode == "" {
		// The webinar's passcode protects its recordings too — see PasscodeRequired in
		// the store. A message with the wrong one of the two would be worse than none.
		passcode = strings.TrimSpace(wb.Passcode)
	}

	/* The WhatsApp half is optional and is resolved once, not per recipient: it is the
	 * same template for all of them, and a host who has not chosen one gets the email
	 * only rather than an error. */
	reminder, hasTemplate, err := s.store.ReminderTemplate(ctx, hostID, types.NotifyWhatsAppReplay)
	if err != nil {
		s.log.Error("replay: reminder template", "host", hostID, "error", err)
	}
	canWhatsApp := err == nil && hasTemplate &&
		host.WhatsAppToken != "" && host.WhatsAppPhoneNumberID != ""

	var emails, messages int
	for _, p := range people {
		in := notify.Invite{
			Name:      p.Name,
			Topic:     wb.Topic,
			WhenText:  whenText(wb.StartsAt, wb.TimeZone),
			HostName:  wb.Host.Name,
			ReplayURL: url,
			Passcode:  passcode,
		}
		subject, body := notify.ReplayReady(in)
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Email:          p.Email,
			Kind:           types.NotifyReplayReady,
			WebinarSlug:    slug,
			RegistrationID: p.RegistrationID,
			Subject:        subject,
			Body:           body,
			// No calendar attachment: there is nothing to put in a diary.
		}); err != nil {
			s.log.Error("replay: could not queue email", "webinar", slug,
				"registration", p.RegistrationID, "error", err)
		} else {
			emails++
		}

		if !canWhatsApp || p.ContactID == "" || p.Phone == "" || !p.OptIn {
			continue
		}
		/* A contact built from what the recipients query already returned, rather than
		 * loaded per person: mergeValue reads the name off it, and five thousand
		 * single-row lookups to get a name we are holding would be the whole cost of
		 * this function. */
		contact := types.CRMContact{ID: p.ContactID, Name: p.Name, Phone: p.Phone, Email: p.Email}
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Kind:             types.NotifyWhatsAppReplay,
			Channel:          "whatsapp",
			ContactID:        p.ContactID,
			WebinarSlug:      slug,
			RegistrationID:   p.RegistrationID,
			TemplateName:     reminder.Template,
			TemplateLanguage: reminder.Language,
			TemplateParams:   resolveMergeFields(reminder.Params, contact, wb, url),
		}); err != nil {
			s.log.Error("replay: could not queue whatsapp", "webinar", slug,
				"contact", p.ContactID, "error", err)
		} else {
			messages++
		}
	}

	// The URL is not logged. It is public, but it is also the thing a passcode is
	// protecting, and this line is otherwise safe to ship anywhere.
	s.log.Info("replay queued", "host", hostID, "webinar", slug, "recording", rec.ID,
		"registrants", len(people), "emails", emails, "whatsapp", messages)
}

/* replayURL is the recording's public page — the same link the host copies from the
 * recordings tab, built from the same two parts.
 *
 * Deliberately not joinURLFromKey: that one carries a registrant's access token, and
 * this one must be forwardable.
 */
func (s *Server) replayURL(slug, recordingID string) string {
	return strings.TrimRight(s.cfg.WebBaseURL, "/") + "/w/" + slug + "/recording/" + recordingID
}
