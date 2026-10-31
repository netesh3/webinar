package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

/* Web Push: subscriptions, the per-account preferences, and the outbox the tick drains.
 * See migrations/0150_push_subscriptions.sql for the shape and api/push.go for who calls what. */

// MaxPushAttempts is how many times one message is tried before it is given up on.
const MaxPushAttempts = 5

// maxPushFailures is how many consecutive failures, with no success in between, retire an
// endpoint. At the backoff's one-hour cap that is most of a day of a push service failing.
const maxPushFailures = 20

// PushSubscription is a browser to subscribe: the endpoint and keys it handed the page.
type PushSubscription struct {
	Endpoint  string
	P256dh    string
	Auth      string
	UserAgent string
	// UserID owns it when the browser is signed in; empty for a guest registrant.
	UserID string
	// RegistrationID scopes it to one registration (a guest's opt-in); empty for none.
	RegistrationID string
}

/* SavePushSubscription upserts a browser by endpoint and links it to the registration, if any.
 *
 * The keys always take the new values (a browser that re-subscribed has new ones), failures
 * and backoff are forgotten (it just proved it is there), and the owner becomes the signed-in
 * account when there is one — the browser belongs to whoever subscribed it last. A guest
 * subscribe leaves an existing owner in place. */
func (s *Store) SavePushSubscription(ctx context.Context, sub PushSubscription) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, user_id)
		VALUES ($1, $2, $3, left($4, 300), nullif($5, '')::uuid)
		ON CONFLICT (endpoint) DO UPDATE SET
		       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
		       user_agent = EXCLUDED.user_agent,
		       user_id = coalesce(EXCLUDED.user_id, push_subscriptions.user_id),
		       failures = 0, next_attempt_at = NULL, updated_at = now()
		RETURNING id::text`,
		sub.Endpoint, sub.P256dh, sub.Auth, sub.UserAgent, sub.UserID).Scan(&id); err != nil {
		return err
	}
	if sub.RegistrationID != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO push_subscription_registrations (subscription_id, registration_id)
			VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, sub.RegistrationID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

/* RenewPushSubscription moves a subscription to the endpoint its push service replaced it
 * with, keeping its owner and registrations. False when the old endpoint is unknown. If the new
 * endpoint is somehow already a row, the old one is folded into it. */
func (s *Store) RenewPushSubscription(ctx context.Context, oldEndpoint, endpoint, p256dh, auth string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var oldID, oldUser string
	err = tx.QueryRow(ctx, `SELECT id::text, coalesce(user_id::text, '') FROM push_subscriptions WHERE endpoint = $1 FOR UPDATE`,
		oldEndpoint).Scan(&oldID, &oldUser)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var newID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM push_subscriptions WHERE endpoint = $1 FOR UPDATE`, endpoint).Scan(&newID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if _, err := tx.Exec(ctx, `
			UPDATE push_subscriptions SET endpoint = $2, p256dh = $3, auth = $4,
			       failures = 0, next_attempt_at = NULL, updated_at = now()
			 WHERE id = $1`, oldID, endpoint, p256dh, auth); err != nil {
			return false, err
		}
	case err != nil:
		return false, err
	default:
		if _, err := tx.Exec(ctx, `
			INSERT INTO push_subscription_registrations (subscription_id, registration_id)
			SELECT $2, registration_id FROM push_subscription_registrations WHERE subscription_id = $1
			ON CONFLICT DO NOTHING`, oldID, newID); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE push_subscriptions SET p256dh = $2, auth = $3,
			       user_id = coalesce(user_id, nullif($4, '')::uuid), updated_at = now()
			 WHERE id = $1`, newID, p256dh, auth, oldUser); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, oldID); err != nil {
			return false, err
		}
	}
	return true, tx.Commit(ctx)
}

/* RemovePushSubscription is an unsubscribe.
 *
 * With a registration, only that link goes. Otherwise a signed-in caller (userID) removes the
 * endpoint if it is theirs or nobody's, and a guest removes it only if nobody owns it — a
 * browser somebody is signed in on is that account's to turn off. Either way a subscription
 * left with no owner and no registration is deleted: nothing would ever be sent to it.
 * ErrNotFound when there was nothing the caller may remove. */
func (s *Store) RemovePushSubscription(ctx context.Context, endpoint, userID, registrationID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var n int64
	if registrationID != "" {
		tag, err := tx.Exec(ctx, `
			DELETE FROM push_subscription_registrations l
			 USING push_subscriptions s
			 WHERE l.subscription_id = s.id AND s.endpoint = $1 AND l.registration_id = $2`,
			endpoint, registrationID)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
	} else {
		tag, err := tx.Exec(ctx, `
			DELETE FROM push_subscriptions
			 WHERE endpoint = $1 AND (user_id IS NULL OR user_id = nullif($2, '')::uuid)`,
			endpoint, userID)
		if err != nil {
			return err
		}
		n = tag.RowsAffected()
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM push_subscriptions s
		 WHERE s.endpoint = $1 AND s.user_id IS NULL
		   AND NOT EXISTS (SELECT 1 FROM push_subscription_registrations l WHERE l.subscription_id = s.id)`,
		endpoint); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// PushDeviceCount is how many browsers, and app installs (native_push_tokens), an account is
