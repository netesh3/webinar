package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/internal/auth"
)

/* Connect Zoom, Connect YouTube and the Drive picker from the apps (29 Oct 2026): see
 * migrations/0175_app_connect_handoffs.sql for why, and api/app_connect.go for the flow. */

const (
	// AppConnectTicketTTL is how long a ticket works. The app opens the system browser with it
	// at once; the start route spends it a second later.
	AppConnectTicketTTL = 2 * time.Minute
	// AppConnectResultTTL is how long a parked result (an authorization code, a Drive pick)
	// waits for the app. Zoom's and Google's own codes last about ten minutes.
	AppConnectResultTTL = 2 * time.Minute
	// AppConnectFlowTTL bounds the whole attempt after the ticket was spent: consent screens,
	// choosing a file. A result attached later than this is refused.
	AppConnectFlowTTL = 15 * time.Minute
	// AppConnectTicketsPerHour is how many tickets one account may mint in an hour.
	AppConnectTicketsPerHour = 30
)

// ErrAppConnectTooMany is an account minting tickets faster than anybody connects anything.
var ErrAppConnectTooMany = errors.New("too many app connect tickets")

// AppConnect is one attempt, as the start route or the redemption sees it.
type AppConnect struct {
	ID       string
	UserID   string
	Provider string
	App      string
	Return   string
	// Payload is the sealed result; only RedeemAppConnectCode and TakeAppConnectPick fill it.
	Payload []byte
}

/* IssueAppConnectTicket mints a ticket for userID to connect provider from app. The raw ticket
 * is returned for the system browser's URL; only its hash is stored. Refuses with
 * ErrAppConnectTooMany past the hourly budget. */
func (s *Store) IssueAppConnectTicket(ctx context.Context, userID, provider, app, ret string) (raw, id string, err error) {
	if _, err := s.pool.Exec(ctx, `DELETE FROM app_connect_handoffs WHERE created_at < now() - interval '1 day'`); err != nil {
		return "", "", err
	}
	var recent int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM app_connect_handoffs
		 WHERE user_id = $1::uuid AND created_at > now() - interval '1 hour'`, userID).Scan(&recent); err != nil {
		return "", "", err
	}
	if recent >= AppConnectTicketsPerHour {
		return "", "", ErrAppConnectTooMany
	}
	raw, err = auth.RandomToken(32)
	if err != nil {
		return "", "", err
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO app_connect_handoffs (ticket_hash, user_id, provider, app, return_path, expires_at)
		VALUES ($1, $2::uuid, $3, $4, $5, now() + make_interval(secs => $6))
		RETURNING id::text`,
		EmailVerifyHash(raw), userID, provider, app, ret, AppConnectTicketTTL.Seconds()).Scan(&id)
	if err != nil {
		return "", "", err
	}
	return raw, id, nil
}

/* StartAppConnect spends a ticket for provider. Like RedeemAppAuthCode it is spent by the
 * first attempt whatever follows. A ticket minted for another provider is ErrNotFound and is
 * not spent. ErrAppCodeUsed is a ticket already started, ErrAppCodeExpired one too old. */
func (s *Store) StartAppConnect(ctx context.Context, raw, provider string) (AppConnect, error) {
	var c AppConnect
	var expired bool
	err := s.pool.QueryRow(ctx, `
		UPDATE app_connect_handoffs SET started_at = now()
		 WHERE ticket_hash = $1 AND provider = $2 AND started_at IS NULL
		RETURNING id::text, user_id::text, provider, app, return_path, expires_at < now()`,
		EmailVerifyHash(raw), provider).Scan(&c.ID, &c.UserID, &c.Provider, &c.App, &c.Return, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app_connect_handoffs
			WHERE ticket_hash = $1 AND provider = $2)`, EmailVerifyHash(raw), provider).Scan(&exists); err != nil {
			return AppConnect{}, err
		}
		if exists {
			return AppConnect{}, ErrAppCodeUsed
		}
		return AppConnect{}, ErrNotFound
	}
	if err != nil {
		return AppConnect{}, err
	}
	if expired {
		return AppConnect{}, ErrAppCodeExpired
	}
	return c, nil
}

/* AttachAppConnectResult parks the sealed result of a started attempt, once. With withCode it
 * also mints the completion code the app redeems (Zoom, YouTube) and returns it raw; Drive is
 * collected by id instead and gets "". An attempt that already has a result, was finished, was
 * never started or started too long ago is ErrAppCodeUsed: a replayed callback or a second
 * pick does nothing. */
func (s *Store) AttachAppConnectResult(ctx context.Context, id, userID string, payload []byte, withCode bool) (string, error) {
	raw := ""
	var hash *string
	if withCode {
		var err error
		if raw, err = auth.RandomToken(32); err != nil {
			return "", err
		}
		h := EmailVerifyHash(raw)
		hash = &h
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE app_connect_handoffs
		   SET payload = $3, code_hash = $4, payload_expires_at = now() + make_interval(secs => $5)
		 WHERE id = $1::uuid AND user_id = $2::uuid AND started_at IS NOT NULL
		   AND started_at > now() - make_interval(secs => $6)
		   AND payload IS NULL AND code_hash IS NULL AND finished_at IS NULL`,
		id, userID, payload, hash, AppConnectResultTTL.Seconds(), AppConnectFlowTTL.Seconds())
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() != 1 {
		return "", ErrAppCodeUsed
	}
	return raw, nil
}

