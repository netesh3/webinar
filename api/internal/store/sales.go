package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The sales chat. See migrations/0105_sales_chat.sql.
 *
 * Conversations are found by the SHA-256 of the visitor's token, never by id, on
 * the visitor's side: the id is what admins use, and it is not a secret.
 */

type SalesConversation struct {
	ID              string
	UserID          string
	AccountEmail    string
	Name            string
	Email           string
	Status          types.SalesStatus
	HandoffReason   string
	HandoffAt       *time.Time
	AssignedAdminID string
	AssignedName    string
	Page            string
	AIReplies       int
	VisitorSeenAt   time.Time
	LastMessageAt   time.Time
	CreatedAt       time.Time
	LastMessage     string
}

type SalesMessage struct {
	ID         int64
	Role       types.SalesRole
	AuthorID   string
	AuthorName string
	Body       string
	Emailed    bool
	CreatedAt  time.Time
}

// HashSalesToken is how a visitor's token is stored and looked up.
func HashSalesToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

const salesConversationColumns = `c.id::text, coalesce(c.user_id::text, ''), coalesce(u.email, ''),
	c.name, c.email, c.status, c.handoff_reason, c.handoff_at,
	coalesce(c.assigned_admin::text, ''), coalesce(a.name, ''), c.page, c.ai_replies,
	c.visitor_seen_at, c.last_message_at, c.created_at,
	coalesce((SELECT m.body FROM sales_messages m WHERE m.conversation_id = c.id
	           AND m.role <> 'system' ORDER BY m.id DESC LIMIT 1), '')`

const salesConversationFrom = ` FROM sales_conversations c
	LEFT JOIN users u ON u.id = c.user_id
	LEFT JOIN users a ON a.id = c.assigned_admin`

func scanSalesConversation(row scanner) (SalesConversation, error) {
	var c SalesConversation
	var status string
	err := row.Scan(&c.ID, &c.UserID, &c.AccountEmail, &c.Name, &c.Email, &status, &c.HandoffReason,
		&c.HandoffAt, &c.AssignedAdminID, &c.AssignedName, &c.Page, &c.AIReplies,
		&c.VisitorSeenAt, &c.LastMessageAt, &c.CreatedAt, &c.LastMessage)
	c.Status = types.SalesStatus(status)
	return c, err
}

// CreateSalesConversation starts a conversation with its greeting already in it.
func (s *Store) CreateSalesConversation(ctx context.Context, tokenHash, userID, name, email, page, greeting string) (SalesConversation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SalesConversation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO sales_conversations (token_hash, user_id, name, email, page)
		VALUES ($1, NULLIF($2, '')::uuid, $3, $4, $5) RETURNING id::text`,
		tokenHash, userID, name, email, page).Scan(&id); err != nil {
		return SalesConversation{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sales_messages (conversation_id, role, body) VALUES ($1, 'ai', $2)`,
		id, greeting); err != nil {
		return SalesConversation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SalesConversation{}, err
	}
	return s.SalesConversationByID(ctx, id)
}

// SalesConversationByToken is the visitor's conversation. Bumps visitor_seen_at:
// every visitor request is the visitor being here.
func (s *Store) SalesConversationByToken(ctx context.Context, tokenHash string) (SalesConversation, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		UPDATE sales_conversations SET visitor_seen_at = now()
		 WHERE token_hash = $1 RETURNING id::text`, tokenHash).Scan(&id)
	if noRows(err) {
		return SalesConversation{}, ErrNotFound
	}
	if err != nil {
		return SalesConversation{}, err
	}
	return s.SalesConversationByID(ctx, id)
}

func (s *Store) SalesConversationByID(ctx context.Context, id string) (SalesConversation, error) {
	c, err := scanSalesConversation(s.pool.QueryRow(ctx,
		`SELECT `+salesConversationColumns+salesConversationFrom+` WHERE c.id = $1::uuid`, id))
	if noRows(err) {
		return SalesConversation{}, ErrNotFound
	}
	return c, err
}

// AddSalesMessage appends a message and moves the conversation up the inbox.
func (s *Store) AddSalesMessage(ctx context.Context, conversationID string, m SalesMessage) (SalesMessage, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SalesMessage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := m
	if err := tx.QueryRow(ctx, `
		INSERT INTO sales_messages (conversation_id, role, author_id, author_name, body, emailed)
		VALUES ($1::uuid, $2, NULLIF($3, '')::uuid, $4, $5, $6) RETURNING id, created_at`,
		conversationID, string(m.Role), m.AuthorID, m.AuthorName, m.Body, m.Emailed).Scan(&out.ID, &out.CreatedAt); err != nil {
		return SalesMessage{}, err
	}
	bumpAI := 0
	if m.Role == types.SalesFromAI {
		bumpAI = 1
	}
	if _, err := tx.Exec(ctx, `
		UPDATE sales_conversations SET last_message_at = now(), ai_replies = ai_replies + $2
		 WHERE id = $1::uuid`, conversationID, bumpAI); err != nil {
		return SalesMessage{}, err
	}
	return out, tx.Commit(ctx)
}

// SalesMessages are a conversation's messages after the given id, oldest first.
func (s *Store) SalesMessages(ctx context.Context, conversationID string, afterID int64) ([]SalesMessage, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, role, coalesce(author_id::text, ''), author_name, body, emailed, created_at
		  FROM sales_messages WHERE conversation_id = $1::uuid AND id > $2
		 ORDER BY id LIMIT 500`, conversationID, afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SalesMessage{}
	for rows.Next() {
		var m SalesMessage
		var role string
		if err := rows.Scan(&m.ID, &role, &m.AuthorID, &m.AuthorName, &m.Body, &m.Emailed, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.Role = types.SalesRole(role)
		out = append(out, m)
	}
	return out, rows.Err()
}

/* RequestSalesHandoff moves a conversation from the assistant to "waiting".
 *
 * Only from 'ai': asking twice, or after an admin joined, is not a second handoff,
 * so admins are emailed once. Returns whether this call made the change.
 */
func (s *Store) RequestSalesHandoff(ctx context.Context, conversationID, reason string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sales_conversations
		   SET status = 'waiting', handoff_reason = $2, handoff_at = now()
		 WHERE id = $1::uuid AND status = 'ai'`, conversationID, reason)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// SetSalesContact records where to reply to the visitor.
func (s *Store) SetSalesContact(ctx context.Context, conversationID, name, email string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sales_conversations SET name = CASE WHEN $2 = '' THEN name ELSE $2 END, email = $3
		 WHERE id = $1::uuid`, conversationID, name, email)
	return err
}

