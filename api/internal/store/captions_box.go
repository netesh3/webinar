package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The on-demand captions droplet's state (migrations/0163, api/internal/api/captions_box.go).
 *
 * One row per video box project. Written only by the video box's step under that project's
 * sfu_box_state lease: SaveCaptionsBox is conditional on the holder still having it. */

// CaptionsBoxState is one video box's captions droplet. Actual is BoxDown, BoxCreating,
// BoxReady or BoxDeleting.
type CaptionsBoxState struct {
	Project       string
	Actual        string
	DropletID     int64
	Since         time.Time
	LastError     string
	Failures      int
	NextAttemptAt *time.Time
	AlertedAt     *time.Time
}

// CaptionsRunProject is the sfu_box_runs project a captions droplet's hours are kept under,
// apart from the video box's (which the cost report reads).
func CaptionsRunProject(project string) string { return project + ":captions" }

// CaptionsBox reads project's row; a box never stepped reads as down.
func (s *Store) CaptionsBox(ctx context.Context, project string) (CaptionsBoxState, error) {
	b := CaptionsBoxState{Project: project}
	err := s.pool.QueryRow(ctx, `
		SELECT actual, coalesce(droplet_id, 0), since, last_error, failures, next_attempt_at, alerted_at
		  FROM captions_box_state WHERE project = $1`, project).
		Scan(&b.Actual, &b.DropletID, &b.Since, &b.LastError, &b.Failures, &b.NextAttemptAt, &b.AlertedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return CaptionsBoxState{Project: project, Actual: BoxDown, Since: time.Now()}, nil
	}
	return b, err
}

/* SaveCaptionsBox writes the row if holder still holds project's sfu_box_state lease
 * (TakeSFUBoxLease); ErrLeaseLost otherwise. */
func (s *Store) SaveCaptionsBox(ctx context.Context, holder string, b CaptionsBoxState) error {
	var droplet *int64
	if b.DropletID != 0 {
		droplet = &b.DropletID
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO captions_box_state AS c
		       (project, actual, droplet_id, since, last_error, failures, next_attempt_at, alerted_at)
		SELECT $1, $3, $4, $5, $6, $7, $8, $9
		 WHERE EXISTS (SELECT 1 FROM sfu_box_state
		                WHERE project = $1 AND lease_holder = $2 AND lease_until > now())
		ON CONFLICT (project) DO UPDATE
		   SET actual = $3, droplet_id = $4, since = $5, last_error = $6, failures = $7,
		       next_attempt_at = $8, alerted_at = $9, updated_at = now()`,
		b.Project, holder, b.Actual, droplet, b.Since, b.LastError, b.Failures, b.NextAttemptAt, b.AlertedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// CaptionAwaitingAgent is a live session that asked for the caption agent and has not heard it.
type CaptionAwaitingAgent struct {
	Slug string
	// Display is captions shown (else the agent is there for the AI transcript only).
	Display bool
}

/* CaptionsAwaitingAgent is project's live sessions with the caption agent requested
 * (server_captions) whose agent has not reported live: a dispatch made before the captions
 * box's worker was up, a room beyond the agent's max rooms, or an agent paused by its CPU
 * guard. The caller tells them apart by asking LiveKit (lk.Client.RedispatchIdle). */
func (s *Store) CaptionsAwaitingAgent(ctx context.Context, project, defaultProject string) ([]CaptionAwaitingAgent, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, coalesce(w.captions_enabled, false) FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		 WHERE w.status = 'live' AND w.kind <> 'simulive'
		   AND w.server_captions AND NOT w.server_captions_live
		   AND `+boxProjectOf+` = $1
		 ORDER BY w.started_at NULLS LAST
		 LIMIT 50`, project, defaultProject)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CaptionAwaitingAgent, error) {
		var a CaptionAwaitingAgent
		err := row.Scan(&a.Slug, &a.Display)
		return a, err
	})
}
