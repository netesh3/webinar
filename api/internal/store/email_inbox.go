package store

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	// ErrInboxTaken means another host already has that local part, as their
	// current address or as a previous alias.
	ErrInboxTaken = errors.New("inbox address taken")
	// ErrInboxLocked means the host already used their one self-service change.
	ErrInboxLocked = errors.New("inbox address locked")
	// ErrInboxInvalid means the local part is not letters, digits and hyphens.
	ErrInboxInvalid = errors.New("inbox address invalid")
)

// Inbox is one host's reply address.
type Inbox struct {
	Local   string
	Address string
	Renamed bool
	Alias   string
	UserID  string
}

// HostEmail is one stored message, inbound or a reply we sent.
type HostEmail struct {
	ID        string
	UserID    string
	Direction string
	From      string
	To        string
	Subject   string
	Body      string
	MessageID string
	InReplyTo string
	CreatedAt time.Time
	// ThreadID is the conversation this message belongs to. It is not a column:
	// it is the oldest message in a reply chain, or this message when nothing links it.
	ThreadID string
}

const inboxLocalPattern = `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`

// EnsureInbox assigns a unique default local part when the host does not have
// one yet. That assignment does not set inbox_renamed_at.
func (s *Store) EnsureInbox(ctx context.Context, userID, name string) (Inbox, error) {
	existing, err := s.readInbox(ctx, userID)
	if err != nil {
		return Inbox{}, err
	}
	if existing.Local != "" {
		return existing, nil
	}
	for _, local := range inboxCandidates(name, userID) {
		tag, err := s.pool.Exec(ctx,
			`UPDATE users SET inbox_local = $2
			  WHERE id = $1 AND inbox_local IS NULL
			    AND NOT EXISTS (SELECT 1 FROM inbox_aliases WHERE local = $2)`,
			userID, local)
		if err != nil {
			if isUniqueViolation(err) {
				continue
			}
			return Inbox{}, err
		}
		if tag.RowsAffected() == 1 {
			return s.readInbox(ctx, userID)
		}
		existing, err = s.readInbox(ctx, userID)
		if err != nil {
			return Inbox{}, err
		}
		if existing.Local != "" {
			return existing, nil
		}
	}
	return Inbox{}, ErrInboxTaken
}

