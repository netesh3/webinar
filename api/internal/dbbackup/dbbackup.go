/*
Package dbbackup names the nightly database backups in object storage and decides which old
ones to delete (docs/BACKUPS.md).

Supabase's Free plan, which production moved to on 2026-10-26, keeps no backups at all, so
.github/workflows/db-backup.yml dumps Postgres every night to R2 under Prefix. Everything here
is pure, so the one rule that can lose data (Prune) is tested without a bucket:

  - Every backup of the last DailyDays days is kept.
  - Older than that, the first backup of each calendar month is kept for MonthlyMonths
    months, counting the current month as one.
  - The newest backup is always kept, however old: if the nightly job has been broken for
    weeks, the last good dump is the one that matters.
  - Only keys this package wrote (Prefix + YYYY/MM/DD/webinarliv-<timestamp>.dump) are
    ever deleted. Anything else under the prefix, and everything outside it (recordings,
    covers, chat images), is never even considered.
*/
package dbbackup

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Prefix is the only part of the bucket backups live in, and the only part Prune touches.
const Prefix = "db-backups/"

// Retention defaults.
const (
	DailyDays     = 30
	MonthlyMonths = 12
)

// stampLayout is the UTC timestamp in a key: sortable, no colons (some tools dislike them).
const stampLayout = "20060102T150405Z"

var keyPattern = regexp.MustCompile(`^db-backups/(\d{4})/(\d{2})/(\d{2})/webinarliv-(\d{8}T\d{6}Z)\.dump$`)

// KeyFor is the object key for a backup taken at t.
func KeyFor(t time.Time) string {
	t = t.UTC()
	return fmt.Sprintf("%s%04d/%02d/%02d/webinarliv-%s.dump", Prefix, t.Year(), int(t.Month()), t.Day(), t.Format(stampLayout))
}

// ParseKey returns when the backup at key was taken, and false for any key KeyFor did not
// produce: such a key is never pruned.
func ParseKey(key string) (time.Time, bool) {
	m := keyPattern.FindStringSubmatch(key)
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.Parse(stampLayout, m[4])
	if err != nil {
		return time.Time{}, false
	}
	// The date folders must agree with the stamp, or the key was not ours.
	if fmt.Sprintf("%s/%s/%s", m[1], m[2], m[3]) != t.Format("2006/01/02") {
		return time.Time{}, false
	}
	return t, true
}

type backup struct {
	key string
	at  time.Time
}

/*
Prune returns the keys to delete from keys at now, under the retention above. Keys outside
Prefix or not in KeyFor's form are ignored (never returned). The result is sorted.
*/
func Prune(keys []string, now time.Time, dailyDays, monthlyMonths int) []string {
	now = now.UTC()
	var all []backup
	for _, k := range keys {
		if !strings.HasPrefix(k, Prefix) {
			continue
		}
		if at, ok := ParseKey(k); ok {
			all = append(all, backup{k, at})
		}
	}
	if len(all) == 0 {
		return nil
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })

	keep := map[string]bool{all[len(all)-1].key: true} // the newest, always
	dailyFrom := now.AddDate(0, 0, -dailyDays)
	// The oldest month still kept monthly: the current month counts as one.
	firstMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -(monthlyMonths - 1), 0)
	seenMonth := map[string]bool{}
	for _, b := range all { // oldest first, so the first of each month wins
		if !b.at.Before(dailyFrom) {
			keep[b.key] = true
			continue
		}
		month := b.at.Format("2006-01")
		if monthlyMonths > 0 && !b.at.Before(firstMonth) && !seenMonth[month] {
			seenMonth[month] = true
			keep[b.key] = true
		}
	}
	var del []string
	for _, b := range all {
		if !keep[b.key] {
			del = append(del, b.key)
		}
	}
	sort.Strings(del)
	return del
}

// Latest is the newest backup key among keys, and false when there is none.
func Latest(keys []string) (string, bool) {
	var best string
	var bestAt time.Time
	for _, k := range keys {
		if at, ok := ParseKey(k); ok && (best == "" || at.After(bestAt)) {
			best, bestAt = k, at
		}
	}
	return best, best != ""
}
