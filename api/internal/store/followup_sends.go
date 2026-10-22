package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

/* Follow-up sends: the dedupe, the per-recipient status and the email unsubscribes behind
 * Results → Follow-ups → Send (api/internal/api/followup_send.go, migrations/0139). */

// FollowupStaleClaim is how long a 'sending' row holds before another request may take it.
const FollowupStaleClaim = 5 * time.Minute

// FollowupSend is one person's follow-up on one channel, as last recorded.
type FollowupSend struct {
	ID               string
	LeadKey          string
	Channel          string
	Status           string
	Mode             string
	Reason           string
	Address          string
	UnsubscribeToken string
	UpdatedAt        time.Time
}

// FollowupSends is every recorded follow-up of one session, by lead key then channel.
func (s *Store) FollowupSends(ctx context.Context, slug string) (map[string]map[string]FollowupSend, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT f.id::text, f.lead_key, f.channel, f.status, f.mode, f.reason, f.address,
		       COALESCE(f.unsubscribe_token, ''), f.updated_at
		  FROM followup_sends f JOIN webinars w ON w.id = f.webinar_id
		 WHERE w.slug = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]FollowupSend{}
	for rows.Next() {
		var f FollowupSend
		if err := rows.Scan(&f.ID, &f.LeadKey, &f.Channel, &f.Status, &f.Mode, &f.Reason, &f.Address,
			&f.UnsubscribeToken, &f.UpdatedAt); err != nil {
			return nil, err
		}
		if out[f.LeadKey] == nil {
			out[f.LeadKey] = map[string]FollowupSend{}
		}
		out[f.LeadKey][f.Channel] = f
	}
	return out, rows.Err()
}

/* ClaimFollowupSend takes the right to send one person's follow-up on one channel, before
 * anything is sent. ok is false when it was already sent (and again is false) or another
 * request is sending it right now — the dedupe. A failed send may always be claimed again,
 * and so may a claim older than FollowupStaleClaim (a request that died mid-send).
 * The returned row carries the email's unsubscribe token, made once and kept. */
func (s *Store) ClaimFollowupSend(ctx context.Context, slug, hostID, leadKey, channel string, again bool) (FollowupSend, bool, error) {
	token, err := newUnsubscribeToken()
	if err != nil {
		return FollowupSend{}, false, err
	}
	var f FollowupSend
	err = s.pool.QueryRow(ctx, `
		INSERT INTO followup_sends (webinar_id, host_id, lead_key, channel, status, unsubscribe_token)
		SELECT w.id, $2::uuid, $3, $4, 'sending', $6 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, lead_key, channel) DO UPDATE
		   SET status = 'sending', reason = '', attempts = followup_sends.attempts + 1, updated_at = now(),
		       unsubscribe_token = COALESCE(followup_sends.unsubscribe_token, EXCLUDED.unsubscribe_token)
		 WHERE followup_sends.status = 'failed'
		    OR (followup_sends.status = 'sending' AND followup_sends.updated_at < now() - make_interval(secs => $7))
		    OR ($5 AND followup_sends.status = 'sent')
		RETURNING id::text, lead_key, channel, status, COALESCE(unsubscribe_token, ''), updated_at`,
		slug, hostID, leadKey, channel, again, token, FollowupStaleClaim.Seconds(),
	).Scan(&f.ID, &f.LeadKey, &f.Channel, &f.Status, &f.UnsubscribeToken, &f.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return FollowupSend{}, false, nil
	}
	if err != nil {
		return FollowupSend{}, false, err
	}
	return f, true, nil
}

// FinishFollowupSend records how a claimed send went: sent or failed, with why.
func (s *Store) FinishFollowupSend(ctx context.Context, id, status, mode, reason, address string) error {
	if status != "sent" && status != "failed" {
		return ErrInvalid
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE followup_sends SET status = $2, mode = $3, reason = $4, address = $5, updated_at = now()
		 WHERE id = $1::uuid`, id, status, mode, reason, address)
	return err
}

// FollowupSendsSince is how many follow-ups a host has sent (or is sending) since since.
func (s *Store) FollowupSendsSince(ctx context.Context, hostID string, since time.Time) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM followup_sends
		 WHERE host_id = $1::uuid AND status IN ('sent', 'sending') AND updated_at >= $2`,
		hostID, since).Scan(&n)
	return n, err
}

// EmailUnsubscribed is whether email asked this host to stop emailing them.
func (s *Store) EmailUnsubscribed(ctx context.Context, hostID, email string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM email_unsubscribes WHERE host_id = $1::uuid AND email = $2)`,
		hostID, normEmail(email)).Scan(&ok)
	return ok, err
}

/* UnsubscribeByToken records the unsubscribe a follow-up email's link stands for, and says
 * whose list and which address. ErrNotFound for a token that is not one of ours. Pressing
 * it twice is fine. */
func (s *Store) UnsubscribeByToken(ctx context.Context, token string) (hostID, email string, err error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return "", "", ErrNotFound
	}
	err = s.pool.QueryRow(ctx, `
		SELECT host_id::text, address FROM followup_sends
		 WHERE unsubscribe_token = $1 AND channel = 'email' AND address <> ''`, token).Scan(&hostID, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO email_unsubscribes (host_id, email) VALUES ($1::uuid, $2)
		ON CONFLICT DO NOTHING`, hostID, normEmail(email))
	return hostID, email, err
}

// UnsubscribeTokenInfo reads who a token is for without unsubscribing them (the GET page).
func (s *Store) UnsubscribeTokenInfo(ctx context.Context, token string) (hostID, email string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT host_id::text, address FROM followup_sends
		 WHERE unsubscribe_token = $1 AND channel = 'email' AND address <> ''`, strings.TrimSpace(token)).Scan(&hostID, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return hostID, email, err
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

func newUnsubscribeToken() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
