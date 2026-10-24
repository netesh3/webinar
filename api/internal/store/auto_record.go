package store

import "context"

/* "Record automatically" (migrations/0161, api/internal/api/auto_record.go).
 *
 * The claim lives on the webinar row so that every path that may start the recording — the
 * sweeper, the LiveKit webhook, Go live — and every API instance agree that it starts once. */

// AutoRecordPending lists live webinars with "Record automatically" on whose recording has
// not been started yet. A simulive is never recorded, so never listed.
func (s *Store) AutoRecordPending(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug
		  FROM webinars
		 WHERE status = 'live'
		   AND kind <> 'simulive'
		   AND auto_recording_id IS NULL
		   AND COALESCE((options->>'autoRecord')::boolean, false)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var slugs []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		slugs = append(slugs, slug)
	}
	return slugs, rows.Err()
}

// ClaimAutoRecording takes the webinar's one automatic recording for recordingID. Reports
// false when it is already taken, or the webinar is no longer live.
func (s *Store) ClaimAutoRecording(ctx context.Context, slug, recordingID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET auto_recording_id = $2::uuid
		 WHERE (slug = $1 OR id::text = $1)
		   AND status = 'live'
		   AND auto_recording_id IS NULL`, slug, recordingID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ReleaseAutoRecording gives the claim back after a start that failed, so the next pass
// tries again. Only this claim: one that has moved on is not this caller's to clear.
func (s *Store) ReleaseAutoRecording(ctx context.Context, slug, recordingID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE webinars SET auto_recording_id = NULL
		 WHERE (slug = $1 OR id::text = $1)
		   AND auto_recording_id = $2::uuid`, slug, recordingID)
	return err
}

// DiscardUnstartedRecording deletes a row whose recording never started (no egress was
// attached), so a retried automatic start does not leave a failed row in the host's list
// for every attempt.
func (s *Store) DiscardUnstartedRecording(ctx context.Context, recordingID string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM recordings
		 WHERE id = $1::uuid
		   AND (egress_id IS NULL OR egress_id = '')
		   AND size_bytes = 0`, recordingID)
	return err
}

// ActiveRecordingIsAuto reports whether the recording running now is the one "Record
// automatically" started (rather than somebody pressing Record).
func (s *Store) ActiveRecordingIsAuto(ctx context.Context, slug string) (bool, error) {
	var auto bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM recordings r JOIN webinars w ON w.id = r.webinar_id
		   WHERE (w.slug = $1 OR w.id::text = $1)
		     AND r.status = 'recording'
		     AND r.id = w.auto_recording_id)`, slug).Scan(&auto)
	return auto, err
}
