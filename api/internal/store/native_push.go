package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

/* Native push: the Android and iOS apps' FCM tokens, and their half of the push outbox
 * (29 Oct 2026). See migrations/0174_native_push_tokens.sql for the shape. The fan-outs in
 * push.go write rows for both browsers and installs; these are the install side's claim and
 * outcomes, the same as the browser side's with a token where the endpoint was. */

/* SaveNativePushToken upserts an install by token. The owner becomes userID (the install
 * belongs to whoever registered it last), and failures and backoff are forgotten: it just
 * proved it is there. */
func (s *Store) SaveNativePushToken(ctx context.Context, userID, platform, token, appVersion string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO native_push_tokens (user_id, platform, token, app_version)
		VALUES ($1::uuid, $2, $3, left($4, 64))
		ON CONFLICT (token) DO UPDATE SET
		       user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
		       app_version = EXCLUDED.app_version,
		       failures = 0, next_attempt_at = NULL, updated_at = now()`,
		userID, platform, token, appVersion)
	return err
}

// RemoveNativePushToken deletes an install the caller owns. ErrNotFound when it is not theirs.
func (s *Store) RemoveNativePushToken(ctx context.Context, userID, token string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM native_push_tokens WHERE token = $1 AND user_id = $2::uuid`, token, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClaimedNativePush is one message, claimed for sending, with its install.
type ClaimedNativePush struct {
	ID       string
	TokenID  string
	Token    string
	Platform string
	Kind     types.PushKind
	Title    string
	Body     string
	URL      string
	Tag      string
	Urgency  string
	TTL      time.Duration
	Attempts int
	// Data and DataOnly are PushMessage's (31 Oct 2026).
	Data     map[string]string
	DataOnly bool
}

// ClaimDueNativePush is ClaimDuePush for installs: the same lease, order and expiry.
func (s *Store) ClaimDueNativePush(ctx context.Context, limit int) ([]ClaimedNativePush, error) {
	if _, err := s.pool.Exec(ctx, `
		UPDATE push_messages SET state = 'expired', claimed_until = NULL
		 WHERE state = 'pending' AND native_token_id IS NOT NULL
		   AND due_at + make_interval(secs => ttl_sec) < now()`); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		WITH due AS (
		    SELECT m.id
		      FROM push_messages m JOIN native_push_tokens t ON t.id = m.native_token_id
		     WHERE m.state = 'pending' AND m.due_at <= now()
		       AND (m.claimed_until IS NULL OR m.claimed_until < now())
		       AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= now())
		     ORDER BY (m.urgency = 'high') DESC, m.due_at
		     LIMIT $1
		       FOR UPDATE OF m SKIP LOCKED
		)
		UPDATE push_messages m
		   SET claimed_until = now() + interval '2 minutes', attempts = m.attempts + 1
		  FROM due, native_push_tokens t
		 WHERE m.id = due.id AND t.id = m.native_token_id
		RETURNING m.id::text, t.id::text, t.token, t.platform,
		          m.kind, m.title, m.body, m.url, m.tag, m.urgency,
		          greatest(0, extract(epoch FROM m.due_at + make_interval(secs => m.ttl_sec) - now()))::int,
		          m.attempts, m.data, m.data_only`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ClaimedNativePush
	for rows.Next() {
		var c ClaimedNativePush
		var kind string
		var ttl int
		var data []byte
		if err := rows.Scan(&c.ID, &c.TokenID, &c.Token, &c.Platform,
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

// NativePushSent records a delivery: the message is done and the install is healthy again.
func (s *Store) NativePushSent(ctx context.Context, messageID, tokenID string) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE push_messages SET state = 'sent', sent_at = now(), claimed_until = NULL, last_error = ''
		 WHERE id = $1`, messageID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE native_push_tokens SET last_ok_at = now(), failures = 0, next_attempt_at = NULL
		 WHERE id = $1`, tokenID)
	return err
}

// NativePushGone deletes an install FCM no longer knows, and everything still queued for it.
func (s *Store) NativePushGone(ctx context.Context, tokenID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM native_push_tokens WHERE id = $1`, tokenID)
	return err
}

// NativePushRetry is PushRetry for an install.
func (s *Store) NativePushRetry(ctx context.Context, messageID, tokenID, reason string, rest time.Duration) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE push_messages
		   SET claimed_until = NULL, last_error = left($2, 500),
		       state = CASE WHEN attempts >= $3 THEN 'failed' ELSE state END
		 WHERE id = $1`, messageID, reason, MaxPushAttempts); err != nil {
		return err
	}
	var failures int
	err := s.pool.QueryRow(ctx, `
		UPDATE native_push_tokens
		   SET failures = failures + 1, next_attempt_at = now() + make_interval(secs => $2)
		 WHERE id = $1
		RETURNING failures`, tokenID, rest.Seconds()).Scan(&failures)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if failures >= maxPushFailures {
		return s.NativePushGone(ctx, tokenID)
	}
	return nil
}

// NativePushFailures is an install's consecutive failure count (0 when it is gone).
func (s *Store) NativePushFailures(ctx context.Context, tokenID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT failures FROM native_push_tokens WHERE id = $1`, tokenID).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

// VoIPToken is one iOS install's PushKit token (platform 'ios_voip', 31 Oct 2026).
type VoIPToken struct {
	ID    string
	Token string
}

/* NativeVoIPTokens lists an account's iOS VoIP tokens, newest first, for ringing an incoming
 * call (api/push_voip.go). The outbox never sends to these (migrations/0176). */
func (s *Store) NativeVoIPTokens(ctx context.Context, userID string) ([]VoIPToken, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, token FROM native_push_tokens
		 WHERE user_id = $1::uuid AND platform = 'ios_voip'
		 ORDER BY updated_at DESC
		 LIMIT 20`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VoIPToken
	for rows.Next() {
		var t VoIPToken
		if err := rows.Scan(&t.ID, &t.Token); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// NativeVoIPSent records that APNs took a call push for this token.
func (s *Store) NativeVoIPSent(ctx context.Context, tokenID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE native_push_tokens SET last_ok_at = now(), failures = 0 WHERE id = $1`, tokenID)
	return err
}
