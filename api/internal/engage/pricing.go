package engage

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/netkumar/webcast/api/types"
)

/* Per-country Meta rates, in millionths of a rupee (1_000_000 = ₹1).
 *
 * Meta's status webhook names a category and, usually, not an amount. The page
 * still has to show a cost, so a missing amount is filled from this table and
 * labelled "about". An amount Meta did send is stored as-is and is not an
 * estimate. Rates are one currency so they can be summed; operators who bill
 * in something else override WHATSAPP_RATES.
 */

// RateTable keys are "CC:category" (IN:utility) and a country fallback "CC".
type RateTable map[string]int64

// DefaultRates is India's Meta card, in rupee micros, when this was written.
func DefaultRates() RateTable {
	return RateTable{
		"IN:utility":        130_000, // ₹0.13
		"IN:marketing":      780_000, // ₹0.78
		"IN:authentication": 130_000,
		"IN:service":        0,
		"IN:referral":       0,
		"IN":                130_000,
	}
}

/* ParseRates reads WHATSAPP_RATES.
 *
 * Each entry is CC:category=micros or CC=micros, comma-separated. Entries
 * replace the built-in value for that key; everything else stays. An empty
 * string is the built-in table. A bad entry is an error so a typo is not
 * silently billed at the wrong rate.
 */
func ParseRates(raw string) (RateTable, error) {
	out := DefaultRates()
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return out, nil
	}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, val, ok := strings.Cut(part, "=")
		if !ok {
			return nil, fmt.Errorf("WHATSAPP_RATES entry %q needs key=micros", part)
		}
		key = strings.ToUpper(strings.TrimSpace(key))
		cc, cat, hasCat := strings.Cut(key, ":")
		if len(cc) != 2 || !isLetters(cc) {
			return nil, fmt.Errorf("WHATSAPP_RATES country in %q must be two letters", part)
		}
		if hasCat {
			cat = strings.ToLower(strings.TrimSpace(cat))
			if cat == "" {
				return nil, fmt.Errorf("WHATSAPP_RATES category in %q is empty", part)
			}
			key = cc + ":" + cat
		} else {
			key = cc
		}
		n, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64)
		if err != nil || n < 0 {
			return nil, fmt.Errorf("WHATSAPP_RATES amount in %q must be micros >= 0", part)
		}
		out[key] = n
	}
	return out, nil
}

func isLetters(s string) bool {
	for _, r := range s {
		if !unicode.IsLetter(r) {
			return false
		}
	}
	return s != ""
}

// Lookup is the rate for this country and category. Service and referral are
// free. A country with no row is a miss: the caller leaves the cost empty
// rather than charging India's rate to somebody else.
func (t RateTable) Lookup(country, category string) (int64, bool) {
	if t == nil {
		return 0, false
	}
	cc := strings.ToUpper(strings.TrimSpace(country))
	cat := strings.ToLower(strings.TrimSpace(category))
	if cat == "service" || cat == "referral" {
		return 0, true
	}
	if cat != "" {
		if v, ok := t[cc+":"+cat]; ok {
			return v, true
		}
	}
	if v, ok := t[cc]; ok {
		return v, true
	}
	return 0, false
}

/* PriceInput is the pricing object from one status callback, plus the
 * recipient's number so a missing amount can be estimated by country. */
type PriceInput struct {
	Category  string
	Billable  *bool
	HasAmount bool
	Micros    int64
	Recipient string
}

/* Quote turns one pricing object into what to store.
 *
 * ok is false when Meta said nothing about price. An explicit amount is stored
 * and is not an estimate. billable false is a zero charge. A category with no
 * amount is estimated when the table has a row for that country.
 */
func Quote(table RateTable, in PriceInput) (category string, micros *int64, estimated, ok bool) {
	category = strings.ToLower(strings.TrimSpace(in.Category))
	if category == "" && !in.HasAmount && in.Billable == nil {
		return "", nil, false, false
	}
	ok = true
	if in.Billable != nil && !*in.Billable && !in.HasAmount {
		z := int64(0)
		return category, &z, false, true
	}
	if in.HasAmount {
		n := in.Micros
		return category, &n, false, true
	}
	if category == "" {
		return "", nil, false, true
	}
	n, found := table.Lookup(CountryFromPhone(in.Recipient), category)
	if !found {
		return category, nil, false, true
	}
	return category, &n, true, true
}

// CountryFromPhone maps a WhatsApp recipient id (digits, no plus) to an ISO
// country. Empty when the prefix is not one this server knows.
func CountryFromPhone(phone string) string {
	digits := digitsOnly(phone)
	if strings.HasPrefix(digits, "00") {
		digits = digits[2:]
	}
	for _, row := range dialCodes {
		if strings.HasPrefix(digits, row.prefix) {
			return row.cc
		}
	}
	return ""
}

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

