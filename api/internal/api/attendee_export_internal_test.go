package api

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// The record builder: RFC 4180 quoting survives a round trip, and every typed cell is
// guarded against formula injection.
func TestAttendeeCSVRecordQuotingAndGuard(t *testing.T) {
	qs := []types.CustomQuestion{{ID: "q1", Label: "=Label"}, {ID: "q2", Label: "Notes"}}
	at := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	rows := []store.AttendeeExportRow{
		{
			Name: "Smith, \"Bob\"\nJr", Email: "@evil.example", Phone: "+919876543210",
			RegisteredAt: &at, Attended: true, FirstJoinedAt: &at, WatchSeconds: 1800,
			JoinedVia: "edge", Questions: 2, RaisedHand: true,
			Answers: map[string]string{"q1": "-2+3", "q2": "line1\nline2, \"x\""},
		},
		{Name: "+cmd", Attended: false, Answers: map[string]string{}},
	}
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	cw.UseCRLF = true
	_ = cw.Write(attendeeCSVHeader(qs))
	for _, r := range rows {
		_ = cw.Write(attendeeCSVRecord(r, qs, time.UTC, 3600))
	}
	cw.Flush()
	recs, err := csv.NewReader(strings.NewReader(buf.String())).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if h := recs[0]; h[len(h)-2] != "'=Label" || h[len(h)-1] != "Notes" {
		t.Errorf("header = %v", h)
	}
	a := recs[1]
	want := []string{
		"Smith, \"Bob\"\nJr", "'@evil.example", "'+919876543210", "2026-10-01T10:00:00+00:00", "yes",
		"2026-10-01T10:00:00+00:00", "", "30", "50", "edge", "2", "0", "0", "yes",
		"'-2+3", "line1\nline2, \"x\"",
	}
	if strings.Join(a, "|") != strings.Join(want, "|") {
		t.Errorf("row =\n%q\nwant\n%q", a, want)
	}
	ns := recs[2]
	if ns[0] != "'+cmd" || ns[4] != "no" || ns[7] != "" || ns[13] != "" || len(ns) != len(recs[0]) {
		t.Errorf("no-show = %q", ns)
	}
}
