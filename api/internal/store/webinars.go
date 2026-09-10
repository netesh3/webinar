package store

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/netkumar/webcast/api/types"
)

// webinarColumns is shared by every read so the scan order can't drift.
const webinarColumns = `
	w.slug, w.webinar_id, w.topic, w.summary, w.description, w.track,
	w.starts_at, w.duration_min, w.time_zone, w.kind, w.status,
	w.started_at, w.ended_at,
	w.registration_required, w.approval, w.attendee_limit, w.price_cents,
	w.passcode, w.agenda, w.takeaways, w.options, w.report,
	w.hide_attendees, w.mute_on_entry, w.allow_unmute, w.chat_enabled,
	w.chat_destination,
	w.qa_enabled, w.raise_hand_enabled, w.reactions_enabled,
	w.polls_enabled, w.locked, w.sfu_project,
	h.id, h.name, h.title, h.org, h.initials, h.hue,
	(SELECT count(*) FROM registrations r
	  WHERE r.webinar_id = w.id AND r.state <> 'declined') AS registrant_count`

const webinarFrom = ` FROM webinars w JOIN users h ON h.id = w.host_id `

func scanWebinar(row scanner) (types.Webinar, string, error) {
	var (
		w          types.Webinar
		startsAt   time.Time
		startedAt  *time.Time
		endedAt    *time.Time
		priceCents *int
		agenda     []byte
		takeaways  []byte
		options    []byte
		report     []byte
		hostID     string
		c          types.SessionControls
	)
	err := row.Scan(
		&w.ID, &w.WebinarID, &w.Topic, &w.Summary, &w.Descript, &w.Track,
		&startsAt, &w.Duration, &w.TimeZone, &w.Kind, &w.Status,
		&startedAt, &endedAt,
		&w.RegistrationRequired, &w.Approval, &w.AttendeeLimit, &priceCents,
		&w.Passcode, &agenda, &takeaways, &options, &report,
		&c.HideAttendees, &c.MuteOnEntry, &c.AllowUnmute, &c.ChatEnabled,
		&c.ChatDestination,
		&c.QAEnabled, &c.RaiseHandEnabled, &c.ReactionsEnabled,
		&c.PollsEnabled, &c.Locked, &w.SFUProject,
		&hostID, &w.Host.Name, &w.Host.Title, &w.Host.Org, &w.Host.Initials, &w.Host.Hue,
		&w.RegistrantCount,
	)
	if err != nil {
		return types.Webinar{}, "", err
	}
	w.Host.ID = hostID
	w.StartsAt = startsAt.Format(time.RFC3339)
	w.Controls = c
	if startedAt != nil {
		w.StartedAt = startedAt.Format(time.RFC3339)
	}
	if endedAt != nil {
		w.EndedAt = endedAt.Format(time.RFC3339)
	}

	if priceCents != nil {
		usd := *priceCents / 100
		w.PriceUsd = &usd
	}
	if err := json.Unmarshal(agenda, &w.Agenda); err != nil {
		return types.Webinar{}, "", fmt.Errorf("agenda: %w", err)
	}
	if err := json.Unmarshal(takeaways, &w.Takeaways); err != nil {
		return types.Webinar{}, "", fmt.Errorf("takeaways: %w", err)
	}
	if err := json.Unmarshal(options, &w.Options); err != nil {
		return types.Webinar{}, "", fmt.Errorf("options: %w", err)
	}
	if len(report) > 0 {
		var r types.WebinarReport
		if err := json.Unmarshal(report, &r); err == nil {
			w.Report = &r
		}
	}
	// Non-nil slices so the JSON is [] rather than null — the frontend maps
	// over these without guarding.
	if w.Agenda == nil {
		w.Agenda = []types.AgendaItem{}
	}
	if w.Takeaways == nil {
		w.Takeaways = []string{}
	}
	w.Panelists = []types.Person{}
	w.CustomQuestions = []types.CustomQuestion{}

	/* Derived here, so every read carries it and no caller has to remember.
	 *
	 * After Approval and Passcode are scanned, and before publicWebinar gets a chance to blank
	 * the passcode — computing it any later would read an empty string and quietly open the
	 * guest door on every passcode-protected webinar.
	 */
	w.GuestJoinAllowed = types.GuestJoinAllowedFor(w)
	return w, hostID, nil
}

