package store

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

// scanner is satisfied by both pgx.Row (single) and pgx.Rows (iterated), so the
// row-mapping code below is written once.
type scanner interface {
	Scan(dest ...any) error
}

// joinKeyAlphabet excludes I, O, 0 and 1 so keys survive being read aloud or
// retyped out of an email.
const joinKeyAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newJoinKey() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	out := make([]byte, len(b))
	for i, v := range b {
		out[i] = joinKeyAlphabet[int(v)%len(joinKeyAlphabet)]
	}
	return string(out)
}

const registrationColumns = `
	r.id::text, w.slug, r.email, r.first_name, r.last_name, r.company, r.job_title,
	r.country, r.phone, r.answers, r.state, r.join_key, r.created_at`

// Register creates a registration, or returns the existing one if this email
// already registered. Idempotent by design: submitting the form twice returns
// the same join key rather than a duplicate row or an error.
//
// userID is empty for someone registering without an account. When it is set,
// the row is linked to that account, which is what lets the registration follow
// the person to another browser instead of living only in localStorage.
func (s *Store) Register(ctx context.Context, slug string, req types.RegisterRequest, userID string) (types.Registration, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Registration{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once committed

	var (
		webinarID     string
		approval      string
		attendeeLimit int
		status        string
	)
	// FOR UPDATE so two concurrent registrations can't both pass the capacity
	// check and push the webinar past its limit.
	err = tx.QueryRow(ctx, `
		SELECT id::text, approval, attendee_limit, status
		  FROM webinars WHERE slug = $1 FOR UPDATE`, slug).
		Scan(&webinarID, &approval, &attendeeLimit, &status)
	if noRows(err) {
		return types.Registration{}, ErrNotFound
	}
	if err != nil {
		return types.Registration{}, err
	}
	// Drafts aren't published and ended webinars can't be joined.
	if status == "draft" || status == "ended" {
		return types.Registration{}, ErrNotFound
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))

	existing, err := registrationByEmail(ctx, tx, webinarID, email)
	switch {
	case err == nil:
		// Claim an earlier guest registration for the signed-in account, so
		// registering again while signed in adopts the row rather than failing
		// on the one-per-email constraint.
		if userID != "" {
			if _, err := tx.Exec(ctx, `
				UPDATE registrations SET user_id = $1
				 WHERE webinar_id = $2 AND lower(email) = $3 AND user_id IS NULL`,
				userID, webinarID, email); err != nil {
				return types.Registration{}, err
			}
		}
		return existing, tx.Commit(ctx)
	case err == ErrNotFound:
		// fall through and create
	default:
		return types.Registration{}, err
	}

	var count int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM registrations
		 WHERE webinar_id = $1 AND state <> 'declined'`, webinarID).Scan(&count); err != nil {
		return types.Registration{}, err
	}
	if count >= attendeeLimit {
		return types.Registration{}, ErrFull
	}

	state := types.RegApproved
	if approval == string(types.ApprovalManual) {
		state = types.RegPending
	}

	answers := orEmptyMap(req.Answers)
	answersJSON, err := json.Marshal(answers)
	if err != nil {
		return types.Registration{}, err
	}

	reg := types.Registration{
		WebinarID: slug,
		Email:     email,
		FirstName: strings.TrimSpace(req.FirstName),
		LastName:  strings.TrimSpace(req.LastName),
		Company:   strings.TrimSpace(req.Company),
		JobTitle:  strings.TrimSpace(req.JobTitle),
		Country:   strings.TrimSpace(req.Country),
		Phone:     NormalisePhone(req.Phone),
		Answers:   answers,
		State:     state,
		JoinKey:   newJoinKey(),
	}

	// NULLIF so an empty userID becomes SQL NULL rather than failing the
	// foreign key on the empty string.
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO registrations
			(webinar_id, email, first_name, last_name, company, job_title, country,
			 phone, answers, state, join_key, user_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,nullif($12,'')::uuid)
		RETURNING id::text, created_at`,
		webinarID, reg.Email, reg.FirstName, reg.LastName, reg.Company,
		reg.JobTitle, reg.Country, reg.Phone, answersJSON, string(reg.State), reg.JoinKey,
		userID,
	).Scan(&reg.ID, &createdAt)
	if isUniqueViolation(err) {
		// Lost a race on the same email — return the row that won.
		won, gerr := registrationByEmail(ctx, tx, webinarID, email)
		if gerr != nil {
			return types.Registration{}, gerr
		}
		return won, tx.Commit(ctx)
	}
	if err != nil {
		return types.Registration{}, err
	}
	reg.RegisteredAt = createdAt.Format(time.RFC3339)

	return reg, tx.Commit(ctx)
}

