package dbbackup

import (
	"reflect"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestKeyRoundTrip(t *testing.T) {
	when := at("2026-10-26T21:30:05Z")
	k := KeyFor(when)
	if k != "db-backups/2026/10/26/webinarliv-20261026T213005Z.dump" {
		t.Fatalf("KeyFor = %q", k)
	}
	got, ok := ParseKey(k)
	if !ok || !got.Equal(when) {
		t.Fatalf("ParseKey(%q) = %v, %v", k, got, ok)
	}
	for _, bad := range []string{
		"db-backups/2026/10/27/webinarliv-20261026T213005Z.dump", // folder disagrees with stamp
		"db-backups/2026/10/26/other-20261026T213005Z.dump",
		"db-backups/2026/10/26/webinarliv-20261026T213005Z.dump.tmp",
		"ab/cd/0f3e-recording.mp4",
		"db-backups/notes.txt",
	} {
		if _, ok := ParseKey(bad); ok {
			t.Errorf("ParseKey(%q) accepted a key KeyFor never writes", bad)
		}
	}
}

func TestPruneKeepsDailyMonthlyAndTheNewest(t *testing.T) {
	now := at("2026-10-26T22:00:00Z")
	var keys []string
	// One backup a night for 500 days.
	for d := 0; d < 500; d++ {
		keys = append(keys, KeyFor(now.AddDate(0, 0, -d).Add(-30*time.Minute)))
	}
	// Things Prune must never touch.
	foreign := []string{"db-backups/README.txt", "ab/cd/0f3e.mp4", "uploads/u1/x.mp4", "clips/ab/y.mp4"}
	keys = append(keys, foreign...)

	del := Prune(keys, now, DailyDays, MonthlyMonths)
	deleted := map[string]bool{}
	for _, k := range del {
		deleted[k] = true
	}
	for _, f := range foreign {
		if deleted[f] {
			t.Fatalf("Prune returned %q, which is not a backup it wrote", f)
		}
	}

	var kept []time.Time
	for _, k := range keys {
		if tm, ok := ParseKey(k); ok && !deleted[k] {
			kept = append(kept, tm)
		}
	}
	daily, monthly := 0, map[string]int{}
	for _, tm := range kept {
		if !tm.Before(now.AddDate(0, 0, -DailyDays)) {
			daily++
		} else {
			monthly[tm.Format("2006-01")]++
		}
	}
	if daily != DailyDays {
		t.Errorf("kept %d daily backups, want %d", daily, DailyDays)
	}
	// Months Nov 2025 .. Oct 2026 are 12 months; the daily window covers late Sep-Oct, so the
	// monthly keepers are the first-of-month backups older than 30 days in those months.
	for m, n := range monthly {
		if n != 1 {
			t.Errorf("month %s kept %d backups past the daily window, want 1", m, n)
		}
		mt, _ := time.Parse("2006-01", m)
		if mt.Before(at("2025-11-01T00:00:00Z")) {
			t.Errorf("month %s is older than the %d-month window", m, MonthlyMonths)
		}
	}
	if len(monthly) < 10 || len(monthly) > 12 {
		t.Errorf("kept monthly backups for %d months, want about %d", len(monthly), MonthlyMonths)
	}
}

func TestPruneAlwaysKeepsTheNewestEvenWhenOld(t *testing.T) {
	now := at("2026-10-26T22:00:00Z")
	// The job has been broken since spring: only two old backups, same month.
	keys := []string{
		KeyFor(at("2025-03-01T21:30:00Z")),
		KeyFor(at("2025-03-15T21:30:00Z")),
	}
	del := Prune(keys, now, DailyDays, MonthlyMonths)
	if want := []string{KeyFor(at("2025-03-01T21:30:00Z"))}; !reflect.DeepEqual(del, want) {
		t.Fatalf("Prune = %v, want only the older one deleted (%v)", del, want)
	}
	if got := Prune(keys[1:], now, DailyDays, MonthlyMonths); len(got) != 0 {
		t.Fatalf("a lone backup must never be deleted, Prune = %v", got)
	}
}

func TestPruneNothing(t *testing.T) {
	if got := Prune(nil, time.Now(), DailyDays, MonthlyMonths); got != nil {
		t.Fatalf("Prune(nil) = %v", got)
	}
}

func TestLatest(t *testing.T) {
	keys := []string{
		KeyFor(at("2026-10-24T21:30:00Z")),
		"db-backups/zzz-not-ours.dump",
		KeyFor(at("2026-10-26T21:30:00Z")),
		KeyFor(at("2026-10-25T21:30:00Z")),
	}
	got, ok := Latest(keys)
	if !ok || got != KeyFor(at("2026-10-26T21:30:00Z")) {
		t.Fatalf("Latest = %q, %v", got, ok)
	}
	if _, ok := Latest([]string{"db-backups/zzz.dump"}); ok {
		t.Fatal("Latest found a backup among keys that are not ours")
	}
}
