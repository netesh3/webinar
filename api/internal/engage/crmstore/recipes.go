package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Recipes: the drips and bots made from a preset, found by their recipe key, and the
 * hot-lead rule, which has a table of its own. See migrations/0062. */

// RecipeDrips is the host's recipe drips by recipe key.
func (s *Store) RecipeDrips(ctx context.Context, hostID string) (map[string]types.CRMDrip, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text FROM crm_drips WHERE host_id = $1::uuid AND recipe IS NOT NULL`, hostID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[string]types.CRMDrip{}
	for _, id := range ids {
		d, err := s.Drip(ctx, hostID, id)
		if err != nil {
			return nil, err
		}
		out[d.Recipe] = d
	}
	return out, nil
}

// SetDripActive switches one of the host's drips on or off without touching its steps.
func (s *Store) SetDripActive(ctx context.Context, hostID, id string, active bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_drips SET active = $3, updated_at = now()
		 WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id, active)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

// RecipeBot is a keyword-reply bot made by the keyword recipe: one word, one reply.
type RecipeBot struct {
	ID     string
	Recipe string
	Active bool
	Word   string
	Reply  string
}

/* RecipeBots is the host's bots whose recipe key starts with prefix, oldest first, with
 * the word they answer and the text of their entry node. */
func (s *Store) RecipeBots(ctx context.Context, hostID, prefix string) ([]RecipeBot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT b.id::text, b.recipe, b.active, COALESCE(b.keywords[1], ''), COALESCE(n.text, '')
		  FROM crm_bots b
		  LEFT JOIN crm_bot_nodes n ON n.bot_id = b.id AND n.key = b.entry_key
		 WHERE b.host_id = $1::uuid AND starts_with(b.recipe, $2)
		 ORDER BY b.created_at, b.id`, hostID, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecipeBot{}
	for rows.Next() {
		var b RecipeBot
		if err := rows.Scan(&b.ID, &b.Recipe, &b.Active, &b.Word, &b.Reply); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// MarkBotRecipe files a bot under a recipe key.
func (s *Store) MarkBotRecipe(ctx context.Context, hostID, id, recipe string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_bots SET recipe = $3 WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id, recipe)
	return err
}

// SetBotActive switches one of the host's bots on or off.
func (s *Store) SetBotActive(ctx context.Context, hostID, id string, active bool) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_bots SET active = $3, updated_at = now()
		 WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id, active)
	return err
}

// HotLeads is the host's hot-lead rule.
type HotLeads struct {
	Active  bool
	Words   []string
	TagID   string
	TagName string
	// Tagged is how many contacts carry the tag.
	Tagged int
}

// HotLeadRule reads the host's rule; the zero value when they never set one up.
func (s *Store) HotLeadRule(ctx context.Context, hostID string) (HotLeads, error) {
	var h HotLeads
	err := s.pool.QueryRow(ctx, `
		SELECT h.active, h.words, COALESCE(t.id::text, ''), COALESCE(t.name, ''),
		       (SELECT count(*) FROM crm_contact_tags ct WHERE ct.tag_id = h.tag_id)
		  FROM crm_hot_leads h
		  LEFT JOIN crm_tags t ON t.id = h.tag_id
		 WHERE h.host_id = $1::uuid`, hostID).Scan(&h.Active, &h.Words, &h.TagID, &h.TagName, &h.Tagged)
	if noRows(err) {
		return HotLeads{}, nil
	}
	return h, err
}

