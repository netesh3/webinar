package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/netkumar/webcast/api/internal/engagement"
	"github.com/netkumar/webcast/api/types"
)

// EngagementSnapshot is a stored summary document and when it was computed.
type EngagementSnapshot struct {
	Payload    []byte
	ComputedAt time.Time
}

func (s *Store) EngagementSnapshot(ctx context.Context, webinarID string, version int) (EngagementSnapshot, error) {
	var snap EngagementSnapshot
	err := s.pool.QueryRow(ctx, `
		SELECT payload, computed_at FROM engagement_snapshots
		 WHERE webinar_id = $1 AND formula_version = $2`, webinarID, version).
		Scan(&snap.Payload, &snap.ComputedAt)
	if noRows(err) {
		return snap, ErrNotFound
	}
	return snap, err
}

/* SaveEngagement replaces a webinar's snapshot and scores in one transaction.
 *
 * Serialized per webinar with a transaction-scoped advisory lock, and written only if
 * nothing newer landed while this one was computing: two API instances recomputing the
 * same webinar at once both finish, and the later write of the earlier compute is the one
 * that is skipped rather than the one that wins. Reports whether it wrote.
 */
func (s *Store) SaveEngagement(ctx context.Context, webinarID string, version int,
	computedAt time.Time, summary []byte, rows []engagement.Scored) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('engagement:' || $1::text, 0))`, webinarID); err != nil {
		return false, err
	}
	var newer bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM engagement_snapshots
		                WHERE webinar_id = $1 AND formula_version = $2 AND computed_at > $3)`,
		webinarID, version, computedAt).Scan(&newer); err != nil {
		return false, err
	}
	if newer {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO engagement_snapshots (webinar_id, formula_version, computed_at, payload)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (webinar_id, formula_version)
		DO UPDATE SET computed_at = EXCLUDED.computed_at, payload = EXCLUDED.payload`,
		webinarID, version, computedAt, summary); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM engagement_scores WHERE webinar_id = $1`, webinarID); err != nil {
		return false, err
	}
	wid, err := uuid.Parse(webinarID)
	if err != nil {
		return false, err
	}
	src, err := scoreRows(wid, version, computedAt, rows)
	if err != nil {
		return false, err
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"engagement_scores"}, scoreColumns, pgx.CopyFromRows(src)); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

var scoreColumns = []string{
	"webinar_id", "identity", "registration_id", "formula_version", "name", "email",
	"score", "tier", "watch_seconds", "first_join_min", "last_leave_min", "join_timing",
	"visits", "counts", "components", "presence", "intensity", "computed_at",
}

func scoreRows(wid uuid.UUID, version int, at time.Time, rows []engagement.Scored) ([][]any, error) {
	out := make([][]any, 0, len(rows))
	for _, s := range rows {
		r := s.Row
		counts, err := json.Marshal(r.Counts)
		if err != nil {
			return nil, err
		}
		parts, err := json.Marshal(s.Components)
		if err != nil {
			return nil, err
		}
		reg := pgtype.UUID{}
		if id, err := uuid.Parse(s.RegistrationID); err == nil {
			reg = pgtype.UUID{Bytes: id, Valid: true}
		}
		out = append(out, []any{
			pgtype.UUID{Bytes: wid, Valid: true}, r.Identity, reg, int16(version), r.Name, r.Email,
			int16(r.Score), string(r.Tier), int32(s.WatchSec), int32(r.FirstJoinMin), int32(r.LastLeaveMin),
			string(r.JoinTiming), int16(r.Visits), counts, parts,
			toInt16(r.Presence), toInt16(r.Intensity), at,
		})
	}
	return out, nil
}

func toInt16(xs []int) []int16 {
	out := make([]int16, len(xs))
	for i, x := range xs {
		out[i] = int16(min(x, 32767))
	}
	return out
}

// AttendeeQuery is a page request against a webinar's stored scores.
type AttendeeQuery struct {
	Sort   types.EngagementSort
	Desc   bool
	Tiers  []types.EngagementTier
	Search string
	Offset int
	Limit  int
}

var sortColumns = map[types.EngagementSort]string{
	types.SortScore: "score",
	types.SortName:  "lower(name)",
	types.SortWatch: "watch_seconds",
	types.SortJoin:  "first_join_min",
}

const scoreSelect = `identity, name, email, score, tier, watch_seconds, first_join_min, last_leave_min,
	join_timing, visits, counts, presence, intensity`

