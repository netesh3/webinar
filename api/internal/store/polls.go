package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Polls and quizzes.
 *
 * Three rules live in the database rather than in a handler, because each of them
 * has a race a handler cannot close:
 *
 *   one open poll   A partial unique index. Two hosts, or one host double-clicking
 *                   Launch, both reach the database and exactly one wins. An
 *                   audience looking at two open polls has no way to know which one
 *                   the host meant.
 *   one vote each   The primary key on (poll_id, identity). Checking for an existing
 *                   vote first leaves a window where two requests both find none.
 *   a quiz has an answer
 *                   A check constraint tying correct_option to kind. A quiz with no
 *                   correct option marks every answer wrong, and nothing downstream
 *                   could tell that from an ordinary poll.
 *
 * The tally is computed on read rather than kept in a counter column. It is a
 * GROUP BY over the votes for one poll — a few hundred rows at webinar scale — and a
 * denormalised count is a second thing to keep correct when a vote arrives twice or
 * a poll is deleted.
 */

const maxPollOptions = 10

// CreatePoll writes a draft. Nothing is shown to the audience until it is opened.
func (s *Store) CreatePoll(ctx context.Context, slug string, in types.PollInput) (types.Poll, error) {
	question := strings.TrimSpace(in.Question)
	if question == "" {
		return types.Poll{}, fmt.Errorf("%w: a poll needs a question", ErrInvalid)
	}
	if !in.Kind.Valid() {
		return types.Poll{}, fmt.Errorf("%w: kind must be poll or quiz", ErrInvalid)
	}

	options := make([]string, 0, len(in.Options))
	for _, o := range in.Options {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			options = append(options, trimmed)
		}
	}
	if len(options) < 2 {
		return types.Poll{}, fmt.Errorf("%w: a poll needs at least two options", ErrInvalid)
	}
	if len(options) > maxPollOptions {
		return types.Poll{}, fmt.Errorf("%w: at most %d options", ErrInvalid, maxPollOptions)
	}

	// A quiz needs a right answer and a poll must not carry one. Checked here so the
	// caller gets a sentence rather than a constraint violation, and again in the
	// schema so no other writer can get it wrong.
	var correct *int
	if in.Kind == types.PollQuizKind {
		if in.CorrectOption == nil {
			return types.Poll{}, fmt.Errorf("%w: a quiz needs a correct answer", ErrInvalid)
		}
		if *in.CorrectOption < 0 || *in.CorrectOption >= len(options) {
			return types.Poll{}, fmt.Errorf("%w: the correct answer is not one of the options", ErrInvalid)
		}
		correct = in.CorrectOption
	}

	encoded, err := json.Marshal(options)
	if err != nil {
		return types.Poll{}, err
	}

	var id string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO polls (webinar_id, question, kind, options, correct_option)
		SELECT w.id, $2, $3, $4::jsonb, $5 FROM webinars w WHERE w.slug = $1
		RETURNING id::text`,
		slug, question, string(in.Kind), string(encoded), correct,
	).Scan(&id)
	if noRows(err) {
		// No row came back because the SELECT matched no webinar.
		return types.Poll{}, ErrNotFound
	}
	if err != nil {
		return types.Poll{}, err
	}
	return s.Poll(ctx, slug, id, "", true)
}

// DeletePoll removes a draft or a closed poll, and its votes with it.
func (s *Store) DeletePoll(ctx context.Context, slug, id string) error {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM polls p USING webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1 AND p.id = $2::uuid`,
		slug, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// OpenPoll starts voting, and closes whichever poll was open before.
