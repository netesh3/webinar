package store

import (
	"context"
	"time"
)

/* Spam flags on a live session's chat and Q&A (migration 0154; api/internal/api/spam.go).
 * Host team only: nothing here is ever read on an audience path. */

// Spam flag statuses, as session_spam_flags.status holds them.
const (
	SpamPending    = "pending"
	SpamClear      = "clear"
	SpamFlagged    = "flagged"
	SpamAutoHidden = "auto_hidden"
	SpamDeleted    = "deleted"
	SpamHidden     = "hidden"
	SpamRemoved    = "removed"
	SpamMuted      = "muted"
	SpamNotSpam    = "not_spam"
)

// SpamFlag is one row of session_spam_flags.
type SpamFlag struct {
	Kind       string // "chat" | "question"
	ID         string
	Identity   string
	Name       string
	Body       string
	RuleScore  float64
	Reasons    []string
	Status     string
	Source     string // "rules" | "ai"
	Category   string
	Confidence float64
	CreatedAt  time.Time
}

// SpamSenderState is what the say path needs to know about one sender, in one query.
type SpamSenderState struct {
	Muted      bool
	AllowLinks bool
	AutoHide   bool
}

// SpamSender is whether identity is muted in the session behind slug, and the session's
// spam settings.
func (s *Store) SpamSender(ctx context.Context, slug, identity string) (SpamSenderState, error) {
	var out SpamSenderState
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM session_chat_mutes m WHERE m.webinar_id = w.id AND m.identity = $2),
		       COALESCE(st.allow_links, false), COALESCE(st.auto_hide, false)
		  FROM webinars w LEFT JOIN session_spam_state st ON st.webinar_id = w.id
		 WHERE w.slug = $1`, slug, identity).Scan(&out.Muted, &out.AllowLinks, &out.AutoHide)
	if noRows(err) {
		return out, ErrNotFound
	}
	return out, err
}

// SpamSettings is the session's allow-links and auto-hide settings.
func (s *Store) SpamSettings(ctx context.Context, slug string) (allowLinks, autoHide bool, err error) {
	st, err := s.SpamSender(ctx, slug, "")
	return st.AllowLinks, st.AutoHide, err
}

// SetSpamSettings saves the session's settings; nil leaves one as it is.
func (s *Store) SetSpamSettings(ctx context.Context, slug string, allowLinks, autoHide *bool) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_spam_state (webinar_id, allow_links, auto_hide)
		SELECT w.id, COALESCE($2, false), COALESCE($3, false) FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO UPDATE
		   SET allow_links = COALESCE($2, session_spam_state.allow_links),
		       auto_hide = COALESCE($3, session_spam_state.auto_hide)`, slug, allowLinks, autoHide)
	return err
}

// SpamPassState is when a pass last stopped at a cap, and when one last ran (zero for never).
func (s *Store) SpamPassState(ctx context.Context, slug string) (limitedAt, lastPassAt time.Time, err error) {
	var l, p *time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT st.limited_at, st.last_pass_at FROM session_spam_state st
		  JOIN webinars w ON w.id = st.webinar_id WHERE w.slug = $1`, slug).Scan(&l, &p)
	if noRows(err) {
		return time.Time{}, time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if l != nil {
		limitedAt = *l
	}
	if p != nil {
		lastPassAt = *p
	}
	return limitedAt, lastPassAt, nil
}

// SetSpamLimited records (or, with nil, clears) a pass stopped at an AI cap.
func (s *Store) SetSpamLimited(ctx context.Context, slug string, at *time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_spam_state (webinar_id, limited_at)
		SELECT w.id, $2 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO UPDATE SET limited_at = EXCLUDED.limited_at`, slug, at)
	return err
}

// SetSpamPassAt records when a pass ran, the start of the next one's sample.
func (s *Store) SetSpamPassAt(ctx context.Context, slug string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_spam_state (webinar_id, last_pass_at)
		SELECT w.id, $2 FROM webinars w WHERE w.slug = $1
		ON CONFLICT (webinar_id) DO UPDATE SET last_pass_at = EXCLUDED.last_pass_at`, slug, at)
	return err
}

// AddSpamFlag records one message; an item already recorded is left as it is. Reports
// whether a row was written.
func (s *Store) AddSpamFlag(ctx context.Context, slug string, f SpamFlag) (bool, error) {
	if f.Source == "" {
		f.Source = "rules"
	}
	reasons := f.Reasons
	if reasons == nil {
		reasons = []string{}
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO session_spam_flags
			(webinar_id, item_kind, item_id, sender_identity, sender_name, body, rule_score,
			 reasons, status, source, category, confidence)
		SELECT w.id, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12
		  FROM webinars w WHERE w.slug = $1
		ON CONFLICT DO NOTHING`,
		slug, f.Kind, f.ID, f.Identity, f.Name, f.Body, f.RuleScore, reasons, f.Status,
		f.Source, f.Category, f.Confidence)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// SetSpamVerdict sets one row's status and, when category is not empty, the AI's verdict.
