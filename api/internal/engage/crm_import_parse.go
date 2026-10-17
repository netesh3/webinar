package engage

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"net/mail"
	"strings"
	"time"
	"unicode"

	"github.com/netkumar/webcast/api/types"
)

/* Contact import: reading the file.
 *
 * Pure functions, so the rules can be tested without a database. Most coaches export
 * from TagMango, whose CSV is: name, email, phone ("+91-9184338388"), Service, Payment
 * cycle, Last transaction date and Subscription expiry date ("17/10/2026 1:49 PM (IST)").
 * Spreadsheets also save tab- and semicolon-separated files, with a byte-order mark and
 * CRLF line ends, so those are accepted too.
 */

var errImportEmpty = errors.New("the file has no rows")

// importAliases maps a normalised header to the field it fills.
var importAliases = map[string]string{
	"name": types.ImportFieldName, "full name": types.ImportFieldName, "fullname": types.ImportFieldName,
	"customer name": types.ImportFieldName, "student name": types.ImportFieldName, "first name": types.ImportFieldName,
	"email": types.ImportFieldEmail, "email address": types.ImportFieldEmail, "e mail": types.ImportFieldEmail,
	"email id": types.ImportFieldEmail, "mail": types.ImportFieldEmail,
	"phone": types.ImportFieldPhone, "phone number": types.ImportFieldPhone, "mobile": types.ImportFieldPhone,
	"mobile number": types.ImportFieldPhone, "mobile no": types.ImportFieldPhone, "whatsapp": types.ImportFieldPhone,
	"whatsapp number": types.ImportFieldPhone, "contact number": types.ImportFieldPhone, "contact": types.ImportFieldPhone,
	"phone no": types.ImportFieldPhone, "number": types.ImportFieldPhone,
	"service": types.ImportFieldService, "product": types.ImportFieldService, "course": types.ImportFieldService,
	"payment cycle":         types.ImportFieldPaymentCycle,
	"last transaction date": types.ImportFieldLastTransaction, "last transaction": types.ImportFieldLastTransaction,
	"subscription expiry date": types.ImportFieldSubscriptionExpiry, "subscription expiry": types.ImportFieldSubscriptionExpiry,
	"expiry date": types.ImportFieldSubscriptionExpiry,
}

// importFields is every field a column can be mapped to, for validating a commit.
var importFields = map[string]bool{
	"": true, types.ImportFieldName: true, types.ImportFieldEmail: true, types.ImportFieldPhone: true,
	types.ImportFieldService: true, types.ImportFieldPaymentCycle: true,
	types.ImportFieldLastTransaction: true, types.ImportFieldSubscriptionExpiry: true,
}

func normaliseHeader(h string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToLower(h) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			space = false
		} else if b.Len() > 0 && !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

/* readImportCSV splits the file into a header and data rows. The separator is whichever
 * of comma, tab or semicolon appears most in the header line. Blank rows are dropped. */
func readImportCSV(data []byte) ([]string, [][]string, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	first := data
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		first = data[:i]
	}
	sep := ','
	best := bytes.Count(first, []byte(","))
	for _, c := range []rune{'\t', ';'} {
		if n := bytes.Count(first, []byte(string(c))); n > best {
			sep, best = c, n
		}
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = sep
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.TrimLeadingSpace = true

	var header []string
	var rows [][]string
	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		blank := true
		for i := range rec {
			rec[i] = strings.TrimSpace(rec[i])
			if rec[i] != "" {
				blank = false
			}
		}
		if blank {
			continue
		}
		if header == nil {
			header = rec
			continue
		}
		rows = append(rows, rec)
	}
	if header == nil {
		return nil, nil, errImportEmpty
	}
	return header, rows, nil
}

// detectMapping guesses each column's field from its header; unknown columns are ignored.
func detectMapping(columns []string) []string {
	out := make([]string, len(columns))
	taken := map[string]bool{}
	for i, c := range columns {
		f := importAliases[normaliseHeader(c)]
		if f != "" && !taken[f] {
			out[i] = f
			taken[f] = true
		}
	}
	return out
}

/* importPhone normalises a number the way a WhatsApp send needs it: E.164.
 *
 * "+91-9184338388", "+91 91843 38388" and "(+91) 9184338388" all keep their country code.
 * Without a +, a ten-digit number is an Indian mobile (+91), as is the same number with
 * a leading 0 or the 91 already in front. Anything else without a + is ambiguous and
 * refused rather than guessed. */
