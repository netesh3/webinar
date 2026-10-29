package notify

import (
	"strings"

	"github.com/netkumar/webcast/api/types"
)

/* Reply-To by category, so a reply to platform mail reaches the inbox that answers
 * it. From never changes: it stays SMTP_FROM (noreply@webinarliv.com), and these are
 * only the Reply-To header. (29 Oct 2026)
 *
 *	invite@    panelist invites, reschedules and cancellations, and the event mail an
 *	           attendee gets on a host's behalf (confirmation, approval, decline,
 *	           reminders, replay), when the host has no inbox address of their own
 *	support@   everything else: welcome, email verification, password reset (people
 *	           reply asking for help), the host's alerts, recaps and expiry notices
 *	billing@   billing mail. The API sends none today: Razorpay sends receipts and
 *	           payment retries itself. A billing kind added later goes in ReplyToCategory.
 *	security@  true security alerts (a new sign-in, a changed password). None are sent
 *	           yet; password reset is support@ on purpose.
 *
 * A Reply-To someone chose wins over all of these: a row's own reply_to (a hosting
 * request, a sales reply), and the host's inbox on mail the host is sending through us.
 */

/* ReplyToCategory is the platform's Reply-To for a kind of notification, with
 * nobody's own address in the way. */
func ReplyToCategory(kind types.NotificationKind) string {
	if SentForHost(kind) {
		return types.ContactInvite
	}
	return types.ContactSupport
}

/* SentForHost is mail a host is sending to their people through us: the replies
 * belong to the host, so their inbox (InboxAddress) is the Reply-To when they have
 * one. Mail to the host themselves (a recap, an approval request) is not: a host
 * replying to it is talking to us. */
func SentForHost(kind types.NotificationKind) bool {
	switch kind {
	case types.NotifyRegistrationApproved, types.NotifyRegistrationDeclined,
		types.NotifyRegistrationConfirmed, types.NotifyReminder, types.NotifyReplayReady,
		types.NotifyPanelistInvited, types.NotifyPanelistRescheduled, types.NotifyPanelistCancelled:
		return true
	}
	return false
}

/* ReplyToFor is the Reply-To the outbox sends a row with. A reply_to on the row
 * comes first, then the host's inbox on mail sent for the host, then the
 * platform's category address. */
func ReplyToFor(kind types.NotificationKind, rowReplyTo, hostInboxLocal string) string {
	if r := strings.TrimSpace(rowReplyTo); r != "" {
		return r
	}
	if SentForHost(kind) {
		if inbox := InboxAddress(hostInboxLocal); inbox != "" {
			return inbox
		}
	}
	return ReplyToCategory(kind)
}
