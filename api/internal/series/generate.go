// Package series builds the dates of a recurring webinar.
//
// Occurrences are wall-clock times in the host's zone. Adding a day is a
// calendar step in that zone, not 24 hours of UTC, so a series that crosses
// a daylight-saving change still starts at the hour the host picked.
package series

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

// MaxOccurrences is Zoom's cap. A schedule that would pass it is refused
// rather than silently shortened.
const MaxOccurrences = 60

// TooManyMessage is the sentence shown when a schedule would pass the cap.
const TooManyMessage = "A series can have at most 60 sessions. Shorten it or end it sooner."

// Pattern is how the series steps.
type Pattern string

const (
	Daily   Pattern = "daily"
	Weekly  Pattern = "weekly"
	Monthly Pattern = "monthly"
)

// End is when the series stops.
type End string

const (
	EndByDate     End = "by_date"
	EndAfterCount End = "after_count"
)

// Input is the schedule the host asked for, before it is checked.
type Input struct {
	Pattern  string
	Interval int
	Weekdays []int // 0 = Sunday … 6 = Saturday. Weekly only.
	End      string
	EndDate  string // YYYY-MM-DD in the series zone, inclusive. By-date only.
	EndCount int
}

// Rule is a schedule that Generate will run.
type Rule struct {
	Pattern    Pattern
	Interval   int
	Weekdays   []time.Weekday
	MonthlyDay int // 1–31. Taken from the first session when the host does not send one.
	End        End
	EndDate    time.Time // calendar date; the clock is ignored
	EndCount   int
}

// Plan is the sessions a rule produces.
type Plan struct {
	Rule    Rule
	Zone    string // IANA name the times were built in
	Times   []time.Time
	Skipped []string // "February 2026", months with no such day
	Summary string
}

// InputError is a schedule the host can fix. The message is safe to show.
type InputError struct {
	Message string
}

func (e *InputError) Error() string { return e.Message }

func invalid(msg string) error { return &InputError{Message: msg} }

// PlanSchedule validates in and lists every session from start.
//
// start is the first session, already an absolute instant. Later sessions
// reuse its clock in zone. Monthly sessions use the day of the month of
// start in that zone; a month that has no such day is skipped.
func PlanSchedule(start time.Time, zone string, in Input) (Plan, error) {
	loc, err := time.LoadLocation(zone)
	if err != nil || loc == nil {
		return Plan{}, invalid("That isn't a recognised time zone.")
	}
	rule, err := normalize(start.In(loc), in, loc)
	if err != nil {
		return Plan{}, err
	}
	plan, err := Generate(start, loc, rule)
	if err != nil {
		return Plan{}, err
	}
	plan.Zone = zone
	return plan, nil
}

