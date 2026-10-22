package knowledge

import (
	"regexp"
	"unicode"
)

/* ScrubPII takes email addresses and phone numbers out of a past answer before it is stored.
 *
 * A past answer is kept to ground future drafts, for every later session's audience: an
 * attendee who typed "call me on 98765 43210" into a question, or a host who answered with
 * a student's address, must not have it repeated to strangers. Only the question and the
 * answer are stored at all (never who asked); this removes what the text itself carries.
 *
 * Phones: a run of digits with the usual separators (spaces, dashes, dots, brackets, a
 * leading +) holding ten digits or more. Shorter runs are prices, years, dates and batch
 * numbers ("₹4,999", "2026-10-22", "batch 12"), which an answer needs. Longer ones are
 * account or card numbers, scrubbed as well. */

var (
	emailPattern = regexp.MustCompile(`(?i)[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,}`)
	phoneRun     = regexp.MustCompile(`\+?\(?\d[\d \t\-.()]{6,}\d`)
)

// The placeholders a scrubbed address or number becomes.
const (
	EmailPlaceholder = "[email]"
	PhonePlaceholder = "[phone]"
)

// ScrubPII is s with email addresses and phone numbers replaced by placeholders.
func ScrubPII(s string) string {
	s = emailPattern.ReplaceAllString(s, EmailPlaceholder)
	return phoneRun.ReplaceAllStringFunc(s, func(m string) string {
		digits := 0
		for _, r := range m {
			if unicode.IsDigit(r) {
				digits++
			}
		}
		if digits < 10 {
			return m
		}
		return PhonePlaceholder
	})
}
