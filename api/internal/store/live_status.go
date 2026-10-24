package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

/* LiveSession is one session a deploy would interrupt (GET /api/internal/live-status).
 *
 * State is why it counts:
 *   "live"          status live: a webinar, meeting or simulive in progress.
 *   "doors-open"    a scheduled simulive whose host opened the doors (people are waiting in it).
 *   "starting-soon" scheduled to start within the next few minutes, or started a few minutes
 *                   ago without the host pressing Start yet (the audience is arriving).
 *   "finalizing"    (FinalizingSessions only) ended, with the after-session transcript still
 *                   being made on the box: blocks a box deploy, never an API or Web one.
 *
 * Project is the video server the room is (or will be) on: the webinar's pin, else its host's
 * assigned project, else defaultProject, the same order the first join uses. A Zoom-venue
 * session is "zoom": it never touches our video servers. Nothing here identifies a person. */
type LiveSession struct {
	Slug      string     `json:"slug"`
	Kind      string     `json:"kind"`
	State     string     `json:"state"`
	Project   string     `json:"project"`
	StartsAt  time.Time  `json:"startsAt"`
	StartedAt *time.Time `json:"startedAt,omitempty"`
}

// liveSoonBefore / liveSoonAfter bound "starting-soon" around starts_at.
const (
	liveSoonBefore = 10 * time.Minute
	liveSoonAfter  = 15 * time.Minute
)

// LiveSessions lists every session a deploy would interrupt right now (see LiveSession).
func (s *Store) LiveSessions(ctx context.Context, defaultProject string) ([]LiveSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.kind,
		       CASE WHEN w.status = 'live' THEN 'live'
		            WHEN w.kind = 'simulive' AND w.simulive_doors_open THEN 'doors-open'
		            ELSE 'starting-soon' END,
		       CASE WHEN coalesce(w.venue, 'app') LIKE 'zoom%' THEN 'zoom'
		            ELSE coalesce(NULLIF(w.sfu_project, ''), NULLIF(u.sfu_project, ''), $1) END,
		       w.starts_at, w.started_at
		  FROM webinars w
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE w.status = 'live'
		    OR (w.status = 'scheduled' AND w.kind = 'simulive' AND w.simulive_doors_open)
		    OR (w.status = 'scheduled'
		        AND w.starts_at <= now() + make_interval(secs => $2)
		        AND w.starts_at >= now() - make_interval(secs => $3))
		 ORDER BY w.starts_at, w.slug`,
		defaultProject, liveSoonBefore.Seconds(), liveSoonAfter.Seconds())
	if err != nil {
		return nil, err
	}
	return collectLiveSessions(rows)
}

func collectLiveSessions(rows pgx.Rows) ([]LiveSession, error) {
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (LiveSession, error) {
		var l LiveSession
		err := row.Scan(&l.Slug, &l.Kind, &l.State, &l.Project, &l.StartsAt, &l.StartedAt)
		return l, err
	})
}

// finalizingFor is how long after its end a session can still count as finalizing: the recap's
// transcript wait (recapTranscriptWait, 30 min) with a little to spare.
const finalizingFor = 35 * time.Minute

/* FinalizingSessions lists the sessions whose post-session work is still running (state
 * "finalizing"): ended less than finalizingFor ago, with the AI recap still waiting for the
 * after-session transcript the caption agent (on the captions box) is making (none stored
 * since the end, wait_until not yet passed). Project is resolved as in LiveSessions. */
func (s *Store) FinalizingSessions(ctx context.Context, defaultProject string) ([]LiveSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, w.kind, 'finalizing',
		       CASE WHEN coalesce(w.venue, 'app') LIKE 'zoom%' THEN 'zoom'
		            ELSE coalesce(NULLIF(w.sfu_project, ''), NULLIF(u.sfu_project, ''), $1) END,
		       w.starts_at, w.started_at
		  FROM session_recaps r
		  JOIN webinars w ON w.id = r.webinar_id
		  LEFT JOIN users u ON u.id = w.host_id
		 WHERE r.status = 'pending'
		   AND r.wait_until > now()
		   AND w.status = 'ended'
		   AND w.ended_at > now() - make_interval(secs => $2)
		   AND NOT EXISTS (SELECT 1 FROM session_transcripts t
		                    WHERE t.webinar_id = w.id AND t.created_at >= w.ended_at)
		 ORDER BY w.ended_at, w.slug`,
		defaultProject, finalizingFor.Seconds())
	if err != nil {
		return nil, err
	}
	return collectLiveSessions(rows)
}