// subscribed on. An iOS install's VoIP token is the same phone as its FCM token: not counted.
func (s *Store) PushDeviceCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM push_subscriptions WHERE user_id = $1)
		     + (SELECT count(*) FROM native_push_tokens WHERE user_id = $1 AND platform <> 'ios_voip')`, userID).Scan(&n)
	return n, err
}

// PushPreferences is the account's opt-outs: kind → enabled, for the kinds with a row.
func (s *Store) PushPreferences(ctx context.Context, userID string) (map[types.PushKind]bool, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT kind, enabled FROM push_preferences WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[types.PushKind]bool{}
	for rows.Next() {
		var k string
		var on bool
		if err := rows.Scan(&k, &on); err != nil {
			return nil, err
		}
		out[types.PushKind(k)] = on
	}
	return out, rows.Err()
}

// SetPushPreferences writes the given kinds; the rest are left as they were.
func (s *Store) SetPushPreferences(ctx context.Context, userID string, prefs map[types.PushKind]bool) error {
	batch := &pgx.Batch{}
	for k, on := range prefs {
		batch.Queue(`
			INSERT INTO push_preferences (user_id, kind, enabled) VALUES ($1, $2, $3)
			ON CONFLICT (user_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled`,
			userID, string(k), on)
	}
	if batch.Len() == 0 {
		return nil
	}
	return s.pool.SendBatch(ctx, batch).Close()
}

// ------------------------------------------------------------------ the outbox

/* PushMessage is one notification to fan out. URL may contain "{joinKey}", which a fan-out to
 * registrants replaces with each registrant's own key (their personal join link). */
type PushMessage struct {
	Kind    types.PushKind
	Title   string
	Body    string
	URL     string
	Tag     string
	Urgency string
	TTL     time.Duration
	// DedupeKey makes the fan-out idempotent: a browser holds at most one message with it.
	// Empty means no deduplication.
	DedupeKey string
	// DueAt zero means now.
	DueAt time.Time
	/* NoWeb and NoNative leave one channel out of the fan-out: the API sets them when that
	 * channel's sender is not configured (no VAPID keys, no FCM key), so nothing is queued
	 * that nothing would send. (29 Oct 2026) */
	NoWeb    bool
	NoNative bool
	/* Data is machine data the receiver acts on (31 Oct 2026, calling): the web push payload
	 * carries it as "data", and the apps get it as FCM data next to url and kind. DataOnly
	 * makes the apps' message a high-priority FCM data message with no notification block,
	 * so the app draws its own UI (a ringing screen) instead of the system drawing a banner;
	 * see push.NativeMessage.DataOnly. Browsers ignore DataOnly: the service worker always
	 * decides what to show. */
	Data     map[string]string
	DataOnly bool
	/* SkipIOSWithVoIP leaves out the iOS FCM tokens of an account that has an iOS VoIP token
	 * (31 Oct 2026): an incoming call rings those iPhones through PushKit and CallKit
	 * (api/push_voip.go), and FCM's "is calling" banner would ring them twice. Only
	 * QueuePushToUsers reads it. */
	SkipIOSWithVoIP bool
}

func (m PushMessage) args() []any {
	urgency := m.Urgency
	if urgency == "" {
		urgency = "normal"
	}
	var due *time.Time
	if !m.DueAt.IsZero() {
		due = &m.DueAt
	}
	var dedupe *string
	if m.DedupeKey != "" {
		dedupe = &m.DedupeKey
	}
	url := m.URL
	if url == "" {
		url = "/"
	}
	var data []byte
	if len(m.Data) > 0 {
		data, _ = json.Marshal(m.Data)
	}
	return []any{string(m.Kind), m.Title, m.Body, url, m.Tag, urgency, int(m.TTL / time.Second), dedupe, due,
		data, m.DataOnly}
}

// The INSERT both fan-outs end in. $1..$11 are PushMessage.args; the source provides sid and
// join_key (empty when there is none to put in the URL).
const pushInsertSQL = `
	INSERT INTO push_messages (subscription_id, kind, title, body, url, tag, urgency, ttl_sec, dedupe_key, due_at,
	                           data, data_only)
	SELECT DISTINCT ON (t.sid) t.sid, $1, $2, $3, replace($4, '{joinKey}', t.join_key), $5, $6, $7, $8,
	       coalesce($9::timestamptz, now()), $10::jsonb, $11
	  FROM targets t
	 ORDER BY t.sid
	ON CONFLICT (subscription_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`

// The same for app installs: the source provides tid (a native_push_tokens id) and join_key.
const pushNativeInsertSQL = `
	INSERT INTO push_messages (native_token_id, kind, title, body, url, tag, urgency, ttl_sec, dedupe_key, due_at,
	                           data, data_only)
	SELECT DISTINCT ON (t.tid) t.tid, $1, $2, $3, replace($4, '{joinKey}', t.join_key), $5, $6, $7, $8,
	       coalesce($9::timestamptz, now()), $10::jsonb, $11
	  FROM targets t
	 ORDER BY t.tid
	ON CONFLICT (native_token_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND native_token_id IS NOT NULL DO NOTHING`

// pushReachableReg is which registrations r (of webinar w) a registrant push may reach: the
// approved ones, and a meeting's lobby knocks (QueuePushToRegistrants).
const pushReachableReg = `(r.state = 'approved' OR (w.kind = 'meeting' AND r.state = 'pending'))`

/* QueuePushToRegistrants fans a message out to the approved registrants of a webinar — all of
 * them, or only registrationIDs when that is non-nil — and returns how many browsers got a row.
 *
 * A registrant is reached on the browsers they opted in from the confirmation page (the
 * registration links, which are that webinar's explicit "tell me" and so are sent whatever
 * the account's settings say), and on their account's browsers when the registration has an
 * account and the account has not turned this kind off. The account's app installs
 * (native_push_tokens) are reached the same way as its browsers.
 *
 * A meeting's guests waiting in the lobby count too (31 Oct 2026): a knock is 'pending' until
 * the host admits it, so somebody who knocked on a scheduled meeting before it began, and
 * opted in from the waiting screen, is told it started (and reminded 15 minutes ahead). A
 * webinar's 'pending' is a registration awaiting approval, which is still not told. */
func (s *Store) QueuePushToRegistrants(ctx context.Context, slug string, registrationIDs []string, m PushMessage) (int, error) {
	args := append(m.args(), slug, registrationIDs)
	const regs = `
		WITH regs AS (
		    SELECT r.id, r.user_id, r.join_key
		      FROM registrations r JOIN webinars w ON w.id = r.webinar_id
		     WHERE w.slug = $12 AND ` + pushReachableReg + `
		       AND ($13::uuid[] IS NULL OR r.id = ANY($13::uuid[]))
		)`
	total := 0
	if !m.NoWeb {
		tag, err := s.pool.Exec(ctx, regs+`, targets AS (
		    SELECT l.subscription_id AS sid, regs.join_key
		      FROM regs JOIN push_subscription_registrations l ON l.registration_id = regs.id
		    UNION ALL
		    SELECT ps.id, regs.join_key
		      FROM regs JOIN push_subscriptions ps ON ps.user_id = regs.user_id
		     WHERE NOT EXISTS (SELECT 1 FROM push_preferences p
		                        WHERE p.user_id = regs.user_id AND p.kind = $1 AND NOT p.enabled)
		)`+pushInsertSQL, args...)
		if err != nil {
			return 0, err
		}
		total += int(tag.RowsAffected())
	}
	if !m.NoNative {
		// An app install is always an account's, so only the account half applies.
		tag, err := s.pool.Exec(ctx, regs+`, targets AS (
		    SELECT t.id AS tid, regs.join_key
		      FROM regs JOIN native_push_tokens t ON t.user_id = regs.user_id AND t.platform <> 'ios_voip'
		     WHERE NOT EXISTS (SELECT 1 FROM push_preferences p
		                        WHERE p.user_id = regs.user_id AND p.kind = $1 AND NOT p.enabled)
		)`+pushNativeInsertSQL, args...)
		if err != nil {
			return total, err
		}
		total += int(tag.RowsAffected())
	}
	return total, nil
}

/* QueuePushToUsers fans a message out to the browsers and app installs of these accounts that
 * have not turned the kind off. A test notification ignores the preferences: it was asked for. */
func (s *Store) QueuePushToUsers(ctx context.Context, userIDs []string, m PushMessage) (int, error) {
	if len(userIDs) == 0 {
		return 0, nil
	}
	args := append(m.args(), userIDs)
	total := 0
	if !m.NoWeb {
		tag, err := s.pool.Exec(ctx, `
			WITH targets AS (
			    SELECT ps.id AS sid, ''::text AS join_key
			      FROM push_subscriptions ps
			     WHERE ps.user_id = ANY($12::uuid[])
			       AND ($1 = 'test' OR NOT EXISTS (SELECT 1 FROM push_preferences p
			                        WHERE p.user_id = ps.user_id AND p.kind = $1 AND NOT p.enabled))
			)`+pushInsertSQL, args...)
		if err != nil {
			return 0, err
		}
		total += int(tag.RowsAffected())
	}
	if !m.NoNative {
		nargs := append(append([]any{}, args...), m.SkipIOSWithVoIP)
		tag, err := s.pool.Exec(ctx, `
			WITH targets AS (
			    SELECT t.id AS tid, ''::text AS join_key
			      FROM native_push_tokens t
			     WHERE t.user_id = ANY($12::uuid[]) AND t.platform <> 'ios_voip'
			       AND NOT ($13::boolean AND t.platform = 'ios' AND EXISTS (
			               SELECT 1 FROM native_push_tokens v WHERE v.user_id = t.user_id AND v.platform = 'ios_voip'))
			       AND ($1 = 'test' OR NOT EXISTS (SELECT 1 FROM push_preferences p
			                        WHERE p.user_id = t.user_id AND p.kind = $1 AND NOT p.enabled))
			)`+pushNativeInsertSQL, nargs...)
		if err != nil {
			return total, err
		}
		total += int(tag.RowsAffected())
	}
	return total, nil
}

// PushReminderWebinar is a webinar whose 15-minute push is due.
type PushReminderWebinar struct {
	Slug     string
	Topic    string
	Kind     types.WebinarKind
	StartsAt time.Time
}

/* DuePushReminders lists the scheduled webinars starting within `window` that have somebody to
 * tell — an approved registrant with a linked browser or an account with one. The fan-out is
 * deduplicated, so a webinar listed on every pass of its window is told once. */
func (s *Store) DuePushReminders(ctx context.Context, window time.Duration) ([]PushReminderWebinar, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.topic, w.kind, w.starts_at
		  FROM webinars w
		 WHERE w.status = 'scheduled' AND w.starts_at > now()
		   AND w.starts_at <= now() + make_interval(secs => $1)
		   AND EXISTS (
		         SELECT 1 FROM registrations r
		          WHERE r.webinar_id = w.id AND `+pushReachableReg+`
		            AND (EXISTS (SELECT 1 FROM push_subscription_registrations l WHERE l.registration_id = r.id)
		                 OR EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = r.user_id)
		                 OR EXISTS (SELECT 1 FROM native_push_tokens t WHERE t.user_id = r.user_id AND t.platform <> 'ios_voip')))
		 ORDER BY w.starts_at
		 LIMIT 200`, window.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PushReminderWebinar
	for rows.Next() {
		var w PushReminderWebinar
		var kind string
		if err := rows.Scan(&w.Slug, &w.Topic, &kind, &w.StartsAt); err != nil {
			return nil, err
		}
		w.Kind = types.WebinarKind(kind)
		out = append(out, w)
	}
	return out, rows.Err()
}

// ClaimedPush is one message, claimed for sending, with its browser.
type ClaimedPush struct {
	ID             string
	SubscriptionID string
	Endpoint       string
	P256dh         string
	Auth           string
	Kind           types.PushKind
	Title          string
	Body           string
	URL            string
	Tag            string
	Urgency        string
	// TTL is what is left of the message's time to live.
	TTL      time.Duration
	Attempts int
	// Data and DataOnly are PushMessage's (31 Oct 2026).
	Data     map[string]string
	DataOnly bool
}

/* ClaimDuePush takes up to limit due messages for sending, high urgency first.
 *
 * A claim is a two-minute lease (claimed_until), taken with SKIP LOCKED, so the in-process
 * ticker and an /internal/tick on another instance never send one message twice. Messages
 * to an endpoint that is backing off are left where they are, and messages whose time to live
 * has run out are retired first: a "starting now" an hour late is worse than none. */
func (s *Store) ClaimDuePush(ctx context.Context, limit int) ([]ClaimedPush, error) {
	if _, err := s.pool.Exec(ctx, `
		UPDATE push_messages SET state = 'expired', claimed_until = NULL
		 WHERE state = 'pending' AND due_at + make_interval(secs => ttl_sec) < now()`); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		WITH due AS (
		    SELECT m.id
		      FROM push_messages m JOIN push_subscriptions ps ON ps.id = m.subscription_id
		     WHERE m.state = 'pending' AND m.due_at <= now()
		       AND (m.claimed_until IS NULL OR m.claimed_until < now())
		       AND (ps.next_attempt_at IS NULL OR ps.next_attempt_at <= now())
		     ORDER BY (m.urgency = 'high') DESC, m.due_at
		     LIMIT $1
		       FOR UPDATE OF m SKIP LOCKED
		)
		UPDATE push_messages m
		   SET claimed_until = now() + interval '2 minutes', attempts = m.attempts + 1
		  FROM due, push_subscriptions ps
		 WHERE m.id = due.id AND ps.id = m.subscription_id
		RETURNING m.id::text, m.subscription_id::text, ps.endpoint, ps.p256dh, ps.auth,
		          m.kind, m.title, m.body, m.url, m.tag, m.urgency,
		          greatest(0, extract(epoch FROM m.due_at + make_interval(secs => m.ttl_sec) - now()))::int,
		          m.attempts, m.data, m.data_only`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClaimedPush
	for rows.Next() {
		var c ClaimedPush
		var kind string
		var ttl int
		var data []byte
		if err := rows.Scan(&c.ID, &c.SubscriptionID, &c.Endpoint, &c.P256dh, &c.Auth,
			&kind, &c.Title, &c.Body, &c.URL, &c.Tag, &c.Urgency, &ttl, &c.Attempts, &data, &c.DataOnly); err != nil {
			return nil, err
		}
		c.Data = pushData(data)
		c.Kind = types.PushKind(kind)
		c.TTL = time.Duration(ttl) * time.Second
		out = append(out, c)
	}
	return out, rows.Err()
}

// pushData reads push_messages.data: a JSON object of strings, or nothing.
func pushData(raw []byte) map[string]string {
	if len(raw) == 0 {
		return nil
	}
	var out map[string]string
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

// PushSent records a delivery: the message is done and the endpoint is healthy again.
func (s *Store) PushSent(ctx context.Context, messageID, subscriptionID string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE push_messages SET state = 'sent', sent_at = now(), claimed_until = NULL, last_error = ''
		 WHERE id = $1`, messageID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE push_subscriptions SET last_ok_at = now(), failures = 0, next_attempt_at = NULL
		 WHERE id = $1`, subscriptionID)
	return err
}

// PushGone deletes a subscription the push service no longer knows (404/410), and with it
// everything still queued for it.
func (s *Store) PushGone(ctx context.Context, subscriptionID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, subscriptionID)
	return err
}

// PushDropped gives up on one message the push service refused for good.
func (s *Store) PushDropped(ctx context.Context, messageID, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE push_messages SET state = 'failed', claimed_until = NULL, last_error = left($2, 500)
		 WHERE id = $1`, messageID, reason)
	return err
}

/* PushRetry backs an endpoint off after a transient failure: rest is how long, and the message
 * goes back in the queue unless it has had its MaxPushAttempts. An endpoint that has failed
 * maxPushFailures times in a row with no success is retired. */
func (s *Store) PushRetry(ctx context.Context, messageID, subscriptionID, reason string, rest time.Duration) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE push_messages
		   SET claimed_until = NULL, last_error = left($2, 500),
		       state = CASE WHEN attempts >= $3 THEN 'failed' ELSE state END
		 WHERE id = $1`, messageID, reason, MaxPushAttempts); err != nil {
		return err
	}
	var failures int
	err := s.pool.QueryRow(ctx, `
		UPDATE push_subscriptions
		   SET failures = failures + 1, next_attempt_at = now() + make_interval(secs => $2)
		 WHERE id = $1
		RETURNING failures`, subscriptionID, rest.Seconds()).Scan(&failures)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if failures >= maxPushFailures {
		return s.PushGone(ctx, subscriptionID)
	}
	return nil
}

// PushRelease puts a claimed message back unsent, without counting it as an attempt.
func (s *Store) PushRelease(ctx context.Context, messageID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE push_messages SET claimed_until = NULL, attempts = greatest(0, attempts - 1)
		 WHERE id = $1 AND state = 'pending'`, messageID)
	return err
}