// Generate lists sessions for a rule that has already been checked.
func Generate(start time.Time, loc *time.Location, rule Rule) (Plan, error) {
	if loc == nil {
		loc = time.UTC
	}
	local := start.In(loc)
	hour, min, sec := local.Clock()
	var (
		times   []time.Time
		skipped []string
	)
	add := func(t time.Time) error {
		if rule.End == EndByDate && dateAfter(t, rule.EndDate) {
			return errStop
		}
		if rule.End == EndAfterCount && len(times) >= rule.EndCount {
			return errStop
		}
		if len(times) >= MaxOccurrences {
			return invalid(TooManyMessage)
		}
		if len(times) == 0 {
			times = append(times, start)
			return nil
		}
		times = append(times, t)
		return nil
	}

	switch rule.Pattern {
	case Daily:
		for i := 0; i < MaxOccurrences+366; i++ {
			day := local.AddDate(0, 0, i*rule.Interval)
			t := time.Date(day.Year(), day.Month(), day.Day(), hour, min, sec, 0, loc)
			if err := add(t); err != nil {
				if err == errStop {
					break
				}
				return Plan{}, err
			}
		}
	case Weekly:
		week0 := startOfWeek(local)
		for w := 0; w < MaxOccurrences*8; w++ {
			week := week0.AddDate(0, 0, w*rule.Interval*7)
			// A week that starts after the end date cannot hold another session.
			// Count-based series have no end date; zero time would look "before"
			// every real week and stop the loop after the first one.
			if rule.End == EndByDate && w > 0 && dateAfter(week, rule.EndDate) {
				break
			}
			added := 0
			for _, wd := range rule.Weekdays {
				day := week.AddDate(0, 0, int(wd))
				if dateBefore(day, local) {
					continue
				}
				t := time.Date(day.Year(), day.Month(), day.Day(), hour, min, sec, 0, loc)
				if err := add(t); err != nil {
					if err == errStop {
						added = -1
						break
					}
					return Plan{}, err
				}
				added++
			}
			if added == -1 {
				break
			}
		}
	case Monthly:
		y, m, _ := local.Date()
		for i := 0; i < MaxOccurrences*12; i++ {
			if rule.End == EndAfterCount && len(times) >= rule.EndCount {
				break
			}
			yy, mm := addMonths(y, m, i*rule.Interval)
			monthStart := time.Date(yy, mm, 1, 0, 0, 0, 0, loc)
			if rule.End == EndByDate && dateAfter(monthStart, rule.EndDate) {
				break
			}
			if daysIn(yy, mm) < rule.MonthlyDay {
				skipped = append(skipped, monthStart.Format("January 2006"))
				continue
			}
			t := time.Date(yy, mm, rule.MonthlyDay, hour, min, sec, 0, loc)
			if err := add(t); err != nil {
				if err == errStop {
					break
				}
				return Plan{}, err
			}
		}
	default:
		return Plan{}, invalid("Choose daily, weekly, or monthly.")
	}

	if len(times) == 0 {
		return Plan{}, invalid("That schedule has no sessions. Move the end date or add another occurrence.")
	}
	// The first instant is the one the host picked, not a reconstructed one,
	// so a daylight-saving ambiguity cannot move the session they just set.
	times[0] = start

	plan := Plan{Rule: rule, Times: times, Skipped: skipped}
	plan.Summary = Summary(rule, len(times), skipped)
	return plan, nil
}

// Summary is the sentence next to the schedule, in the shape
// "Every day, until Oct 8, 2026, 7 occurrence(s)".
func Summary(rule Rule, count int, skipped []string) string {
	var b strings.Builder
	switch rule.Pattern {
	case Daily:
		if rule.Interval == 1 {
			b.WriteString("Every day")
		} else {
			fmt.Fprintf(&b, "Every %d days", rule.Interval)
		}
	case Weekly:
		if rule.Interval == 1 {
			b.WriteString("Every week")
		} else {
			fmt.Fprintf(&b, "Every %d weeks", rule.Interval)
		}
		if names := weekdayNames(rule.Weekdays); names != "" {
			b.WriteString(" on ")
			b.WriteString(names)
		}
	case Monthly:
		if rule.Interval == 1 {
			b.WriteString("Every month")
		} else {
			fmt.Fprintf(&b, "Every %d months", rule.Interval)
		}
		if rule.MonthlyDay > 0 {
			fmt.Fprintf(&b, " on the %s", ordinal(rule.MonthlyDay))
		}
	default:
		b.WriteString("Every session")
	}
	if rule.End == EndByDate && !rule.EndDate.IsZero() {
		b.WriteString(", until ")
		b.WriteString(rule.EndDate.Format("Jan 2, 2006"))
	}
	fmt.Fprintf(&b, ", %d occurrence(s)", count)
	if len(skipped) > 0 {
		b.WriteString(". ")
		b.WriteString(joinAnd(skipped))
		if len(skipped) == 1 {
			b.WriteString(" is skipped — that month has no ")
		} else {
			b.WriteString(" are skipped — those months have no ")
		}
		b.WriteString(ordinal(rule.MonthlyDay))
	}
	return b.String()
}

