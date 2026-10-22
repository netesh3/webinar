package store

import (
	"context"
	"encoding/base64"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// Page size for the Attending tab. Larger than the host list's ten: these rows
// are someone else's sessions, read and scrolled past rather than managed.
const (
	DefaultAttendingLimit = 20
	MaxAttendingLimit     = 100
)

/* AttendingFilter narrows and pages AttendingPage. Every field is optional; the
 * zero filter is the first page of everything. */
type AttendingFilter struct {
	// Search matches the topic or the host's name, case-insensitively, anywhere.
	Search string
	// From/To bound starts_at inclusively; zero is unbounded on that side.
	From, To time.Time
	// Limit defaults to DefaultAttendingLimit, capped at MaxAttendingLimit.
	Limit int
	// Cursor is a previous page's NextCursor.
	Cursor string
}

/* attendingPairs is every (webinar, registration) this account can attend: its
 * own registrations, plus every non-draft session of a series it signed up for
 * once — the same expansion expandSeriesRegistrations does for /api/me/
 * registrations, in SQL so the page can be cut before anything is loaded.
 *
 * One row per webinar. When two registrations reach the same session (a
 * direct signup and a series one), the direct one wins, then the oldest.
 */
const attendingPairs = `
	WITH pairs AS (
	  SELECT r.webinar_id AS wid, r.id AS rid, 0 AS pref, r.created_at
	    FROM registrations r
	   WHERE r.user_id = $1
	  UNION ALL
	  SELECT sib.id, r.id, 1, r.created_at
	    FROM registrations r
	    JOIN webinars src ON src.id = r.webinar_id
	    JOIN webinars sib ON sib.series_id = src.series_id
	                     AND sib.id <> src.id AND sib.status <> 'draft'
	   WHERE r.user_id = $1 AND src.series_id IS NOT NULL
	), mine AS (
	  SELECT DISTINCT ON (wid) wid, rid FROM pairs ORDER BY wid, pref, created_at
	)`

/* AttendingPage is one page of the sessions other people host that userID is
 * registered for.
 *
 * Ordered live first, then starts_at descending, slug as the tiebreaker — all
 * three in the keyset. The cursor carries the last row's own values rather than
 * a slug to re-resolve: a session going live between two page reads would
 * otherwise move the anchor itself to the top and repeat the whole first page.
 *
 * A session this account hosts is left out. A host who registered for their own
 * webinar to see the attendee side already has it under Upcoming or Completed.
 */
func (s *Store) AttendingPage(ctx context.Context, userID string, f AttendingFilter) (types.AttendingPage, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultAttendingLimit
	}
	if limit > MaxAttendingLimit {
		limit = MaxAttendingLimit
	}

	args := []any{userID}
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	where := " WHERE w.host_id <> $1"
	if !f.From.IsZero() {
		where += " AND w.starts_at >= " + arg(f.From)
	}
	if !f.To.IsZero() {
		where += " AND w.starts_at <= " + arg(f.To)
	}
	if q := strings.TrimSpace(f.Search); q != "" {
		p := arg("%" + likeLiteral(q) + "%")
		where += " AND (w.topic ILIKE " + p + ` ESCAPE '\' OR h.name ILIKE ` + p + ` ESCAPE '\')`
	}
	countArgs := slices.Clone(args)
	countWhere := where

	if f.Cursor != "" {
		c, err := decodeAttendingCursor(f.Cursor)
		if err != nil {
			return types.AttendingPage{}, err
		}
		where += " AND ((w.status = 'live')::int, w.starts_at, w.slug) < (" +
			arg(c.pin) + "::int, " + arg(c.startsAt) + "::timestamptz, " + arg(c.slug) + "::text)"
	}

	const from = ` FROM mine m JOIN webinars w ON w.id = m.wid JOIN users h ON h.id = w.host_id`

	type key struct {
		slug     string
		rid      string
		pin      int
		startsAt time.Time
	}
	var (
		keys  []key
		total int
	)
	if err := RunParallel(ctx,
		func(ctx context.Context) error {
			rows, err := s.pool.Query(ctx, attendingPairs+`
				SELECT w.slug, m.rid::text, (w.status = 'live')::int, w.starts_at`+from+where+`
				 ORDER BY (w.status = 'live')::int DESC, w.starts_at DESC, w.slug DESC
				 LIMIT `+strconv.Itoa(limit+1), args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var k key
				if err := rows.Scan(&k.slug, &k.rid, &k.pin, &k.startsAt); err != nil {
					return err
				}
				keys = append(keys, k)
			}
			return rows.Err()
		},
		func(ctx context.Context) error {
			return s.pool.QueryRow(ctx, attendingPairs+`SELECT count(*)`+from+countWhere, countArgs...).Scan(&total)
		},
	); err != nil {
		return types.AttendingPage{}, err
	}

	more := len(keys) > limit
	if more {
		keys = keys[:limit]
	}
	page := types.AttendingPage{Items: []types.RegisteredWebinar{}, Total: total}
	if len(keys) == 0 {
		return page, nil
	}

	slugs := make([]string, 0, len(keys))
	rids := make([]string, 0, len(keys))
	for _, k := range keys {
		slugs = append(slugs, k.slug)
		rids = append(rids, k.rid)
	}
	var (
		webinars []types.Webinar
		regs     = map[string]types.Registration{}
	)
	if err := RunParallel(ctx,
		func(ctx context.Context) error {
			var err error
			webinars, err = s.queryWebinars(ctx, ` WHERE w.slug = ANY($1)`, slugs)
			return err
		},
		func(ctx context.Context) error {
			rows, err := s.pool.Query(ctx, `
				SELECT `+registrationColumns+`
				  FROM registrations r
				  JOIN webinars w ON w.id = r.webinar_id
				 WHERE r.id = ANY($1::uuid[])`, rids)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				reg, err := scanRegistration(rows)
				if err != nil {
					return err
				}
				regs[reg.ID] = reg
			}
			return rows.Err()
		},
	); err != nil {
		return types.AttendingPage{}, err
	}
	bySlug := make(map[string]types.Webinar, len(webinars))
	for _, w := range webinars {
		bySlug[w.ID] = w
	}
	for _, k := range keys {
		w, okW := bySlug[k.slug]
		reg, okR := regs[k.rid]
		if !okW || !okR {
			continue // deleted between the two reads
		}
		// A series signup is stored once, against one session; each sibling row
		// carries it under its own slug, as /api/me/registrations does.
		reg.WebinarID = w.ID
		page.Items = append(page.Items, types.RegisteredWebinar{Webinar: w, Registration: reg})
	}
	if more {
		last := keys[len(keys)-1]
		page.NextCursor = encodeAttendingCursor(attendingCursor{pin: last.pin, startsAt: last.startsAt, slug: last.slug})
	}
	return page, nil
}

type attendingCursor struct {
	pin      int
	startsAt time.Time
	slug     string
}

func encodeAttendingCursor(c attendingCursor) string {
	raw := fmt.Sprintf("%d|%d|%s", c.pin, c.startsAt.UnixMicro(), c.slug)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeAttendingCursor(cursor string) (attendingCursor, error) {
	bad := fmt.Errorf("%w: cursor is not one this server issued", ErrInvalid)
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return attendingCursor{}, bad
	}
	parts := strings.SplitN(string(raw), "|", 3)
	if len(parts) != 3 || parts[2] == "" {
		return attendingCursor{}, bad
	}
	pin, err1 := strconv.Atoi(parts[0])
	micro, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || (pin != 0 && pin != 1) {
		return attendingCursor{}, bad
	}
	return attendingCursor{pin: pin, startsAt: time.UnixMicro(micro).UTC(), slug: parts[2]}, nil
}