// PushFailures is an endpoint's consecutive failure count (0 when it is gone).
func (s *Store) PushFailures(ctx context.Context, subscriptionID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT failures FROM push_subscriptions WHERE id = $1`, subscriptionID).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

// PrunePushMessages deletes finished messages older than before, in bounded batches.
func (s *Store) PrunePushMessages(ctx context.Context, before time.Time, batch int) (int64, error) {
	var total int64
	for {
		tag, err := s.pool.Exec(ctx, `
			DELETE FROM push_messages WHERE id IN (
			  SELECT id FROM push_messages WHERE state <> 'pending' AND created_at < $1 LIMIT $2)`,
			before, batch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < int64(batch) || ctx.Err() != nil {
			return total, nil
		}
	}
}

// LobbyNotifyUserIDs are the accounts told about a knock: the meeting's host, and any account
// a host made co-host of it.
func (s *Store) LobbyNotifyUserIDs(ctx context.Context, slug string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.host_id::text FROM webinars w WHERE w.slug = $1 AND w.host_id IS NOT NULL
		UNION
		SELECT u.id::text
		  FROM webinar_stage_grants g
		  JOIN webinars w ON w.id = g.webinar_id
		  JOIN users u ON g.identity = 'user_' || u.id::text
		 WHERE w.slug = $1 AND g.co_host`, slug)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
