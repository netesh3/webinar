package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

/* Calling (31 Oct 2026): the calls table (migrations/0176) and who a host may call.
 * api/calls.go decides; this is the SQL. See docs/calling.md. */

// Call is one row of calls, with the names and the meeting it rings into.
type Call struct {
	ID            string
	CallerID      string
	CallerName    string
	CallerAvatar  string
	CalleeID      string
	CalleeName    string
	Slug          string
	Topic         string
	State         types.CallState
	AddedPanelist bool
	CreatedAt     time.Time
	ExpiresAt     time.Time
}

const callColumns = `c.id::text, c.caller_id::text, cu.name, cu.email,
	coalesce(cu.google_picture, ''),
	c.callee_id::text, ee.name, ee.email, w.slug, w.topic, c.state, c.added_panelist,
	c.created_at, c.expires_at`

const callFrom = ` FROM calls c
	JOIN users cu ON cu.id = c.caller_id
	JOIN users ee ON ee.id = c.callee_id
	JOIN webinars w ON w.id = c.webinar_id`

func scanCall(row scanner) (Call, error) {
	var c Call
	var callerEmail, calleeEmail, picture, state string
	err := row.Scan(&c.ID, &c.CallerID, &c.CallerName, &callerEmail, &picture,
		&c.CalleeID, &c.CalleeName, &calleeEmail, &c.Slug, &c.Topic, &state, &c.AddedPanelist,
		&c.CreatedAt, &c.ExpiresAt)
	if err != nil {
		return Call{}, err
	}
	c.State = types.CallState(state)
	// A display name, never the address: an account without a name reads as its address's
	// local part, as everywhere else (NameFromEmail).
	if strings.TrimSpace(c.CallerName) == "" {
		c.CallerName = NameFromEmail(callerEmail)
	}
	if strings.TrimSpace(c.CalleeName) == "" {
		c.CalleeName = NameFromEmail(calleeEmail)
	}
	/* Only a photo anybody may load: an uploaded avatar is served to its own account alone
	 * (GET /api/auth/avatar), so another person's ring shows the Google photo or initials. */
	c.CallerAvatar = publicPicture(picture)
	return c, nil
}

// CallLimits are the counts the abuse limits read, for one caller and callee.
type CallLimits struct {
	// LastHour is how many calls the caller placed in the past hour, to anybody.
	LastHour int
	// DeclinedInARow is how many of the caller's latest ended calls to this callee were
	// declined, counting back from the newest until one was not (at most 3).
	DeclinedInARow int
	// LastDeclinedAt is when the newest of those declines happened.
	LastDeclinedAt time.Time
}

// CallLimitsFor reads the counts the caller's next call to callee is checked against.
func (s *Store) CallLimitsFor(ctx context.Context, callerID, calleeID string) (CallLimits, error) {
	var out CallLimits
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM calls WHERE caller_id = $1 AND created_at > now() - interval '1 hour'`,
		callerID).Scan(&out.LastHour); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT state, coalesce(ended_at, created_at)
		  FROM calls
		 WHERE caller_id = $1 AND callee_id = $2 AND state <> 'ringing'
		 ORDER BY created_at DESC
		 LIMIT 3`, callerID, calleeID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var at time.Time
		if err := rows.Scan(&state, &at); err != nil {
			return out, err
		}
		if state != string(types.CallDeclined) {
			break
		}
		if out.DeclinedInARow == 0 {
			out.LastDeclinedAt = at
		}
		out.DeclinedInARow++
	}
	return out, rows.Err()
}

/* CreateCall places a ringing call from caller to callee into the meeting slug, and gives the
 * callee a seat on its panel when they had none (the way an invited person reaches a meeting's
 * stage: POST /api/host/webinars/{slug}/join). One transaction, so a call never rings into a
 * meeting the callee cannot enter. ErrNotFound when the meeting or the callee is gone. */