func (s *Store) queryWebinars(ctx context.Context, where string, args ...any) ([]types.Webinar, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+webinarColumns+webinarFrom+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.Webinar{}
	for rows.Next() {
		w, _, err := scanWebinar(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return s.attachChildren(ctx, out)
}

/* VisibleTo returns every webinar one account is entitled to see in a list.
 *
 * This replaced Browsable, which returned every scheduled or live webinar to anybody who
 * asked, signed in or not. That was a deliberate public catalogue and it is now a closed
 * one: an account sees what it hosts, what it has been assigned to present, and what it
 * has registered for. Nothing else.
 *
 * Three arms, and the third is the one that keeps registration working. Without it a
 * person who signs up for a webinar would immediately stop being able to see it, because
 * they neither host nor present it.
 *
 * Drafts and ended sessions are included on purpose, unlike the old catalogue. The status
 * filter existed to stop strangers seeing a half-written webinar; when the audience is
 * restricted to people already involved, hiding their own past sessions from them is not
 * privacy, it is just a missing history.
 *
 * Registration by join key alone — no account — is NOT covered here and cannot be: the
 * credential lives in the browser, not in a session. Those resolve through ByJoinKeys.
 */
func (s *Store) VisibleTo(ctx context.Context, userID string) ([]types.Webinar, error) {
	return s.queryWebinars(ctx, `
		 WHERE w.host_id = $1
		    OR EXISTS (SELECT 1 FROM webinar_panelists p
		                WHERE p.webinar_id = w.id AND p.user_id = $1)
		    OR EXISTS (SELECT 1 FROM registrations r
		                WHERE r.webinar_id = w.id AND r.user_id = $1)
		 ORDER BY w.starts_at ASC`, userID)
}

// ByHost returns every webinar owned by one host, including drafts and past.
func (s *Store) ByHost(ctx context.Context, hostID string) ([]types.Webinar, error) {
	return s.queryWebinars(ctx,
		` WHERE w.host_id = $1 ORDER BY w.starts_at ASC`, hostID)
}

// OnStageFor returns webinars where this account is a panelist rather than the
// host, so the host portal can show sessions they are expected to appear on.
func (s *Store) OnStageFor(ctx context.Context, userID string) ([]types.Webinar, error) {
	return s.queryWebinars(ctx, `
		 WHERE w.host_id <> $1
		   AND EXISTS (SELECT 1 FROM webinar_panelists p
		                WHERE p.webinar_id = w.id AND p.user_id = $1)
		 ORDER BY w.starts_at ASC`, userID)
}

func (s *Store) WebinarBySlug(ctx context.Context, slug string) (types.Webinar, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+webinarColumns+webinarFrom+` WHERE w.slug = $1`, slug)
	w, _, err := scanWebinar(row)
	if noRows(err) {
		return types.Webinar{}, ErrNotFound
	}
	if err != nil {
		return types.Webinar{}, err
	}
	list, err := s.attachChildren(ctx, []types.Webinar{w})
	if err != nil {
		return types.Webinar{}, err
	}
	return list[0], nil
}

// HostIDFor is used by authorization checks — cheaper than loading the webinar.
func (s *Store) HostIDFor(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT host_id::text FROM webinars WHERE slug = $1`, slug).Scan(&id)
	if noRows(err) {
		return "", ErrNotFound
	}
	return id, err
}

// PanelistIDs returns the user ids allowed to publish alongside the host.
func (s *Store) PanelistIDs(ctx context.Context, slug string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.user_id::text
		  FROM webinar_panelists p
		  JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// Tracks lists the topic tags already in use, for the schedule form's
// suggestions. Suggesting what exists means there is no hardcoded taxonomy to
// keep in sync with whatever an operator actually runs.
func (s *Store) Tracks(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT track FROM webinars
		 WHERE track <> '' ORDER BY track`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------- writes

// CreateWebinar inserts a webinar owned by hostID and returns the full record.
//
// The slug and the human-facing webinar id are generated here rather than asked
// for: both have to be unique, and a form that can fail on "that URL is taken"
// after a host filled in twelve fields is a form people abandon.
func (s *Store) CreateWebinar(ctx context.Context, hostID string, in types.WebinarInput) (types.Webinar, error) {
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return types.Webinar{}, fmt.Errorf("%w: startsAt must be RFC3339", ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	slug, err := uniqueSlug(ctx, tx, in.Topic)
	if err != nil {
		return types.Webinar{}, err
	}
	webinarID, err := uniqueWebinarID(ctx, tx)
	if err != nil {
		return types.Webinar{}, err
	}

	agenda, takeaways, options, err := marshalWebinarJSON(in)
	if err != nil {
		return types.Webinar{}, err
	}

	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO webinars
			(slug, webinar_id, topic, summary, description, track,
			 starts_at, duration_min, time_zone, kind, status, host_id,
			 registration_required, approval, attendee_limit, passcode,
			 agenda, takeaways, options,
			 hide_attendees, mute_on_entry, allow_unmute, chat_enabled,
			 qa_enabled, raise_hand_enabled, reactions_enabled, locked,
			 chat_destination, polls_enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
		        $13,$14,$15,$16,$17,$18,$19,
		        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
		RETURNING id::text`,
		slug, webinarID, strings.TrimSpace(in.Topic), strings.TrimSpace(in.Summary),
		strings.TrimSpace(in.Descript), strings.TrimSpace(in.Track),
		startsAt, in.Duration, in.TimeZone, string(in.Kind), string(in.Status), hostID,
		in.RegistrationRequired, string(in.Approval), in.AttendeeLimit,
		strings.TrimSpace(in.Passcode), agenda, takeaways, options,
		in.Controls.HideAttendees, in.Controls.MuteOnEntry, in.Controls.AllowUnmute,
		in.Controls.ChatEnabled, in.Controls.QAEnabled, in.Controls.RaiseHandEnabled,
		in.Controls.ReactionsEnabled, in.Controls.Locked,
		string(in.Controls.ChatDestination.OrDefault()), in.Controls.PollsEnabled,
	).Scan(&id)
	if isUniqueViolation(err) {
		return types.Webinar{}, ErrConflict
	}
	if err != nil {
		return types.Webinar{}, err
	}

	if err := replaceQuestions(ctx, tx, id, in.CustomQuestions); err != nil {
		return types.Webinar{}, err
	}
	if err := replacePanelists(ctx, tx, id, hostID, in.PanelistEmails); err != nil {
		return types.Webinar{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

// UpdateWebinar replaces the editable fields of an existing webinar.
//
// Status is deliberately not settable here: moving between scheduled, live and
// ended has side effects at the SFU, so it goes through SetStatus. The only
// exception is publishing a draft, which is a pure database change.
func (s *Store) UpdateWebinar(ctx context.Context, slug string, in types.WebinarInput) (types.Webinar, error) {
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return types.Webinar{}, fmt.Errorf("%w: startsAt must be RFC3339", ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Webinar{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	agenda, takeaways, options, err := marshalWebinarJSON(in)
	if err != nil {
		return types.Webinar{}, err
	}

	var (
		id      string
		hostID  string
		current string
	)
	err = tx.QueryRow(ctx,
		`SELECT id::text, host_id::text, status FROM webinars WHERE slug = $1 FOR UPDATE`,
		slug).Scan(&id, &hostID, &current)
	if noRows(err) {
		return types.Webinar{}, ErrNotFound
	}
	if err != nil {
		return types.Webinar{}, err
	}

	// Publishing a draft is allowed; anything else keeps the live status the
	// start/end endpoints own.
	status := current
	if current == string(types.StatusDraft) &&
		(in.Status == types.StatusScheduled || in.Status == types.StatusDraft) {
		status = string(in.Status)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE webinars SET
			topic = $2, summary = $3, description = $4, track = $5,
			starts_at = $6, duration_min = $7, time_zone = $8, kind = $9,
			status = $10, registration_required = $11, approval = $12,
			attendee_limit = $13, passcode = $14,
			agenda = $15, takeaways = $16, options = $17,
			hide_attendees = $18, mute_on_entry = $19, allow_unmute = $20,
			chat_enabled = $21, qa_enabled = $22, raise_hand_enabled = $23,
			reactions_enabled = $24, locked = $25, chat_destination = $26,
			polls_enabled = $27,
			updated_at = now()
		 WHERE id = $1`,
		id, strings.TrimSpace(in.Topic), strings.TrimSpace(in.Summary),
		strings.TrimSpace(in.Descript), strings.TrimSpace(in.Track),
		startsAt, in.Duration, in.TimeZone, string(in.Kind), status,
		in.RegistrationRequired, string(in.Approval), in.AttendeeLimit,
		strings.TrimSpace(in.Passcode), agenda, takeaways, options,
		in.Controls.HideAttendees, in.Controls.MuteOnEntry, in.Controls.AllowUnmute,
		in.Controls.ChatEnabled, in.Controls.QAEnabled, in.Controls.RaiseHandEnabled,
		in.Controls.ReactionsEnabled, in.Controls.Locked,
		string(in.Controls.ChatDestination.OrDefault()), in.Controls.PollsEnabled,
	); err != nil {
		return types.Webinar{}, err
	}

	if err := replaceQuestions(ctx, tx, id, in.CustomQuestions); err != nil {
		return types.Webinar{}, err
	}
	if err := replacePanelists(ctx, tx, id, hostID, in.PanelistEmails); err != nil {
		return types.Webinar{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Webinar{}, err
	}
	return s.WebinarBySlug(ctx, slug)
}

// SetStatus moves a webinar between scheduled, live and ended, stamping the
// transition times. Returns the updated record so a handler can mirror the new
// state into room metadata in the same request.
func (s *Store) SetStatus(ctx context.Context, slug string, status types.WebinarStatus) (types.Webinar, error) {
	var col string
	switch status {
	case types.StatusLive:
		col = `started_at = coalesce(started_at, now()), ended_at = NULL`
	case types.StatusEnded:
		col = `ended_at = now()`
	case types.StatusScheduled, types.StatusDraft:
		col = `started_at = NULL, ended_at = NULL`
	default:
		return types.Webinar{}, fmt.Errorf("%w: unknown status %q", ErrInvalid, status)
	}

	tag, err := s.pool.Exec(ctx,
		`UPDATE webinars SET status = $2, `+col+`, updated_at = now() WHERE slug = $1`,
		slug, string(status))
	if err != nil {
		return types.Webinar{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Webinar{}, ErrNotFound
	}
	return s.WebinarBySlug(ctx, slug)
}

// UpdateControls applies a partial change to the in-session controls and
// returns the whole webinar, so the caller can push the new state to the SFU
// without a second read.
func (s *Store) UpdateControls(ctx context.Context, slug string, p types.ControlsPatch) (types.Webinar, error) {
	// Sent as *string rather than as *ChatDestination so the driver never has to
	// guess at a named type, matching how Kind and Status are written.
	var chatDestination *string
	if p.ChatDestination != nil {
		v := string(*p.ChatDestination)
		chatDestination = &v
	}

	// COALESCE against a nullable parameter is how a partial update stays one
	// statement: a nil pointer arrives as SQL NULL and the column keeps its
	// value, with no dynamically assembled SET clause to get wrong.
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET
			hide_attendees     = coalesce($2, hide_attendees),
			mute_on_entry      = coalesce($3, mute_on_entry),
			allow_unmute       = coalesce($4, allow_unmute),
			chat_enabled       = coalesce($5, chat_enabled),
			qa_enabled         = coalesce($6, qa_enabled),
			raise_hand_enabled = coalesce($7, raise_hand_enabled),
			reactions_enabled  = coalesce($8, reactions_enabled),
			locked             = coalesce($9, locked),
			chat_destination   = coalesce($10, chat_destination),
			polls_enabled      = coalesce($11, polls_enabled),
			updated_at         = now()
		 WHERE slug = $1`,
		slug, p.HideAttendees, p.MuteOnEntry, p.AllowUnmute, p.ChatEnabled,
		p.QAEnabled, p.RaiseHandEnabled, p.ReactionsEnabled, p.Locked,
		chatDestination, p.PollsEnabled)
	if err != nil {
		return types.Webinar{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Webinar{}, ErrNotFound
	}
	return s.WebinarBySlug(ctx, slug)
}

/* Deleted reports what a delete actually removed.
 *
 * Returned rather than logged so the handler can log one line and the tests can assert on
 * numbers instead of on "no error". "Delete everything belonging to this webinar" is a claim
 * about seven tables and two kinds of file, and a delete that quietly missed one of them
 * returns nil just as cheerfully as one that worked.
 */
type Deleted struct {
	Status        string
	Registrations int
	ChatMessages  int
	Polls         int
	PollVotes     int
	Recordings    int
	Panelists     int
	StageGrants   int
	Questions     int
	/* Object-storage keys that were pointed at by the rows above. The rows cascade; bytes do
	 * not, so these are the caller's to delete once the transaction has committed. Chat images
	 * and recording files both live here — a recording is by far the larger of the two and was
	 * being left behind entirely. */
	BlobKeys []string
}

/* DeleteWebinar removes a webinar and everything hanging off it.
 *
 * Allowed in ANY status, including live and ended. It used to refuse both, on the reasoning
 * that an ended webinar's registrations are the attendance record — a defensible policy, and
 * the wrong one for a host who wants their data gone. "Delete this webinar" now means what it
 * says, and the confirmation dialog is where the warning belongs.
 *
 * Everything happens in one transaction, and the counts are taken inside it. Counting before
 * the delete in a separate query would report what was there a moment ago rather than what was
 * removed, and a registration arriving between the two would be silently uncounted while still
 * being deleted.
 *
 * The child rows are removed by ON DELETE CASCADE (see the migrations), not by DELETE
 * statements here. Naming each table in this function would mean a table added later is a
 * table this function forgets — the schema is the right place for that rule. What this
 * function does add is the counting and the collection of storage keys, because neither is
 * something a cascade can do.
 */
func (s *Store) DeleteWebinar(ctx context.Context, slug string) (Deleted, error) {
	var out Deleted

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id string
	err = tx.QueryRow(ctx, `SELECT id, status FROM webinars WHERE slug = $1`, slug).
		Scan(&id, &out.Status)
	if noRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}

	/* One round trip for every count, so the numbers are consistent with each other and with
	 * the delete below. `webinar_stage_grants` and `webinar_panelists` are included because a
	 * promotion and an invitation are also data about this webinar. */
	err = tx.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM registrations       WHERE webinar_id = $1),
		       (SELECT count(*) FROM chat_messages       WHERE webinar_id = $1),
		       (SELECT count(*) FROM polls               WHERE webinar_id = $1),
		       (SELECT count(*) FROM poll_votes v JOIN polls p ON p.id = v.poll_id
		                                          WHERE p.webinar_id = $1),
		       (SELECT count(*) FROM recordings         WHERE webinar_id = $1),
		       (SELECT count(*) FROM webinar_panelists   WHERE webinar_id = $1),
		       (SELECT count(*) FROM webinar_stage_grants WHERE webinar_id = $1),
		       (SELECT count(*) FROM custom_questions    WHERE webinar_id = $1)`, id).
		Scan(&out.Registrations, &out.ChatMessages, &out.Polls, &out.PollVotes,
			&out.Recordings, &out.Panelists, &out.StageGrants, &out.Questions)
	if err != nil {
		return out, err
	}

	/* Every key in object storage this webinar owns, in one query.
	 *
	 * Chat images and recording files, unioned rather than fetched separately, because the
	 * caller does the same thing with both and a second list is a second thing to forget. A
	 * recording with no storage key yet — a row created a moment ago whose first chunk has not
	 * arrived — is filtered out rather than handed over as an empty string. */
	rows, err := tx.Query(ctx, `
		SELECT media_key FROM chat_messages
		 WHERE webinar_id = $1 AND media_key IS NOT NULL AND media_key <> ''
		UNION ALL
		SELECT storage_key FROM recordings
		 WHERE webinar_id = $1 AND storage_key <> ''`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return out, err
		}
		out.BlobKeys = append(out.BlobKeys, key)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM webinars WHERE id = $1`, id); err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// AddPanelist grants an existing account a seat on the stage.
func (s *Store) AddPanelist(ctx context.Context, slug, email string) (types.Person, error) {
	u, err := s.UserByEmail(ctx, email)
	if err != nil {
		return types.Person{}, err
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_panelists (webinar_id, user_id, position)
		SELECT w.id, $2, coalesce(
			(SELECT max(position) + 1 FROM webinar_panelists p WHERE p.webinar_id = w.id), 0)
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT DO NOTHING`, slug, u.ID)
	if err != nil {
		return types.Person{}, err
	}
	if tag.RowsAffected() == 0 {
		// Either the webinar is gone or they already have a seat. The second is
		// not an error worth surfacing to someone clicking "invite".
		if _, err := s.HostIDFor(ctx, slug); err != nil {
			return types.Person{}, err
		}
	}
	return u.Person(), nil
}

func (s *Store) RemovePanelist(ctx context.Context, slug, userID string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_panelists p
		 USING webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1 AND p.user_id = $2`, slug, userID)
	return err
}

// --------------------------------------------------------------- stage grants

// GrantStage records that a host promoted an attendee, so the promotion
// survives that attendee reconnecting. Without it, a panelist who loses their
// wifi rejoins as audience and the host has to promote them again.
//
// audioOnly distinguishes "allowed to talk" from a full stage seat, and has to be
// stored too — coming back from a dropped connection with a camera the host never
// granted would be worse than losing the grant entirely.
// A fresh grant clears any host mute: bringing someone (back) on stage is the
// host saying they may speak.
func (s *Store) GrantStage(ctx context.Context, slug, identity, display string, audioOnly bool) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_stage_grants (webinar_id, identity, display, audio_only)
		SELECT w.id, $2, $3, $4 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE
		   SET display = excluded.display, audio_only = excluded.audio_only,
		       muted_by_host = false`,
		slug, identity, display, audioOnly)
	return err
}

func (s *Store) RevokeStage(ctx context.Context, slug, identity string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_stage_grants g
		 USING webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1 AND g.identity = $2`, slug, identity)
	return err
}

// StageGrant describes what a host granted one identity earlier in the session.
//
// A struct rather than a row of bools: `granted, audioOnly, mutedByHost, err :=`
// is a call site where transposing two values compiles cleanly and hands somebody
// a microphone the host took away.
type StageGrant struct {
	// Granted false means ordinary audience — the other fields are meaningless.
	Granted   bool
	AudioOnly bool
	// MutedByHost survives a reconnect on purpose: a reload must not be a way to
	// undo a host mute.
	MutedByHost bool
}

func (s *Store) StageGrant(ctx context.Context, slug, identity string) (StageGrant, error) {
	var g StageGrant
	err := s.pool.QueryRow(ctx, `
		SELECT g.audio_only, g.muted_by_host FROM webinar_stage_grants g
		  JOIN webinars w ON w.id = g.webinar_id
		 WHERE w.slug = $1 AND g.identity = $2`, slug, identity).
		Scan(&g.AudioOnly, &g.MutedByHost)
	if noRows(err) {
		return StageGrant{}, nil
	}
	if err != nil {
		return StageGrant{}, err
	}
	g.Granted = true
	return g, nil
}

// SetGrantMuted latches or lifts a host mute for one identity.
//
// A scheduled panelist has no grant to hang it on — they speak by right, from the
// panelist list — so muting one inserts a row that records only the mute. Without
// that, reloading the page would be how a muted panelist starts talking again.
func (s *Store) SetGrantMuted(ctx context.Context, slug, identity string, muted bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinar_stage_grants g SET muted_by_host = $3
		  FROM webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1 AND g.identity = $2`,
		slug, identity, muted)
	if err != nil || tag.RowsAffected() > 0 {
		return err
	}
	// Nothing to lift a mute from, so there is nothing to record.
	if !muted {
		return nil
	}
	// audio_only true rather than false on this insert: the value is never read
	// for a panelist, and if it ever were read for somebody else it would hand
	// back the narrower grant rather than a camera nobody granted.
	_, err = s.pool.Exec(ctx, `
		INSERT INTO webinar_stage_grants (webinar_id, identity, display, audio_only, muted_by_host)
		SELECT w.id, $2, '', true, true FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE SET muted_by_host = true`,
		slug, identity)
	return err
}

// MuteAllGrants latches the host mute across every grant in one session, so
// "mute everyone" also holds for the people the host had allowed to speak.
func (s *Store) MuteAllGrants(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE webinar_stage_grants g SET muted_by_host = true
		  FROM webinars w
		 WHERE w.id = g.webinar_id AND w.slug = $1`, slug)
	return err
}

// ClearStageGrants runs when a webinar ends: promotions are scoped to one
// session, so the next one starts with only the scheduled panelists.
func (s *Store) ClearStageGrants(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM webinar_stage_grants g
		 USING webinars w WHERE w.id = g.webinar_id AND w.slug = $1`, slug)
	return err
}

