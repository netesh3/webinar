package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Bots: the flow, and where each person is in it.
 *
 * Unlike every other file in this CRM, the rows here are read while somebody is
 * waiting. An inbound message arrives, the webhook has to answer Meta inside its
 * timeout, and between those two things this file is asked four questions: is this
 * person already mid-conversation, whose bot answers them, what does the flow say, and
 * where have they got to. Each of those is one query on an indexed column, and none of
 * them fans out — a bot's whole flow is read at once (forty nodes at most) rather than
 * a node at a time down a chain of edges.
 *
 * Nothing here sends. The API layer owns that, because sending needs the host's token
 * and Meta's rules about windows, neither of which belongs in a store. What this file
 * owns is the state machine: which node, what state, and the two guards that keep a
 * flow from running away — the wamid it last acted on, and the number of steps it has
 * taken. See migrations/0047.
 */

// BotInput is a bot as the host built it. Nodes are the whole flow: saving replaces
// them, for the reason SaveDrip gives about steps.
type BotInput struct {
	Name     string
	Trigger  string
	Keywords []string
	Entry    string
	Active   bool
	Nodes    []types.CRMBotNode
}

/* SaveBot writes a bot and its nodes, creating it when id is empty.
 *
 * One transaction, nodes deleted and rewritten inside it — and here that is not just
 * the blunt option, it is the only correct one. A node's key is its identity, an edge
 * is a key, and a host who renames a node has rewritten every edge that pointed at it.
 * Diffing that would mean guessing which node is "the same node", and a wrong guess
 * silently reroutes a live conversation.
 *
 * The sessions survive, and they store a key. A conversation parked at a node the host
 * has just deleted is a real state, and the runtime reads it as "that step is gone" and
 * stops with a reason. The alternative — refusing the edit, or cancelling everybody
 * mid-flow — is worse in both directions.
 *
 * store.ErrConflict is the one-active-catch-all index: a host may have several bots that
 * answer everything, but only one of them switched on.
 */
func (s *Store) SaveBot(ctx context.Context, hostID, id string, in BotInput) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	name := strings.Join(strings.Fields(in.Name), " ")
	keywords := in.Keywords
	if keywords == nil {
		keywords = []string{}
	}
	if id == "" {
		err = tx.QueryRow(ctx, `
			INSERT INTO crm_bots (host_id, name, trigger_kind, keywords, entry_key, active)
			VALUES ($1::uuid, $2, $3, $4, $5, $6)
			RETURNING id::text`,
			hostID, name, in.Trigger, keywords, in.Entry, in.Active).Scan(&id)
		if isUniqueViolation(err) {
			return "", store.ErrConflict
		}
		if err != nil {
			return "", err
		}
	} else {
		tag, err := tx.Exec(ctx, `
			UPDATE crm_bots
			   SET name = $3, trigger_kind = $4, keywords = $5, entry_key = $6,
			       active = $7, updated_at = now()
			 WHERE host_id = $1::uuid AND id = $2::uuid`,
			hostID, id, name, in.Trigger, keywords, in.Entry, in.Active)
		if isUniqueViolation(err) {
			return "", store.ErrConflict
		}
		if err != nil {
			return "", err
		}
		if tag.RowsAffected() == 0 {
			return "", store.ErrNotFound
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM crm_bot_nodes WHERE bot_id = $1::uuid`, id); err != nil {
			return "", err
		}
	}

	for i, node := range in.Nodes {
		buttons := node.Buttons
		if buttons == nil {
			buttons = []types.CRMBotButton{}
		}
		/* The sequence and the tag are both looked up by host as well as by id, so a node
		 * can only ever point at one of this host's own. Another host's id lands as NULL —
		 * a broken node rather than a cross-account reference — and the API refuses it
		 * before it gets here, so this is the floor and not the check. */
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm_bot_nodes
				(bot_id, key, kind, text, options, next_key, delay_minutes, drip_id, position,
				 tag_id)
			VALUES ($1::uuid, $2, $3, $4, $5, $6, $7,
			        (SELECT d.id FROM crm_drips d
			          WHERE d.id = NULLIF($8,'')::uuid AND d.host_id = $9::uuid), $10,
			        (SELECT t.id FROM crm_tags t
			          WHERE t.id = NULLIF($11,'')::uuid AND t.host_id = $9::uuid))`,
			id, node.Key, node.Kind, node.Text, buttons, node.Next, node.DelayMinutes,
			node.DripID, hostID, i, node.TagID); err != nil {
			return "", err
		}
	}
	return id, tx.Commit(ctx)
}