// EngagementAttendees is one page of rows and the number matching the filters.
func (s *Store) EngagementAttendees(ctx context.Context, webinarID string, q AttendeeQuery) ([]types.EngagementAttendeeRow, int, error) {
	col, ok := sortColumns[q.Sort]
	if !ok {
		return nil, 0, fmt.Errorf("%w: sort %q", ErrInvalid, q.Sort)
	}
	dir := "ASC"
	if q.Desc {
		dir = "DESC"
	}
	tiers := make([]string, 0, len(q.Tiers))
	for _, t := range q.Tiers {
		tiers = append(tiers, string(t))
	}
	search := ""
	if q.Search != "" {
		search = "%" + likeEscape(strings.ToLower(q.Search)) + "%"
	}
	rows, err := s.pool.Query(ctx, `
		SELECT `+scoreSelect+`, count(*) OVER () AS total
		  FROM engagement_scores
		 WHERE webinar_id = $1
		   AND (cardinality($2::text[]) = 0 OR tier = ANY($2))
		   AND ($3 = '' OR lower(name) LIKE $3 OR lower(email) LIKE $3)
		 ORDER BY `+col+` `+dir+`, identity
		 OFFSET $4 LIMIT $5`, webinarID, tiers, search, q.Offset, q.Limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []types.EngagementAttendeeRow{}
	total := 0
	for rows.Next() {
		r, err := scanScore(rows, &total)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(out) == 0 && q.Offset > 0 {
		if err := s.pool.QueryRow(ctx, `
			SELECT count(*) FROM engagement_scores
			 WHERE webinar_id = $1 AND (cardinality($2::text[]) = 0 OR tier = ANY($2))
			   AND ($3 = '' OR lower(name) LIKE $3 OR lower(email) LIKE $3)`,
			webinarID, tiers, search).Scan(&total); err != nil {
			return nil, 0, err
		}
	}
	return out, total, nil
}

// EngagementScore is one stored row and its score breakdown.
func (s *Store) EngagementScore(ctx context.Context, webinarID, identity string) (types.EngagementAttendeeRow, []types.EngagementComponent, string, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT `+scoreSelect+`, components, COALESCE(registration_id::text, '')
		  FROM engagement_scores WHERE webinar_id = $1 AND identity = $2`, webinarID, identity)
	var (
		parts []byte
		reg   string
		out   []types.EngagementComponent
	)
	r, err := scanScore(row, nil, &parts, &reg)
	if noRows(err) {
		return r, nil, "", ErrNotFound
	}
	if err != nil {
		return r, nil, "", err
	}
	if err := json.Unmarshal(parts, &out); err != nil {
		return r, nil, "", err
	}
	return r, out, reg, nil
}

func scanScore(row pgx.Row, total *int, extra ...any) (types.EngagementAttendeeRow, error) {
	var (
		r                   types.EngagementAttendeeRow
		watch               int
		counts              []byte
		presence, intensity []int16
		tier, timing        string
	)
	dest := []any{&r.Identity, &r.Name, &r.Email, &r.Score, &tier, &watch, &r.FirstJoinMin,
		&r.LastLeaveMin, &timing, &r.Visits, &counts, &presence, &intensity}
	if total != nil {
		dest = append(dest, total)
	}
	if err := row.Scan(append(dest, extra...)...); err != nil {
		return r, err
	}
	r.Tier = types.EngagementTier(tier)
	r.JoinTiming = types.JoinTiming(timing)
	r.WatchMin = (watch + 30) / 60
	r.Presence = fromInt16(presence)
	r.Intensity = fromInt16(intensity)
	return r, json.Unmarshal(counts, &r.Counts)
}

func fromInt16(xs []int16) []int {
	out := make([]int, len(xs))
	for i, x := range xs {
		out[i] = int(x)
	}
	return out
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// EngagementCSVRow is one registrant or attendee in the export.
type EngagementCSVRow struct {
	Name, Email, Tier, JoinTiming string
	Score, WatchMin, Visits       int
	FirstJoinMin, LastLeaveMin    *int
	Counts                        types.EngagementCounts
	Attended                      bool
}

/* EachEngagementCSVRow streams the export: every registrant (no-shows included) and every
 * scored attendee without a registration, one row at a time, so a 5,000-person export is
 * never held in memory. */
func (s *Store) EachEngagementCSVRow(ctx context.Context, webinarID string, fn func(EngagementCSVRow) error) error {
	rows, err := s.pool.Query(ctx, `
		SELECT COALESCE(NULLIF(es.name, ''), btrim(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,''))),
		       COALESCE(NULLIF(es.email, ''), r.email, ''),
		       COALESCE(es.tier, 'no_show'), COALESCE(es.join_timing, ''),
		       COALESCE(es.score, 0), COALESCE(es.watch_seconds, 0), COALESCE(es.visits, 0),
		       es.first_join_min, NULLIF(es.last_leave_min, -1), COALESCE(es.counts, '{}'::jsonb),
		       es.identity IS NOT NULL
		  FROM (SELECT * FROM registrations WHERE webinar_id = $1 AND state <> 'declined') r
		  FULL JOIN (SELECT * FROM engagement_scores WHERE webinar_id = $1) es ON es.registration_id = r.id
		 ORDER BY es.score DESC NULLS LAST, 1`, webinarID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			c      EngagementCSVRow
			watch  int
			counts []byte
		)
		if err := rows.Scan(&c.Name, &c.Email, &c.Tier, &c.JoinTiming, &c.Score, &watch, &c.Visits,
			&c.FirstJoinMin, &c.LastLeaveMin, &counts, &c.Attended); err != nil {
			return err
		}
		c.WatchMin = (watch + 30) / 60
		if err := json.Unmarshal(counts, &c.Counts); err != nil {
			return err
		}
		if err := fn(c); err != nil {
			return err
		}
	}
	return rows.Err()
}

/* PruneEngagementEvents deletes raw events older than the cutoff, in bounded batches so
 * one sweep never holds a long lock. Computed scores and snapshots are kept. */
func (s *Store) PruneEngagementEvents(ctx context.Context, before time.Time, batch int) (int64, error) {
	var total int64
	for {
		tag, err := s.pool.Exec(ctx, `
			DELETE FROM engagement_events WHERE id IN (
			  SELECT id FROM engagement_events WHERE occurred_at < $1 LIMIT $2)`, before, batch)
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < int64(batch) || ctx.Err() != nil {
			return total, nil
		}
	}
}
