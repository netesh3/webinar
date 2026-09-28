package store

import "context"

/* IntegrationInterests is the set of "notify me" providers this account has
 * asked about. The key is the provider id; the value is always true. */
func (s *Store) IntegrationInterests(ctx context.Context, userID string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT provider FROM integration_interest WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

/* RecordIntegrationInterest remembers that this account wants to hear when a
 * coming-soon provider ships. Asking twice is the same as asking once. */
func (s *Store) RecordIntegrationInterest(ctx context.Context, userID, provider string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO integration_interest (user_id, provider)
		VALUES ($1, $2)
		ON CONFLICT (user_id, provider) DO NOTHING`, userID, provider)
	return err
}