//
// Closing the previous one here rather than refusing is the behaviour a host wants:
// launching the next question means they are done with the last, and making them
// close it first is a second click that only ever has one answer.
func (s *Store) OpenPoll(ctx context.Context, slug, id string) (types.Poll, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return types.Poll{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The previous poll first, so the partial unique index is never violated inside
	// the transaction.
	if _, err := tx.Exec(ctx, `
		UPDATE polls p SET state = 'closed', closed_at = now()
		  FROM webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1
		   AND p.state = 'open' AND p.id <> $2::uuid`,
		slug, id); err != nil {
		return types.Poll{}, err
	}

	// Reopening a closed poll is allowed and clears its closing time — a host who
	// closed one by accident should not have to retype it. The votes already cast
	// stay, which is why the tally is not reset.
	tag, err := tx.Exec(ctx, `
		UPDATE polls p SET state = 'open', opened_at = coalesce(p.opened_at, now()), closed_at = NULL
		  FROM webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1 AND p.id = $2::uuid`,
		slug, id)
	if err != nil {
		return types.Poll{}, err
	}
	if tag.RowsAffected() == 0 {
		return types.Poll{}, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return types.Poll{}, err
	}
	return s.Poll(ctx, slug, id, "", true)
}

// ClosePoll ends voting. The tally is final and a quiz answer becomes visible.
func (s *Store) ClosePoll(ctx context.Context, slug, id string) (types.Poll, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE polls p SET state = 'closed', closed_at = now()
		  FROM webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1 AND p.id = $2::uuid AND p.state <> 'closed'`,
		slug, id)
	if err != nil {
		return types.Poll{}, err
	}
	if tag.RowsAffected() == 0 {
		// Either it does not exist or it was already closed. Poll() tells them apart
		// and returns the current state, so closing twice is not an error.
		return s.Poll(ctx, slug, id, "", true)
	}
	return s.Poll(ctx, slug, id, "", true)
}

// CloseOpenPolls ends whatever was open, used when the webinar ends. A poll left
// open on a room nobody is in would still be accepting votes.
func (s *Store) CloseOpenPolls(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE polls p SET state = 'closed', closed_at = now()
		  FROM webinars w
		 WHERE w.id = p.webinar_id AND w.slug = $1 AND p.state = 'open'`,
		slug)
	return err
}

// Vote records one answer.
//
// ErrConflict when the poll is not open, and when this identity has already
// answered. The second one is the primary key's answer rather than a lookup: two
// requests from the same reloaded tab both find no existing vote, and only one of
// them can insert.
func (s *Store) Vote(ctx context.Context, slug, id, identity string, choice int) error {
	if identity == "" {
		return fmt.Errorf("%w: a vote needs a voter", ErrInvalid)
	}

	tag, err := s.pool.Exec(ctx, `
		INSERT INTO poll_votes (poll_id, identity, choice)
		SELECT p.id, $3, $4
		  FROM polls p JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1 AND p.id = $2::uuid AND p.state = 'open'
		   AND $4 >= 0 AND $4 < jsonb_array_length(p.options)`,
		slug, id, identity, choice)
	if isUniqueViolation(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// The SELECT matched nothing: no such poll, it is not open, or the choice is
		// not one of the options. Told apart by reading the poll back.
		p, readErr := s.Poll(ctx, slug, id, identity, true)
		if readErr != nil {
			return readErr
		}
		if p.State != types.PollOpen {
			return fmt.Errorf("%w: that poll is not open", ErrConflict)
		}
		return fmt.Errorf("%w: that is not one of the options", ErrInvalid)
	}
	return nil
}

// Polls lists every poll on a webinar, oldest first.
//
// `identity` is the caller, used to report their own answer; empty for a host
// reading the list rather than voting in it. `full` is the authorization decision,
// made by the caller: true for the host, who sees every tally and every answer, and
// false for the audience, who see a tally only once it is shared and an answer only
// once voting has closed.
func (s *Store) Polls(ctx context.Context, slug, identity string, full bool) ([]types.Poll, error) {
	rows, err := s.pool.Query(ctx, pollSelect+`
		 WHERE w.slug = $1
		 ORDER BY p.created_at`, slug, identity)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.Poll{}
	for rows.Next() {
		poll, err := scanPoll(rows, full)
		if err != nil {
			return nil, err
		}
		out = append(out, poll)
	}
	return out, rows.Err()
}

// Poll reads one.
func (s *Store) Poll(ctx context.Context, slug, id, identity string, full bool) (types.Poll, error) {
	row := s.pool.QueryRow(ctx, pollSelect+`
		 WHERE w.slug = $1 AND p.id = $3::uuid`, slug, identity, id)
	poll, err := scanPoll(row, full)
	if noRows(err) {
		return types.Poll{}, ErrNotFound
	}
	if err != nil {
		return types.Poll{}, err
	}
	return poll, nil
}

