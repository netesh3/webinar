package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/netkumar/webcast/api/types"
)

// AttendanceTouch is one person to record as present.
type AttendanceTouch struct {
	Identity       string
	RegistrationID string
	Name           string
}

func (s *Store) TouchAttendance(ctx context.Context, slug, identity, registrationID, name string) error {
	return s.touchAttendance(ctx, slug, []AttendanceTouch{{Identity: identity, RegistrationID: registrationID, Name: name}})
}

// TouchAttendanceMany records everyone the SFU roster currently shows. It takes
// participants rather than bare identities so the name travels with them: these
// rows have no registration to look a name up in later.
func (s *Store) TouchAttendanceMany(ctx context.Context, slug string, seen []types.LiveParticipant) error {
	touches := make([]AttendanceTouch, 0, len(seen))
	for _, p := range seen {
		touches = append(touches, AttendanceTouch{Identity: p.Identity, Name: p.Name})
	}
	return s.touchAttendance(ctx, slug, touches)
}

// attendanceTouchEvery is how stale last_seen_at may get before a touch rewrites
// it. The host's roster poll touches every attendee every few seconds; nothing
// reads last_seen_at that finely (watch time comes from attendance_visits), so
// rewriting the row each time only produced dead tuples.
const attendanceTouchEvery = time.Minute

/* touchAttendance upserts a batch in one statement.
 *
 * Identities repeat within a batch only by accident, but ON CONFLICT refuses to touch a
 * row twice in one statement, so they are merged first: the first non-empty name and
 * registration win.
 *
 * An existing row is rewritten only when it gains something — a name or registration it
 * lacked — or when last_seen_at is older than attendanceTouchEvery. Otherwise the
 * conflict is a no-op and the row is not rewritten. */
func (s *Store) touchAttendance(ctx context.Context, slug string, touches []AttendanceTouch) error {
	var ids, regs, names []string
	index := map[string]int{}
	for _, t := range touches {
		if t.Identity == "" {
			continue
		}
		name := strings.TrimSpace(t.Name)
		if i, ok := index[t.Identity]; ok {
			if regs[i] == "" {
				regs[i] = t.RegistrationID
			}
			if names[i] == "" {
				names[i] = name
			}
			continue
		}
		index[t.Identity] = len(ids)
		ids = append(ids, t.Identity)
		regs = append(regs, t.RegistrationID)
		names = append(names, name)
	}
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO attendance (webinar_id, identity, registration_id, name)
		SELECT w.id, p.identity,
		       /* The registration, from the caller or from the identity itself.
		        *
		        * An attendee identity IS "att_" plus their join key (see attendeeIdentity in
		        * api/internal/api/join.go), and join_key is unique — so a caller that does not
		        * have the registration to hand does not have to go without it. That is every
		        * caller except the join endpoint: the host's roster poll and the SFU webhooks
		        * know an identity and nothing else.
		        *
		        * Which is the root of what migrations/0034 worked around. Rows written without
		        * a registration had no name to join to, so the report fell back to printing
		        * "att_7f3c..." at people; 0034 added a name column and backfilled it from chat.
		        * Resolving the link here means the row finds the registrant's real name AND
		        * their email, which a display name never carried. */
		       COALESCE(
		         NULLIF(p.registration_id,'')::uuid,
		         (SELECT r.id FROM registrations r
		           WHERE r.webinar_id = w.id
		             AND starts_with(p.identity, 'att_')
		             AND r.join_key = substring(p.identity from 5))
		       ),
		       p.name
		  FROM webinars w
		 CROSS JOIN unnest($2::text[], $3::text[], $4::text[]) AS p(identity, registration_id, name)
		 WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE
		   SET last_seen_at = now(),
		       -- A later touch usually knows less than the first one: a name can arrive empty.
		       -- Fill in what is still blank, never overwrite what is already there.
		       registration_id = COALESCE(attendance.registration_id, EXCLUDED.registration_id),
		       name = CASE WHEN attendance.name = '' THEN EXCLUDED.name ELSE attendance.name END
		 WHERE attendance.last_seen_at < now() - $5::interval
		    OR (attendance.registration_id IS NULL AND EXCLUDED.registration_id IS NOT NULL)
		    OR (attendance.name = '' AND EXCLUDED.name <> '')`,
		slug, ids, regs, names, attendanceTouchEvery)
	return err
}

/* OpenVisit records an arrival, and is safe to call twice for the same one.
 *
 * LiveKit retries a webhook it did not get a 200 for, so a duplicate participant_joined is
 * ordinary rather than exceptional. The partial unique index on (webinar_id, identity) WHERE
 * left_at IS NULL is what makes the second one a no-op instead of a second visit — which
 * would otherwise double that person's time for the rest of the session.
 *
 * The summary row is touched too, because it is where the name and the registration live and
 * the report still reads them from there.
 *
 * An edge viewer the host just promoted arrives here with their feed visit still open. That
 * visit is handed to the webhooks (seen_at cleared) rather than duplicated: the person never
 * left, and from now on participant_left is what says when they do.
 */
func (s *Store) OpenVisit(ctx context.Context, slug, identity, name string, at time.Time) error {
	if identity == "" {
		return nil
	}
	if err := s.TouchAttendance(ctx, slug, identity, "", name); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO attendance_visits (webinar_id, identity, joined_at)
		SELECT w.id, $2, $3 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) WHERE left_at IS NULL DO UPDATE
		   SET seen_at = NULL
		 WHERE attendance_visits.seen_at IS NOT NULL`,
		slug, identity, at)
	return err
}

