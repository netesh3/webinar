package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/types"
)

// How long a verification link works. The mail says the same number.
const EmailVerifyTTL = 24 * time.Hour

var (
	// ErrVerifyExpired is a token that was real and was not used in time.
	ErrVerifyExpired = errors.New("verification token expired")
	// ErrVerifyUsed is a token that already confirmed an address, or was replaced by a newer link.
	ErrVerifyUsed = errors.New("verification token used")
)

// EmailVerifyHash is what gets stored. The raw token never does.
func EmailVerifyHash(raw string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(raw)))
	return hex.EncodeToString(sum[:])
}

/* IssueEmailVerification mints a single-use token and retires any unused one for this account.
 *
 * The returned string is the secret that goes in the mail. Only its hash is inserted.
 */
func (s *Store) IssueEmailVerification(ctx context.Context, userID string) (string, error) {
	raw, err := auth.RandomToken(32)
	if err != nil {
		return "", err
	}
	hash := EmailVerifyHash(raw)
	expires := time.Now().Add(EmailVerifyTTL)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE email_verification_tokens
		   SET used_at = now()
		 WHERE user_id = $1::uuid AND used_at IS NULL`, userID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
		VALUES ($1::uuid, $2, $3)`, userID, hash, expires); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return raw, nil
}

// CompletedRegistration is a webinar registration the verification link just finished.
// WhatsAppOptIn was stored with the form, because the CRM write waits for this moment.
type CompletedRegistration struct {
	Registration  types.Registration
	WhatsAppOptIn bool
}

/* RedeemEmailVerification marks the account verified if the token is unused and unexpired.
 *
 * ErrNotFound is a token we never issued. ErrVerifyUsed and ErrVerifyExpired are the
 * other two failures. A success consumes the token, so a second request fails.
 *
 * Webinar registrations waiting on this address are finished in the same transaction:
 * approved when the webinar lets people in automatically, pending when the host reviews
 * them. The join link is still only sent by the caller, after this commits.
 */
func (s *Store) RedeemEmailVerification(ctx context.Context, raw string) (string, []CompletedRegistration, error) {
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
		  FROM email_verification_tokens
		 WHERE token_hash = $1
		 FOR UPDATE`, EmailVerifyHash(raw)).Scan(&userID, &expires, &used)
	if noRows(err) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	if used != nil {
		return "", nil, ErrVerifyUsed
	}
	if !expires.After(time.Now()) {
		return "", nil, ErrVerifyExpired
	}

	if _, err := tx.Exec(ctx, `
		UPDATE email_verification_tokens SET used_at = now() WHERE token_hash = $1`,
		EmailVerifyHash(raw)); err != nil {
		return "", nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users
		   SET email_verified_at = COALESCE(email_verified_at, now())
		 WHERE id = $1::uuid`, userID); err != nil {
		return "", nil, err
	}

	rows, err := tx.Query(ctx, `
		UPDATE registrations r
		   SET state = CASE WHEN w.approval = 'manual' THEN 'pending' ELSE 'approved' END
		  FROM webinars w
		 WHERE r.webinar_id = w.id
		   AND r.user_id = $1::uuid
		   AND r.state = 'unverified'
		RETURNING r.id::text, w.slug, r.email, r.first_name, r.last_name, r.company,
		          r.job_title, r.country, r.phone, r.answers, r.state, r.join_key,
		          r.created_at, r.whatsapp_opt_in`, userID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()

	done := []CompletedRegistration{}
	for rows.Next() {
		var (
			item    CompletedRegistration
			answers []byte
			created time.Time
		)
		if err := rows.Scan(
			&item.Registration.ID, &item.Registration.WebinarID, &item.Registration.Email,
			&item.Registration.FirstName, &item.Registration.LastName, &item.Registration.Company,
			&item.Registration.JobTitle, &item.Registration.Country, &item.Registration.Phone,
			&answers, &item.Registration.State, &item.Registration.JoinKey, &created,
			&item.WhatsAppOptIn,
		); err != nil {
			return "", nil, err
		}
		if len(answers) > 0 {
			if err := json.Unmarshal(answers, &item.Registration.Answers); err != nil {
				return "", nil, err
			}
		}
		item.Registration.Answers = orEmptyMap(item.Registration.Answers)
		item.Registration.RegisteredAt = created.Format(time.RFC3339)
		done = append(done, item)
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, err
	}
	return userID, done, nil
}

// MarkEmailVerified stamps the account confirmed. A second call keeps the original time.
func (s *Store) MarkEmailVerified(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET email_verified_at = COALESCE(email_verified_at, now())
		 WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkEmailVerifiedByEmail is MarkEmailVerified for a caller that has the address.
func (s *Store) MarkEmailVerifiedByEmail(ctx context.Context, email string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET email_verified_at = COALESCE(email_verified_at, now())
		 WHERE lower(email) = lower($1)`, strings.TrimSpace(email))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