// ------------------------------------------------------------------ helpers

func marshalWebinarJSON(in types.WebinarInput) (agenda, takeaways, options []byte, err error) {
	if in.Agenda == nil {
		in.Agenda = []types.AgendaItem{}
	}
	if in.Takeaways == nil {
		in.Takeaways = []string{}
	}
	if agenda, err = json.Marshal(in.Agenda); err != nil {
		return nil, nil, nil, err
	}
	if takeaways, err = json.Marshal(in.Takeaways); err != nil {
		return nil, nil, nil, err
	}
	if options, err = json.Marshal(in.Options); err != nil {
		return nil, nil, nil, err
	}
	return agenda, takeaways, options, nil
}

func replaceQuestions(ctx context.Context, tx pgx.Tx, webinarID string, qs []types.CustomQuestion) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM custom_questions WHERE webinar_id = $1`, webinarID); err != nil {
		return err
	}
	for i, q := range qs {
		key := strings.TrimSpace(q.ID)
		if key == "" {
			key = slugify(q.Label)
		}
		if key == "" {
			continue // a question with neither key nor label is not a question
		}
		kind := q.Type
		switch kind {
		case "short", "select", "checkbox":
		default:
			kind = "short"
		}
		opts, err := json.Marshal(orEmptyStrings(q.Options))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO custom_questions
				(webinar_id, key, label, type, required, options, position)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (webinar_id, key) DO UPDATE
			   SET label = excluded.label, type = excluded.type,
			       required = excluded.required, options = excluded.options,
			       position = excluded.position`,
			webinarID, key, strings.TrimSpace(q.Label), kind, q.Required, opts, i,
		); err != nil {
			return err
		}
	}
	return nil
}

