package store

import (
	"context"
	"fmt"
	"time"
)

/* Load tests (migrations/0162_load_tests.sql, api/internal/api/admin_loadtest.go). */

// MaxLoadTestViewers is the most viewers one load test may admit (the table's CHECK).
const MaxLoadTestViewers = 5000

// SetLoadTest marks the webinar as a load test admitting `viewers`, or updates the number.
func (s *Store) SetLoadTest(ctx context.Context, slug string, viewers int, adminID string) error {
	if viewers < 1 || viewers > MaxLoadTestViewers {
		return fmt.Errorf("viewers must be 1..%d", MaxLoadTestViewers)
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO load_tests (webinar_id, viewers, enabled_by)
		SELECT id, $2, nullif($3, '')::uuid FROM webinars WHERE slug = $1
		ON CONFLICT (webinar_id) DO UPDATE SET viewers = EXCLUDED.viewers, enabled_by = EXCLUDED.enabled_by`,
		slug, viewers, adminID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClearLoadTest turns the load test off. Not marked is not an error.
func (s *Store) ClearLoadTest(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM load_tests t USING webinars w WHERE t.webinar_id = w.id AND w.slug = $1`, slug)
	return err
}

/* LoadTestViewers is the viewers a load test on this webinar admits, and whether it is one.
 * On the join path, so one primary-key lookup through the slug index. */
func (s *Store) LoadTestViewers(ctx context.Context, slug string) (int, bool, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT t.viewers FROM load_tests t JOIN webinars w ON w.id = t.webinar_id WHERE w.slug = $1`, slug).Scan(&n)
	if noRows(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return n, true, nil
}

// ErrNotLoadTest is a load-test call on a webinar that is not marked as one.
var ErrNotLoadTest = fmt.Errorf("webinar is not a load test")

// ErrLoadTestFull is minting more seats than the load test admits.
var ErrLoadTestFull = fmt.Errorf("load test seats exhausted")

/* AddLoadTestViewers mints n name-only, approved seats ("Load viewer N") on a load-test
 * webinar and returns their join keys. They are guest registrations (migrations/0012): no
 * email, no account, so nothing mails them, the CRM never sees them and no users row is made.
 * They go with the webinar. The webinar's own attendee_limit is not applied (that is what the
 * load test replaces); the load test's viewers is, counting seats minted before. */
func (s *Store) AddLoadTestViewers(ctx context.Context, slug string, n int) ([]string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var webinarID, status string
	var viewers int
	err = tx.QueryRow(ctx, `
		SELECT w.id::text, w.status, coalesce(t.viewers, 0)
		  FROM webinars w LEFT JOIN load_tests t ON t.webinar_id = w.id
		 WHERE w.slug = $1 FOR UPDATE OF w`, slug).Scan(&webinarID, &status, &viewers)
	if noRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if viewers == 0 {
		return nil, ErrNotLoadTest
	}
	if status == "draft" || status == "ended" {
		return nil, ErrNotFound
	}
	var have int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM registrations WHERE webinar_id = $1::uuid AND is_guest AND first_name LIKE 'Load viewer %'`,
		webinarID).Scan(&have); err != nil {
		return nil, err
	}
	if have+n > viewers {
		return nil, ErrLoadTestFull
	}
	keys := make([]string, n)
	for i := range keys {
		keys[i] = newJoinKey()
	}
	// One statement for the batch: a thousand round trips to the database is what makes a
	// thousand-seat mint slow, not the rows.
	if _, err := tx.Exec(ctx, `
		INSERT INTO registrations
			(webinar_id, email, first_name, last_name, company, job_title, country,
			 phone, answers, state, join_key, is_guest, created_at)
		SELECT $1::uuid, '', 'Load viewer ' || ($2::int + k.n), '', '', '', '', '', '{}'::jsonb,
		       'approved', k.key, true, $4
		  FROM unnest($3::text[]) WITH ORDINALITY AS k(key, n)`,
		webinarID, have, keys, time.Now()); err != nil {
		return nil, err
	}
	return keys, tx.Commit(ctx)
}
