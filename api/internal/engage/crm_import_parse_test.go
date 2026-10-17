package engage

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

const tagMangoCSV = "name,email,phone,Service,Payment cycle,Last transaction date,Subscription expiry date\r\n" +
	"Moon salat,moonsalat59@gmail.com,+91-9184338388,AI Agents Workshop,onetime,17/10/2026 1:49 PM (IST),31/12/2030 6:24 PM (IST)\r\n" +
	"Neeraj,ratkarwa0010@gmail.com,+91-9624837650,AI Agents Workshop,onetime,17/10/2026 12:23 PM (IST),31/12/2030 6:24 PM (IST)\r\n"

func TestReadsTheTagMangoExportCommaAndTab(t *testing.T) {
	for name, data := range map[string]string{
		"comma":      "\xef\xbb\xbf" + tagMangoCSV,
		"tab":        strings.ReplaceAll(tagMangoCSV, ",", "\t"),
		"semicolon":  strings.ReplaceAll(tagMangoCSV, ",", ";"),
		"quoted":     "\"name\",\"email\",\"phone\"\n\"Salat, Moon\",\"moonsalat59@gmail.com\",\"+91 91843 38388\"\n\n",
		"blank rows": "name,phone\n\n,\nNeeraj,9624837650\n",
	} {
		cols, rows, err := readImportCSV([]byte(data))
		if err != nil || len(rows) == 0 {
			t.Fatalf("%s: %v rows=%d", name, err, len(rows))
		}
		m := detectMapping(cols)
		people, invalid, _ := buildImport(m, rows)
		if len(invalid) != 0 || len(people) == 0 {
			t.Fatalf("%s: people %+v invalid %+v (mapping %v)", name, people, invalid, m)
		}
		if name == "comma" || name == "tab" || name == "semicolon" {
			p := people[0]
			if p.Name != "Moon salat" || p.Email != "moonsalat59@gmail.com" || p.Phone != "+919184338388" {
				t.Errorf("%s: first person = %+v", name, p)
			}
			if p.Service != "AI Agents Workshop" || p.Attrs["payment_cycle"] != "onetime" ||
				p.Attrs["last_transaction_at"] != "2026-10-17T13:49:00+05:30" ||
				p.Attrs["subscription_expires_at"] != "2030-12-31T18:24:00+05:30" {
				t.Errorf("%s: extras = %+v", name, p.Attrs)
			}
		}
		if name == "quoted" && people[0].Name != "Salat, Moon" {
			t.Errorf("quoted name = %q", people[0].Name)
		}
	}
}

func TestImportPhone(t *testing.T) {
	for raw, want := range map[string]string{
		"+91-9184338388":    "+919184338388",
		"+91 91843 38388":   "+919184338388",
		"(+91) 9184338388":  "+919184338388",
		"9184338388":        "+919184338388",
		"09184338388":       "+919184338388",
		"919184338388":      "+919184338388",
		"0091 9184338388":   "+919184338388",
		"+1 (415) 555-0100": "+14155550100",
		"+44 7700 900123":   "+447700900123",
	} {
		if got, reason := importPhone(raw); got != want {
			t.Errorf("importPhone(%q) = %q (%s), want %q", raw, got, reason, want)
		}
	}
	for _, raw := range []string{"", "12345", "4155550100", "abc", "+91 12345", "+9118433838", "n/a"} {
		if got, reason := importPhone(raw); got != "" || reason == "" {
			t.Errorf("importPhone(%q) = %q, want refused", raw, got)
		}
	}
}

func TestBuildImportReportsInvalidAndDuplicates(t *testing.T) {
	_, rows, _ := readImportCSV([]byte("Full Name,Mobile Number,Email\nA,9184338388,a@x.com\nB,12,b@x.com\nC,+91 91843 38388,\nD,,d@x.com\nE,9624837650,not-an-email\n"))
	m := detectMapping([]string{"Full Name", "Mobile Number", "Email"})
	if m[0] != types.ImportFieldName || m[1] != types.ImportFieldPhone || m[2] != types.ImportFieldEmail {
		t.Fatalf("mapping = %v", m)
	}
	people, invalid, dupes := buildImport(m, rows)
	if len(people) != 2 || dupes != 1 || len(invalid) != 2 {
		t.Fatalf("people %d dupes %d invalid %+v", len(people), dupes, invalid)
	}
	if invalid[0].Row != 3 || invalid[1].Row != 5 || invalid[1].Reason != "no phone number" {
		t.Errorf("invalid rows = %+v", invalid)
	}
	if people[1].Email != "" {
		t.Errorf("a malformed email should be dropped, got %q", people[1].Email)
	}
}

func TestServiceTagFitsTheTagLimit(t *testing.T) {
	if got := serviceTag(strings.Repeat("x", 80)); len([]rune(got)) > types.TagMaxLength {
		t.Errorf("service tag %q is over %d", got, types.TagMaxLength)
	}
	if got := serviceTag("AI Agents Workshop"); got != "Service: AI Agents Workshop" {
		t.Errorf("service tag = %q", got)
	}
}
