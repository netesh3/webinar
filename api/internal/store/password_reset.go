package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/auth"
)

// How long a reset link works. The mail says the same number. Shorter than the
// verification link's day, because this one ends with the holder signed in.
const PasswordResetTTL = time.Hour

var (
	// ErrResetExpired is a reset link that was real and was not used in time.
	ErrResetExpired = errors.New("password reset token expired")
	// ErrResetUsed is a reset link that already set a password, or was replaced by a newer one.
	ErrResetUsed = errors.New("password reset token used")
)

// PasswordResetHash is what gets stored. The raw token never does — the same rule, and
// the same hash, as the verification link.
func PasswordResetHash(raw string) string { return EmailVerifyHash(raw) }

/* IssuePasswordReset mints a single-use reset token and retires any unused one for this account.
 *
 * The returned string is the secret that goes in the mail. Only its hash is inserted.
 * Retiring the older link means only the newest mail works, rather than two live links
 * sitting in one inbox.
 */
func (s *Store) IssuePasswordReset(ctx context.Context, userID string) (string, error) {
	raw, err := auth.RandomToken(32)
	if err != nil {
		return "", err
	}
	expires := time.Now().Add(PasswordResetTTL)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE password_reset_tokens
		   SET used_at = now()
		 WHERE user_id = $1::uuid AND used_at IS NULL`, userID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
		VALUES ($1::uuid, $2, $3)`, userID, PasswordResetHash(raw), expires); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return raw, nil
}

/* RedeemPasswordReset sets a new password if the token is unused and unexpired.
 *
 * passwordHash arrives hashed: argon2id is slow on purpose, and hashing here would hold
 * the token's row lock for as long as it takes.
 *
 * ErrNotFound is a token we never issued. ErrResetUsed and ErrResetExpired are the other
 * two failures. A success consumes the token, and every other link still outstanding for
 * the account, and stamps password_changed_at — which is what signs out every session
 * issued before now. That stamp is the API's clock rather than the database's, because it
 * is compared with session issue times, and the API is what stamps those.
 *
 * The link went to this account's address, so redeeming it proves the inbox exactly as the
 * verification link does. An unverified account is verified here, and its waiting webinar
 * registrations are finished in the same transaction; the caller sends their join links
 * after this commits.
 */
func (s *Store) RedeemPasswordReset(ctx context.Context, raw, passwordHash string) (string, []CompletedRegistration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 256 {
		return "", nil, ErrNotFound
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		userID  string
		expires time.Time
		used    *time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT user_id::text, expires_at, used_at
		  FROM password_reset_tokens
		 WHERE token_hash = $1
		 FOR UPDATE`, PasswordResetHash(raw)).Scan(&userID, &expires, &used)
	if noRows(err) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	if used != nil {
		return "", nil, ErrResetUsed
	}
	if !expires.After(time.Now()) {
		return "", nil, ErrResetExpired
	}

	if _, err := tx.Exec(ctx, `
		UPDATE password_reset_tokens
		   SET used_at = now()
		 WHERE user_id = $1::uuid AND used_at IS NULL`, userID); err != nil {
		return "", nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users
		   SET password_hash       = $2,
		       password_changed_at = $3,
		       email_verified_at   = COALESCE(email_verified_at, now())
		 WHERE id = $1::uuid`, userID, passwordHash, time.Now()); err != nil {
		return "", nil, err
	}

	done, err := finishWaitingRegistrations(ctx, tx, userID)
	if err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	return userID, done, nil
}