func importPhone(raw string) (string, string) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", "no phone number"
	}
	plus := strings.HasPrefix(strings.TrimLeft(s, "( "), "+")
	if strings.HasPrefix(s, "00") {
		plus = true
		s = s[2:]
	}
	var d strings.Builder
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			d.WriteRune(r)
		case r == '+' || r == '-' || r == ' ' || r == '(' || r == ')' || r == '.':
		default:
			return "", "not a phone number"
		}
	}
	digits := d.String()
	if !plus {
		switch {
		case len(digits) == 10 && strings.ContainsAny(digits[:1], "6789"):
			digits = "91" + digits
		case len(digits) == 11 && digits[0] == '0' && strings.ContainsAny(digits[1:2], "6789"):
			digits = "91" + digits[1:]
		case len(digits) == 12 && strings.HasPrefix(digits, "91"):
		default:
			return "", "add the country code, e.g. +91"
		}
	}
	if len(digits) < 8 || len(digits) > 15 || digits[0] == '0' {
		return "", "not a phone number"
	}
	if strings.HasPrefix(digits, "91") && (len(digits) != 12 || !strings.ContainsAny(digits[2:3], "6789")) {
		return "", "not an Indian mobile number"
	}
	return "+" + digits, ""
}

var ist = time.FixedZone("IST", 5*3600+30*60)

/* importTime reads TagMango's "17/10/2026 1:49 PM (IST)" (day first) and a few close
 * spellings, as RFC3339. A value it cannot read is kept as typed. */
func importTime(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(s, "(IST)"), "IST"))
	for _, layout := range []string{"02/01/2006 3:04 PM", "2/1/2006 3:04 PM", "02/01/2006 15:04", "02/01/2006", "2/1/2006", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, ist); err == nil {
			return t.Format(time.RFC3339)
		}
	}
	return strings.TrimSpace(raw)
}

// importPerson is one row ready to write.
type importPerson struct {
	Row     int
	Name    string
	Email   string
	Phone   string
	Service string
	Attrs   map[string]string
}

/* buildImport applies a mapping: people to write, the rows left out and why, and how
 * many rows repeated a phone already seen. */
func buildImport(mapping []string, rows [][]string) ([]importPerson, []types.CRMImportRowError, int) {
	var people []importPerson
	var invalid []types.CRMImportRowError
	seen := map[string]bool{}
	dupes := 0
	get := func(rec []string, field string) string {
		for i, f := range mapping {
			if f == field && i < len(rec) {
				return strings.TrimSpace(rec[i])
			}
		}
		return ""
	}
	for i, rec := range rows {
		row := i + 2
		rawPhone := get(rec, types.ImportFieldPhone)
		phone, reason := importPhone(rawPhone)
		if reason != "" {
			invalid = append(invalid, types.CRMImportRowError{Row: row, Value: rawPhone, Reason: reason})
			continue
		}
		if seen[phone] {
			dupes++
			continue
		}
		seen[phone] = true
		email := get(rec, types.ImportFieldEmail)
		if a, err := mail.ParseAddress(email); err != nil || a.Address != email {
			email = ""
		}
		p := importPerson{
			Row:     row,
			Name:    strings.Join(strings.Fields(get(rec, types.ImportFieldName)), " "),
			Email:   strings.ToLower(email),
			Phone:   phone,
			Service: strings.Join(strings.Fields(get(rec, types.ImportFieldService)), " "),
			Attrs:   map[string]string{},
		}
		if p.Service != "" {
			p.Attrs["service"] = p.Service
		}
		if v := get(rec, types.ImportFieldPaymentCycle); v != "" {
			p.Attrs["payment_cycle"] = v
		}
		if v := importTime(get(rec, types.ImportFieldLastTransaction)); v != "" {
			p.Attrs["last_transaction_at"] = v
		}
		if v := importTime(get(rec, types.ImportFieldSubscriptionExpiry)); v != "" {
			p.Attrs["subscription_expires_at"] = v
		}
		people = append(people, p)
	}
	return people, invalid, dupes
}

// serviceTag is the tag an imported Service value becomes, within the tag length limit.
func serviceTag(service string) string {
	name := "Service: " + service
	if r := []rune(name); len(r) > types.TagMaxLength {
		name = strings.TrimSpace(string(r[:types.TagMaxLength]))
	}
	return name
}
