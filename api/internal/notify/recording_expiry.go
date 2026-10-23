package notify

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

/* The host's "recordings are about to be deleted" email, 7 days and 1 day before.
 *
 * One email per host per sweep, listing every recording that reached a reminder at once,
 * each with a one-click "Keep 3 more months" link (signed for that recording, its host and
 * the expiry this email is about; the landing page needs the host signed in) and a link to
 * the recording itself. Plain text: it is a list of links, and every client renders it. */

// ExpiringItem is one recording in the email.
type ExpiringItem struct {
	Topic     string
	CreatedAt time.Time
	ExpiresAt time.Time
	SizeBytes int64
	KeepURL   string // absolute, signed
	OpenURL   string // absolute: the session's Recording tab
}

// RecordingExpiryNotice carries everything the email needs. Assembled by the caller.
type RecordingExpiryNotice struct {
	Product    string
	HostName   string
	KeepMonths int
	Items      []ExpiringItem
	// Now is when the email is written, for "in 7 days" / "tomorrow".
	Now time.Time
	// Zone is the host's IANA zone for dates; empty is UTC.
	Zone string
}

// RecordingExpiryEmail renders the email and the bell's one line.
func RecordingExpiryEmail(n RecordingExpiryNotice) (subject, text, alert string) {
	product := productName(n.Product)
	loc := eventLocation(n.Zone)
	count := len(n.Items)
	soonest := n.Items[0].ExpiresAt
	for _, it := range n.Items {
		if it.ExpiresAt.Before(soonest) {
			soonest = it.ExpiresAt
		}
	}
	when := ExpiresIn(soonest, n.Now)
	if count == 1 {
		subject = fmt.Sprintf("Your recording of %q is deleted %s", oneLine(n.Items[0].Topic), when)
		alert = fmt.Sprintf("Recording deleted %s unless you keep it longer.", when)
	} else {
		subject = fmt.Sprintf("%d of your recordings are deleted soon", count)
		alert = fmt.Sprintf("%d recordings are deleted soon (first %s) unless you keep them longer.", count, when)
	}

	var b strings.Builder
	b.WriteString(panelistGreeting(n.HostName) + "\n\n")
	if count == 1 {
		b.WriteString("This cloud recording is about to be deleted:\n\n")
	} else {
		b.WriteString("These cloud recordings are about to be deleted:\n\n")
	}
	for _, it := range n.Items {
		fmt.Fprintf(&b, "- %s (recorded %s, %s)\n  Deleted %s, on %s.\n",
			oneLine(it.Topic), it.CreatedAt.In(loc).Format("2 Jan 2006"), sizeText(it.SizeBytes),
			ExpiresIn(it.ExpiresAt, n.Now), it.ExpiresAt.In(loc).Format("Mon 2 Jan 2006"))
		fmt.Fprintf(&b, "  Keep %d more months: %s\n", n.KeepMonths, it.KeepURL)
		if it.OpenURL != "" {
			fmt.Fprintf(&b, "  Open or download it: %s\n", it.OpenURL)
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "Keeping one longer counts toward your recording storage. To let one go, do nothing, "+
		"or press \"Let it expire\" on its card and we won't remind you again.\n\n")
	b.WriteString("Thanks,\nThe " + product + " team\n")
	return subject, b.String(), alert
}

// ExpiresIn is "within 24 hours", "in 1 day" or "in N days" from now to at (nearest day).
func ExpiresIn(at, now time.Time) string {
	hours := at.Sub(now).Hours()
	if hours < 24 {
		return "within 24 hours"
	}
	days := int(hours/24 + 0.5)
	if days == 1 {
		return "in 1 day"
	}
	return "in " + strconv.Itoa(days) + " days"
}

func sizeText(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%d MB", n>>20)
	default:
		return fmt.Sprintf("%d KB", max(1, n>>10))
	}
}
