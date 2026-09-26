package api

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Invite mail: confirmation (or approval) plus 24h/1h reminders.
 *
 * The join URL is a bearer credential. These helpers never put it in a host-facing
 * alert, and they skip guests (no address) and declined/ended sessions.
 */

func (s *Server) enqueueApprovedInvite(
	ctx context.Context,
	wb types.Webinar,
	email, name, registrationID, joinURL string,
	kind types.NotificationKind,
) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || registrationID == "" {
		return
	}

	in := notify.Invite{
		Name:     name,
		Topic:    wb.Topic,
		WhenText: whenText(wb.StartsAt, wb.TimeZone),
		JoinURL:  joinURL,
		HostName: wb.Host.Name,
	}

	var subject, body string
	switch kind {
	case types.NotifyRegistrationConfirmed:
		subject, body = notify.RegistrationConfirmed(in)
	default:
		kind = types.NotifyRegistrationApproved
		subject, body = notify.RegistrationApproved(in)
	}

	starts, _ := time.Parse(time.RFC3339, wb.StartsAt)
	ics := notify.ICSFile(notify.CalendarEvent{
		UID:         registrationID + "@webinarliv.com",
		Title:       wb.Topic,
		Description: strings.TrimSpace(wb.Summary),
		URL:         joinURL,
		StartsAt:    starts,
		DurationMin: wb.Duration,
	})

	n := store.Notification{
		Email:          email,
		Kind:           kind,
		WebinarSlug:    wb.ID,
		Subject:        subject,
		Body:           body,
		ICS:            ics,
		RegistrationID: registrationID,
	}
	if err := s.store.Notify(ctx, s.store.DB(), n); err != nil {
		s.log.Error("notify: could not queue invite", "email", email, "kind", kind, "err", err)
		return
	}

	if wb.Options.EmailReminders {
		s.enqueueReminders(ctx, wb, email, name, registrationID, joinURL, ics, starts)
	}
}

func (s *Server) enqueueReminders(
	ctx context.Context,
	wb types.Webinar,
	email, name, registrationID, joinURL, ics string,
	starts time.Time,
) {
	if starts.IsZero() {
		return
	}
	in := notify.Invite{
		Name:     name,
		Topic:    wb.Topic,
		WhenText: whenText(wb.StartsAt, wb.TimeZone),
		JoinURL:  joinURL,
		HostName: wb.Host.Name,
	}

	now := time.Now()
	for _, offset := range wb.Options.Reminders {
		due := starts.Add(-time.Duration(offset) * time.Minute)
		if !due.After(now) {
			// Its time already passed (the webinar is soon). No "in 24 hours" mail at T-10m.
			continue
		}
		subject, body := notify.Reminder(in, notify.StartsIn(offset))
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Email:          email,
			Kind:           types.NotifyReminder,
			WebinarSlug:    wb.ID,
			Subject:        subject,
			Body:           body,
			ICS:            ics,
			RegistrationID: registrationID,
			DueAt:          due,
			OffsetMin:      offset,
		}); err != nil {
			s.log.Error("notify: could not queue reminder", "offsetMin", offset, "email", email, "err", err)
		}
	}
}

/* replanReminders applies a saved webinar's start time and reminder times to the email
 * reminders already queued, and queues the times that are new. Called after every save;
 * a save that changed neither does one UPDATE and one empty query.
 */
func (s *Server) replanReminders(ctx context.Context, wb types.Webinar) {
	starts, err := time.Parse(time.RFC3339, wb.StartsAt)
	if err != nil {
		return
	}
	offsets := wb.Options.Reminders
	if !wb.Options.EmailReminders {
		// Switched off: the sweep already holds these back, and dropping them means
		// switching back on queues them fresh with the current times.
		offsets = []int{}
	}
	if err := s.store.ReplanReminders(ctx, wb.ID, starts, offsets); err != nil {
		s.log.Warn("reminders: could not replan", "slug", wb.ID, "error", err)
		return
	}
	if len(offsets) == 0 || wb.Status == types.StatusEnded {
		return
	}
	gaps, err := s.store.ReminderGaps(ctx, wb.ID, offsets)
	if err != nil {
		s.log.Warn("reminders: could not list new times", "slug", wb.ID, "error", err)
		return
	}
	for _, g := range gaps {
		// One time at a time, through the same path registration uses, so a reminder
		// added later reads exactly like one queued at sign-up.
		one := wb
		one.Options.Reminders = []int{g.OffsetMin}
		joinURL := s.joinURLFromKey(wb.ID, g.JoinKey)
		ics := notify.ICSFile(notify.CalendarEvent{
			UID:         g.RegistrationID + "@webinarliv.com",
			Title:       wb.Topic,
			Description: strings.TrimSpace(wb.Summary),
			URL:         joinURL,
			StartsAt:    starts,
			DurationMin: wb.Duration,
		})
		s.enqueueReminders(ctx, one, g.Email, g.Name, g.RegistrationID, joinURL, ics, starts)
	}
}

func (s *Server) notifyNewRegistration(ctx context.Context, wb types.Webinar, reg types.Registration, _ bool) {
	joinURL := s.joinURLFromKey(wb.ID, reg.JoinKey)
	name := strings.TrimSpace(reg.FirstName + " " + reg.LastName)
	s.enqueueApprovedInvite(ctx, wb, reg.Email, name, reg.ID, joinURL, types.NotifyRegistrationConfirmed)
	s.flushOutbox(ctx)
}

func (s *Server) joinURLFromKey(slug, key string) string {
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	if key == "" {
		return base + "/webinars/" + slug
	}
	return base + "/webinars/" + slug + "/room?k=" + key
}
