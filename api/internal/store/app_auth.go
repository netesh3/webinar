package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/internal/auth"
)

/* The desktop and mobile apps' sign-in hand-off (29 Oct 2026): see
 * migrations/0173_app_auth_codes.sql for why, and api/auth_app.go for the flow. */

// AppAuthCodeTTL is how long a hand-off code works. The app redeems it a second or two after
// the system browser hands it over; two minutes is for a slow phone, not for later.
const AppAuthCodeTTL = 2 * time.Minute

var (
	// ErrAppCodeExpired is a real code redeemed too late.
	ErrAppCodeExpired = errors.New("app auth code expired")
	// ErrAppCodeUsed is a code that was already redeemed (or tried) once.
	ErrAppCodeUsed = errors.New("app auth code used")
)

// AppAuthCode is a redeemed code: whose it is and what the app must prove.
type AppAuthCode struct {
	UserID    string
	Challenge string
	App       string
	Next      string
}

/* IssueAppAuthCode mints a hand-off code for userID. The raw code is returned for the
 * webinarliv:// link; only its hash is stored. Codes that died a day ago go at the same time,
 * so the table never holds more than a day of sign-ins. */
func (s *Store) IssueAppAuthCode(ctx context.Context, userID, challenge, app, next string) (string, error) {
	raw, err := auth.RandomToken(32)
	if err != nil {
		return "", err
	}
	return raw, s.IssueAppAuthCodeAs(ctx, raw, userID, challenge, app, next)
}

/* IssueAppAuthCodeAs is IssueAppAuthCode with the raw code chosen by the caller (31 Oct 2026):
 * the Google callback derives it from its replay row (api/auth_google_replay.go), so that a
 * callback the browser sends twice hands the app the same code both times. raw must be as
 * unguessable as RandomToken's. */
func (s *Store) IssueAppAuthCodeAs(ctx context.Context, raw, userID, challenge, app, next string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM app_auth_codes WHERE expires_at < now() - interval '1 day'`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO app_auth_codes (code_hash, user_id, challenge, app, next_path, expires_at)
		VALUES ($1, $2::uuid, $3, $4, $5, now() + make_interval(secs => $6))`,
		EmailVerifyHash(raw), userID, challenge, app, next, AppAuthCodeTTL.Seconds())
	return err
}

/* RedeemAppAuthCode consumes a code and returns what it was bound to.
 *
 * Consumed on the first attempt whatever happens next: the UPDATE claims the row only while
 * used_at is null, so two concurrent redemptions cannot both get it, and a caller that then
 * fails the verifier check has spent the code. ErrNotFound is a code never issued,
 * ErrAppCodeUsed one already tried, ErrAppCodeExpired one past its two minutes. */
func (s *Store) RedeemAppAuthCode(ctx context.Context, raw string) (AppAuthCode, error) {
	var c AppAuthCode
	var expired bool
	err := s.pool.QueryRow(ctx, `
		UPDATE app_auth_codes SET used_at = now()
		 WHERE code_hash = $1 AND used_at IS NULL
		RETURNING user_id::text, challenge, app, next_path, expires_at < now()`,
		EmailVerifyHash(raw)).Scan(&c.UserID, &c.Challenge, &c.App, &c.Next, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app_auth_codes WHERE code_hash = $1)`,
			EmailVerifyHash(raw)).Scan(&exists); err != nil {
			return AppAuthCode{}, err
		}
		if exists {
			return AppAuthCode{}, ErrAppCodeUsed
		}
		return AppAuthCode{}, ErrNotFound
	}
	if err != nil {
		return AppAuthCode{}, err
	}
	if expired {
		return AppAuthCode{}, ErrAppCodeExpired
	}
	return c, nil
}
