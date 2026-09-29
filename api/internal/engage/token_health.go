package engage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/notify"
)

/* Keeping WhatsApp connections healthy without waiting for a send to fail.
 *
 * Meta's Embedded Signup tokens have no refresh: a business token either never
 * expires (the normal setup) or lasts 60 days, and the only way to a new one is the
 * host signing in through the dialog again. So there is nothing to renew here — what
 * this does is notice early:
 *
 *   - once a day per host, ask Meta (/debug_token) whether the token still works.
 *     A dead one is marked, and Account settings shows Reconnect before tomorrow's
 *     reminders fail rather than after.
 *   - a token that does expire gets one email a week ahead, and the account shows
 *     the date.
 *
 * Run from Tick under its own lease. Cheap: one Graph call per host per day.
 */

const (
	tokenCheckEvery  = 24 * time.Hour
	tokenCheckBatch  = 50
	tokenExpiryAhead = 7 * 24 * time.Hour
)

func (s *Module) checkWhatsAppTokens(ctx context.Context) {
	if !s.whatsapp.Enabled() {
		return
	}
	release, ok, err := s.store.TryLease(ctx, "whatsapp-token-check", 5*time.Minute)
	if err != nil || !ok {
		if err != nil {
			s.log.Error("whatsapp token check: lease", "error", err)
		}
		return
	}
	defer release()

	due, err := s.store.TokensDueCheck(ctx, tokenCheckEvery, tokenCheckBatch)
	if err != nil {
		s.log.Error("whatsapp token check: due", "error", err)
		return
	}
	for _, h := range due {
		s.checkOneToken(ctx, h, time.Now())
	}
}

func (s *Module) checkOneToken(ctx context.Context, h crmstore.TokenCheck, now time.Time) {
	health, err := s.whatsapp.CheckToken(ctx, h.Token)
	if err != nil {
		// Meta unreachable, or the app's own credentials refused: not this host's
		// problem, and not a reason to tell them to reconnect. Tried again next tick.
		s.log.Warn("whatsapp token check failed", "host", h.HostID, "error", err)
		return
	}
	if !health.Valid {
		s.log.Warn("whatsapp token invalid: host must reconnect", "host", h.HostID, "reason", health.Reason)
		if err := s.store.MarkWhatsAppTokenRejected(ctx, h.HostID, h.Token); err != nil {
			s.log.Error("whatsapp token check: mark rejected", "host", h.HostID, "error", err)
		}
		// Recorded as checked too, so it is not asked again every minute.
		_ = s.store.RecordTokenCheck(ctx, h.HostID, h.Token, h.ExpiresAt)
		return
	}

	var expires *time.Time
	if !health.ExpiresAt.IsZero() {
		e := health.ExpiresAt
		expires = &e
	}
	if err := s.store.RecordTokenCheck(ctx, h.HostID, h.Token, expires); err != nil {
		s.log.Error("whatsapp token check: record", "host", h.HostID, "error", err)
		return
	}
	if expires == nil || h.Warned || expires.Sub(now) > tokenExpiryAhead {
		return
	}
	if s.mail == nil || !s.mail.Configured() {
		return
	}
	// Marked first, as with the reply digest: one missed warning beats one a day.
	if err := s.store.MarkExpiryWarned(ctx, h.HostID, h.Token); err != nil {
		s.log.Error("whatsapp token check: mark warned", "host", h.HostID, "error", err)
		return
	}
	if err := s.mail.Send(ctx, tokenExpiryMessage(h.Email, *expires, s.cfg.WebBaseURL)); err != nil {
		s.log.Warn("whatsapp expiry email", "host", h.HostID, "error", err)
	}
}

func tokenExpiryMessage(to string, expires time.Time, web string) notify.Message {
	day := expires.UTC().Format("Mon 2 Jan")
	body := fmt.Sprintf("Your WhatsApp connection stops working on %s. Meta issues these for a "+
		"limited time and they can't be renewed automatically — after that date, no "+
		"confirmations, reminders or follow-ups will send.\n\n"+
		"Reconnect now (takes a minute, same number, nothing is lost):\n%s/settings#integrations\n",
		day, strings.TrimRight(web, "/"))
	return notify.Message{
		To:      to,
		Subject: "Reconnect WhatsApp before " + day,
		Body:    body,
	}
}