// replacePanelists resolves emails to accounts. Addresses with no account are
// skipped rather than rejected: a host pasting in a list should not have the
// whole save fail because one colleague has not signed up yet.
func replacePanelists(ctx context.Context, tx pgx.Tx, webinarID, hostID string, emails []string) error {
	if _, err := tx.Exec(ctx,
		`DELETE FROM webinar_panelists WHERE webinar_id = $1`, webinarID); err != nil {
		return err
	}
	seen := map[string]bool{hostID: true} // the host is already on the stage
	position := 0
	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" {
			continue
		}
		var userID string
		err := tx.QueryRow(ctx,
			`SELECT id::text FROM users WHERE lower(email) = $1`, email).Scan(&userID)
		if noRows(err) {
			continue
		}
		if err != nil {
			return err
		}
		if seen[userID] {
			continue
		}
		seen[userID] = true
		if _, err := tx.Exec(ctx, `
			INSERT INTO webinar_panelists (webinar_id, user_id, position)
			VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
			webinarID, userID, position); err != nil {
			return err
		}
		position++
	}
	return nil
}

// uniqueSlug turns a topic into a URL segment, adding a short suffix only when
// the plain form is taken.
func uniqueSlug(ctx context.Context, tx pgx.Tx, topic string) (string, error) {
	base := slugify(topic)
	if base == "" {
		base = "webinar"
	}
	if len(base) > 60 {
		base = strings.Trim(base[:60], "-")
	}
	for attempt := 0; attempt < 12; attempt++ {
		candidate := base
		if attempt > 0 {
			suffix, err := randomDigits(4)
			if err != nil {
				return "", err
			}
			candidate = base + "-" + suffix
		}
		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM webinars WHERE slug = $1)`, candidate).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not allocate a unique slug for %q", topic)
}

