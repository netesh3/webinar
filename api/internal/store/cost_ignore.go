package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The Cost by host report's ignore list (migration 0151): test and staff accounts whose usage
 * is not a customer's. Matching is in api/cost_ignore.go; this only keeps the rows. */

// CostIgnoreRule is one row of cost_ignore_rules, with a host rule's email for display.
type CostIgnoreRule struct {
	ID        string
	Kind      string
	Value     string
	Note      string
	CreatedBy string // the admin's email; empty once they are gone
	CreatedAt time.Time
	HostEmail string // for a host rule: the host's email now; empty otherwise
}

const costIgnoreSelect = `
	SELECT r.id::text, r.kind, r.value, r.note, coalesce(c.email, ''), r.created_at,
	       coalesce(h.email, '')
	  FROM cost_ignore_rules r
	  LEFT JOIN users c ON c.id = r.created_by
	  LEFT JOIN users h ON r.kind = 'host' AND h.id::text = r.value`

func scanCostIgnore(row pgx.CollectableRow) (CostIgnoreRule, error) {
	var c CostIgnoreRule
	err := row.Scan(&c.ID, &c.Kind, &c.Value, &c.Note, &c.CreatedBy, &c.CreatedAt, &c.HostEmail)
	return c, err
}

// CostIgnoreRules lists the ignore list, oldest first.
func (s *Store) CostIgnoreRules(ctx context.Context) ([]CostIgnoreRule, error) {
	rows, err := s.pool.Query(ctx, costIgnoreSelect+` ORDER BY r.created_at, r.id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanCostIgnore)
}

// AddCostIgnoreRule adds a rule. ErrConflict when the same kind and value is already there.
func (s *Store) AddCostIgnoreRule(ctx context.Context, kind, value, note, createdBy string) (CostIgnoreRule, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO cost_ignore_rules (kind, value, note, created_by)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid) RETURNING id::text`, kind, value, note, createdBy).Scan(&id)
	if isUniqueViolation(err) {
		return CostIgnoreRule{}, ErrConflict
	}
	if err != nil {
		return CostIgnoreRule{}, err
	}
	rows, err := s.pool.Query(ctx, costIgnoreSelect+` WHERE r.id = $1::uuid`, id)
	if err != nil {
		return CostIgnoreRule{}, err
	}
	return pgx.CollectExactlyOneRow(rows, scanCostIgnore)
}

// DeleteCostIgnoreRule removes a rule. ErrNotFound for an unknown id.
func (s *Store) DeleteCostIgnoreRule(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM cost_ignore_rules WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CostIgnoreCandidate is an account the ignore list might want: anyone who hosts or has
// hosted, or an admin.
type CostIgnoreCandidate struct {
	ID, Name, Email string
	IsAdmin         bool
}

// CostIgnoreCandidates lists the accounts that run up host costs, and the admins.
func (s *Store) CostIgnoreCandidates(ctx context.Context) ([]CostIgnoreCandidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id::text, coalesce(u.name, ''), coalesce(u.email, ''), u.is_admin
		  FROM users u
		 WHERE u.is_admin OR u.can_host OR EXISTS (SELECT 1 FROM webinars w WHERE w.host_id = u.id)
		 ORDER BY lower(u.email)`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CostIgnoreCandidate, error) {
		var c CostIgnoreCandidate
		err := row.Scan(&c.ID, &c.Name, &c.Email, &c.IsAdmin)
		return c, err
	})
}

// CostHostExists reports whether an account id is a user, for a host rule.
func (s *Store) CostHostExists(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id::text = $1)`, id).Scan(&ok)
	return ok, err
}