type dial struct {
	prefix string
	cc     string
}

// Longest prefix first, so 1868 (Trinidad) wins over 1 (US/Canada).
var dialCodes = func() []dial {
	rows := []dial{
		{"1868", "TT"}, {"1876", "JM"}, {"1809", "DO"}, {"1829", "DO"}, {"1849", "DO"},
		{"1787", "PR"}, {"1939", "PR"},
		{"971", "AE"}, {"966", "SA"}, {"880", "BD"}, {"977", "NP"}, {"852", "HK"}, {"886", "TW"},
		{"234", "NG"}, {"254", "KE"}, {"255", "TZ"}, {"256", "UG"},
		{"353", "IE"}, {"358", "FI"}, {"351", "PT"},
		{"91", "IN"}, {"92", "PK"}, {"94", "LK"}, {"90", "TR"},
		{"44", "GB"}, {"49", "DE"}, {"33", "FR"}, {"39", "IT"}, {"34", "ES"}, {"31", "NL"}, {"32", "BE"},
		{"27", "ZA"}, {"20", "EG"},
		{"61", "AU"}, {"64", "NZ"}, {"81", "JP"}, {"82", "KR"}, {"86", "CN"},
		{"55", "BR"}, {"52", "MX"}, {"54", "AR"}, {"57", "CO"}, {"56", "CL"}, {"51", "PE"},
		{"60", "MY"}, {"62", "ID"}, {"63", "PH"}, {"65", "SG"}, {"66", "TH"}, {"84", "VN"},
		{"7", "RU"}, {"1", "US"},
	}
	sort.Slice(rows, func(i, j int) bool { return len(rows[i].prefix) > len(rows[j].prefix) })
	return rows
}()

/* ExplainFailure turns the text stored on a failed message into a sentence a
 * coach can act on. The stored text is Meta's own ("131042: There is no
 * payment method…"); the code selects the fix, and the rest is the reason. */
func ExplainFailure(raw string, count int) types.CRMFailure {
	code, reason := splitMetaError(raw)
	title, fix := failureCopy(code)
	if title == "" {
		title = reason
	}
	if title == "" {
		title = "WhatsApp couldn't deliver this"
	}
	if fix == "" {
		fix = "Check that the wording is still approved, and that WhatsApp Manager has a payment method on the account."
	}
	return types.CRMFailure{Code: code, Reason: title, Count: count, Fix: fix}
}

func splitMetaError(raw string) (code, reason string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	head, rest, ok := strings.Cut(raw, ":")
	head = strings.TrimSpace(head)
	if ok && isDigits(head) {
		return head, strings.TrimSpace(rest)
	}
	return "", raw
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func failureCopy(code string) (title, fix string) {
	switch code {
	case "131026":
		return "Their phone couldn't take it",
			"That number isn't on WhatsApp, or they haven't accepted WhatsApp's latest terms. Nothing to change here — the next message to a working number will go through."
	case "131047":
		return "Too late for a free reply",
			"More than 24 hours have passed since they wrote. Send an approved template instead of a free-form reply."
	case "131042", "131031":
		return "WhatsApp is waiting on a payment method",
			"Add a payment method in WhatsApp Manager. Messages stay failed until Meta can bill the account."
	case "131048", "131049":
		return "Meta held this one back",
			"WhatsApp limited marketing messages to this person. Wait, and send fewer promotional messages to people who don't reply."
	case "131050":
		return "They asked to stop marketing messages",
			"They opted out of marketing. Utility messages such as reminders can still go; promotional ones should not."
	case "131051":
		return "That kind of message isn't supported",
			"Send text, or a template WhatsApp has approved. This type of attachment can't go out from here."
	case "131052", "131053":
		return "The attachment didn't go through",
			"The image or file couldn't be downloaded. Send it again, or send the message without the attachment."
	case "132000", "131008":
		return "The wording's blanks don't match",
			"The template expects a different number of values. Edit the message and fill every blank."
	case "132001", "132015", "132016":
		return "That wording isn't available",
			"The template is missing, paused, or turned off at Meta. Pick another approved wording, or resubmit this one in WhatsApp Manager."
	case "132005", "132007", "132012", "131009":
		return "A blank in the wording was rejected",
			"One of the filled-in values is the wrong shape or too long. Edit the message and try a shorter value."
	case "133010":
		return "Your number isn't registered to send",
			"Finish registering the number in WhatsApp settings. Until then every send fails."
	case "130429", "131056":
		return "Sent too quickly",
			"WhatsApp rate-limited this number. Wait a little, then send again. It is not a problem with the wording."
	case "368":
		return "The WhatsApp account is restricted",
			"Meta has restricted the business account. Open WhatsApp Manager to see what they need before messages will send."
	default:
		return "", ""
	}
}