func (s *Store) CreateCall(ctx context.Context, callerID, calleeID, slug string, ring time.Duration) (Call, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Call{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var webinarID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM webinars WHERE slug = $1`, slug).Scan(&webinarID)
	if noRows(err) {
		return Call{}, ErrNotFound
	}
	if err != nil {
		return Call{}, err
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO webinar_panelists (webinar_id, user_id, position)
		SELECT $1::uuid, u.id, coalesce(
		       (SELECT max(position) + 1 FROM webinar_panelists p WHERE p.webinar_id = $1::uuid), 0)
		  FROM users u WHERE u.id = $2::uuid
		ON CONFLICT DO NOTHING`, webinarID, calleeID)
	if err != nil {
		return Call{}, err
	}
	added := tag.RowsAffected() == 1
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO calls (caller_id, callee_id, webinar_id, added_panelist, expires_at)
		SELECT $1::uuid, u.id, $3::uuid, $4, now() + make_interval(secs => $5)
		  FROM users u WHERE u.id = $2::uuid
		RETURNING id::text`, callerID, calleeID, webinarID, added, ring.Seconds()).Scan(&id)
	if noRows(err) {
		return Call{}, ErrNotFound
	}
	if err != nil {
		return Call{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Call{}, err
	}
	return s.CallByID(ctx, id)
}

// CallByID loads one call. ErrNotFound for an unknown id (or one that is not a uuid).
func (s *Store) CallByID(ctx context.Context, id string) (Call, error) {
	if !looksLikeUUID(id) {
		return Call{}, ErrNotFound
	}
	c, err := scanCall(s.pool.QueryRow(ctx, `SELECT `+callColumns+callFrom+` WHERE c.id = $1::uuid`, id))
	if noRows(err) {
		return Call{}, ErrNotFound
	}
	return c, err
}

/* RingingCall is the caller's call to callee into slug still ringing, if there is one, so
 * pressing Call twice rings once. ErrNotFound when there is none. */
func (s *Store) RingingCall(ctx context.Context, callerID, calleeID, slug string) (Call, error) {
	c, err := scanCall(s.pool.QueryRow(ctx, `SELECT `+callColumns+callFrom+`
		 WHERE c.caller_id = $1 AND c.callee_id = $2 AND w.slug = $3
		   AND c.state = 'ringing' AND c.expires_at > now()
		 ORDER BY c.created_at DESC LIMIT 1`, callerID, calleeID, slug))
	if noRows(err) {
		return Call{}, ErrNotFound
	}
	return c, err
}

// RingingCallsFor are the calls ringing for this callee now, newest first: what a device that
// opens its event stream mid-ring is told about.
func (s *Store) RingingCallsFor(ctx context.Context, calleeID string) ([]Call, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+callColumns+callFrom+`
		 WHERE c.callee_id = $1 AND c.state = 'ringing' AND c.expires_at > now()
		 ORDER BY c.created_at DESC LIMIT 5`, calleeID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Call, error) { return scanCall(row) })
}

/* EndCall moves a ringing call to `to`, and reports whether this call did it.
 *
 * Only out of ringing, and only once: the UPDATE is conditional, so an accept on the phone and a
 * decline in the browser at the same moment leave one answer. A ringing call whose time is up
 * can only become missed (an accept a second late is not an accept). When the call ends any
 * way but accepted, the panel seat it gave the callee is taken back in the same transaction.
 * The returned call is the row as it now stands, changed or not. */
func (s *Store) EndCall(ctx context.Context, id string, to types.CallState) (Call, bool, error) {
	if !looksLikeUUID(id) {
		return Call{}, false, ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Call{}, false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var webinarID, calleeID string
	var added bool
	err = tx.QueryRow(ctx, `
		UPDATE calls SET state = $2, ended_at = now()
		 WHERE id = $1::uuid AND state = 'ringing'
		   AND (expires_at > now()) = ($2 <> 'missed')
		RETURNING webinar_id::text, callee_id::text, added_panelist`, id, string(to)).
		Scan(&webinarID, &calleeID, &added)
	changed := err == nil
	if err != nil && !noRows(err) {
		return Call{}, false, err
	}
	if changed && added && to != types.CallAccepted {
		if err := releaseCallSeat(ctx, tx, webinarID, calleeID); err != nil {
			return Call{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Call{}, false, err
	}
	c, err := s.CallByID(ctx, id)
	return c, changed, err
}

/* releaseCallSeat takes back the panel seat a call gave, unless another call still ringing
 * (or one that was answered) holds it for the same person and meeting. */
func releaseCallSeat(ctx context.Context, tx pgx.Tx, webinarID, calleeID string) error {
	_, err := tx.Exec(ctx, `
		DELETE FROM webinar_panelists p
		 WHERE p.webinar_id = $1::uuid AND p.user_id = $2::uuid
		   AND NOT EXISTS (SELECT 1 FROM calls c
		                    WHERE c.webinar_id = $1::uuid AND c.callee_id = $2::uuid
		                      AND c.added_panelist
		                      AND (c.state = 'accepted' OR (c.state = 'ringing' AND c.expires_at > now())))`,
		webinarID, calleeID)
	return err
}

/* ExpireCalls ends every ringing call whose time is up as missed, and returns them, so the
 * sweep can tell both ends. Each row is ended through EndCall, so the seat goes back and a
 * call answered at the same instant is left answered. */
func (s *Store) ExpireCalls(ctx context.Context, limit int) ([]Call, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text FROM calls WHERE state = 'ringing' AND expires_at <= now()
		 ORDER BY expires_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var out []Call
	for _, id := range ids {
		c, changed, err := s.EndCall(ctx, id, types.CallMissed)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return out, err
		}
		if changed {
			out = append(out, c)
		}
	}
	return out, nil
}

// ------------------------------------------------------------------ contacts

// contactLimit is the most rows one contacts search returns.
const contactLimit = 20

/* Contacts is who host may call, matching q: the people they have shared a session with.
 *
 * There is no team or address book in this product, so "people you know" is what the rows
 * already say: the panelists and co-hosts of the host's own sessions, the hosts of sessions
 * the host was a panelist on, and the signed-in attendees of the host's sessions (an approved
 * registration with an account, or a meeting guest who knocked signed in). The host's own
 * account is never listed. q matches the name, case-insensitively; empty q lists the most
 * recent. Addresses are not searched and not returned: see ContactByEmail. */
func (s *Store) Contacts(ctx context.Context, hostID, q string) ([]types.Contact, error) {
	q = strings.TrimSpace(q)
	pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
	rows, err := s.pool.Query(ctx, `
		WITH mine AS (SELECT id, created_at FROM webinars WHERE host_id = $1),
		people AS (
		    SELECT p.user_id AS uid, m.created_at AS at
		      FROM webinar_panelists p JOIN mine m ON m.id = p.webinar_id
		    UNION ALL
		    SELECT u.id, m.created_at
		      FROM webinar_stage_grants g JOIN mine m ON m.id = g.webinar_id
		      JOIN users u ON g.identity = 'user_' || u.id::text
		     WHERE g.co_host
		    UNION ALL
		    SELECT w.host_id, w.created_at
		      FROM webinar_panelists p JOIN webinars w ON w.id = p.webinar_id
		     WHERE p.user_id = $1 AND w.host_id IS NOT NULL
		    UNION ALL
		    SELECT r.user_id, r.created_at
		      FROM registrations r JOIN mine m ON m.id = r.webinar_id
		     WHERE r.user_id IS NOT NULL AND r.state = 'approved'
		    UNION ALL
		    SELECT r.knock_user_id, r.created_at
		      FROM registrations r JOIN mine m ON m.id = r.webinar_id
		     WHERE r.knock_user_id IS NOT NULL AND r.state = 'approved'
		),
		ranked AS (
		    SELECT uid, max(at) AS at FROM people WHERE uid IS NOT NULL AND uid <> $1 GROUP BY uid
		)
		SELECT u.id::text, u.name, u.email, u.initials, u.hue,
		       coalesce(u.google_picture, '')
		  FROM ranked k JOIN users u ON u.id = k.uid
		 WHERE $2 = '' OR u.name ILIKE $3
		 ORDER BY k.at DESC, u.id
		 LIMIT $4`, hostID, q, pattern, contactLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.Contact{}
	for rows.Next() {
		var c types.Contact
		var email, picture string
		if err := rows.Scan(&c.UserID, &c.Name, &email, &c.Initials, &c.Hue, &picture); err != nil {
			return nil, err
		}
		c.Name = contactName(c.Name, email)
		c.AvatarURL = publicPicture(picture)
		out = append(out, c)
	}
	return out, rows.Err()
}

/* ContactByEmail is the account with exactly this address, for "call someone by their email".
 * Exact and whole (case-insensitive), never a prefix, so the directory cannot be walked; the
 * handler rate-limits it as well. ErrNotFound when there is no such account. */
func (s *Store) ContactByEmail(ctx context.Context, email string) (types.Contact, error) {
	var c types.Contact
	var name, picture, stored string
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, email, initials, hue, coalesce(google_picture, '')
		  FROM users WHERE lower(email) = lower($1)`, strings.TrimSpace(email)).
		Scan(&c.UserID, &name, &stored, &c.Initials, &c.Hue, &picture)
	if noRows(err) {
		return types.Contact{}, ErrNotFound
	}
	if err != nil {
		return types.Contact{}, err
	}
	c.Name = contactName(name, stored)
	c.AvatarURL = publicPicture(picture)
	c.Email = strings.TrimSpace(email)
	return c, nil
}

func contactName(name, email string) string {
	if n := strings.TrimSpace(name); n != "" {
		return n
	}
	return NameFromEmail(email)
}

// publicPicture keeps a photo URL another person's browser may load: the Google one.
func publicPicture(picture string) string {
	if strings.HasPrefix(picture, "https://") {
		return picture
	}
	return ""
}

// looksLikeUUID is a cheap shape check, so a junk id is a 404 rather than a cast error.
func looksLikeUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, r := range id {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
				return false
			}
		}
	}
	return true
}
