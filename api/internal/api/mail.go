package api

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
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
		subject, body = s.registrantMail(ctx, wb.Host.ID, notify.TplRegistrationConfirmed, in, "", func() (string, string) {
			return notify.RegistrationConfirmed(in)
		})
	default:
		kind = types.NotifyRegistrationApproved
		subject, body = s.registrantMail(ctx, wb.Host.ID, notify.TplRegistrationApproved, in, "", func() (string, string) {
			return notify.RegistrationApproved(in)
		})
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
		window := notify.StartsIn(offset)
		subject, body := s.registrantMail(ctx, wb.Host.ID, notify.TplReminder, in, window, func() (string, string) {
			return notify.Reminder(in, window)
		})
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
		joinURL := s.messageJoinURL(ctx, wb, g.RegistrationID, g.JoinKey)
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

func (s *Server) messageJoinURL(ctx context.Context, wb types.Webinar, registrationID, key string) string {
	if zoom.IsVenue(wb.Venue) && registrationID != "" {
		if u, err := s.store.RegistrationZoomJoin(ctx, registrationID); err == nil && u != "" {
			return u
		}
	}
	if key != "" {
		return s.joinURLFromKey(wb.ID, key)
	}
	return s.joinURLFor(ctx, wb.ID, registrationID)
}

func (s *Server) notifyNewRegistration(ctx context.Context, wb types.Webinar, reg types.Registration, _ bool) {
	joinURL := s.messageJoinURL(ctx, wb, reg.ID, reg.JoinKey)
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

/* panelistWhen is the panelist mails' own time format (notify.EventTime): day, start–end
 * with the GMT offset, and the length. "" when the start does not parse. */
func panelistWhen(startsAt string, durationMin int, zone string) string {
	at, err := time.Parse(time.RFC3339, startsAt)
	if err != nil {
		return ""
	}
	return notify.EventTime(at, durationMin, zone)
}

func (s *Server) panelistInvite(wb types.Webinar, p store.PanelistContact, calendar bool) notify.Invite {
	name := p.Name
	/* An account with no profile name carries its address's local part as one (see the
	 * welcome email). "Hi priya.s92," reads like a broken mail merge. */
	if local, _, ok := strings.Cut(strings.TrimSpace(p.Email), "@"); ok &&
		strings.EqualFold(strings.TrimSpace(name), local) {
		name = ""
	}
	return notify.Invite{
		Name:     name,
		Topic:    wb.Topic,
		WhenText: panelistWhen(wb.StartsAt, wb.Duration, wb.TimeZone),
		HostName: wb.Host.Name,
		StageURL: s.stageURL(wb.ID),
		Email:    strings.ToLower(strings.TrimSpace(p.Email)),
		Product:  s.cfg.AppName,
		Calendar: calendar,
	}
}

/* calendarSequence is the SEQUENCE for a panelist's calendar file: seconds since 2024, at
 * the moment the file is written. A calendar replaces an event it already holds only for a
 * higher SEQUENCE, and every panelist file is written in response to a save or a delete
 * that happened after the one before it, so the clock is the version counter — without a
 * column to keep in step. Seconds since 2024 rather than since 1970 keeps it well inside
 * the 32-bit integer some clients parse it into. */
func calendarSequence(now time.Time) int {
	const epoch2024 = 1704067200
	n := int(now.Unix() - epoch2024)
	if n < 0 {
		n = 0
	}
	// Two saves inside one second still get increasing numbers from this process.
	sequenceMu.Lock()
	defer sequenceMu.Unlock()
	if n <= lastSequence {
		n = lastSequence + 1
	}
	lastSequence = n
	return n
}

var (
	sequenceMu   sync.Mutex
	lastSequence int
)

// panelistOrganizer is the host's name and account address, for the file's ORGANIZER.
func (s *Server) panelistOrganizer(ctx context.Context, wb types.Webinar) (name, email string) {
	if wb.Host.ID == "" {
		return "", ""
	}
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil {
		return "", ""
	}
	return strings.TrimSpace(wb.Host.Name), strings.ToLower(strings.TrimSpace(host.Email))
}

func (s *Server) panelistICS(ctx context.Context, wb types.Webinar, p store.PanelistContact, cancelled bool) string {
	starts, err := time.Parse(time.RFC3339, wb.StartsAt)
	if err != nil {
		return ""
	}
	orgName, orgEmail := s.panelistOrganizer(ctx, wb)
	return notify.ICSFile(notify.CalendarEvent{
		// Stable per panelist and webinar, so a rescheduled or cancelled file replaces the first one.
		UID:            "panelist-" + p.UserID + "-" + wb.ID + "@webinarliv.com",
		Sequence:       calendarSequence(time.Now()),
		Cancelled:      cancelled,
		Title:          wb.Topic,
		Description:    strings.TrimSpace(wb.Summary),
		URL:            s.stageURL(wb.ID),
		StartsAt:       starts,
		DurationMin:    wb.Duration,
		OrganizerName:  orgName,
		OrganizerEmail: orgEmail,
		AttendeeName:   strings.TrimSpace(p.Name),
		AttendeeEmail:  strings.ToLower(strings.TrimSpace(p.Email)),
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
		ics := s.panelistICS(ctx, wb, p, false)
		in := s.panelistInvite(wb, p, ics != "")
		kind := types.NotifyPanelistInvited
		if invited[email] {
			if !moved {
				continue
			}
			kind = types.NotifyPanelistRescheduled
		}
		var subject, text, html string
		if kind == types.NotifyPanelistRescheduled {
			if prev, err := time.Parse(time.RFC3339, prevStartsAt); err == nil {
				in.WasText = notify.EventStart(prev, wb.TimeZone)
			}
			subject, text, html = s.panelistMail(ctx, wb.Host.ID, notify.TplPanelistRescheduled, in, func() (string, string, string) {
				return notify.PanelistRescheduled(in)
			})
		} else {
			subject, text, html = s.panelistMail(ctx, wb.Host.ID, notify.TplPanelistInvited, in, func() (string, string, string) {
				return notify.PanelistInvited(in)
			})
		}
		if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
			Email:       email,
			Kind:        kind,
			WebinarSlug: wb.ID,
			Subject:     subject,
			Body:        text,
			HTML:        html,
			ICS:         ics,
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
		ics := s.panelistICS(ctx, wb, p, true)
		in := s.panelistInvite(wb, p, ics != "")
		subject, text, html := s.panelistMail(ctx, wb.Host.ID, notify.TplPanelistCancelled, in, func() (string, string, string) {
			return notify.PanelistCancelled(in)
		})
		out = append(out, store.Notification{
			Email: email, Kind: types.NotifyPanelistCancelled, Subject: subject, Body: text,
			HTML: html, ICS: ics,
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