// OpenPollID reports which poll is currently accepting votes, if any. Used to tell
// the room something changed without shipping the whole list to it.
func (s *Store) OpenPollID(ctx context.Context, slug string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		SELECT p.id::text FROM polls p JOIN webinars w ON w.id = p.webinar_id
		 WHERE w.slug = $1 AND p.state = 'open'`, slug).Scan(&id)
	if noRows(err) {
		return "", nil
	}
	return id, err
}

/* pollSelect is shared by both reads so the scan order cannot drift.
 *
 * The tally is a correlated aggregate rather than a join: a LEFT JOIN onto votes
 * would multiply the poll row by its votes and every other column would need
 * grouping. `tally` comes back as a JSON object keyed by choice index, which is
 * turned into a dense array in Go — jsonb_object_agg leaves out options nobody
 * picked, and a client needs a zero in that slot rather than a gap.
 *
 * $2 is the caller's identity, for their own answer. It is deliberately a parameter
 * rather than a second query: "have I voted" has to be answered in the same read as
 * the tally, or a client can render a vote form for a poll it has already answered.
 */
const pollSelect = `
	SELECT p.id::text, p.question, p.kind, p.options, p.correct_option, p.state,
	       p.created_at, p.closed_at,
	       (SELECT coalesce(jsonb_object_agg(t.choice, t.n), '{}'::jsonb)
	          FROM (SELECT v.choice, count(*) AS n FROM poll_votes v
	                 WHERE v.poll_id = p.id GROUP BY v.choice) t) AS tally,
	       (SELECT count(*) FROM poll_votes v WHERE v.poll_id = p.id) AS total,
	       (SELECT v.choice FROM poll_votes v
	         WHERE v.poll_id = p.id AND v.identity = $2) AS my_choice
	  FROM polls p JOIN webinars w ON w.id = p.webinar_id`

func scanPoll(row scanner, full bool) (types.Poll, error) {
	var (
		p         types.Poll
		options   []byte
		tally     []byte
		correct   *int
		createdAt time.Time
		closedAt  *time.Time
		myChoice  *int
	)
	if err := row.Scan(
		&p.ID, &p.Question, &p.Kind, &options, &correct, &p.State,
		&createdAt, &closedAt,
		&tally, &p.TotalVotes, &myChoice,
	); err != nil {
		return types.Poll{}, err
	}

	if err := json.Unmarshal(options, &p.Options); err != nil {
		return types.Poll{}, fmt.Errorf("poll options: %w", err)
	}
	p.CreatedAt = createdAt.Format(time.RFC3339)
	if closedAt != nil {
		p.ClosedAt = closedAt.Format(time.RFC3339)
	}

	p.MyChoice = -1
	if myChoice != nil {
		p.MyChoice = *myChoice
	}

	// The two disclosure decisions, in one place. `full` is the caller's
	// entitlement, decided by the handler: true for the stage, false for the audience.

	// A quiz answer is withheld from the audience until voting closes. While it is
	// open, the answer sitting in every browser is the whole quiz given away — and
	// reading it out of a network response takes no skill. Once closed there is no
	// answer left to influence, and telling people whether they were right is the
	// reason a quiz exists.
	p.CorrectOption = -1
	if correct != nil && (full || p.State == types.PollClosed) {
		p.CorrectOption = *correct
	}

	// The audience gets no numbers, ever. Not per option, not as a percentage, and
	// not as a running total. A visible tally makes the answers stop being
	// independent: whoever has not voted yet can see which way the room is going.
	//
	// Zeroed here rather than filtered in the UI, so there is nothing to hide on the
	// client and nothing in the response to go looking for.
	if full {
		p.Votes = denseTally(tally, len(p.Options))
	} else {
		p.Votes = []int{}
		p.TotalVotes = 0
	}
	return p, nil
}

// denseTally turns {"0":4,"2":1} into [4,0,1,0]. Options nobody picked are absent
// from the aggregate, and a bar chart needs a zero in that slot rather than a hole.
func denseTally(raw []byte, options int) []int {
	counts := make([]int, options)
	if len(raw) == 0 {
		return counts
	}
	var byChoice map[string]int
	if err := json.Unmarshal(raw, &byChoice); err != nil {
		// A tally we cannot read is reported as no votes rather than failing the
		// whole request: the question and the options are still worth showing.
		return counts
	}
	for key, n := range byChoice {
		var i int
		if _, err := fmt.Sscanf(key, "%d", &i); err != nil {
			continue
		}
		if i >= 0 && i < options {
			counts[i] = n
		}
	}
	return counts
}