/* CloseVisit records a departure against whichever visit is still open.
 *
 * Idempotent for the same reason OpenVisit is: the WHERE clause finds nothing the second
 * time. A left with no matching open visit — a webhook that arrived out of order, or a
 * participant whose join we never saw — writes nothing rather than inventing a visit, since
 * a visit with no arrival has no duration anybody could believe.
 *
 * Only a visit the webhooks own. An edge viewer's (seen_at set) is the browser's to close: a
 * late participant_left from their spell on the stage must not end the feed visit they went
 * back to.
 */
func (s *Store) CloseVisit(ctx context.Context, slug, identity string, at time.Time) error {
	if identity == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = $3
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1
		   AND v.identity = $2 AND v.left_at IS NULL AND v.seen_at IS NULL`,
		slug, identity, at)
	return err
}

/* CloseOpenVisits ends every visit still open on a webinar.
 *
 * Called from more than one place on purpose, because no single one of them is reliable.
 * room_finished is the tidy signal and does not arrive if LiveKit is restarted; the host
 * pressing End is reliable but says nothing about a room that emptied on the meeting limit;
 * and a participant_left can be lost like any other webhook. Whichever gets here first wins
 * and the rest are no-ops, so an open visit cannot outlive the session and report itself as
 * "still watching" three weeks later.
 *
 * An edge visit whose beats had already stopped ends at its last beat, not at `at`: the
 * viewer who closed their tab twenty minutes before the end did not watch those twenty.
 */
func (s *Store) CloseOpenVisits(ctx context.Context, slug string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = CASE WHEN v.seen_at < $2::timestamptz - $3::interval THEN v.seen_at
		                      ELSE GREATEST($2, v.joined_at) END
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1 AND v.left_at IS NULL`,
		slug, at, edgeVisitStale)
	return err
}

func (s *Store) UpsertSessionQuestion(ctx context.Context, slug string, q types.SessionQuestion) error {
	if q.ID == "" || q.Text == "" {
		return nil
	}
	role := q.Role
	if role == "" {
		role = types.RoleAttendee
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_questions (id, webinar_id, identity, name, body, anonymous, role)
		SELECT $1, w.id, $3, $4, $5, $6, $7
		  FROM webinars w WHERE w.slug = $2
		ON CONFLICT (id) DO NOTHING`,
		q.ID, slug, q.Identity, q.Name, q.Text, q.Anonymous, string(role))
	return err
}

// Upvotes are in questions.go (UpvoteQuestion): one row per voter, so a rejoin can
// tell somebody they already voted and a second click is not a second vote.

func (s *Store) UpdateSessionQuestion(ctx context.Context, slug, id string, patch types.QuestionPatch) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_questions q
		   SET answered = COALESCE($3, q.answered),
		       answer = COALESCE($4, q.answer),
		       pinned = COALESCE($5, q.pinned),
		       dismissed = COALESCE($6, q.dismissed)
		  FROM webinars w
		 WHERE q.webinar_id = w.id AND w.slug = $1 AND q.id = $2`,
		slug, id, patch.Answered, patch.Answer, patch.Pinned, patch.Dismissed)
	return err
}