func (s *Store) SetSpamVerdict(ctx context.Context, slug, kind, id, status, source, category string, confidence float64) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE session_spam_flags f
		   SET status = $4,
		       source = CASE WHEN $5 = '' THEN f.source ELSE $5 END,
		       category = CASE WHEN $5 = '' THEN f.category ELSE $6 END,
		       confidence = CASE WHEN $5 = '' THEN f.confidence ELSE $7 END,
		       updated_at = now()
		  FROM webinars w
		 WHERE f.webinar_id = w.id AND w.slug = $1 AND f.item_kind = $2 AND f.item_id = $3`,
		slug, kind, id, status, source, category, confidence)
	return err
}

// SpamFlagByID is one row; ErrNotFound when there is none.
func (s *Store) SpamFlagByID(ctx context.Context, slug, kind, id string) (SpamFlag, error) {
	rows, err := s.spamFlags(ctx, `w.slug = $1 AND f.item_kind = $2 AND f.item_id = $3`, slug, kind, id)
	if err != nil {
		return SpamFlag{}, err
	}
	if len(rows) == 0 {
		return SpamFlag{}, ErrNotFound
	}
	return rows[0], nil
}

// SpamPending is the session's messages waiting for the AI pass, oldest first, at most limit.
func (s *Store) SpamPending(ctx context.Context, slug string, limit int) ([]SpamFlag, error) {
	return s.spamFlags(ctx, `w.slug = $1 AND f.status = 'pending' ORDER BY f.created_at LIMIT $2`, slug, limit)
}

// SpamOpen is what the host team's Flagged filter lists: flagged, auto-hidden and acted-on
// rows, newest first. Pending and clear rows are not flags.
func (s *Store) SpamOpen(ctx context.Context, slug string, limit int) ([]SpamFlag, error) {
	return s.spamFlags(ctx, `w.slug = $1 AND f.status NOT IN ('pending', 'clear')
		ORDER BY f.created_at DESC LIMIT $2`, slug, limit)
}

func (s *Store) spamFlags(ctx context.Context, where string, args ...any) ([]SpamFlag, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT f.item_kind, f.item_id, f.sender_identity, f.sender_name, f.body, f.rule_score,
		       f.reasons, f.status, f.source, f.category, f.confidence, f.created_at
		  FROM session_spam_flags f JOIN webinars w ON w.id = f.webinar_id
		 WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpamFlag{}
	for rows.Next() {
		var f SpamFlag
		var score, conf float32
		if err := rows.Scan(&f.Kind, &f.ID, &f.Identity, &f.Name, &f.Body, &score, &f.Reasons,
			&f.Status, &f.Source, &f.Category, &conf, &f.CreatedAt); err != nil {
			return nil, err
		}
		f.RuleScore, f.Confidence = round2(float64(score)), round2(float64(conf))
		out = append(out, f)
	}
	return out, rows.Err()
}

func round2(v float64) float64 { return float64(int(v*100+0.5)) / 100 }

// SpamCounts is how many of the session's messages were flagged, and how many of those were
// taken out of the room (deleted, hidden, auto-hidden, or their sender removed or muted).
func (s *Store) SpamCounts(ctx context.Context, slug string) (flagged, removed int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE f.status NOT IN ('pending', 'clear')),
		       count(*) FILTER (WHERE f.status IN ('auto_hidden', 'deleted', 'hidden', 'removed', 'muted'))
		  FROM session_spam_flags f JOIN webinars w ON w.id = f.webinar_id
		 WHERE w.slug = $1`, slug).Scan(&flagged, &removed)
	return flagged, removed, err
}

// SpamSampleMessage is one recent chat line the AI pass may look at alongside the suspicious.
type SpamSampleMessage struct {
	ID, Identity, Name, Body string
	CreatedAt                time.Time
}

// SpamSample is the session's newest attendee chat after since, not deleted and not already
// recorded in session_spam_flags, newest first, at most limit.
func (s *Store) SpamSample(ctx context.Context, slug string, since time.Time, limit int) ([]SpamSampleMessage, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.sender_identity, m.sender_name, m.content, m.created_at
		  FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1 AND m.sender_role = 'attendee' AND m.deleted_at IS NULL
		   AND m.message_type = 'text' AND m.created_at > $2
		   AND NOT EXISTS (SELECT 1 FROM session_spam_flags f
		                    WHERE f.webinar_id = w.id AND f.item_kind = 'chat' AND f.item_id = m.id)
		 ORDER BY m.created_at DESC LIMIT $3`, slug, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SpamSampleMessage{}
	for rows.Next() {
		var m SpamSampleMessage
		if err := rows.Scan(&m.ID, &m.Identity, &m.Name, &m.Body, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// LiveSlugsWithPendingSpam is the live sessions with messages waiting for an AI pass.
func (s *Store) LiveSlugsWithPendingSpam(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug FROM webinars w
		 WHERE w.status = 'live' AND EXISTS (
		       SELECT 1 FROM session_spam_flags f WHERE f.webinar_id = w.id AND f.status = 'pending')
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		out = append(out, slug)
	}
	return out, rows.Err()
}

// SetChatMuted mutes (or unmutes) one person's chat and questions in the session behind slug.
func (s *Store) SetChatMuted(ctx context.Context, slug, identity string, muted bool) error {
	if !muted {
		_, err := s.pool.Exec(ctx, `
			DELETE FROM session_chat_mutes m USING webinars w
			 WHERE m.webinar_id = w.id AND w.slug = $1 AND m.identity = $2`, slug, identity)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO session_chat_mutes (webinar_id, identity)
		SELECT w.id, $2 FROM webinars w WHERE w.slug = $1
		ON CONFLICT DO NOTHING`, slug, identity)
	return err
}

// ChatMutedIdentities is everyone muted in the session behind slug.
func (s *Store) ChatMutedIdentities(ctx context.Context, slug string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.identity FROM session_chat_mutes m JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1 ORDER BY m.created_at`, slug)
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
