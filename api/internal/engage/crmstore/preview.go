package crmstore

import (
	"context"
	"time"
)

/* PreviewFacts are the host's own values for the merge-field examples, so a preview reads
 * "Hi Priya, Mindful Money starts…" rather than a made-up contact and webinar. Every one
 * may be empty — a new host has no contacts and no webinars — and the caller keeps its
 * generic example for those. */
type PreviewFacts struct {
	ContactName string
	Slug        string
	Topic       string
	StartsAt    time.Time
	TimeZone    string
	HostName    string
}

// PreviewFacts reads the host's newest contact with a name, their next (else latest)
// webinar, and their own name.
func (s *Store) PreviewFacts(ctx context.Context, hostID string) (PreviewFacts, error) {
	var f PreviewFacts
	if err := s.pool.QueryRow(ctx, `SELECT name FROM users WHERE id = $1::uuid`, hostID).
		Scan(&f.HostName); err != nil && !noRows(err) {
		return f, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT name FROM crm_contacts
		 WHERE host_id = $1::uuid AND btrim(name) <> ''
		 ORDER BY created_at DESC LIMIT 1`, hostID).Scan(&f.ContactName); err != nil && !noRows(err) {
		return f, err
	}
	// The next one coming up is what a host is most likely writing about; with none
	// scheduled, the most recent.
	err := s.pool.QueryRow(ctx, `
		SELECT slug, topic, starts_at, time_zone FROM webinars
		 WHERE host_id = $1::uuid AND btrim(topic) <> ''
		 ORDER BY (starts_at >= now()) DESC,
		          CASE WHEN starts_at >= now() THEN starts_at END ASC,
		          starts_at DESC
		 LIMIT 1`, hostID).Scan(&f.Slug, &f.Topic, &f.StartsAt, &f.TimeZone)
	if err != nil && !noRows(err) {
		return f, err
	}
	return f, nil
}