var errStop = fmt.Errorf("stop")

func normalize(local time.Time, in Input, loc *time.Location) (Rule, error) {
	rule := Rule{Interval: in.Interval, MonthlyDay: local.Day()}
	switch Pattern(in.Pattern) {
	case Daily, Weekly, Monthly:
		rule.Pattern = Pattern(in.Pattern)
	default:
		return Rule{}, invalid("Choose daily, weekly, or monthly.")
	}
	if rule.Interval < 1 || rule.Interval > 99 {
		return Rule{}, invalid("Repeat every 1 to 99.")
	}
	if rule.Pattern == Weekly {
		seen := map[time.Weekday]bool{}
		for _, d := range in.Weekdays {
			if d < 0 || d > 6 {
				return Rule{}, invalid("Weekdays are Sunday through Saturday.")
			}
			wd := time.Weekday(d)
			if !seen[wd] {
				seen[wd] = true
				rule.Weekdays = append(rule.Weekdays, wd)
			}
		}
		sort.Slice(rule.Weekdays, func(i, j int) bool { return rule.Weekdays[i] < rule.Weekdays[j] })
		if !seen[local.Weekday()] {
			return Rule{}, invalid("Include the weekday the first session falls on.")
		}
	}
	switch End(in.End) {
	case EndByDate:
		rule.End = EndByDate
		if strings.TrimSpace(in.EndDate) == "" {
			return Rule{}, invalid("Pick the date the series ends.")
		}
		end, err := time.ParseInLocation("2006-01-02", in.EndDate, loc)
		if err != nil {
			return Rule{}, invalid("The end date should be YYYY-MM-DD.")
		}
		rule.EndDate = end
		if dateBefore(end, local) {
			return Rule{}, invalid("The end date is before the first session.")
		}
	case EndAfterCount:
		rule.End = EndAfterCount
		if in.EndCount < 1 {
			return Rule{}, invalid("Say how many sessions the series runs.")
		}
		if in.EndCount > MaxOccurrences {
			return Rule{}, invalid(TooManyMessage)
		}
		rule.EndCount = in.EndCount
	default:
		return Rule{}, invalid("End the series on a date, or after a number of sessions.")
	}
	return rule, nil
}

func startOfWeek(t time.Time) time.Time {
	y, m, d := t.Date()
	midnight := time.Date(y, m, d, 0, 0, 0, 0, t.Location())
	return midnight.AddDate(0, 0, -int(t.Weekday()))
}

func addMonths(year int, month time.Month, n int) (int, time.Month) {
	total := int(month) - 1 + n
	return year + total/12, time.Month(total%12 + 1)
}

func daysIn(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func dateAfter(t, day time.Time) bool {
	ty, tm, td := t.Date()
	dy, dm, dd := day.Date()
	if ty != dy {
		return ty > dy
	}
	if tm != dm {
		return tm > dm
	}
	return td > dd
}

func dateBefore(t, day time.Time) bool {
	ty, tm, td := t.Date()
	dy, dm, dd := day.Date()
	if ty != dy {
		return ty < dy
	}
	if tm != dm {
		return tm < dm
	}
	return td < dd
}

func weekdayNames(days []time.Weekday) string {
	names := make([]string, len(days))
	for i, d := range days {
		names[i] = d.String()
	}
	return joinAnd(names)
}

func joinAnd(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	case 2:
		return parts[0] + " and " + parts[1]
	default:
		return strings.Join(parts[:len(parts)-1], ", ") + ", and " + parts[len(parts)-1]
	}
}

func ordinal(n int) string {
	switch n % 100 {
	case 11, 12, 13:
		return strconv.Itoa(n) + "th"
	}
	switch n % 10 {
	case 1:
		return strconv.Itoa(n) + "st"
	case 2:
		return strconv.Itoa(n) + "nd"
	case 3:
		return strconv.Itoa(n) + "rd"
	default:
		return strconv.Itoa(n) + "th"
	}
}
