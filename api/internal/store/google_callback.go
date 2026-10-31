package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/internal/auth"
)

/* Google callbacks the browser sends twice (31 Oct 2026): see
 * migrations/0178_google_callback_replays.sql for why, and api/auth_google_replay.go for the
 * flow. */

// GoogleCallbackReplayTTL is how long a finished callback is answered again. A replay comes a
// few hundred ms after the first; two minutes matches the app code it may carry.
const GoogleCallbackReplayTTL = AppAuthCodeTTL

// GoogleCallback is one (state, code) pair's row: claimed by the first callback, then how it
// ended once Done.
type GoogleCallback struct {
	// Nonce is the row's own random value: the app code is derived from it, and Finish and
	// Release only touch the row they claimed.
	Nonce   string
	Done    bool
	UserID  string
	App     string
	Landing string
	Failure string
}

/* ClaimGoogleCallback is the first step of every callback with a code. claimed is true when
 * this caller now owns the pair and must exchange it with Google, then Finish or Release it.
 * Otherwise the row is somebody else's: Done with its outcome, or still pending (the first is
 * mid-exchange), or gone (the first failed hard and released it), in which case Nonce is "" and
 * the caller may claim again. A row past its expiry is claimed afresh. */
func (s *Store) ClaimGoogleCallback(ctx context.Context, keyHash string) (GoogleCallback, bool, error) {
	nonce, err := auth.RandomToken(32)
	if err != nil {
		return GoogleCallback{}, false, err
	}
	var claimed bool
	err = s.pool.QueryRow(ctx, `
		INSERT INTO google_callback_replays (key_hash, app_nonce, expires_at)
		VALUES ($1, $2, now() + make_interval(secs => $3))
		ON CONFLICT (key_hash) DO UPDATE
		   SET user_id = NULL, app = '', app_nonce = excluded.app_nonce, landing = '', failure = '',
		       done_at = NULL, expires_at = excluded.expires_at, created_at = now()
		 WHERE google_callback_replays.expires_at < now()
		RETURNING true`,
		keyHash, nonce, GoogleCallbackReplayTTL.Seconds()).Scan(&claimed)
	if err == nil {
		return GoogleCallback{Nonce: nonce}, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return GoogleCallback{}, false, err
	}
	var c GoogleCallback
	err = s.pool.QueryRow(ctx, `
		SELECT app_nonce, done_at IS NOT NULL, coalesce(user_id::text, ''), app, landing, failure
		  FROM google_callback_replays WHERE key_hash = $1`,
		keyHash).Scan(&c.Nonce, &c.Done, &c.UserID, &c.App, &c.Landing, &c.Failure)
	if errors.Is(err, pgx.ErrNoRows) {
		return GoogleCallback{}, false, nil
	}
	return c, false, err
}

/* FinishGoogleCallback records how the claimed callback ended and starts its two minutes:
 * userID and app (or landing) for a sign-in, failure for a refusal. */
func (s *Store) FinishGoogleCallback(ctx context.Context, keyHash string, c GoogleCallback) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE google_callback_replays
		   SET user_id = NULLIF($3, '')::uuid, app = $4, landing = $5, failure = $6,
		       done_at = now(), expires_at = now() + make_interval(secs => $7)
		 WHERE key_hash = $1 AND app_nonce = $2 AND done_at IS NULL`,
		keyHash, c.Nonce, c.UserID, c.App, c.Landing, c.Failure, GoogleCallbackReplayTTL.Seconds())
	return err
}

// ReleaseGoogleCallback drops a claim that ended in neither (a 500), so a waiting repeat is not
// held to it.
func (s *Store) ReleaseGoogleCallback(ctx context.Context, keyHash, nonce string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM google_callback_replays WHERE key_hash = $1 AND app_nonce = $2 AND done_at IS NULL`,
		keyHash, nonce)
	return err
}

// PruneGoogleCallbacks deletes rows that expired before before, for the token-retention sweep.
func (s *Store) PruneGoogleCallbacks(ctx context.Context, before time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM google_callback_replays WHERE expires_at < $1`, before)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
