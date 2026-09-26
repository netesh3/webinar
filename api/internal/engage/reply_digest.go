package engage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/notify"
)

/* The coach's email about WhatsApp replies waiting.
 *
 * A coach is not watching the Messages tab. So when somebody writes in, the coach gets
 * one email — after the conversation has been quiet for a few minutes, so a burst of
 * five messages is one email, and at most once an hour. The email is a pointer, not the
 * conversation: names and a count, and a link to the inbox.
 *
 * Run from Tick, under its own lease, so two instances do not both send it.
 */

const (
	replyDigestQuiet = 5 * time.Minute
	replyDigestEvery = time.Hour
)

// UseMail gives the module a way to email hosts. Without it the digest is skipped.
func (s *Module) UseMail(t notify.Transport) { s.mail = t }

func (s *Module) sendReplyDigests(ctx context.Context) {
	if s.mail == nil || !s.mail.Configured() {
		return
	}
	release, ok, err := s.store.TryLease(ctx, "reply-digest", 2*time.Minute)
	if err != nil || !ok {
		if err != nil {
			s.log.Error("reply digest: lease", "error", err)
		}
		return
	}
	defer release()
	due, err := s.store.ReplyDigestsDue(ctx, replyDigestQuiet, replyDigestEvery)
	if err != nil {
		s.log.Error("reply digest: due", "error", err)
		return
	}
	for _, d := range due {
		// Marked first: an email that fails is one missed nudge, while one that
		// succeeds and is not marked is sent again every minute.
		if err := s.store.MarkReplyDigestSent(ctx, d.HostID); err != nil {
			s.log.Error("reply digest: mark", "error", err, "host", d.HostID)
			continue
		}
		if err := s.mail.Send(ctx, replyDigestMessage(d.Email, d.Waiting, d.Names, s.cfg.WebBaseURL)); err != nil {
			s.log.Warn("reply digest: send", "error", err, "host", d.HostID)
			continue
		}
		s.log.Info("reply digest sent", "host", d.HostID, "waiting", d.Waiting)
	}
}

func replyDigestMessage(to string, waiting int, names []string, web string) notify.Message {
	who := strings.Join(names, ", ")
	if waiting > len(names) {
		who += fmt.Sprintf(" and %d more", waiting-len(names))
	}
	subject := "1 WhatsApp reply waiting"
	if waiting != 1 {
		subject = fmt.Sprintf("%d WhatsApp replies waiting", waiting)
	}
	body := fmt.Sprintf("%s wrote to you on WhatsApp.\n\nReply here: %s/host?tab=messages\n\n"+
		"WhatsApp lets you reply in your own words for 24 hours after their last message.\n",
		who, strings.TrimRight(web, "/"))
	return notify.Message{To: to, Subject: subject, Body: body}
}