/* JoinSalesConversation is an admin taking the conversation. Returns whether this
 * admin was not already the one on it, so the "joined" line is posted once. */
func (s *Store) JoinSalesConversation(ctx context.Context, conversationID, adminID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sales_conversations SET status = 'human', assigned_admin = $2::uuid,
		       handoff_at = coalesce(handoff_at, now())
		 WHERE id = $1::uuid AND (status <> 'human' OR assigned_admin IS DISTINCT FROM $2::uuid)`,
		conversationID, adminID)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.SalesConversationByID(ctx, conversationID); err != nil {
			return false, err
		}
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) CloseSalesConversation(ctx context.Context, conversationID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE sales_conversations SET status = 'closed' WHERE id = $1::uuid`, conversationID)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

/* SalesInbox lists conversations for admins.
 *
 * filter: "needs" (waiting, or with an admin), "ai", "closed", or "" for all.
 * Conversations where the visitor never wrote anything are left out: an auto-opened
 * widget that nobody typed into is not a lead.
 */
func (s *Store) SalesInbox(ctx context.Context, filter string, limit int) ([]SalesConversation, int, error) {
	where := `EXISTS (SELECT 1 FROM sales_messages v WHERE v.conversation_id = c.id AND v.role = 'visitor')`
	switch filter {
	case "needs":
		where += ` AND c.status IN ('waiting', 'human')`
	case "ai":
		where += ` AND c.status = 'ai'`
	case "closed":
		where += ` AND c.status = 'closed'`
	}
	rows, err := s.pool.Query(ctx, `SELECT `+salesConversationColumns+salesConversationFrom+
		` WHERE `+where+` ORDER BY (c.status = 'waiting') DESC, c.last_message_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []SalesConversation{}
	for rows.Next() {
		c, err := scanSalesConversation(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	var waiting int
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM sales_conversations WHERE status = 'waiting'`).Scan(&waiting)
	return out, waiting, err
}

// TouchSalesAdmin marks an admin as having the sales inbox open now.
func (s *Store) TouchSalesAdmin(ctx context.Context, adminID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sales_admin_presence (user_id, seen_at) VALUES ($1::uuid, now())
		ON CONFLICT (user_id) DO UPDATE SET seen_at = now()`, adminID)
	return err
}

// SalesTeamOnline is whether any admin had the inbox open within the window.
func (s *Store) SalesTeamOnline(ctx context.Context, within time.Duration) (bool, error) {
	var online bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM sales_admin_presence p JOIN users u ON u.id = p.user_id
		                WHERE u.is_admin AND p.seen_at > now() - make_interval(secs => $1))`,
		within.Seconds()).Scan(&online)
	return online, err
}

// AdminEmails is every admin account's address, for the handoff note.
func (s *Store) AdminEmails(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT email FROM users WHERE is_admin ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ReopenSalesConversation hands a closed conversation back to the assistant when
// the visitor writes again.
func (s *Store) ReopenSalesConversation(ctx context.Context, conversationID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE sales_conversations SET status = 'ai', assigned_admin = NULL, handoff_reason = '', handoff_at = NULL
		 WHERE id = $1::uuid AND status = 'closed'`, conversationID)
	return err
}