/* The bot read, with the conversations it has had.
 *
 * Five counts, one per session state, because "it is running" is not a fact about a
 * bot — it is a fact about the people in it. A flow where forty conversations stopped
 * and two finished is working exactly as written and completely wrong.
 */
const botSelect = `
	SELECT b.id::text, b.name, b.trigger_kind, b.keywords, b.entry_key, b.active,
	       b.created_at,
	       (SELECT count(*) FROM crm_bot_sessions x
	         WHERE x.bot_id = b.id AND x.state = 'waiting'),
	       (SELECT count(*) FROM crm_bot_sessions x
	         WHERE x.bot_id = b.id AND x.state = 'sleeping'),
	       (SELECT count(*) FROM crm_bot_sessions x
	         WHERE x.bot_id = b.id AND x.state = 'done'),
	       (SELECT count(*) FROM crm_bot_sessions x
	         WHERE x.bot_id = b.id AND x.state = 'handoff'),
	       (SELECT count(*) FROM crm_bot_sessions x
	         WHERE x.bot_id = b.id AND x.state = 'stopped')
	  FROM crm_bots b`

func scanBot(row scanner) (types.CRMBot, error) {
	var (
		b         types.CRMBot
		createdAt time.Time
		st        types.CRMBotStats
	)
	if err := row.Scan(&b.ID, &b.Name, &b.Trigger, &b.Keywords, &b.Entry, &b.Active,
		&createdAt, &st.Waiting, &st.Sleeping, &st.Done, &st.HandedOff, &st.Stopped); err != nil {
		return types.CRMBot{}, err
	}
	b.CreatedAt = createdAt.Format(time.RFC3339)
	b.Stats = st
	b.Nodes = []types.CRMBotNode{}
	if b.Keywords == nil {
		b.Keywords = []string{}
	}
	return b, nil
}

// nodeSelect reads a flow, with each enroll node's sequence and each set_tag node's label
// named. LEFT JOIN both, because a sequence or a tag that has been deleted leaves the node
// pointing at nothing, which is a state the builder has to be able to show.
const nodeSelect = `
	SELECT n.bot_id::text, n.key, n.kind, n.text, n.options, n.next_key,
	       n.delay_minutes, COALESCE(n.drip_id::text,''), COALESCE(d.name,''),
	       COALESCE(n.tag_id::text,''), COALESCE(t.name,'')
	  FROM crm_bot_nodes n
	  LEFT JOIN crm_drips d ON d.id = n.drip_id
	  LEFT JOIN crm_tags t ON t.id = n.tag_id`

func scanNode(row scanner) (string, types.CRMBotNode, error) {
	var (
		botID string
		n     types.CRMBotNode
	)
	if err := row.Scan(&botID, &n.Key, &n.Kind, &n.Text, &n.Buttons, &n.Next,
		&n.DelayMinutes, &n.DripID, &n.DripName, &n.TagID, &n.TagName); err != nil {
		return "", types.CRMBotNode{}, err
	}
	if n.Buttons == nil {
		n.Buttons = []types.CRMBotButton{}
	}
	return botID, n, nil
}

