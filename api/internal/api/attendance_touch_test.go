package api_test

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// The host's roster poll touches every attendee every few seconds. One batch
// writes each new person once, fills in a name that arrives late, and a repeat
// poll inside the minute rewrites nothing.
func TestRosterTouchIsBatchedAndSkipsUnchangedRows(t *testing.T) {
	h := newHarness(t)
	h.signup("Roster Host", "roster-host@example.com", true)
	wb := h.newWebinar("Roster touch", nil)
	ctx := t.Context()

	// "att_b" twice in one batch: ON CONFLICT would refuse that without the merge.
	if err := h.store.TouchAttendanceMany(ctx, wb.ID, []types.LiveParticipant{
		{Identity: "att_a", Name: "Ada"},
		{Identity: "att_b", Name: ""},
		{Identity: "att_b", Name: "Grace"},
		{Identity: "", Name: "nobody"},
	}); err != nil {
		t.Fatalf("first touch: %v", err)
	}

	type row struct{ name, xmin string }
	read := func() map[string]row {
		t.Helper()
		rows, err := h.store.Pool().Query(ctx, `
			SELECT a.identity, a.name, a.xmin::text
			  FROM attendance a JOIN webinars w ON w.id = a.webinar_id
			 WHERE w.slug = $1`, wb.ID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]row{}
		for rows.Next() {
			var id string
			var r row
			if err := rows.Scan(&id, &r.name, &r.xmin); err != nil {
				t.Fatal(err)
			}
			out[id] = r
		}
		return out
	}

	first := read()
	if len(first) != 2 || first["att_a"].name != "Ada" || first["att_b"].name != "Grace" {
		t.Fatalf("after first touch = %+v", first)
	}

	if err := h.store.TouchAttendanceMany(ctx, wb.ID, []types.LiveParticipant{
		{Identity: "att_a", Name: "Ada"},
		{Identity: "att_b", Name: "Grace"},
	}); err != nil {
		t.Fatalf("repeat touch: %v", err)
	}
	if again := read(); again["att_a"].xmin != first["att_a"].xmin || again["att_b"].xmin != first["att_b"].xmin {
		t.Fatalf("repeat poll rewrote rows: before %+v after %+v", first, again)
	}

	// A row that was written without a name still takes one later.
	if err := h.store.TouchAttendance(ctx, wb.ID, "att_c", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := h.store.TouchAttendanceMany(ctx, wb.ID, []types.LiveParticipant{{Identity: "att_c", Name: "Hedy"}}); err != nil {
		t.Fatal(err)
	}
	if got := read()["att_c"].name; got != "Hedy" {
		t.Fatalf("late name = %q, want Hedy", got)
	}
}
