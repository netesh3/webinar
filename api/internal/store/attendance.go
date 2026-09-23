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

func (s *Store) TouchAttendance(ctx context.Context, slug, identity, registrationID, name string) error {
	if identity == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO attendance (webinar_id, identity, registration_id, name)
		SELECT w.id, $2,
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
		         NULLIF($3,'')::uuid,
		         (SELECT r.id FROM registrations r
		           WHERE r.webinar_id = w.id
		             AND starts_with($2, 'att_')
		             AND r.join_key = substring($2 from 5))
		       ),
		       $4
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id, identity) DO UPDATE
		   SET last_seen_at = now(),
		       -- A later touch usually knows less than the first one: a name can arrive empty.
		       -- Fill in what is still blank, never overwrite what is already there.
		       registration_id = COALESCE(attendance.registration_id, EXCLUDED.registration_id),
		       name = CASE WHEN attendance.name = '' THEN EXCLUDED.name ELSE attendance.name END`,
		slug, identity, registrationID, strings.TrimSpace(name))
	return err
}

// TouchAttendanceMany records everyone the SFU roster currently shows. It takes
// participants rather than bare identities so the name travels with them: these
// rows have no registration to look a name up in later.
func (s *Store) TouchAttendanceMany(ctx context.Context, slug string, seen []types.LiveParticipant) error {
	for _, p := range seen {
		if err := s.TouchAttendance(ctx, slug, p.Identity, "", p.Name); err != nil {
			return err
		}
	}
	return nil
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
		ON CONFLICT DO NOTHING`,
		slug, identity, at)
	return err
}

/* CloseVisit records a departure against whichever visit is still open.
 *
 * Idempotent for the same reason OpenVisit is: the WHERE clause finds nothing the second
 * time. A left with no matching open visit — a webhook that arrived out of order, or a
 * participant whose join we never saw — writes nothing rather than inventing a visit, since
 * a visit with no arrival has no duration anybody could believe.
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
		   AND v.identity = $2 AND v.left_at IS NULL`,
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
 */
func (s *Store) CloseOpenVisits(ctx context.Context, slug string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = GREATEST($2, v.joined_at)
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1 AND v.left_at IS NULL`,
		slug, at)
	return err
}

func (s *Store) UpsertSessionQuestion(ctx context.Context, slug string, q types.SessionQuestion) error {
	if q.ID == "" || q.Text == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_questions (id, webinar_id, identity, name, body, anonymous)
		SELECT $1, w.id, $3, $4, $5, $6
		  FROM webinars w WHERE w.slug = $2
		ON CONFLICT (id) DO NOTHING`,
		q.ID, slug, q.Identity, q.Name, q.Text, q.Anonymous)
	return err
}

func (s *Store) AddQuestionUpvote(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_questions SET upvotes = upvotes + 1 WHERE id = $1`, id)
	return err
}

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

func (s *Store) CaptionTranscript(ctx context.Context, slug string) (string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(c.at, 'HH24:MI:SS'), c.identity, c.body
		  FROM session_captions c
		  JOIN webinars w ON w.id = c.webinar_id
		 WHERE w.slug = $1
		 ORDER BY c.at`, slug)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var at, identity, body string
		if err := rows.Scan(&at, &identity, &body); err != nil {
			return "", err
		}
		b.WriteString(at)
		b.WriteString(" ")
		b.WriteString(identity)
		b.WriteString(": ")
		b.WriteString(body)
		b.WriteByte('\n')
	}
	return b.String(), rows.Err()
}
