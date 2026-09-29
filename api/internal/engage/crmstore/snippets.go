package crmstore

import (
	"context"
	"strings"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// SnippetMax is how many quick replies a host may keep: a row of chips, not a library.
const SnippetMax = 20

// Snippets is the host's quick replies, in their order.
func (s *Store) Snippets(ctx context.Context, hostID string) ([]types.CRMSnippet, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, title, body FROM crm_snippets
		 WHERE host_id = $1::uuid ORDER BY position, created_at, id`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.CRMSnippet{}
	for rows.Next() {
		var sn types.CRMSnippet
		if err := rows.Scan(&sn.ID, &sn.Title, &sn.Body); err != nil {
			return nil, err
		}
		out = append(out, sn)
	}
	return out, rows.Err()
}

/* SaveSnippet creates a quick reply when id is empty, or rewrites one. store.ErrConflict
 * when the host already has SnippetMax. */
func (s *Store) SaveSnippet(ctx context.Context, hostID, id, title, body string) (types.CRMSnippet, error) {
	title = strings.Join(strings.Fields(title), " ")
	body = strings.TrimSpace(body)
	if title == "" || body == "" || len([]rune(title)) > 40 || len([]rune(body)) > 4096 {
		return types.CRMSnippet{}, store.ErrInvalid
	}
	out := types.CRMSnippet{Title: title, Body: body}
	if id == "" {
		err := s.pool.QueryRow(ctx, `
			INSERT INTO crm_snippets (host_id, title, body, position)
			SELECT $1::uuid, $2, $3, COALESCE(max(position) + 1, 0)
			  FROM crm_snippets WHERE host_id = $1::uuid
			HAVING count(*) < $4
			RETURNING id::text`, hostID, title, body, SnippetMax).Scan(&out.ID)
		if noRows(err) {
			return out, store.ErrConflict
		}
		return out, err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm_snippets SET title = $3, body = $4
		 WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id, title, body)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() == 0 {
		return out, store.ErrNotFound
	}
	out.ID = id
	return out, nil
}

// DeleteSnippet removes one of the host's quick replies.
func (s *Store) DeleteSnippet(ctx context.Context, hostID, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM crm_snippets WHERE host_id = $1::uuid AND id = $2::uuid`, hostID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}