// uniqueWebinarID mints the human-readable id a host reads out on a call,
// grouped like a phone number for the same reason phone numbers are.
func uniqueWebinarID(ctx context.Context, tx pgx.Tx) (string, error) {
	for attempt := 0; attempt < 12; attempt++ {
		a, err := randomDigits(3)
		if err != nil {
			return "", err
		}
		b, err := randomDigits(4)
		if err != nil {
			return "", err
		}
		c, err := randomDigits(4)
		if err != nil {
			return "", err
		}
		candidate := a + " " + b + " " + c

		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM webinars WHERE webinar_id = $1)`, candidate).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not allocate a unique webinar id")
}

func randomDigits(n int) (string, error) {
	out := make([]byte, n)
	for i := range out {
		v, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		out[i] = byte('0' + v.Int64())
	}
	return string(out), nil
}

// slugify keeps ASCII letters and digits and collapses everything else into
// single hyphens.
func slugify(s string) string {
	var b strings.Builder
	lastHyphen := true // leading hyphens are suppressed
	for _, r := range strings.ToLower(s) {
		switch {
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			b.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			b.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// attachChildren fills panelists and custom questions for a batch of webinars
// with two queries total rather than two per webinar.
func (s *Store) attachChildren(ctx context.Context, list []types.Webinar) ([]types.Webinar, error) {
	if len(list) == 0 {
		return list, nil
	}
	slugs := make([]string, len(list))
	idx := make(map[string]int, len(list))
	for i, w := range list {
		slugs[i] = w.ID
		idx[w.ID] = i
	}

	panelRows, err := s.pool.Query(ctx, `
		SELECT w.slug, u.id::text, u.name, u.title, u.org, u.initials, u.hue
		  FROM webinar_panelists p
		  JOIN webinars w ON w.id = p.webinar_id
		  JOIN users u    ON u.id = p.user_id
		 WHERE w.slug = ANY($1)
		 ORDER BY w.slug, p.position`, slugs)
	if err != nil {
		return nil, err
	}
	for panelRows.Next() {
		var slug string
		var p types.Person
		if err := panelRows.Scan(&slug, &p.ID, &p.Name, &p.Title, &p.Org, &p.Initials, &p.Hue); err != nil {
			panelRows.Close()
			return nil, err
		}
		if i, ok := idx[slug]; ok {
			list[i].Panelists = append(list[i].Panelists, p)
		}
	}
	panelRows.Close()
	if err := panelRows.Err(); err != nil {
		return nil, err
	}

	qRows, err := s.pool.Query(ctx, `
		SELECT w.slug, q.key, q.label, q.type, q.required, q.options
		  FROM custom_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = ANY($1)
		 ORDER BY w.slug, q.position`, slugs)
	if err != nil {
		return nil, err
	}
	defer qRows.Close()
	for qRows.Next() {
		var slug string
		var q types.CustomQuestion
		var opts []byte
		if err := qRows.Scan(&slug, &q.ID, &q.Label, &q.Type, &q.Required, &opts); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(opts, &q.Options); err != nil {
			return nil, err
		}
		if i, ok := idx[slug]; ok {
			list[i].CustomQuestions = append(list[i].CustomQuestions, q)
		}
	}
	return list, qRows.Err()
}

/* ClaimSFUProject records which LiveKit project a webinar's room lives on, and reports what was
 * already recorded if somebody got there first.
 *
 * FOR UPDATE, and therefore a transaction. Read-then-write without the lock would let two
 * attendees arriving in the same millisecond each see an empty pin, each write their own choice,
 * and end up in two separate rooms on two different projects — the exact split this column
 * exists to prevent. The lock serialises them: the second one reads the first one's answer and
 * uses it. Same reasoning, and the same shape, as the capacity check in RegisterGuest.
 *
 * `fresh` says the pin was created by THIS call. It is the caller's licence to try a different
 * project when the first one refuses the room, because a pin that did not exist a moment ago
 * cannot have anybody connected to it yet. See Server.sfuFor.
 */
func (s *Store) ClaimSFUProject(
	ctx context.Context, slug, projectID string,
) (effective string, fresh bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var current string
	err = tx.QueryRow(ctx,
		`SELECT sfu_project FROM webinars WHERE slug = $1 FOR UPDATE`, slug).Scan(&current)
	if noRows(err) {
		return "", false, ErrNotFound
	}
	if err != nil {
		return "", false, err
	}
	if current != "" {
		// Somebody already chose. Committing an empty transaction is cheaper to reason
		// about than a second exit path that skips the commit.
		return current, false, tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE webinars SET sfu_project = $2 WHERE slug = $1`, slug, projectID); err != nil {
		return "", false, err
	}
	return projectID, true, tx.Commit(ctx)
}

/* RepinSFUProject moves a webinar to a different project, unconditionally.
 *
 * Used in exactly one situation: the project a webinar was pinned to is no longer in the
 * configuration, so nothing can mint a token for it and the room is unreachable. The caller
 * checks that the webinar is not live before calling — moving a live room puts the host on one
 * project and new arrivals on another, which is worse than the error it replaces.
 */
func (s *Store) RepinSFUProject(ctx context.Context, slug, projectID string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE webinars SET sfu_project = $2 WHERE slug = $1`, slug, projectID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* WebinarsOnSFUProject answers "what is still running on the project I am about to retire".
 *
 * Live and scheduled only. An ended webinar keeps its pin as a record of where it happened, and
 * including those would bury the two sessions an operator actually has to worry about under
 * every session they have ever run.
 */
func (s *Store) WebinarsOnSFUProject(ctx context.Context, projectID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug FROM webinars
		 WHERE sfu_project = $1 AND status IN ('live', 'scheduled')
		 ORDER BY starts_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		out = append(out, slug)
	}
	return out, rows.Err()
}
