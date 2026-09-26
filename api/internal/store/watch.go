package store

import (
	"context"

	"github.com/netkumar/webcast/api/types"
)

/* Watch time per registration: the session report's number, per person.
 *
 * The report measures an identity; an attendee's identity is "att_" plus their join key,
 * and TouchAttendance links it to the registration. So a registration's minutes are its
 * attendance rows' visits, clipped to the live window and rounded once at the end, the
 * same arithmetic as attendanceWindow and clippedSeconds.
 *
 * Exported as SQL because the CRM resolves the same numbers in its own queries (the
 * People list and the watch-time audience) and must not keep a second copy of the rule.
 */

/* WatchByRegistrationSQL selects (rid, watch_min) for every registration that joined a
 * webinar matching webinarWhere, a condition on `w`. A registration with no row never
 * joined; one with watch_min 0 sat on the waiting screen.
 */
func WatchByRegistrationSQL(webinarWhere string) string {
	return `SELECT a.registration_id AS rid,
	       floor((COALESCE(sum(GREATEST(0, EXTRACT(EPOCH FROM (
	         LEAST(COALESCE(v.left_at, COALESCE(w.ended_at, now())), COALESCE(w.ended_at, now()))
	         - GREATEST(v.joined_at, COALESCE(w.started_at, v.joined_at)))))), 0) + 30) / 60)::int AS watch_min
	  FROM attendance a
	  JOIN webinars w ON w.id = a.webinar_id
	  LEFT JOIN attendance_visits v ON v.webinar_id = a.webinar_id AND v.identity = a.identity
	 WHERE a.registration_id IS NOT NULL AND starts_with(a.identity, 'att_') AND (` + webinarWhere + `)
	 GROUP BY a.registration_id`
}

/* AttachWatch fills in Joined and WatchMin on a webinar's roster rows.
 *
 * Its own query rather than columns on Registrants, which also runs inside a
 * registration request that has no use for them.
 */
func (s *Store) AttachWatch(ctx context.Context, slug string, rows []types.RegistrantRow) error {
	if len(rows) == 0 {
		return nil
	}
	found, err := s.pool.Query(ctx, `
		SELECT wt.rid::text, wt.watch_min FROM (`+WatchByRegistrationSQL(`w.slug = $1`)+`) wt`, slug)
	if err != nil {
		return err
	}
	defer found.Close()
	by := make(map[string]int, len(rows))
	for found.Next() {
		var (
			id  string
			min int
		)
		if err := found.Scan(&id, &min); err != nil {
			return err
		}
		by[id] = min
	}
	if err := found.Err(); err != nil {
		return err
	}
	for i := range rows {
		if min, ok := by[rows[i].ID]; ok {
			rows[i].Joined = true
			rows[i].WatchMin = min
		}
	}
	return nil
}