// RenameInbox changes the local part once. The previous value is kept as an
// alias. A second change returns ErrInboxLocked and does not write.
func (s *Store) RenameInbox(ctx context.Context, userID, name, next string) (Inbox, error) {
	next = strings.ToLower(strings.TrimSpace(next))
	if !inboxLocalOK(next) {
		return Inbox{}, ErrInboxInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Inbox{}, err
	}
	defer tx.Rollback(ctx)

	var current *string
	var renamed *time.Time
	err = tx.QueryRow(ctx,
		`SELECT inbox_local, inbox_renamed_at FROM users WHERE id = $1 FOR UPDATE`,
		userID).Scan(&current, &renamed)
	if err != nil {
		return Inbox{}, err
	}
	cur := ""
	if current != nil {
		cur = *current
	}
	if cur == "" {
		if err := tx.Rollback(ctx); err != nil {
			return Inbox{}, err
		}
		if _, err := s.EnsureInbox(ctx, userID, name); err != nil {
			return Inbox{}, err
		}
		return s.RenameInbox(ctx, userID, name, next)
	}
	if cur == next {
		if err := tx.Commit(ctx); err != nil {
			return Inbox{}, err
		}
		return s.readInbox(ctx, userID)
	}
	if renamed != nil {
		return Inbox{}, ErrInboxLocked
	}
	var taken bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (
		    SELECT 1 FROM users WHERE inbox_local = $1 AND id <> $2
		    UNION ALL
		    SELECT 1 FROM inbox_aliases WHERE local = $1 AND user_id <> $2
		 )`, next, userID).Scan(&taken); err != nil {
		return Inbox{}, err
	}
	if taken {
		return Inbox{}, ErrInboxTaken
	}
	if _, err := tx.Exec(ctx, `DELETE FROM inbox_aliases WHERE user_id = $1`, userID); err != nil {
		return Inbox{}, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO inbox_aliases (local, user_id) VALUES ($1, $2)`, cur, userID); err != nil {
		if isUniqueViolation(err) {
			return Inbox{}, ErrInboxTaken
		}
		return Inbox{}, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET inbox_local = $2, inbox_renamed_at = now() WHERE id = $1`,
		userID, next); err != nil {
		if isUniqueViolation(err) {
			return Inbox{}, ErrInboxTaken
		}
		return Inbox{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Inbox{}, err
	}
	return s.readInbox(ctx, userID)
}

// HostForInboxLocal resolves a current address or a previous alias.
func (s *Store) HostForInboxLocal(ctx context.Context, local string) (string, bool, error) {
	local = strings.ToLower(strings.TrimSpace(local))
	if !inboxLocalOK(local) {
		return "", false, nil
	}
	var id string
	err := s.pool.QueryRow(ctx,
		`SELECT id FROM users WHERE inbox_local = $1
		 UNION ALL
		 SELECT user_id FROM inbox_aliases WHERE local = $1
		 LIMIT 1`, local).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// InsertHostEmail stores one message for that host only.
func (s *Store) InsertHostEmail(ctx context.Context, m HostEmail) (HostEmail, error) {
	if m.ID == "" {
		m.ID = uuid.NewString()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = time.Now().UTC()
	}
	err := s.pool.QueryRow(ctx,
		`INSERT INTO host_emails
		    (id, user_id, direction, from_addr, to_addr, subject, body, message_id, in_reply_to, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		 RETURNING created_at`,
		m.ID, m.UserID, m.Direction, m.From, m.To, m.Subject, m.Body, m.MessageID, m.InReplyTo, m.CreatedAt,
	).Scan(&m.CreatedAt)
	return m, err
}

// EmailInboxPageSize is how many conversations one inbox page lists.
const EmailInboxPageSize = 25

// ListHostEmails returns one host's messages, oldest first.
//
// Kept for callers that want the whole mailbox. The inbox page groups these
// into reply chains and then slices.
func (s *Store) ListHostEmails(ctx context.Context, userID string) ([]HostEmail, error) {
	return s.listHostEmails(ctx, userID)
}

// ListHostEmailPage returns one page of conversations for that host.
//
// A conversation is a reply chain (In-Reply-To / message id), not everyone who
// shares an address. total is the number of conversations. page is clamped to
// the last page that exists.
func (s *Store) ListHostEmailPage(ctx context.Context, userID string, page int) ([]HostEmail, int, int, error) {
	all, err := s.listHostEmails(ctx, userID)
	if err != nil {
		return nil, 0, 1, err
	}
	out, total, page := pageEmailThreads(groupEmailThreads(all), page)
	return out, total, page, nil
}

func (s *Store) listHostEmails(ctx context.Context, userID string) ([]HostEmail, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, user_id, direction, from_addr, to_addr, subject, body, message_id, in_reply_to, created_at
		   FROM (
		     SELECT id::text, user_id::text, direction, from_addr, to_addr, subject, body,
		            message_id, in_reply_to, created_at
		       FROM host_emails
		      WHERE user_id = $1
		     UNION ALL
		     SELECT n.id::text, w.host_id::text, 'out', '', n.email, n.subject, n.body,
		            '', '', COALESCE(n.delivered_at, n.created_at)
		       FROM notifications n
		       JOIN webinars w ON w.id = n.webinar_id
		      WHERE w.host_id = $1
		        AND n.delivery = 'sent'
		        AND n.email <> ''
		        AND NOT EXISTS (
		          SELECT 1 FROM host_emails h
		           WHERE h.user_id = w.host_id
		             AND h.message_id = 'outbox:' || n.id::text
		        )
		   ) mail
		  ORDER BY created_at ASC`, userID)
	// No row cap: the inbox pages conversations after they are grouped. A cap
	// here would drop mail before the page slice and make later pages wrong.
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HostEmail
	for rows.Next() {
		var m HostEmail
		if err := rows.Scan(&m.ID, &m.UserID, &m.Direction, &m.From, &m.To, &m.Subject, &m.Body, &m.MessageID, &m.InReplyTo, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// pageEmailThreads slices conversations, not raw messages. page is 1-based and
// clamped to the last page that exists. An empty mailbox is page 1.
func pageEmailThreads(threads [][]HostEmail, page int) ([]HostEmail, int, int) {
	total := len(threads)
	if page < 1 {
		page = 1
	}
	pages := 1
	if total > 0 {
		pages = (total + EmailInboxPageSize - 1) / EmailInboxPageSize
	}
	if page > pages {
		page = pages
	}
	start := (page - 1) * EmailInboxPageSize
	if start > total {
		start = total
	}
	end := start + EmailInboxPageSize
	if end > total {
		end = total
	}
	var out []HostEmail
	for _, thread := range threads[start:end] {
		out = append(out, thread...)
	}
	return out, total, page
}

// groupEmailThreads joins messages only when they share a reply-chain id.
//
// A link is In-Reply-To (or any id in that header) matching another row's
// message id or row id. Messages that cite the same id are one chain even when
// the parent row is not in the mailbox. The same address or the same subject
// is not a link. Each chain's id is its oldest message.
func groupEmailThreads(msgs []HostEmail) [][]HostEmail {
	n := len(msgs)
	if n == 0 {
		return nil
	}
	parent := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra != rb {
			parent[rb] = ra
		}
	}

	byID := map[string]int{}
	for i, m := range msgs {
		for _, id := range []string{normMailID(m.ID), normMailID(m.MessageID)} {
			if id == "" {
				continue
			}
			if prev, ok := byID[id]; ok && prev != i {
				union(prev, i)
			}
			byID[id] = i
		}
	}
	shared := map[string]int{}
	for i, m := range msgs {
		for _, ref := range mailRefs(m.InReplyTo) {
			if prev, ok := byID[ref]; ok {
				union(prev, i)
			}
			if prev, ok := shared[ref]; ok {
				union(prev, i)
			} else {
				shared[ref] = i
			}
		}
	}

	order := make([]int, 0, n)
	groups := map[int][]HostEmail{}
	seen := map[int]bool{}
	for i := range msgs {
		root := find(i)
		if !seen[root] {
			seen[root] = true
			order = append(order, root)
		}
		groups[root] = append(groups[root], msgs[i])
	}
	threads := make([][]HostEmail, 0, len(order))
	for _, root := range order {
		thread := groups[root]
		sort.SliceStable(thread, func(a, b int) bool {
			if thread[a].CreatedAt.Equal(thread[b].CreatedAt) {
				return thread[a].ID < thread[b].ID
			}
			return thread[a].CreatedAt.Before(thread[b].CreatedAt)
		})
		id := thread[0].ID
		for i := range thread {
			thread[i].ThreadID = id
		}
		threads = append(threads, thread)
	}
	sort.SliceStable(threads, func(a, b int) bool {
		la := threads[a][len(threads[a])-1]
		lb := threads[b][len(threads[b])-1]
		if la.CreatedAt.Equal(lb.CreatedAt) {
			return la.ID > lb.ID
		}
		return la.CreatedAt.After(lb.CreatedAt)
	})
	return threads
}

func normMailID(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "<>")
	return strings.ToLower(strings.TrimSpace(s))
}

func mailRefs(s string) []string {
	var out []string
	for _, part := range strings.Fields(s) {
		if id := normMailID(part); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// HostEmailForUser loads one message only when it belongs to that host.
func (s *Store) HostEmailForUser(ctx context.Context, userID, id string) (HostEmail, error) {
	var m HostEmail
	err := s.pool.QueryRow(ctx,
		`SELECT id::text, user_id::text, direction, from_addr, to_addr, subject, body, message_id, in_reply_to, created_at
		   FROM host_emails WHERE id = $1 AND user_id = $2
		 UNION ALL
		 SELECT n.id::text, w.host_id::text, 'out', '', n.email, n.subject, n.body,
		        '', '', COALESCE(n.delivered_at, n.created_at)
		   FROM notifications n
		   JOIN webinars w ON w.id = n.webinar_id
		  WHERE n.id = $1 AND w.host_id = $2 AND n.delivery = 'sent' AND n.email <> ''
		  LIMIT 1`, id, userID).
		Scan(&m.ID, &m.UserID, &m.Direction, &m.From, &m.To, &m.Subject, &m.Body, &m.MessageID, &m.InReplyTo, &m.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return HostEmail{}, ErrNotFound
	}
	return m, err
}

func (s *Store) readInbox(ctx context.Context, userID string) (Inbox, error) {
	var local *string
	var renamed *time.Time
	var alias *string
	err := s.pool.QueryRow(ctx,
		`SELECT u.inbox_local, u.inbox_renamed_at, a.local
		   FROM users u
		   LEFT JOIN inbox_aliases a ON a.user_id = u.id
		  WHERE u.id = $1`, userID).Scan(&local, &renamed, &alias)
	if err != nil {
		return Inbox{}, err
	}
	in := Inbox{UserID: userID, Renamed: renamed != nil}
	if local != nil {
		in.Local = *local
		in.Address = *local + "@webinarliv.com"
	}
	if alias != nil {
		in.Alias = *alias
	}
	return in, nil
}

func inboxLocalOK(local string) bool {
	if local == "" || len(local) > 32 {
		return false
	}
	for i, r := range local {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || (r == '-' && i > 0 && i < len(local)-1)
		if !ok {
			return false
		}
	}
	return true
}

func inboxSlug(name string) string {
	var b strings.Builder
	hyphen := false
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			hyphen = false
			continue
		}
		if b.Len() > 0 && !hyphen {
			b.WriteByte('-')
			hyphen = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 32 {
		s = strings.Trim(s[:32], "-")
	}
	if !inboxLocalOK(s) {
		return "host"
	}
	return s
}

func inboxCandidates(name, userID string) []string {
	base := inboxSlug(name)
	hex := strings.ToLower(strings.ReplaceAll(userID, "-", ""))
	if len(hex) < 8 {
		hex += "00000000"
	}
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if inboxLocalOK(s) && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	add(base)
	for _, n := range []int{4, 6, 8} {
		add(fitInbox(base, hex[:n]))
	}
	return out
}

func fitInbox(base, suffix string) string {
	extra := 1 + len(suffix)
	b := base
	if len(b)+extra > 32 {
		keep := 32 - extra
		if keep < 1 {
			keep = 1
		}
		if keep > len(b) {
			keep = len(b)
		}
		b = strings.Trim(b[:keep], "-")
		if b == "" {
			b = "h"
		}
	}
	return b + "-" + suffix
}
