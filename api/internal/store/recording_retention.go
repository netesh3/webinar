package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

/* Recording retention, "Keep longer" and the recording storage quota. The rules are in
 * migrations/0148: recording_expires_at is the one definition of when a session goes, and
 * recording_quota_bytes / recording_used_bytes the one definition of the meter. Every query
 * here takes defaultDays, the deployment's RECORDINGS_RETENTION_DAYS, rather than the store
 * knowing its configuration. */

// RecordingRetention is one session's place in the retention rules.
type RecordingRetention struct {
	ExpiresAt    *time.Time
	Extended     bool
	OverQuota    bool
	RemindersOff bool
}

// RecordingRetentions reads the retention of each session root in ids.
func (s *Store) RecordingRetentions(ctx context.Context, ids []string, defaultDays int) (map[string]RecordingRetention, error) {
	out := map[string]RecordingRetention{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, recording_expires_at(r.id, $2),
		       r.keep_until IS NOT NULL AND r.keep_until > recording_expires_at_default(r.id, $2),
		       r.over_quota, r.reminders_off
		  FROM recordings r
		 WHERE r.id = ANY($1::uuid[]) AND r.parent_id IS NULL`, ids, defaultDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id string
			rr RecordingRetention
		)
		if err := rows.Scan(&id, &rr.ExpiresAt, &rr.Extended, &rr.OverQuota, &rr.RemindersOff); err != nil {
			return nil, err
		}
		out[id] = rr
	}
	return out, rows.Err()
}

// RecordingStorageFor is a host's recording storage meter.
func (s *Store) RecordingStorageFor(ctx context.Context, hostID string, defaultDays int) (types.RecordingStorage, error) {
	var (
		out      types.RecordingStorage
		plan     string
		override *int64
		days     *int
	)
	err := s.pool.QueryRow(ctx, `
		SELECT recording_used_bytes(u.id), recording_quota_bytes(u.id), plan_recording_quota_bytes(u.id),
		       u.recording_quota_bytes, effective_plan(u.id), u.recording_retention_days
		  FROM users u WHERE u.id = $1::uuid`, hostID,
	).Scan(&out.UsedBytes, &out.QuotaBytes, &out.PlanQuotaBytes, &override, &plan, &days)
	if noRows(err) {
		return types.RecordingStorage{}, ErrNotFound
	}
	if err != nil {
		return types.RecordingStorage{}, err
	}
	out.QuotaOverride = override != nil
	out.Plan = types.Plan(plan)
	out.KeepMonths = types.RecordingKeepMonths
	out.RetentionDays = 0
	if defaultDays > 0 {
		out.RetentionDays = defaultDays
		if days != nil {
			out.RetentionDays = *days
		}
	}
	out.OverQuota = out.UsedBytes > out.QuotaBytes
	return out, nil
}

// MarkRecordingOverQuota flags a session root started while its host was over quota.
func (s *Store) MarkRecordingOverQuota(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE recordings SET over_quota = true WHERE id = $1::uuid AND parent_id IS NULL`, id)
	return err
}

// RecordingOwner is what "Keep longer" checks before it moves anything.
type RecordingOwner struct {
	SessionID string
	HostID    string
	Webinar   string
	Topic     string
	ExpiresAt *time.Time
	OverQuota bool
	Ready     bool
}

// RecordingOwnerOf resolves id (a session or any of its takes) to its session and host.
func (s *Store) RecordingOwnerOf(ctx context.Context, id string, defaultDays int) (RecordingOwner, error) {
	var o RecordingOwner
	err := s.pool.QueryRow(ctx, `
		SELECT root.id::text, coalesce(root.owner_id::text, w.host_id::text, ''), coalesce(w.slug, ''),
		       coalesce(nullif(root.title, ''), w.topic, ''),
		       recording_expires_at(root.id, $2), root.over_quota,
		       EXISTS (SELECT 1 FROM recordings c WHERE (c.id = root.id OR c.parent_id = root.id)
		                AND c.status = 'ready' AND c.size_bytes > 0)
		       AND NOT EXISTS (SELECT 1 FROM recordings c WHERE (c.id = root.id OR c.parent_id = root.id)
		                AND c.status = 'recording')
		  FROM recordings t
		  JOIN recordings root ON root.id = coalesce(t.parent_id, t.id)
		  LEFT JOIN webinars w ON w.id = root.webinar_id
		 WHERE t.id = $1::uuid`, id, defaultDays,
	).Scan(&o.SessionID, &o.HostID, &o.Webinar, &o.Topic, &o.ExpiresAt, &o.OverQuota, &o.Ready)
	if noRows(err) {
		return RecordingOwner{}, ErrNotFound
	}
	return o, err
}

