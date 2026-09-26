package crmstore

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The host's WhatsApp templates, cached from Meta.
 *
 * Meta owns these rows; this package only mirrors them. Nothing here edits a
 * template, because a body that differs from the approved one by a character is
 * rejected at send time — so the only writes are "replace what Meta just told
 * us" and the only reads are for a picker and for a send.
 */

// TemplateInput is one template as Meta described it. The wa package's Template
// converted at the boundary, so store keeps knowing nothing about Graph.
type TemplateInput struct {
	Name     string
	Language string
	Status   string
	Category string
	Header   string
	Body     string
	Footer   string
	// How many {{n}} placeholders Body has, and so how many values a send must
	// supply.
	Variables int
	// Empty when sendable; otherwise why not, in words a host can read.
	Unsupported string
}

/* ReplaceTemplates makes the cache equal to what Meta just returned.
 *
 * A replace and not a merge: a template deleted in WhatsApp Manager has to
 * disappear from the picker, and a status that went from APPROVED to PAUSED has
 * to stop being sendable. Leaving a stale row behind would offer a host a send
 * that Meta will refuse.
 *
 * Done as upsert-then-sweep inside one transaction, keyed on a single batch
 * timestamp. The alternative — delete all, insert all — would empty the picker
 * for the length of the transaction and, worse, churn the ids on every sync.
 *
 * An empty list is honoured rather than treated as a mistake: a host who deleted
 * their last template has no templates. The caller is responsible for not
 * calling this with the empty result of a FAILED sync, which is why every error
 * from Graph aborts before reaching here.
 */
func (s *Store) ReplaceTemplates(ctx context.Context, hostID string, in []TemplateInput) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op once committed

	batch := time.Now().UTC()
	for _, t := range in {
		name := strings.TrimSpace(t.Name)
		lang := strings.TrimSpace(t.Language)
		if name == "" || lang == "" {
			// Neither half of the identity can be blank, and a row that cannot be
			// named cannot be sent. Skipped rather than failing the whole sync over
			// one malformed entry.
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm_templates
				(host_id, name, language, status, category, header, body, footer,
				 variables, unsupported, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT (host_id, name, language) DO UPDATE SET
				status = excluded.status,
				category = excluded.category,
				header = excluded.header,
				body = excluded.body,
				footer = excluded.footer,
				variables = excluded.variables,
				unsupported = excluded.unsupported,
				synced_at = excluded.synced_at,
				updated_at = now()`,
			hostID, name, lang, strings.TrimSpace(t.Status), strings.TrimSpace(t.Category),
			t.Header, t.Body, t.Footer, t.Variables, t.Unsupported, batch,
		); err != nil {
			return err
		}
	}

	// Anything this sync did not touch no longer exists at Meta.
	if _, err := tx.Exec(ctx,
		`DELETE FROM crm_templates WHERE host_id = $1 AND synced_at < $2`, hostID, batch); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const crmTemplateColumns = `
	name, language, status, category, header, body, footer, variables,
	unsupported, synced_at`

func scanTemplate(row scanner) (types.CRMTemplate, time.Time, error) {
	var (
		t      types.CRMTemplate
		synced time.Time
	)
	if err := row.Scan(&t.Name, &t.Language, &t.Status, &t.Category, &t.Header,
		&t.Body, &t.Footer, &t.Variables, &t.Unsupported, &synced); err != nil {
		return types.CRMTemplate{}, time.Time{}, err
	}
	/* Sendable, derived rather than stored, so one rule answers both the picker and
	 * the send path. Two conditions: Meta approved it, and it is made only of the
	 * parts this code fills in. */
	t.Sendable = t.Status == "APPROVED" && t.Unsupported == ""
	return t, synced, nil
}

/* Templates lists a host's cached templates alphabetically, with the last time
 * Meta was asked.
 *
 * Alphabetical and not by status: a host looking for "webinar_reminder_24h" knows
 * its name, and grouping approved ones first would move rows around under them
 * every time an approval came through.
 */
func (s *Store) Templates(ctx context.Context, hostID string) ([]types.CRMTemplate, time.Time, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+crmTemplateColumns+`
		  FROM crm_templates
		 WHERE host_id = $1
		 ORDER BY name, language`, hostID)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer rows.Close()

	// Never nil: a host with no templates has an empty list on the wire.
	out := make([]types.CRMTemplate, 0, 16)
	var newest time.Time
	for rows.Next() {
		t, synced, err := scanTemplate(rows)
		if err != nil {
			return nil, time.Time{}, err
		}
		if synced.After(newest) {
			newest = synced
		}
		out = append(out, t)
	}
	return out, newest, rows.Err()
}

// Template reads one by its full identity, which is what a send has to check
// before spending a Graph call on a name that is not approved.
func (s *Store) Template(ctx context.Context, hostID, name, language string) (types.CRMTemplate, error) {
	t, _, err := scanTemplate(s.pool.QueryRow(ctx, `
		SELECT `+crmTemplateColumns+`
		  FROM crm_templates
		 WHERE host_id = $1 AND name = $2 AND language = $3`,
		hostID, strings.TrimSpace(name), strings.TrimSpace(language)))
	if noRows(err) {
		return types.CRMTemplate{}, store.ErrNotFound
	}
	return t, err
}