func (s *Store) SessionQuestions(ctx context.Context, slug string) ([]types.SessionQuestion, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT q.id, q.identity, q.name, q.body, q.anonymous, q.answered, q.answer,
		       q.pinned, q.dismissed, q.upvotes, q.created_at
		  FROM session_questions q
		  JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1
		 ORDER BY q.pinned DESC, q.dismissed, q.answered, q.upvotes DESC, q.created_at`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.SessionQuestion{}
	for rows.Next() {
		var q types.SessionQuestion
		var at time.Time
		if err := rows.Scan(&q.ID, &q.Identity, &q.Name, &q.Text, &q.Anonymous, &q.Answered,
			&q.Answer, &q.Pinned, &q.Dismissed, &q.Upvotes, &at); err != nil {
			return nil, err
		}
		q.CreatedAt = at.Format(time.RFC3339)
		out = append(out, q)
	}
	return out, rows.Err()
}

func (s *Store) ComputeAndSaveReport(ctx context.Context, slug string) (types.SessionReport, error) {
	rep, err := s.SessionReport(ctx, slug)
	if err != nil {
		return types.SessionReport{}, err
	}
	summary := types.WebinarReport{
		Attended:    rep.Attended,
		AvgWatchMin: rep.AvgWatchMin,
		Questions:   rep.Questions,
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		return types.SessionReport{}, err
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE webinars SET report = $2 WHERE slug = $1`, slug, raw)
	return rep, err
}

/* The window a visit is measured against, and the clip that applies it.
 *
 * Attendees are in the LiveKit room while the "waiting for the host" screen is showing, so
 * time connected is not time watching: somebody who arrives twenty minutes early and leaves
 * at half past has been in the room for fifty minutes and has seen thirty. The report says
 * thirty, because "watch time" to anybody reading it means time there was something to
 * watch.
 *
 * `lo` is deliberately allowed to be NULL, and GREATEST ignores NULLs in Postgres — so a
 * webinar that never went live has no lower bound and its room time is reported in full.
 * Zeros for everybody would be defensible and useless: for a session that was set up, sat in,
 * and abandoned, how long people waited is the only thing the report can say.
 */
const attendanceWindow = `
	WITH win AS (
	  SELECT w.id, w.host_id, w.started_at AS lo, COALESCE(w.ended_at, now()) AS hi
	    FROM webinars w WHERE w.slug = $1
	)`

// clippedSeconds is one visit's contribution, inside the live window and never negative.
const clippedSeconds = `
	GREATEST(0, EXTRACT(EPOCH FROM (
	  LEAST(COALESCE(v.left_at, win.hi), win.hi) - GREATEST(v.joined_at, win.lo)
	)))`

/* The headline figures are attendees only, and `starts_with(identity, 'att_')` is how.
 *
 * The stage is in the attendance table too — a host's own presence is a participant like any
 * other — and counting it would put the host in their own audience and drag the average
 * towards the one person who was there for the whole hour by definition. The per-person rows
 * still list them, labelled, because "was my panelist there?" is a real question. It is only
 * the summary that is audience-only.
 *
 * The prefix is the identity scheme from api/internal/api/join.go: attendees are "att_" plus
 * their join key, the stage is "user_" plus a user id.
 */
