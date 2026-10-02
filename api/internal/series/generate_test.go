package series

import (
	"strings"
	"testing"
	"time"
)

func at(t *testing.T, zone, wall string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatal(err)
	}
	got, err := time.ParseInLocation("2006-01-02 15:04", wall, loc)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func dates(t *testing.T, zone string, times []time.Time) []string {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(times))
	for i, ts := range times {
		out[i] = ts.In(loc).Format("2006-01-02 15:04")
	}
	return out
}

func TestDailySevenDays(t *testing.T) {
	start := at(t, "Asia/Kolkata", "2026-10-02 23:15")
	plan, err := PlanSchedule(start, "Asia/Kolkata", Input{
		Pattern: "daily", Interval: 1, End: "after_count", EndCount: 7,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := dates(t, "Asia/Kolkata", plan.Times)
	want := []string{
		"2026-10-02 23:15", "2026-10-03 23:15", "2026-10-04 23:15",
		"2026-10-05 23:15", "2026-10-06 23:15", "2026-10-07 23:15",
		"2026-10-08 23:15",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("daily:\n got %v\nwant %v", got, want)
	}
	if plan.Summary != "Every day, 7 occurrence(s)" {
		t.Fatalf("summary %q", plan.Summary)
	}
}

func TestDailyUntilDateIsInclusive(t *testing.T) {
	start := at(t, "Asia/Kolkata", "2026-10-02 23:15")
	plan, err := PlanSchedule(start, "Asia/Kolkata", Input{
		Pattern: "daily", Interval: 1, End: "by_date", EndDate: "2026-10-08",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Times) != 7 {
		t.Fatalf("until Oct 8: %d sessions, want 7", len(plan.Times))
	}
	last := plan.Times[len(plan.Times)-1].In(mustLoc(t, "Asia/Kolkata")).Format("2006-01-02")
	if last != "2026-10-08" {
		t.Fatalf("last session %s, want 2026-10-08", last)
	}
	if plan.Summary != "Every day, until Oct 8, 2026, 7 occurrence(s)" {
		t.Fatalf("summary %q", plan.Summary)
	}
}

func TestDailyIntervalKeepsTheLocalClockAcrossDST(t *testing.T) {
	// US clocks spring forward on 2026-03-08. A UTC add of 24h would land
	// on 10:00 or 08:00 the next morning; the host asked for 09:00.
	start := at(t, "America/New_York", "2026-03-07 09:00")
	plan, err := PlanSchedule(start, "America/New_York", Input{
		Pattern: "daily", Interval: 1, End: "after_count", EndCount: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := dates(t, "America/New_York", plan.Times)
	want := []string{"2026-03-07 09:00", "2026-03-08 09:00", "2026-03-09 09:00"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("DST daily:\n got %v\nwant %v", got, want)
	}
}

func TestWeeklyMondayAndWednesday(t *testing.T) {
	// 2026-10-05 is a Monday.
	start := at(t, "UTC", "2026-10-05 11:15")
	plan, err := PlanSchedule(start, "UTC", Input{
		Pattern: "weekly", Interval: 1, Weekdays: []int{int(time.Monday), int(time.Wednesday)},
		End: "after_count", EndCount: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := dates(t, "UTC", plan.Times)
	want := []string{
		"2026-10-05 11:15", "2026-10-07 11:15",
		"2026-10-12 11:15", "2026-10-14 11:15",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("weekly:\n got %v\nwant %v", got, want)
	}
	if !strings.Contains(plan.Summary, "Monday and Wednesday") {
		t.Fatalf("summary %q", plan.Summary)
	}
}

func TestWeeklyIntervalSkipsAWeek(t *testing.T) {
	start := at(t, "UTC", "2026-10-05 11:15")
	plan, err := PlanSchedule(start, "UTC", Input{
		Pattern: "weekly", Interval: 2, Weekdays: []int{int(time.Monday), int(time.Wednesday)},
		End: "after_count", EndCount: 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := dates(t, "UTC", plan.Times)
	want := []string{
		"2026-10-05 11:15", "2026-10-07 11:15",
		"2026-10-19 11:15", "2026-10-21 11:15",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("every 2 weeks:\n got %v\nwant %v", got, want)
	}
}

func TestWeeklyRequiresTheStartWeekday(t *testing.T) {
	start := at(t, "UTC", "2026-10-05 11:15") // Monday
	_, err := PlanSchedule(start, "UTC", Input{
		Pattern: "weekly", Interval: 1, Weekdays: []int{int(time.Wednesday)},
		End: "after_count", EndCount: 2,
	})
	if err == nil || !strings.Contains(err.Error(), "weekday") {
		t.Fatalf("err %v, want the start weekday required", err)
	}
}

func TestMonthlyThirtyFirstSkipsShortMonths(t *testing.T) {
	start := at(t, "UTC", "2026-01-31 18:00")
	plan, err := PlanSchedule(start, "UTC", Input{
		Pattern: "monthly", Interval: 1, End: "after_count", EndCount: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	got := dates(t, "UTC", plan.Times)
	want := []string{
		"2026-01-31 18:00",
		"2026-03-31 18:00",
		"2026-05-31 18:00",
		"2026-07-31 18:00",
		"2026-08-31 18:00",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("monthly 31st:\n got %v\nwant %v", got, want)
	}
	joined := strings.Join(plan.Skipped, ",")
	for _, month := range []string{"February 2026", "April 2026", "June 2026"} {
		if !strings.Contains(joined, month) {
			t.Fatalf("skipped %q, missing %s", joined, month)
		}
	}
	if strings.Contains(joined, "August 2026") {
		t.Fatalf("August has a 31st and was skipped: %s", joined)
	}
	if !strings.Contains(plan.Summary, "no 31st") {
		t.Fatalf("summary should say the 31st is skipped: %q", plan.Summary)
	}
}

func TestCapAtSixty(t *testing.T) {
	start := at(t, "UTC", "2026-01-01 09:00")
	if _, err := PlanSchedule(start, "UTC", Input{
		Pattern: "daily", Interval: 1, End: "after_count", EndCount: 61,
	}); err == nil || !strings.Contains(err.Error(), "60") {
		t.Fatalf("count 61: %v", err)
	}
	plan, err := PlanSchedule(start, "UTC", Input{
		Pattern: "daily", Interval: 1, End: "after_count", EndCount: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Times) != 60 {
		t.Fatalf("exactly 60: got %d", len(plan.Times))
	}
	// 61 calendar days, 2026-01-01 through 2026-03-02.
	if _, err := PlanSchedule(start, "UTC", Input{
		Pattern: "daily", Interval: 1, End: "by_date", EndDate: "2026-03-02",
	}); err == nil || !strings.Contains(err.Error(), "60") {
		t.Fatalf("by date past 60: %v", err)
	}
}

func TestEndDateBeforeStartIsRejected(t *testing.T) {
	start := at(t, "UTC", "2026-10-02 09:00")
	_, err := PlanSchedule(start, "UTC", Input{
		Pattern: "daily", Interval: 1, End: "by_date", EndDate: "2026-10-01",
	})
	if err == nil {
		t.Fatal("expected the end date to be rejected")
	}
}

func mustLoc(t *testing.T, zone string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(zone)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}