/* RegisterGuest creates a name-only registration and returns its join key.
 *
 * Deliberately NOT a variant of Register. Register's whole shape is built around the email
 * being the identity — it looks for an existing row by address, adopts a guest row into a
 * signed-in account, and is idempotent because submitting a form twice must not take two seats.
 * A guest has no address, so none of that applies: every tap is a different person and there is
 * nothing to be idempotent about. Threading a `guest bool` through Register would have meant
 * skipping most of it.
 *
 * The capacity check is the one thing that is shared, and it is inside the transaction with
 * FOR UPDATE on the webinar for the same reason as in Register: two guests arriving together
 * must not both pass a check that only had room for one.
 *
 * State is always approved. A pending guest is a contradiction — there is no address to notify
 * and nothing for a host to review — which is why the endpoint refuses guest entry outright on
 * a manual-approval webinar rather than creating a row that can never be actioned.
 */
func (s *Store) RegisterGuest(ctx context.Context, slug, name string) (types.Registration, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Registration{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		webinarID     string
		approval      string
		attendeeLimit int
		status        string
	)
	err = tx.QueryRow(ctx, `
		SELECT id::text, approval, attendee_limit, status
		  FROM webinars WHERE slug = $1 FOR UPDATE`, slug).
		Scan(&webinarID, &approval, &attendeeLimit, &status)
	if noRows(err) {
		return types.Registration{}, ErrNotFound
	}
	if err != nil {
		return types.Registration{}, err
	}
	if status == "draft" || status == "ended" {
		return types.Registration{}, ErrNotFound
	}
	/* Refused in the store as well as in the handler.
	 *
	 * The handler checks first and gives a readable message; this is the backstop, because a
	 * guest row on a manual-approval webinar is a seat nobody can ever approve or decline, and
	 * a second caller of this method should not be able to create one by forgetting. */
	if approval == string(types.ApprovalManual) {
		return types.Registration{}, ErrGuestNotAllowed
	}

	var count int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM registrations
		 WHERE webinar_id = $1 AND state <> 'declined'`, webinarID).Scan(&count); err != nil {
		return types.Registration{}, err
	}
	if count >= attendeeLimit {
		return types.Registration{}, ErrFull
	}

	reg := types.Registration{
		WebinarID: slug,
		FirstName: strings.TrimSpace(name),
		State:     types.RegApproved,
		JoinKey:   newJoinKey(),
		IsGuest:   true,
	}

	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO registrations
			(webinar_id, email, first_name, last_name, company, job_title, country,
			 phone, answers, state, join_key, is_guest)
		VALUES ($1,'',$2,'','','','','', '{}'::jsonb, $3, $4, true)
		RETURNING created_at`,
		webinarID, reg.FirstName, string(reg.State), reg.JoinKey,
	).Scan(&createdAt)
	if err != nil {
		return types.Registration{}, err
	}
	reg.RegisteredAt = createdAt.Format(time.RFC3339)

	return reg, tx.Commit(ctx)
}

/* normalisePhone reduces whatever was typed to E.164.
 *
 * The form sends an assembled value, but a pasted number arrives with spaces, dashes,
 * brackets, or a leading 00 instead of a plus — all of which are the same number written by
 * different people. Storing them verbatim means the host's export has six formats in it and
 * nothing can dial any of them.
 *
 * A leading `00` becomes `+`, because that is the same thing in every country that uses it.
 * Everything that is not a digit is dropped. An empty result stays empty rather than becoming
 * a lone `+`, so "no number given" is distinguishable from a broken one.
 */
func NormalisePhone(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "00") {
		trimmed = "+" + trimmed[2:]
	}
	var digits strings.Builder
	for _, r := range trimmed {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	if digits.Len() == 0 {
		return ""
	}
	return "+" + digits.String()
}

// registrationByEmail looks up one registration inside an open transaction.
func registrationByEmail(ctx context.Context, tx pgx.Tx, webinarID, email string) (types.Registration, error) {
	row := tx.QueryRow(ctx, `
		SELECT `+registrationColumns+`
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE r.webinar_id = $1 AND lower(r.email) = $2`, webinarID, email)
	reg, err := scanRegistration(row)
	if noRows(err) {
		return types.Registration{}, ErrNotFound
	}
	return reg, err
}

/* ByJoinKeys resolves the join keys a browser is holding, WITH the webinar attached.
 *
 * It used to return bare registrations, and the caller filled in the webinar details from
 * the public catalogue. That worked only because the catalogue was public. Now that a list
 * requires a session and is scoped to the caller (see VisibleTo), a guest who registered
 * without an account has no catalogue to resolve against — so the answer has to be
 * self-contained.
 *
 * The join key is the credential here, exactly like the personal link Zoom emails out.
 * Holding one is proof of registration, which is why this endpoint needs no session and
 * why it must return only the rows whose keys were presented.
 */