func (s *Store) SessionReport(ctx context.Context, slug string) (types.SessionReport, error) {
	// An edge viewer who went away without a goodbye is still an open visit until something
	// closes it, and an open visit counts until now(). See SweepEdgeVisits.
	if err := s.SweepEdgeVisits(ctx, slug, time.Now()); err != nil {
		return types.SessionReport{}, err
	}
	var rep types.SessionReport
	err := s.pool.QueryRow(ctx, attendanceWindow+`
		SELECT
		  (SELECT count(*) FROM registrations r JOIN win ON win.id = r.webinar_id) AS registered,
		  (SELECT count(*) FROM registrations r JOIN win ON win.id = r.webinar_id
		    WHERE r.state = 'approved') AS approved,
		  (SELECT count(*) FROM attendance a JOIN win ON win.id = a.webinar_id
		    WHERE starts_with(a.identity, 'att_')) AS attended,
		  /* Averaged over each attendee's SUMMED visits, not over the span of their
		   * evening. This is the number the old query got wrong: avg(last_seen -
		   * first_joined) counted the gap in the middle for anybody who rejoined. */
		  COALESCE((
		    SELECT (avg(per.secs)/60)::int FROM (
		      SELECT sum(`+clippedSeconds+`) AS secs
		        FROM attendance_visits v JOIN win ON win.id = v.webinar_id
		       WHERE starts_with(v.identity, 'att_')
		       GROUP BY v.identity
		    ) per
		  ), 0) AS avg_watch,
		  (SELECT count(*) FROM session_questions q JOIN win ON win.id = q.webinar_id
		    WHERE NOT q.dismissed) AS questions,
		  (SELECT count(DISTINCT pv.identity) FROM poll_votes pv
		     JOIN polls p ON p.id = pv.poll_id
		     JOIN win ON win.id = p.webinar_id) AS poll_voters
		FROM win`,
		slug).Scan(&rep.Registered, &rep.Approved, &rep.Attended, &rep.AvgWatchMin,
		&rep.Questions, &rep.PollVoters)
	if errors.Is(err, pgx.ErrNoRows) {
		// No such webinar. An empty report rather than an error: the caller asked what
		// happened in a session, and "nothing" is a truthful answer to that.
		return types.SessionReport{Attendees: []types.AttendanceRow{}}, nil
	}
	if err != nil {
		return types.SessionReport{}, err
	}

	qrows, err := s.SessionQuestions(ctx, slug)
	if err != nil {
		return types.SessionReport{}, err
	}
	rep.QuestionRows = qrows

	rep.Attendees, err = s.attendanceRows(ctx, slug)
	if err != nil {
		return types.SessionReport{}, err
	}
	return rep, nil
}

/* One row per person, each carrying its visits.
 *
 * Read as one row per VISIT and folded here rather than aggregated into JSON in the database.
 * The fold is a dozen lines, the SQL stays something a person can read, and the ordering does
 * the grouping: every visit by one identity arrives together because the query says so.
 *
 * Ordered by each person's FIRST arrival — a window function, not v.joined_at — so the list
 * reads as the order people walked in. Sorting by the visit would scatter a rejoiner's rows
 * through the list and, once folded, put them wherever their last visit happened to fall.
 */