/* RedeemAppConnectCode spends a completion code and returns the attempt with its payload,
 * which is wiped from the row in the same statement. Spent on the first attempt, whoever makes
 * it: the caller checks the account and a wrong one has burnt it. */
func (s *Store) RedeemAppConnectCode(ctx context.Context, raw string) (AppConnect, error) {
	var c AppConnect
	var expired bool
	err := s.pool.QueryRow(ctx, `
		WITH hit AS (
			SELECT id, payload FROM app_connect_handoffs
			 WHERE code_hash = $1 AND finished_at IS NULL
			   FOR UPDATE)
		UPDATE app_connect_handoffs a SET finished_at = now(), payload = NULL
		  FROM hit
		 WHERE a.id = hit.id
		RETURNING a.id::text, a.user_id::text, a.provider, a.app, a.return_path, hit.payload,
		          a.payload_expires_at < now()`,
		EmailVerifyHash(raw)).Scan(&c.ID, &c.UserID, &c.Provider, &c.App, &c.Return, &c.Payload, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM app_connect_handoffs WHERE code_hash = $1)`,
			EmailVerifyHash(raw)).Scan(&exists); err != nil {
			return AppConnect{}, err
		}
		if exists {
			return AppConnect{}, ErrAppCodeUsed
		}
		return AppConnect{}, ErrNotFound
	}
	if err != nil {
		return AppConnect{}, err
	}
	if expired {
		return AppConnect{}, ErrAppCodeExpired
	}
	return c, nil
}

// ErrAppConnectPending is a Drive attempt of the caller's that has no pick yet.
var ErrAppConnectPending = errors.New("app connect result not there yet")

/* TakeAppConnectPick collects a Drive pick for its own account, once, wiping the payload.
 * ErrAppConnectPending is an attempt still under way; ErrNotFound covers everything else (not
 * this account's, already collected, abandoned), so the room stops asking. */
func (s *Store) TakeAppConnectPick(ctx context.Context, id, userID string) (AppConnect, error) {
	var c AppConnect
	var expired bool
	err := s.pool.QueryRow(ctx, `
		WITH hit AS (
			SELECT id, payload FROM app_connect_handoffs
			 WHERE id = $1::uuid AND user_id = $2::uuid AND provider = 'drive'
			   AND payload IS NOT NULL AND finished_at IS NULL
			   FOR UPDATE)
		UPDATE app_connect_handoffs a SET finished_at = now(), payload = NULL
		  FROM hit
		 WHERE a.id = hit.id
		RETURNING a.id::text, a.user_id::text, a.provider, a.app, a.return_path, hit.payload,
		          a.payload_expires_at < now()`,
		id, userID).Scan(&c.ID, &c.UserID, &c.Provider, &c.App, &c.Return, &c.Payload, &expired)
	if errors.Is(err, pgx.ErrNoRows) {
		var waiting bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM app_connect_handoffs
			 WHERE id = $1::uuid AND user_id = $2::uuid AND provider = 'drive'
			   AND payload IS NULL AND finished_at IS NULL
			   AND (started_at IS NULL AND expires_at > now()
			        OR started_at > now() - make_interval(secs => $3)))`,
			id, userID, AppConnectFlowTTL.Seconds()).Scan(&waiting); err != nil {
			return AppConnect{}, err
		}
		if waiting {
			return AppConnect{}, ErrAppConnectPending
		}
		return AppConnect{}, ErrNotFound
	}
	if err != nil {
		return AppConnect{}, err
	}
	if expired {
		return AppConnect{}, ErrNotFound
	}
	return c, nil
}
