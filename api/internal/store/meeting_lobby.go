package store

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The meeting lobby, kept in the registrations table.
 *
 * A knock is a guest registration (is_guest, no email) in state pending; the host admitting
 * it is the row moving to approved, and denying it is declined. That is the manual-approval
 * mechanism webinars already have, reused rather than mirrored: the join path already refuses
 * anything but an approved row, a join key is already the credential, the rejoin cookie,
 * removals, chat and attendance all already key on attendeeIdentity(joinKey) — so an admitted
 * guest is, to everything downstream, an ordinary approved registration. A separate lobby table
 * would have needed every one of those taught about it.
 *
 * On a meeting EVERY guest row is a lobby row, because a meeting refuses the other two doors
 * (POST /register and /guest-join) outright — see the handlers. So "is_guest on a meeting" is
 * all the lobby needs to be told apart; no migration.
 */

// lobbyMax bounds how many people may wait in one meeting's lobby at once. A meeting holds at
// most types.MaxMeetingCapOverride, so a queue several times that is already somebody leaning
// on the button; the bound is what stops an open link becoming an unbounded table.
const lobbyMax = 200

/* Knock puts a name in a meeting's lobby and returns the new row with its join key.
 *
 * Never idempotent, like RegisterGuest: a name is not an identity and two people called Asha
 * are two knocks. A browser that already knocked keeps its place by sending its key back, which
 * the handler resolves before it gets here.
 *
 * ErrNotFound for anything that is not a published meeting (a webinar, a draft, an ended one —
 * the handler has already told the caller which), ErrFull when the lobby is at lobbyMax. The
 * count is inside the transaction with the webinar row locked, for the same reason as
 * RegisterGuest's: two knocks together must not both take the last place.
 *
 * knockUserID is the signed-in account that knocked, or "" for a visitor with no session. It
 * is kept apart from user_id (migrations/0164) and read only to make the guest a co-host.
 */
func (s *Store) Knock(ctx context.Context, slug, name, knockUserID string) (types.Registration, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Registration{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var webinarID, status, kind string
	err = tx.QueryRow(ctx, `
		SELECT id::text, status, kind FROM webinars WHERE slug = $1 FOR UPDATE`, slug).
		Scan(&webinarID, &status, &kind)
	if noRows(err) {
		return types.Registration{}, ErrNotFound
	}
	if err != nil {
		return types.Registration{}, err
	}
	if kind != string(types.KindMeeting) || status == "draft" || status == "ended" {
		return types.Registration{}, ErrNotFound
	}

	var waiting int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM registrations
		 WHERE webinar_id = $1::uuid AND is_guest AND state = 'pending'`, webinarID).
		Scan(&waiting); err != nil {
		return types.Registration{}, err
	}
	if waiting >= lobbyMax {
		return types.Registration{}, ErrFull
	}

	reg := types.Registration{
		WebinarID: slug,
		FirstName: strings.TrimSpace(name),
		State:     types.RegPending,
		JoinKey:   newJoinKey(),
		IsGuest:   true,
	}
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO registrations
			(webinar_id, email, first_name, last_name, company, job_title, country,
			 phone, answers, state, join_key, is_guest, knock_user_id)
		VALUES ($1,'',$2,'','','','','', '{}'::jsonb, 'pending', $3, true, NULLIF($4, '')::uuid)
		RETURNING id::text, created_at`,
		webinarID, reg.FirstName, reg.JoinKey, knockUserID,
	).Scan(&reg.ID, &createdAt)
	if err != nil {
		return types.Registration{}, err
	}
	reg.RegisteredAt = createdAt.Format(time.RFC3339)
	return reg, tx.Commit(ctx)
}

// LobbyWaiting is everyone waiting to be let into the meeting, longest-waiting first.
func (s *Store) LobbyWaiting(ctx context.Context, slug string) ([]types.LobbyEntry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.first_name, r.created_at
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND r.is_guest AND r.state = 'pending'
		 ORDER BY r.created_at, r.id
		 LIMIT $2`, slug, lobbyMax)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.LobbyEntry{}
	for rows.Next() {
		var (
			e  types.LobbyEntry
			at time.Time
		)
		if err := rows.Scan(&e.ID, &e.Name, &at); err != nil {
			return nil, err
		}
		e.RequestedAt = at.UTC().Format(time.RFC3339)
		out = append(out, e)
	}
	return out, rows.Err()
}

// LobbyWaitingCount is how many are waiting, for the host's "N waiting" badge.
func (s *Store) LobbyWaitingCount(ctx context.Context, slug string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND r.is_guest AND r.state = 'pending'`, slug).Scan(&n)
	return n, err
}

/* DecideLobby admits (approved) or denies (declined) one waiting guest.
 *
 * Scoped by slug, like SetRegistrationStates: the id arrives in the URL, and the route's
 * ownership check proves the caller owns the meeting in the path, not that the id belongs to
 * it. Only a row still waiting is matched, so a double click, or two co-hosts acting at once,
 * is ErrNotFound for the second rather than flipping a decision already made. id must already
 * be a well-formed uuid; the handler checks.
 */
func (s *Store) DecideLobby(ctx context.Context, slug, id string, state types.RegistrationState) error {
	var got string
	err := s.pool.QueryRow(ctx, `
		UPDATE registrations r
		   SET state = $3
		  FROM webinars w
		 WHERE r.id = $2::uuid AND w.id = r.webinar_id AND w.slug = $1
		   AND r.is_guest AND r.state = 'pending'
		RETURNING r.id::text`, slug, id, string(state)).Scan(&got)
	if noRows(err) {
		return ErrNotFound
	}
	return err
}

/* AdmitOldest lets in up to n of the longest-waiting guests and reports how many it admitted.
 *
 * Oldest first because that is the order the host sees and the order people arrived in; "admit
 * all" that stops at the cap must stop at the people who came last, not at whoever the planner
 * happened to read first. SKIP LOCKED so a single admit landing at the same moment is not a
 * deadlock, only a row this statement leaves for the other one.
 */
func (s *Store) AdmitOldest(ctx context.Context, slug string, n int) (int, error) {
	if n <= 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE registrations
		   SET state = 'approved'
		 WHERE id IN (
		   SELECT r.id FROM registrations r
		     JOIN webinars w ON w.id = r.webinar_id
		    WHERE w.slug = $1 AND r.is_guest AND r.state = 'pending'
		    ORDER BY r.created_at, r.id
		    LIMIT $2
		    FOR UPDATE OF r SKIP LOCKED)`, slug, n)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// WebinarKindOf is the kind of one webinar, for the hot paths (chat) that need only that.
func (s *Store) WebinarKindOf(ctx context.Context, slug string) (types.WebinarKind, error) {
	var kind string
	err := s.pool.QueryRow(ctx, `SELECT kind FROM webinars WHERE slug = $1`, slug).Scan(&kind)
	if noRows(err) {
		return "", ErrNotFound
	}
	return types.WebinarKind(kind), err
}