// SaveHotLeadRule writes the host's rule.
func (s *Store) SaveHotLeadRule(ctx context.Context, hostID string, active bool, words []string, tagID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO crm_hot_leads (host_id, active, words, tag_id)
		VALUES ($1::uuid, $2, $3, NULLIF($4,'')::uuid)
		ON CONFLICT (host_id) DO UPDATE
		   SET active = EXCLUDED.active, words = EXCLUDED.words,
		       tag_id = COALESCE(EXCLUDED.tag_id, crm_hot_leads.tag_id), updated_at = now()`,
		hostID, active, words, tagID)
	return err
}

/* MatchesHotLead is whether text mentions one of the words: a case-insensitive substring,
 * so "what's the price?" matches "price". Words are matched as written, trimmed. */
func MatchesHotLead(text string, words []string) bool {
	t := strings.ToLower(text)
	for _, w := range words {
		w = strings.ToLower(strings.TrimSpace(w))
		if w != "" && strings.Contains(t, w) {
			return true
		}
	}
	return false
}

/* HotLeadCandidates is who the rule would have tagged from the last `days` of replies:
 * up to `limit` names, and how many in all. */
func (s *Store) HotLeadCandidates(ctx context.Context, hostID string, words []string, days, limit int) ([]string, int, error) {
	pats := make([]string, 0, len(words))
	for _, w := range words {
		w = strings.ToLower(strings.TrimSpace(w))
		if w == "" {
			continue
		}
		w = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(w)
		pats = append(pats, "%"+w+"%")
	}
	if len(pats) == 0 {
		return []string{}, 0, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.name, count(*) OVER ()
		  FROM crm_contacts c
		 WHERE c.host_id = $1::uuid AND EXISTS (
		       SELECT 1 FROM crm_messages m
		        WHERE m.contact_id = c.id AND m.direction = 'in'
		          AND m.created_at >= $2 AND lower(m.body) LIKE ANY($3))
		 ORDER BY c.name
		 LIMIT $4`, hostID, time.Now().Add(-time.Duration(days)*24*time.Hour), pats, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	names, total := []string{}, 0
	for rows.Next() {
		var n string
		if err := rows.Scan(&n, &total); err != nil {
			return nil, 0, err
		}
		names = append(names, n)
	}
	return names, total, rows.Err()
}

/* KeywordAsks is how many people sent exactly one of the words in the last `days`, the
 * way a keyword bot matches: the whole message, case and spacing aside. */
func (s *Store) KeywordAsks(ctx context.Context, hostID string, words []string, days int) (int, error) {
	keys := make([]string, 0, len(words))
	for _, w := range words {
		if k := strings.ToLower(strings.Join(strings.Fields(w), " ")); k != "" {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return 0, nil
	}
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT m.contact_id) FROM crm_messages m
		 WHERE m.host_id = $1::uuid AND m.direction = 'in' AND m.created_at >= $2
		   AND lower(regexp_replace(btrim(m.body), '\s+', ' ', 'g')) = ANY($3)`,
		hostID, time.Now().Add(-time.Duration(days)*24*time.Hour), keys).Scan(&n)
	return n, err
}

// LatestEndedWebinar is the host's most recent ended webinar, for "would have reached".
func (s *Store) LatestEndedWebinar(ctx context.Context, hostID string) (slug, topic string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT slug, topic FROM webinars
		 WHERE host_id = $1::uuid AND (status = 'ended' OR ended_at IS NOT NULL)
		 ORDER BY COALESCE(ended_at, starts_at) DESC LIMIT 1`, hostID).Scan(&slug, &topic)
	if noRows(err) {
		return "", "", nil
	}
	return slug, topic, err
}

// ReminderReads is the host's WhatsApp confirmations and reminders over the last `days`:
// sent, and read.
func (s *Store) ReminderReads(ctx context.Context, hostID string, days int) (sent, read int, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE n.delivery = 'sent'),
		       count(m.id) FILTER (WHERE m.status = 'read')
		  FROM notifications n
		  JOIN webinars w ON w.id = n.webinar_id
		  LEFT JOIN crm_messages m ON m.notification_id = n.id
		 WHERE w.host_id = $1::uuid AND n.channel = 'whatsapp'
		   AND n.kind IN ('wa_registration_confirmed', 'wa_reminder') AND n.due_at >= $2`,
		hostID, time.Now().Add(-time.Duration(days)*24*time.Hour)).Scan(&sent, &read)
	return sent, read, err
}

// LatestWebinar is the host's newest webinar by start time, ended or not.
func (s *Store) LatestWebinar(ctx context.Context, hostID string) (slug, topic string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT slug, topic FROM webinars WHERE host_id = $1::uuid
		 ORDER BY starts_at DESC LIMIT 1`, hostID).Scan(&slug, &topic)
	if noRows(err) {
		return "", "", nil
	}
	return slug, topic, err
}