// Bots lists a host's bots, newest first, with their flows. Two queries for the whole
// page, like Drips: the list screen draws every node.
func (s *Store) Bots(ctx context.Context, hostID string, limit int) ([]types.CRMBot, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, botSelect+`
		 WHERE b.host_id = $1::uuid
		 ORDER BY b.created_at DESC
		 LIMIT $2`, hostID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMBot{}
	at := map[string]int{}
	ids := []string{}
	for rows.Next() {
		b, err := scanBot(rows)
		if err != nil {
			return nil, err
		}
		at[b.ID] = len(out)
		ids = append(ids, b.ID)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}

	nodes, err := s.pool.Query(ctx, nodeSelect+`
		 WHERE n.bot_id = ANY($1::uuid[])
		 ORDER BY n.bot_id, n.position, n.key`, ids)
	if err != nil {
		return nil, err
	}
	defer nodes.Close()
	for nodes.Next() {
		botID, n, err := scanNode(nodes)
		if err != nil {
			return nil, err
		}
		if i, ok := at[botID]; ok {
			out[i].Nodes = append(out[i].Nodes, n)
		}
	}
	return out, nodes.Err()
}

// Bot reads one. Another host's id is store.ErrNotFound, like every other CRM read.
func (s *Store) Bot(ctx context.Context, hostID, id string) (types.CRMBot, error) {
	row := s.pool.QueryRow(ctx, botSelect+`
		 WHERE b.host_id = $1::uuid AND b.id = $2::uuid`, hostID, id)
	b, err := scanBot(row)
	if noRows(err) {
		return types.CRMBot{}, store.ErrNotFound
	}
	if err != nil {
		return types.CRMBot{}, err
	}

	rows, err := s.pool.Query(ctx, nodeSelect+`
		 WHERE n.bot_id = $1::uuid ORDER BY n.position, n.key`, id)
	if err != nil {
		return types.CRMBot{}, err
	}
	defer rows.Close()
	for rows.Next() {
		_, n, err := scanNode(rows)
		if err != nil {
			return types.CRMBot{}, err
		}
		b.Nodes = append(b.Nodes, n)
	}
	return b, rows.Err()
}

/* DeleteBot removes a bot, its flow and every conversation it had.
 *
 * The sessions go with it, which is the part to know before pressing it: switching a
 * bot off keeps the record of who it talked to and where they stopped, and deleting it
 * does not. What survives either way is the messages — they are in each contact's
 * conversation, where they belong, because they were really sent.
 */
