package crmstore

import (
	"context"

	"github.com/netkumar/webcast/api/internal/store"
)

/* ContactWatchMinutes is each contact's watch minutes for one webinar, keyed by contact
 * id, for the `watched` merge field. Registrations are filed under contacts the way the
 * roster files them (pickContactForRegistration); somebody registered twice keeps the
 * longer of the two.
 */
func (s *Store) ContactWatchMinutes(ctx context.Context, hostID, slug string) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pick.id::text, max(wt.watch_min)
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		  JOIN (`+store.WatchByRegistrationSQL(`w.slug = $2`)+`) wt ON wt.rid = r.id
		  CROSS JOIN LATERAL (`+pickContactForRegistration+`) pick
		 WHERE w.slug = $2 AND w.host_id = $1::uuid
		 GROUP BY pick.id`, hostID, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var (
			id  string
			min int
		)
		if err := rows.Scan(&id, &min); err != nil {
			return nil, err
		}
		out[id] = min
	}
	return out, rows.Err()
}
