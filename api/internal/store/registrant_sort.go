package store

import (
	"fmt"
	"strings"
)

/* RegistrantOrderSQL is the JOIN and ORDER BY for one page of a webinar's roster.
 *
 * column is a whitelist key. It is never copied into the SQL: a request that
 * sends "name; drop table" is rejected, and the fragments below are constants.
 * An empty column keeps the historical order, newest registration first.
 */
func RegistrantOrderSQL(column string, desc bool) (join, orderBy string, err error) {
	column = strings.ToLower(strings.TrimSpace(column))
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	switch column {
	case "":
		return "", "r.created_at DESC, r.id DESC", nil
	case "name":
		return "", "NULLIF(lower(trim(r.first_name || ' ' || r.last_name)), '') " + dir + " NULLS LAST, r.id ASC", nil
	case "company":
		return "", "NULLIF(lower(trim(r.company)), '') " + dir + " NULLS LAST, r.id ASC", nil
	case "status":
		return "", "lower(r.state) " + dir + " NULLS LAST, r.id ASC", nil
	case "registered":
		return "", "r.created_at " + dir + " NULLS LAST, r.id ASC", nil
	case "watched":
		return "LEFT JOIN (" + WatchByRegistrationSQL("w.slug = $1") + ") wt ON wt.rid = r.id",
			"wt.watch_min " + dir + " NULLS LAST, r.id ASC", nil
	default:
		return "", "", fmt.Errorf("%w: sort", ErrInvalid)
	}
}
