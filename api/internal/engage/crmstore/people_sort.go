package crmstore

import (
	"errors"
	"strings"
)

// ErrBadSort is a sort column or direction the People list does not allow.
var ErrBadSort = errors.New("bad sort")

/* PeopleOrderSQL is the ORDER BY for one page of the People tab.
 *
 * column and order are whitelist keys. They are never copied into the SQL.
 * An empty column keeps the historical order: whoever was active most recently.
 * scoped is the webinar filter — attendance is "came, and for how long" on one
 * webinar, and "how many they came to" across all of them.
 */
func PeopleOrderSQL(column, order string, scoped bool) (string, error) {
	column = strings.ToLower(strings.TrimSpace(column))
	if column == "" {
		return "coalesce(c.last_seen_at, c.created_at) DESC, c.id DESC", nil
	}
	dir, err := peopleSortDir(order)
	if err != nil {
		return "", err
	}
	switch column {
	case "name":
		return "NULLIF(lower(trim(c.name)), '') " + dir + " NULLS LAST, c.id ASC", nil
	case "attendance":
		if scoped {
			return "per.attended " + dir + " NULLS LAST, per.watch_min " + dir + " NULLS LAST, c.id ASC", nil
		}
		return "per.attended_webinars " + dir + " NULLS LAST, per.webinars " + dir + " NULLS LAST, c.id ASC", nil
	case "engagement":
		return "ce.avg_score " + dir + " NULLS LAST, c.id ASC", nil
	case "last":
		return "per.last_starts " + dir + " NULLS LAST, c.id ASC", nil
	default:
		return "", ErrBadSort
	}
}

func peopleSortDir(order string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(order)) {
	case "", "asc":
		return "ASC", nil
	case "desc":
		return "DESC", nil
	default:
		return "", ErrBadSort
	}
}