func (s *Store) ByJoinKeys(ctx context.Context, keys []string) ([]types.RegisteredWebinar, error) {
	if len(keys) == 0 {
		return []types.RegisteredWebinar{}, nil
	}
	if len(keys) > 100 {
		keys = keys[:100] // bound the query regardless of what the client sends
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+registrationColumns+`
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE r.join_key = ANY($1)
		 ORDER BY w.starts_at ASC`, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	regs := []types.Registration{}
	for rows.Next() {
		reg, err := scanRegistration(rows)
		if err != nil {
			return nil, err
		}
		regs = append(regs, reg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return s.attachWebinars(ctx, regs)
}

/* attachWebinars pairs registrations with their webinars in one extra query.
 *
 * Two queries rather than one wide join, and shared by both callers rather than written
 * twice: the webinar read already knows how to batch-attach panelists and custom
 * questions, and duplicating that scan is how the two copies drift apart.
 */
func (s *Store) attachWebinars(ctx context.Context, regs []types.Registration) ([]types.RegisteredWebinar, error) {
	if len(regs) == 0 {
		return []types.RegisteredWebinar{}, nil
	}
	slugs := make([]string, 0, len(regs))
	for _, reg := range regs {
		slugs = append(slugs, reg.WebinarID)
	}

	webinars, err := s.queryWebinars(ctx, ` WHERE w.slug = ANY($1)`, slugs)
	if err != nil {
		return nil, err
	}
	bySlug := make(map[string]types.Webinar, len(webinars))
	for _, w := range webinars {
		bySlug[w.ID] = w
	}

	out := make([]types.RegisteredWebinar, 0, len(regs))
	for _, reg := range regs {
		w, ok := bySlug[reg.WebinarID]
		if !ok {
			continue // deleted between the two queries
		}
		out = append(out, types.RegisteredWebinar{Webinar: w, Registration: reg})
	}
	return out, nil
}

// ByUser lists a signed-in account's registrations with the webinar attached.
func (s *Store) ByUser(ctx context.Context, userID string) ([]types.RegisteredWebinar, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+registrationColumns+`
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE r.user_id = $1
		 ORDER BY w.starts_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	regs := []types.Registration{}
	for rows.Next() {
		reg, err := scanRegistration(rows)
		if err != nil {
			return nil, err
		}
		regs = append(regs, reg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return s.attachWebinars(ctx, regs)
}

// RegistrationForUser is the signed-in join path: the session identifies the
// person, so the browser does not need to present a join key at all.
func (s *Store) RegistrationForUser(ctx context.Context, slug, userID string) (types.Registration, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+registrationColumns+`
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1 AND r.user_id = $2`, slug, userID)
	reg, err := scanRegistration(row)
	if noRows(err) {
		return types.Registration{}, ErrNotFound
	}
	return reg, err
}

// ByJoinKey is the join path's authorization lookup.
func (s *Store) ByJoinKey(ctx context.Context, key string) (types.Registration, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+registrationColumns+`
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE r.join_key = $1`, key)
	reg, err := scanRegistration(row)
	if noRows(err) {
		return types.Registration{}, ErrNotFound
	}
	return reg, err
}

func scanRegistration(row scanner) (types.Registration, error) {
	var (
		reg       types.Registration
		answers   []byte
		createdAt time.Time
	)
	if err := row.Scan(
		&reg.ID, &reg.WebinarID, &reg.Email, &reg.FirstName, &reg.LastName, &reg.Company,
		&reg.JobTitle, &reg.Country, &reg.Phone, &answers, &reg.State, &reg.JoinKey,
		&createdAt,
	); err != nil {
		return types.Registration{}, err
	}
	if err := json.Unmarshal(answers, &reg.Answers); err != nil {
		return types.Registration{}, err
	}
	reg.Answers = orEmptyMap(reg.Answers)
	reg.RegisteredAt = createdAt.Format(time.RFC3339)
	return reg, nil
}

// Registrants powers the host's registration tab.
func (s *Store) Registrants(ctx context.Context, slug string, limit int) ([]types.RegistrantRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id::text, r.first_name, r.last_name, r.email, r.company,
		       r.job_title, r.phone, r.state, r.created_at, r.user_id IS NOT NULL,
		       r.is_guest
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = $1
		 ORDER BY r.created_at DESC
		 LIMIT $2`, slug, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.RegistrantRow{}
	for rows.Next() {
		var (
			r         types.RegistrantRow
			first     string
			last      string
			createdAt time.Time
		)
		if err := rows.Scan(&r.ID, &first, &last, &r.Email, &r.Company,
			&r.JobTitle, &r.Phone, &r.State, &createdAt, &r.HasAccount,
			&r.IsGuest); err != nil {
			return nil, err
		}
		r.Name = strings.TrimSpace(first + " " + last)
		r.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetRegistrationState backs the host's approve/decline action. It returns the
// affected webinar's slug so the handler can check ownership.
func (s *Store) SetRegistrationState(ctx context.Context, id string, state types.RegistrationState) (string, error) {
	var slug string
	err := s.pool.QueryRow(ctx, `
		UPDATE registrations r
		   SET state = $2
		  FROM webinars w
		 WHERE r.id = $1 AND w.id = r.webinar_id
		RETURNING w.slug`, id, string(state)).Scan(&slug)
	if noRows(err) {
		return "", ErrNotFound
	}
	return slug, err
}

// ApproveAllPending clears the manual-approval queue in one statement and
// reports how many people it let in.
func (s *Store) ApproveAllPending(ctx context.Context, slug string) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE registrations r
		   SET state = 'approved'
		  FROM webinars w
		 WHERE r.webinar_id = w.id AND w.slug = $1 AND r.state = 'pending'`, slug)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

/* SetRegistrationStates is the batch approve/decline: a chosen set of rows, one statement.
 *
 * The alternative was N calls to SetRegistrationState from the browser, which is what the UI
 * did before. That is worse than slow. A host ticking forty boxes and pressing Approve would
 * fire forty requests, each its own transaction, and a failure halfway through leaves half the
 * room approved with nothing to tell the host which half. One statement is atomic: either the
 * selection went through or none of it did.
 *
 * SCOPED BY SLUG, and that is the security-relevant part rather than a convenience. The ids
 * arrive in a request body, so without the `w.slug = $1` clause a host could paste registration
 * ids belonging to somebody else's webinar and approve strangers into it — the route's
 * requireOwnership check proves they own the webinar in the URL and says nothing about the ids.
 * Rows outside the slug are silently not matched, so the returned count is the honest number
 * changed and a caller that passes foreign ids is told it changed fewer rows than it asked for.
 *
 * Returns the rows it actually changed, not just a count, because the caller has to notify each
 * of those people and needs their addresses. Only genuinely changed rows come back — re-approving
 * somebody already approved is a no-op here and must not send them a second invitation.
 */
func (s *Store) SetRegistrationStates(
	ctx context.Context, slug string, ids []string, state types.RegistrationState,
) ([]types.RegistrantRow, error) {
	if len(ids) == 0 {
		return []types.RegistrantRow{}, nil
	}
	if len(ids) > 1000 {
		ids = ids[:1000] // bound the statement regardless of what the client sends
	}

	rows, err := s.pool.Query(ctx, `
		UPDATE registrations r
		   SET state = $3
		 WHERE r.id = ANY($2)
		   AND r.state <> $3
		   AND r.webinar_id = (SELECT id FROM webinars WHERE slug = $1)
		RETURNING r.id::text, r.first_name, r.last_name, r.email, r.company,
		          r.job_title, r.phone, r.state, r.created_at,
		          r.user_id IS NOT NULL, r.is_guest`,
		slug, ids, string(state))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.RegistrantRow{}
	for rows.Next() {
		var (
			r         types.RegistrantRow
			first     string
			last      string
			createdAt time.Time
		)
		if err := rows.Scan(&r.ID, &first, &last, &r.Email, &r.Company,
			&r.JobTitle, &r.Phone, &r.State, &createdAt, &r.HasAccount,
			&r.IsGuest); err != nil {
			return nil, err
		}
		r.Name = strings.TrimSpace(first + " " + last)
		r.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, r)
	}
	return out, rows.Err()
}

/* JoinKeyForRegistration reads back the access token for one registration.
 *
 * Separate from the batch UPDATE's RETURNING clause on purpose. The join key is a bearer
 * credential and the batch response is an API payload that gets logged, so the key is fetched
 * only on the path that actually needs it — building one person's invitation link.
 */
func (s *Store) JoinKeyForRegistration(ctx context.Context, id string) (string, error) {
	var key string
	err := s.pool.QueryRow(ctx,
		`SELECT join_key FROM registrations WHERE id = $1`, id).Scan(&key)
	if noRows(err) {
		return "", ErrNotFound
	}
	return key, err
}

// WebinarSlugForRegistration is used to authorize before mutating.
func (s *Store) WebinarSlugForRegistration(ctx context.Context, id string) (string, error) {
	var slug string
	err := s.pool.QueryRow(ctx, `
		SELECT w.slug FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE r.id = $1`, id).Scan(&slug)
	if noRows(err) {
		return "", ErrNotFound
	}
	return slug, err
}

func orEmptyMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