func (s *Store) DeleteBot(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM crm_bots WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

// BotSequences is the host's drips as an enroll node's options: id and name, newest
// first. Every sequence, paused ones included — a bot may enrol somebody on a sequence
// the host has not switched on yet, and the drip decides what that means, not the bot.
func (s *Store) BotSequences(ctx context.Context, hostID string) ([]types.CRMBotSequence, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name FROM crm_drips
		 WHERE host_id = $1::uuid ORDER BY created_at DESC LIMIT 200`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMBotSequence{}
	for rows.Next() {
		var q types.CRMBotSequence
		if err := rows.Scan(&q.ID, &q.Name); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

/* BotSessions is who this bot has talked to, most recent first.
 *
 * Capped and unpaged, like DripEnrollments: this is a host looking at a flow, not an
 * export. Finished and stopped conversations are included, since where they stopped is
 * the only honest review of the thing.
 */
func (s *Store) BotSessions(ctx context.Context, botID string, limit int) ([]types.CRMBotSession, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.id::text, c.id::text, c.name, c.phone, s.node_key, s.state,
		       s.ended_reason, s.resume_at, s.steps, s.created_at, s.updated_at
		  FROM crm_bot_sessions s
		  JOIN crm_contacts c ON c.id = s.contact_id
		 WHERE s.bot_id = $1::uuid
		 ORDER BY s.updated_at DESC, s.id
		 LIMIT $2`, botID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.CRMBotSession{}
	for rows.Next() {
		var (
			b       types.CRMBotSession
			resume  *time.Time
			created time.Time
			updated time.Time
		)
		if err := rows.Scan(&b.ID, &b.ContactID, &b.ContactName, &b.Phone, &b.NodeKey,
			&b.State, &b.EndedReason, &resume, &b.Steps, &created, &updated); err != nil {
			return nil, err
		}
		if resume != nil && b.State == "sleeping" {
			// Only meaningful while something is still owed; a date next to a finished
			// conversation would read as though it were about to say something else.
			b.ResumeAt = resume.Format(time.RFC3339)
		}
		b.CreatedAt = created.Format(time.RFC3339)
		b.UpdatedAt = updated.Format(time.RFC3339)
		out = append(out, b)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- the runtime

/* BotRun is a conversation already under way, as the runtime needs to see it.
 *
 * LastWAMID is the interesting field. Meta retries a delivery it did not see a 2xx
 * for, and a retried answer to a question would otherwise be read as a second answer
 * — running the flow twice and sending two messages out of one of theirs.
 */
type BotRun struct {
	SessionID string
	BotID     string
	BotName   string
	// Active is the bot's switch, read with the session: a host who turns a bot off
	// while somebody is mid-flow has stopped that conversation too.
	Active    bool
	State     string
	NodeKey   string
	LastWAMID string
	Steps     int
}

/* LatestBotSession is the last conversation this contact had with any of the host's
 * bots — live or finished — or store.ErrNotFound if they have never been in one.
 *
 * The finished ones are included for one reason, and it is the retry guard. A session
 * that has just ENDED is exactly the state Meta's redelivery arrives in: the answer
 * that ended it comes again, finds nothing live, and starts the whole flow over. So the
 * newest session is returned whatever became of it, and the caller compares
 * LastWAMID before deciding anything else.
 *
 * At most one is ever live — see the unique index in migrations/0047 — so ordering by
 * age is only picking between a live one and the history behind it.
 */
func (s *Store) LatestBotSession(ctx context.Context, hostID, contactID string) (BotRun, error) {
	var run BotRun
	err := s.pool.QueryRow(ctx, `
		SELECT s.id::text, b.id::text, b.name, b.active, s.state, s.node_key,
		       s.last_wamid, s.steps
		  FROM crm_bot_sessions s
		  JOIN crm_bots b ON b.id = s.bot_id AND b.host_id = $1::uuid
		 WHERE s.contact_id = $2::uuid
		 ORDER BY s.created_at DESC, s.id DESC
		 LIMIT 1`,
		hostID, contactID).Scan(&run.SessionID, &run.BotID, &run.BotName, &run.Active,
		&run.State, &run.NodeKey, &run.LastWAMID, &run.Steps)
	if noRows(err) {
		return BotRun{}, store.ErrNotFound
	}
	return run, err
}

// BotStart is a bot that will answer a message, and the node its flow begins at.
type BotStart struct {
	BotID   string
	BotName string
	Entry   string
}

/* BotForMessage picks the bot that answers this message, or store.ErrNotFound.
 *
 * Keywords beat the catch-all, which is the only ordering a host would predict: a bot
 * on the word "price" exists precisely so it wins over the one that greets everybody.
 * Between two keyword bots the older one wins — arbitrary, but fixed, so the same
 * message does not get different answers on different days.
 *
 * `text` is compared whole, lower-cased, and never as a substring: the reason
 * isWhatsAppStop gives applies to every keyword, not just that one.
 *
 * A bot whose entry node has been deleted is skipped rather than started, since
 * starting it would post nothing and park a conversation nobody can answer.
 */
func (s *Store) BotForMessage(ctx context.Context, hostID, text string) (BotStart, error) {
	key := strings.ToLower(strings.Join(strings.Fields(text), " "))
	var out BotStart
	err := s.pool.QueryRow(ctx, `
		SELECT b.id::text, b.name, b.entry_key
		  FROM crm_bots b
		 WHERE b.host_id = $1::uuid AND b.active AND b.entry_key <> ''
		   AND (b.trigger_kind = 'any_message'
		        OR (b.trigger_kind = 'keyword' AND $2 <> '' AND $2 = ANY(b.keywords)))
		   AND EXISTS (SELECT 1 FROM crm_bot_nodes n
		                WHERE n.bot_id = b.id AND n.key = b.entry_key)
		 ORDER BY (b.trigger_kind = 'keyword') DESC, b.created_at
		 LIMIT 1`, hostID, key).Scan(&out.BotID, &out.BotName, &out.Entry)
	if noRows(err) {
		return BotStart{}, store.ErrNotFound
	}
	return out, err
}

/* StartBotSession opens a conversation at a bot's entry node.
 *
 * store.ErrConflict when this contact is already in one: two messages arriving together
 * would otherwise start two flows, and the unique index is what decides between them
 * rather than whichever query ran first.
 */
func (s *Store) StartBotSession(ctx context.Context, botID, contactID, nodeKey, wamid string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO crm_bot_sessions (bot_id, contact_id, node_key, state, last_wamid)
		VALUES ($1::uuid, $2::uuid, $3, 'waiting', $4)
		RETURNING id::text`, botID, contactID, nodeKey, wamid).Scan(&id)
	if isUniqueViolation(err) {
		return "", store.ErrConflict
	}
	return id, err
}

/* BotNodes reads a whole flow, keyed by node.
 *
 * All of it in one query rather than a node at a time down the edges. A flow is capped
 * at forty nodes, a turn may run a dozen of them, and a round trip per step would put
 * the webhook's response time at the mercy of how long the host's flowchart is.
 */
func (s *Store) BotNodes(ctx context.Context, botID string) (map[string]types.CRMBotNode, error) {
	rows, err := s.pool.Query(ctx, nodeSelect+` WHERE n.bot_id = $1::uuid`, botID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]types.CRMBotNode{}
	for rows.Next() {
		_, n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out[n.Key] = n
	}
	return out, rows.Err()
}

/* BotStep is where a conversation got to, written after a turn.
 *
 * One struct and one UPDATE for all five outcomes, because they differ only in which
 * fields are set, and because a turn has to leave the session in exactly one state —
 * two writes for one turn is how a flow ends up both waiting and finished.
 */
type BotStep struct {
	// One of the session states: waiting, sleeping, done, handoff, stopped.
	State string
	// The node it is parked at, or the one to run when it wakes. Empty once finished.
	NodeKey string
	// Why it stopped, for the states nobody chose.
	Reason string
	// When a sleeping flow wakes. Zero clears it.
	ResumeAt time.Time
	// Nodes run in this conversation in total, not in this turn.
	Steps int
	// The inbound message this turn acted on. Empty leaves the stored one alone, which
	// is what a sweeper-driven turn wants: nothing arrived to act on.
	WAMID string
}

// SaveBotSession records the outcome of one turn.
func (s *Store) SaveBotSession(ctx context.Context, sessionID string, step BotStep) error {
	var resume *time.Time
	if !step.ResumeAt.IsZero() {
		at := step.ResumeAt.UTC()
		resume = &at
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_bot_sessions
		   SET state = $2, node_key = $3, ended_reason = $4, resume_at = $5, steps = $6,
		       last_wamid = CASE WHEN $7 <> '' THEN $7 ELSE last_wamid END,
		       updated_at = now()
		 WHERE id = $1::uuid`,
		sessionID, step.State, step.NodeKey, step.Reason, resume, step.Steps, step.WAMID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

/* SetContactBotPaused hands a conversation to a person, or gives it back.
 *
 * Pausing also closes whatever flow was under way, in the same statement pair: leaving
 * a session waiting would mean the host's own reply is read by the bot as an answer to
 * its last question. Resuming deliberately does NOT reopen it — the next message from
 * that person starts a flow from the top, which is the only place a conversation can
 * honestly be picked up from after a human has been in it.
 */
func (s *Store) SetContactBotPaused(ctx context.Context, hostID, contactID string, paused bool, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE crm_contacts
		   SET bot_paused_at = CASE WHEN $3 THEN COALESCE(bot_paused_at, now()) END,
		       updated_at = now()
		 WHERE id = $1::uuid AND host_id = $2::uuid`, contactID, hostID, paused)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	if paused {
		if _, err := tx.Exec(ctx, `
			UPDATE crm_bot_sessions
			   SET state = 'handoff', ended_reason = $2, resume_at = NULL, updated_at = now()
			 WHERE contact_id = $1::uuid AND state IN ('waiting','sleeping')`,
			contactID, reason); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

/* stopBotsForContact ends every flow this person is in, inside a transaction the
 * caller owns.
 *
 * Called from SetContactWhatsAppOptOut. Somebody who has said stop must not be woken
 * up by a wait node tomorrow, and a sweep that discovers the opt-out at wake time
 * would be a day of a host looking at a conversation that is apparently still going.
 */
func stopBotsForContact(ctx context.Context, q store.Querier, contactID, reason string) error {
	_, err := q.Exec(ctx, `
		UPDATE crm_bot_sessions
		   SET state = 'stopped', ended_reason = $2, resume_at = NULL, updated_at = now()
		 WHERE contact_id = $1::uuid AND state IN ('waiting','sleeping')`,
		contactID, reason)
	return err
}

// ----------------------------------------------------------------- sweeping

/* BotDue is a sleeping conversation whose wait is over.
 *
 * It carries the two things that may have changed while it slept — consent, and
 * whether a person has taken the conversation over — because the sweeper's options
 * differ: a flow whose contact opted out overnight is stopped and said so, not woken
 * up and continued.
 */
type BotDue struct {
	SessionID string
	BotID     string
	BotName   string
	HostID    string

	ContactID   string
	ContactName string
	Phone       string

	// NodeKey is the node to run, not the wait that held it: a sleeping session
	// already stores where it is going.
	NodeKey string
	Steps   int

	// OptedOut is somebody who said stop while the flow slept. Paused is a person
	// having taken the conversation over.
	OptedOut bool
	Paused   bool
}

/* DueBotSessions is every sleeping conversation that should wake now.
 *
 * The bot has to be active: switching one off stops the people in it as well as new
 * ones, exactly as pausing a drip does. Ordered by due time so a backlog drains
 * oldest-first, and limited because this runs every thirty seconds and one flow with a
 * one-minute wait and a thousand people in it must not become a thousand sends in a
 * tick.
 */
func (s *Store) DueBotSessions(ctx context.Context, limit int) ([]BotDue, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT s.id::text, b.id::text, b.name, b.host_id::text,
		       c.id::text, c.name, c.phone, s.node_key, s.steps,
		       (c.whatsapp_opt_out_at IS NOT NULL
		        AND (c.whatsapp_opt_in_at IS NULL
		             OR c.whatsapp_opt_in_at <= c.whatsapp_opt_out_at)),
		       (c.bot_paused_at IS NOT NULL)
		  FROM crm_bot_sessions s
		  JOIN crm_bots b     ON b.id = s.bot_id AND b.active
		  JOIN crm_contacts c ON c.id = s.contact_id
		 WHERE s.state = 'sleeping' AND s.resume_at IS NOT NULL AND s.resume_at <= now()
		 ORDER BY s.resume_at, s.id
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []BotDue{}
	for rows.Next() {
		var d BotDue
		if err := rows.Scan(&d.SessionID, &d.BotID, &d.BotName, &d.HostID,
			&d.ContactID, &d.ContactName, &d.Phone, &d.NodeKey, &d.Steps,
			&d.OptedOut, &d.Paused); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
