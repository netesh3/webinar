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

	slots, useSlots := s.messageSlots(ctx, wb.ID)
	sendConfirm := true
	sendReminders := wb.Options.EmailReminders
	if useSlots {
		sendConfirm = slotSends(slots, types.SlotConfirmation, types.ChannelEmail)
		sendReminders = slotSends(slots, types.SlotReminder, types.ChannelEmail)
	}
	if !sendConfirm && !sendReminders {
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

	if sendConfirm {
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
	}

	if !sendReminders {
		return
	}
	one := wb
	if useSlots {
		if rem, ok := types.FindSlot(slots, types.SlotReminder); ok {
			one.Options.Reminders = rem.BeforeMinutes()
		}
	}
	s.enqueueReminders(ctx, one, email, name, registrationID, joinURL, ics, starts)
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
	if slots, ok := s.messageSlots(ctx, wb.ID); ok {
		if rem, found := types.FindSlot(slots, types.SlotReminder); !found || !rem.Sends(types.ChannelEmail) {
			offsets = []int{}
		} else {
			offsets = rem.BeforeMinutes()
		}
	} else if !wb.Options.EmailReminders {
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

/* The panel's mail. A panelist reaches the stage by signing in at /host/<slug>/room (see
 * web/lib/access.ts, PANELIST) — the attendee link would seat them in the audience — so that
 * is the only link these carry.
 *
 * Drafts send nothing: a draft is not a commitment, and the invite goes out the first time
 * the webinar is saved as scheduled. Nothing here fails the save; errors are logged. */

func (s *Server) stageURL(slug string) string {
	return strings.TrimRight(s.cfg.WebBaseURL, "/") + "/host/" + slug + "/room"
}

func (s *Server) panelistInvite(wb types.Webinar, name string) notify.Invite {
	return notify.Invite{
		Name:     name,
		Topic:    wb.Topic,
		WhenText: whenText(wb.StartsAt, wb.TimeZone),
		HostName: wb.Host.Name,
		StageURL: s.stageURL(wb.ID),
	}
}

func (s *Server) panelistICS(wb types.Webinar, userID string) string {
	starts, err := time.Parse(time.RFC3339, wb.StartsAt)
	if err != nil {
		return ""
	}
	return notify.ICSFile(notify.CalendarEvent{
		// Stable per panelist and webinar, so a rescheduled file replaces the first one.
		UID:         "panelist-" + userID + "-" + wb.ID + "@webinarliv.com",
		Title:       wb.Topic,
		Description: strings.TrimSpace(wb.Summary),
		URL:         s.stageURL(wb.ID),
		StartsAt:    starts,
		DurationMin: wb.Duration,
	})
}

/* syncPanelistMail runs after every save. It forgets invitations to anybody no longer on
 * the panel, tells the panelists already invited when the start moved, and invites whoever
 * is new. `prevStartsAt` is the start before this save ("" on create). */
func (s *Server) syncPanelistMail(ctx context.Context, wb types.Webinar, prevStartsAt string) {
	if err := s.store.ForgetPanelistInvites(ctx, wb.ID); err != nil {
		s.log.Warn("panelist mail: could not drop removed panelists", "slug", wb.ID, "error", err)
	}
	if wb.Status != types.StatusScheduled && wb.Status != types.StatusLive {
		return
	}
	panel, err := s.store.PanelistContacts(ctx, wb.ID)
	if err != nil {
		s.log.Warn("panelist mail: could not list the panel", "slug", wb.ID, "error", err)
		return
	}
	if len(panel) == 0 {
		return
	}
	invited, err := s.store.InvitedPanelistEmails(ctx, wb.ID)
	if err != nil {
		s.log.Warn("panelist mail: could not read who is invited", "slug", wb.ID, "error", err)
		return
	}
	moved := prevStartsAt != "" && !sameInstant(prevStartsAt, wb.StartsAt)

	queued := 0
	for _, p := range panel {
		email := strings.ToLower(strings.TrimSpace(p.Email))
		kind := types.NotifyPanelistInvited
		subject, body := notify.PanelistInvited(s.panelistInvite(wb, p.Name))
		if invited[email] {
			if !moved {
				continue
			}
			kind = types.NotifyPanelistRescheduled
			subject, body = notify.PanelistRescheduled(s.panelistInvite(wb, p.Name))
		}
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Email:       email,
			Kind:        kind,
			WebinarSlug: wb.ID,
			Subject:     subject,
			Body:        body,
			ICS:         s.panelistICS(wb, p.UserID),
		}); err != nil {
			s.log.Error("panelist mail: could not queue", "slug", wb.ID, "kind", kind, "err", err)
			continue
		}
		queued++
	}
	if queued > 0 {
		s.log.Info("panelist mail queued", "slug", wb.ID, "count", queued)
		s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
	}
}

/* panelistCancellations renders the "cancelled" mail for the invited panel of a scheduled
 * webinar about to be deleted. Read before the delete (the rows cascade with it) and queued
 * after, with no webinar_id, so the outbox does not hold it back for a webinar that is gone. */
func (s *Server) panelistCancellations(ctx context.Context, slug string) []store.Notification {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil || wb.Status != types.StatusScheduled {
		return nil
	}
	panel, err := s.store.PanelistContacts(ctx, slug)
	if err != nil || len(panel) == 0 {
		return nil
	}
	invited, err := s.store.InvitedPanelistEmails(ctx, slug)
	if err != nil {
		return nil
	}
	out := []store.Notification{}
	for _, p := range panel {
		email := strings.ToLower(strings.TrimSpace(p.Email))
		if !invited[email] {
			continue
		}
		subject, body := notify.PanelistCancelled(s.panelistInvite(wb, p.Name))
		out = append(out, store.Notification{
			Email: email, Kind: types.NotifyPanelistCancelled, Subject: subject, Body: body,
		})
	}
	return out
}

func (s *Server) sendPanelistCancellations(ctx context.Context, owed []store.Notification) {
	if len(owed) == 0 {
		return
	}
	for _, n := range owed {
		if err := s.store.Notify(ctx, s.store.DB(), n); err != nil {
			s.log.Error("panelist mail: could not queue cancellation", "err", err)
		}
	}
	s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
}

func sameInstant(a, b string) bool {
	ta, errA := time.Parse(time.RFC3339, a)
	tb, errB := time.Parse(time.RFC3339, b)
	if errA != nil || errB != nil {
		return a == b
	}
	return ta.Equal(tb)
}
