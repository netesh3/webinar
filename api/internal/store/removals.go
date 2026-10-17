package store

import "context"

// RecordRemoval notes that the host removed identity from the webinar's room.
// Removing the same person twice moves the timestamp forward.
func (s *Store) RecordRemoval(ctx context.Context, slug, identity string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO room_removals (webinar_id, identity)
		SELECT w.id, $2 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE SET removed_at = now()`, slug, identity)
	return err
}

// WasRemoved reports whether identity was removed from the webinar's current
// run. A removal from before the latest start belongs to an earlier run and does
// not count.
func (s *Store) WasRemoved(ctx context.Context, slug, identity string) (bool, error) {
	var removed bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM room_removals rr
		    JOIN webinars w ON w.id = rr.webinar_id
		   WHERE w.slug = $1 AND rr.identity = $2
		     AND rr.removed_at >= COALESCE(w.started_at, '-infinity'::timestamptz))`,
		slug, identity).Scan(&removed)
	return removed, err
}