func (s *Store) attendanceRows(ctx context.Context, slug string) ([]types.AttendanceRow, error) {
	rows, err := s.pool.Query(ctx, attendanceWindow+`
		SELECT v.identity,
		       -- Never the identity: it is an opaque join key, and a report that
		       -- names people "att_7f3c..." is a report nobody can read.
		       COALESCE(
		         NULLIF(trim(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')), ''),
		         NULLIF(trim(a.name), ''),
		         'Guest') AS name,
		       COALESCE(r.email, '') AS email,
		       /* From the identity alone. A "user_" that is not the host was on the stage,
		        * which is all "panelist" claims — so a co-host, or somebody dropped from the
		        * panel list after the fact, is still labelled by where they actually were
		        * rather than by a grant that has since been cleared. */
		       CASE WHEN v.identity = 'user_' || win.host_id::text THEN 'host'
		            WHEN starts_with(v.identity, 'user_') THEN 'panelist'
		            ELSE 'attendee' END AS role,
		       v.joined_at,
		       v.left_at,
		       (`+clippedSeconds+`)::bigint AS clipped_seconds,
		       min(v.joined_at) OVER (PARTITION BY v.identity) AS first_joined
		  FROM attendance_visits v
		  JOIN win ON win.id = v.webinar_id
		  LEFT JOIN attendance a
		         ON a.webinar_id = v.webinar_id AND a.identity = v.identity
		  LEFT JOIN registrations r ON r.id = a.registration_id
		 ORDER BY first_joined, v.identity, v.joined_at`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.AttendanceRow{}
	// Index into out, so appending a visit does not copy the row it belongs to.
	at := map[string]int{}
	/* The accumulators, kept beside the rows rather than on them.
	 *
	 * Seconds because the total must be summed before it is rounded, and openVisit because
	 * "still in the room" is a fact about the fold rather than about the wire type — neither
	 * belongs on AttendanceRow, where they would travel to the browser for nothing. */
	seconds := map[int]int64{}
	openVisit := map[int]bool{}
	for rows.Next() {
		var (
			identity, name, email, role string
			joinedAt                    time.Time
			leftAt                      *time.Time
			visitSeconds                int64
			// Selected for the ORDER BY, scanned because the row has it. The fold needs
			// nothing from it: the ordering it produced is what the fold relies on.
			firstJoined time.Time
		)
		if err := rows.Scan(&identity, &name, &email, &role,
			&joinedAt, &leftAt, &visitSeconds, &firstJoined); err != nil {
			return nil, err
		}

		i, seen := at[identity]
		if !seen {
			i = len(out)
			at[identity] = i
			out = append(out, types.AttendanceRow{
				Identity:      identity,
				Name:          name,
				Email:         email,
				Role:          role,
				FirstJoinedAt: joinedAt.Format(time.RFC3339),
			})
		}

		visit := types.AttendanceVisit{
			JoinedAt: joinedAt.Format(time.RFC3339),
			// Rounded rather than truncated: a 90-second visit reported as one minute is
			// a worse answer than two, and truncation makes every visit under a minute
			// vanish into zero while still counting as a visit.
			Minutes: int((visitSeconds + 30) / 60),
		}
		if leftAt != nil {
			visit.LeftAt = leftAt.Format(time.RFC3339)
		}
		out[i].Visits = append(out[i].Visits, visit)

		/* The total is summed from the SECONDS and rounded once, at the end.
		 *
		 * Three 40-second visits are two minutes; adding up their rounded minutes would
		 * call them three. The per-visit figures are for reading a row, and the total is
		 * what the number at the end of it has to be right about. */
		seconds[i] += visitSeconds
		out[i].WatchMin = int((seconds[i] + 30) / 60)

		/* Absent while anybody is still in the room, and it stays absent.
		 *
		 * Visits arrive oldest-first, so the last one seen is normally the latest. But an
		 * EARLIER visit left open — which the partial unique index makes impossible from
		 * the webhook path and a hand-edited row could still produce — must not be papered
		 * over by a later close, because "left at 10:15" beside an open visit is a report
		 * asserting somebody both left and did not. */
		if leftAt == nil {
			openVisit[i] = true
			out[i].LastLeftAt = ""
		} else if !openVisit[i] {
			out[i].LastLeftAt = leftAt.Format(time.RFC3339)
		}
	}
	return out, rows.Err()
}

func (s *Store) AppendCaption(ctx context.Context, slug, identity, body string) error {
	if body == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_captions (webinar_id, identity, body)
		SELECT w.id, $2, $3 FROM webinars w WHERE w.slug = $1`,
		slug, identity, body)
	return err
}

// CaptionTranscript is the webinar's caption transcript: built from the caption
// rows while they exist (capped at maxTranscriptLines), and from the archived
// copy once retention has deleted them.
func (s *Store) CaptionTranscript(ctx context.Context, slug string) (string, error) {
	var webinarID string
	var archived *string
	err := s.pool.QueryRow(ctx, `
		SELECT w.id::text, t.body
		  FROM webinars w LEFT JOIN webinar_transcripts t ON t.webinar_id = w.id
		 WHERE w.slug = $1`, slug).Scan(&webinarID, &archived)
	if noRows(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	text, _, err := s.buildTranscript(ctx, webinarID)
	if err != nil || text != "" || archived == nil {
		return text, err
	}
	return *archived, nil
}
