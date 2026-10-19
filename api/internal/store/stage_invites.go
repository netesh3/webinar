package store

import (
	"context"
	"fmt"
	"time"
)

// --------------------------------------------------------------- stage invites

// StageInvite is a host's offer of the stage, waiting for the attendee to answer it.
//
// It is kept here rather than in the memory of the API instance the host's click
// reached, because the answer can arrive at any instance. See
// migrations/0121_stage_invites.sql.
type StageInvite struct {
	AudioOnly bool
}

// PutStageInvite records an invite, replacing any earlier one for the same person.
//
// token identifies this invite in particular, so the expiry for it can remove it later
// without taking a newer invite with it (WithdrawStageInvite).
func (s *Store) PutStageInvite(
	ctx context.Context, slug, identity, token string, audioOnly bool, ttl time.Duration,
) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_stage_invites (webinar_id, identity, token, audio_only, expires_at)
		SELECT w.id, $2, $3, $4, now() + make_interval(secs => $5::double precision)
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE
		   SET token = excluded.token, audio_only = excluded.audio_only,
		       invited_at = now(), expires_at = excluded.expires_at`,
		slug, identity, token, audioOnly, ttl.Seconds())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("stage invite: no webinar %q", slug)
	}
	return nil
}

// TakeStageInvite removes the open invite for one person and reports whether there was
// one.
//
// The DELETE is the claim: for any one invite exactly one caller gets ok == true,
// whichever instance it runs on, so an accept and a decline (or two accepts) cannot both
// win. An expired invite is not taken. It is reported as not open and left for its
// expiry (WithdrawStageInvite), which is what tells the attendee the offer has gone — an
// answer arriving just after the minute must not take that message away.
func (s *Store) TakeStageInvite(ctx context.Context, slug, identity string) (StageInvite, bool, error) {
	var inv StageInvite
	err := s.pool.QueryRow(ctx, `
		DELETE FROM webinar_stage_invites i
		 USING webinars w
		 WHERE w.id = i.webinar_id AND w.slug = $1 AND i.identity = $2
		   AND i.expires_at > now()
		RETURNING i.audio_only`, slug, identity).
		Scan(&inv.AudioOnly)
	if noRows(err) {
		return StageInvite{}, false, nil
	}
	if err != nil {
		return StageInvite{}, false, err
	}
	return inv, true, nil
}

// WithdrawStageInvite removes one particular invite — the one carrying token — if it is
// still there, and reports whether it did. An invite already answered, or replaced by a
// newer one, is left alone and reported as not removed.
func (s *Store) WithdrawStageInvite(ctx context.Context, slug, identity, token string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_stage_invites i
		 USING webinars w
		 WHERE w.id = i.webinar_id AND w.slug = $1 AND i.identity = $2 AND i.token = $3`,
		slug, identity, token)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}