/* ExtendRecording moves a session's expiry RecordingKeepMonths past the expiry in effect.
 * onlyIfExpiresAt, when set, makes it a no-op unless the expiry is still that one — what
 * keeps a reused email link from extending twice. Returns the new expiry and whether it
 * moved. Turns reminders back on: a recording somebody keeps is one they care about.
 *
 * The months are added by types.AddMonths (clamped to the target month's end), not by SQL
 * interval arithmetic, so the expiry follows one rule wherever it is computed. The session
 * row is locked while the new expiry is worked out: two keeps at once add twice, in turn. */
func (s *Store) ExtendRecording(ctx context.Context, sessionID string, defaultDays int, onlyIfExpiresAt *time.Time) (time.Time, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return time.Time{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var expires *time.Time
	err = tx.QueryRow(ctx, `
		SELECT recording_expires_at(r.id, $2) FROM recordings r
		 WHERE r.id = $1::uuid AND r.parent_id IS NULL FOR UPDATE`,
		sessionID, defaultDays,
	).Scan(&expires)
	if noRows(err) || (err == nil && expires == nil) {
		// No such session, or a deployment that deletes nothing: there is no expiry to move.
		return time.Time{}, false, ErrNotFound
	}
	if err != nil {
		return time.Time{}, false, err
	}
	if onlyIfExpiresAt != nil && !expires.Truncate(time.Second).Equal(onlyIfExpiresAt.Truncate(time.Second)) {
		return *expires, false, nil
	}
	next := types.AddMonths(*expires, types.RecordingKeepMonths)
	if _, err := tx.Exec(ctx,
		`UPDATE recordings SET keep_until = $2, reminders_off = false WHERE id = $1::uuid`,
		sessionID, next); err != nil {
		return time.Time{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, false, err
	}
	return next, true, nil
}

/* LetRecordingExpire undoes "Keep longer" and stops the reminders: the expiry goes back to
 * the default window, but never sooner than a day from now (so a slip of the finger can still
 * be taken back) and never later than it already was. */
func (s *Store) LetRecordingExpire(ctx context.Context, sessionID string, defaultDays int) (time.Time, error) {
	tag, err := s.pool.Exec(ctx, `
		WITH cur AS (SELECT recording_expires_at($1::uuid, $2) AS at,
		                    recording_expires_at_default($1::uuid, $2) AS base)
		UPDATE recordings r
		   SET keep_until = CASE WHEN cur.base >= LEAST(cur.at, now() + interval '1 day') THEN NULL
		                         ELSE LEAST(cur.at, now() + interval '1 day') END,
		       reminders_off = true
		  FROM cur
		 WHERE r.id = $1::uuid AND r.parent_id IS NULL`, sessionID, defaultDays)
	if err != nil {
		return time.Time{}, err
	}
	if tag.RowsAffected() == 0 {
		return time.Time{}, ErrNotFound
	}
	// Read in a statement of its own: the UPDATE's own snapshot still sees the old keep_until.
	var expires *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT recording_expires_at($1::uuid, $2)`, sessionID, defaultDays).Scan(&expires); err != nil || expires == nil {
		return time.Time{}, err
	}
	return *expires, nil
}

// SetUserRecordingStorage sets (nil: clears) an account's recording quota and retention days.
func (s *Store) SetUserRecordingStorage(ctx context.Context, userID string, quotaBytes *int64, retentionDays *int) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users SET recording_quota_bytes = $2, recording_retention_days = $3 WHERE id = $1::uuid`,
		userID, quotaBytes, retentionDays)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* RecordingSoonestExpiries is, per webinar slug, when its first ready session is deleted:
 * the Completed list's badge. Webinars with nothing ready or nothing expiring are absent. */
func (s *Store) RecordingSoonestExpiries(ctx context.Context, slugs []string, defaultDays int) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	if len(slugs) == 0 || defaultDays <= 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, min(recording_expires_at(r.id, $2))
		  FROM webinars w JOIN recordings r ON r.webinar_id = w.id AND r.parent_id IS NULL
		 WHERE w.slug = ANY($1)
		   AND EXISTS (SELECT 1 FROM recordings c WHERE (c.id = r.id OR c.parent_id = r.id)
		                AND c.status = 'ready' AND c.size_bytes > 0)
		 GROUP BY w.slug`, slugs, defaultDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			slug string
			at   *time.Time
		)
		if err := rows.Scan(&slug, &at); err != nil {
			return nil, err
		}
		if at != nil {
			out[slug] = *at
		}
	}
	return out, rows.Err()
}

// ExpiringRecording is one session coming up on an expiry reminder.
type ExpiringRecording struct {
	ID        string
	HostID    string
	HostName  string
	HostEmail string
	Webinar   string
	Topic     string
	SizeBytes int64
	CreatedAt time.Time
	ExpiresAt time.Time
	Stage     string // "7d" or "1d"
}

/* DueExpiryReminders lists sessions whose expiry is within 7 days (stage 7d) or 1 day (1d)
 * and that have not had that stage's reminder for that expiry, grouped by host (ordered by
 * host, then expiry). A session reaching both at once — kept for less than a week — gets
 * only the 1-day one. Sessions with "Let it expire", nothing ready, or a take still
 * recording are left out, and so is a host with no address. */
func (s *Store) DueExpiryReminders(ctx context.Context, defaultDays, limit int) ([]ExpiringRecording, error) {
	if defaultDays <= 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		WITH roots AS (
		  SELECT r.id, r.created_at, coalesce(w.slug, '') AS slug,
		         coalesce(nullif(r.title, ''), w.topic, '') AS topic, u.id AS host_id, u.name, u.email,
		         recording_expires_at(r.id, $1) AS expires_at,
		         (SELECT coalesce(sum(c.size_bytes), 0) FROM recordings c
		           WHERE (c.id = r.id OR c.parent_id = r.id) AND c.status = 'ready')::bigint AS size
		    FROM recordings r
		    LEFT JOIN webinars w ON w.id = r.webinar_id
		    JOIN users u ON u.id = coalesce(r.owner_id, w.host_id)
		   WHERE r.parent_id IS NULL AND NOT r.reminders_off
		     AND EXISTS (SELECT 1 FROM recordings c WHERE (c.id = r.id OR c.parent_id = r.id)
		                  AND c.status = 'ready' AND c.size_bytes > 0)
		     AND NOT EXISTS (SELECT 1 FROM recordings c WHERE (c.id = r.id OR c.parent_id = r.id)
		                  AND c.status = 'recording')
		), staged AS (
		  SELECT roots.*, CASE WHEN expires_at <= now() + interval '1 day' THEN '1d' ELSE '7d' END AS stage
		    FROM roots
		   WHERE expires_at > now() AND expires_at <= now() + interval '7 days'
		)
		SELECT id::text, host_id::text, name, email, slug, topic, size, created_at, expires_at, stage
		  FROM staged
		 WHERE NOT EXISTS (SELECT 1 FROM recording_expiry_reminders x
		                    WHERE x.recording_id = staged.id AND x.expires_at = staged.expires_at
		                      AND x.stage = staged.stage)
		 ORDER BY host_id, expires_at
		 LIMIT $2`, defaultDays, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (ExpiringRecording, error) {
		var e ExpiringRecording
		err := row.Scan(&e.ID, &e.HostID, &e.HostName, &e.HostEmail, &e.Webinar, &e.Topic,
			&e.SizeBytes, &e.CreatedAt, &e.ExpiresAt, &e.Stage)
		return e, err
	})
}

/* QueueExpiryReminder records the reminders for one host's batch and writes its outbox rows
 * in one transaction. Any recording whose reminder another runner already recorded is
 * dropped from the batch by the primary key; ok=false means none were left, and nothing was
 * written. */
func (s *Store) QueueExpiryReminder(ctx context.Context, batch []ExpiringRecording, msgs func([]ExpiringRecording) []Notification) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var fresh []ExpiringRecording
	for _, e := range batch {
		tag, err := tx.Exec(ctx, `
			INSERT INTO recording_expiry_reminders (recording_id, expires_at, stage)
			VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING`, e.ID, e.ExpiresAt, e.Stage)
		if err != nil {
			return false, err
		}
		if tag.RowsAffected() == 1 {
			fresh = append(fresh, e)
		}
	}
	if len(fresh) == 0 {
		return false, nil
	}
	for _, m := range msgs(fresh) {
		if err := s.Notify(ctx, tx, m); err != nil {
			return false, err
		}
	}
	return true, tx.Commit(ctx)
}
