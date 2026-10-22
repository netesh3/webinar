package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

/* Captions on replays (migrations/0140, api/recording_captions.go): what a recording's CC is
 * built from — the original session's after-session transcript, else its live caption lines —
 * and whether the host lets it be shown. */

// ReplayCaptionsPolicy is the host's "Show captions on replays" (nil: not chosen) and whether
// captions were ever shown while the webinar was live, which is the default.
func (s *Store) ReplayCaptionsPolicy(ctx context.Context, slug string) (setting *bool, shownLive bool, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT replay_captions, captions_shown_live FROM webinars
		 WHERE slug = $1 OR id::text = $1`, slug).Scan(&setting, &shownLive)
	if noRows(err) {
		return nil, false, ErrNotFound
	}
	return setting, shownLive, err
}

// ShowReplayCaptions is the effective switch: the host's choice, else whether CC was shown live.
func ShowReplayCaptions(setting *bool, shownLive bool) bool {
	if setting != nil {
		return *setting
	}
	return shownLive
}

// SetReplayCaptions records the host's choice.
func (s *Store) SetReplayCaptions(ctx context.Context, slug string, on bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET replay_captions = $2, updated_at = now()
		 WHERE slug = $1 OR id::text = $1`, slug, on)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// HasCaptionSource reports whether the webinar has anything a replay's captions could be made of.
func (s *Store) HasCaptionSource(ctx context.Context, slug string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM session_transcripts t
		                WHERE t.webinar_id = w.id AND jsonb_array_length(t.segments) > 0)
		    OR EXISTS (SELECT 1 FROM session_captions c WHERE c.webinar_id = w.id)
		  FROM webinars w WHERE w.slug = $1 OR w.id::text = $1`, slug).Scan(&ok)
	if noRows(err) {
		return false, ErrNotFound
	}
	return ok, err
}

/* RecordingTranscript is the after-session transcript for a recording made between from and
 * to: the first one stored after the recording began (a transcript is saved when its session
 * ends) that has any segment inside the recording, with only those segments. found is false
 * when there is none. */
func (s *Store) RecordingTranscript(ctx context.Context, slug string, from, to time.Time) (segments []TranscriptSegment, found bool, err error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.segments
		  FROM session_transcripts t JOIN webinars w ON w.id = t.webinar_id
		 WHERE (w.slug = $1 OR w.id::text = $1) AND t.created_at >= $2
		 ORDER BY t.created_at, t.id LIMIT 10`, slug, from)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	lo, hi := from.UnixMilli(), to.UnixMilli()
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, false, err
		}
		var all []TranscriptSegment
		if err := json.Unmarshal(raw, &all); err != nil {
			continue
		}
		var in []TranscriptSegment
		for _, sg := range all {
			if max(sg.End, sg.Start) >= lo && sg.Start < hi {
				in = append(in, sg)
			}
		}
		if len(in) > 0 {
			return in, true, nil
		}
	}
	return nil, false, rows.Err()
}

/* RecordingCaptionLines is the live caption lines stored between from and to, oldest first,
 * at most limit. Name is the speaker's: the account's for a stage identity ("user_" + id),
 * the registration's for an attendee brought on stage ("att_" + join key), else empty. */
func (s *Store) RecordingCaptionLines(ctx context.Context, slug string, from, to time.Time, limit int) ([]CaptionLine, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.at, c.identity,
		       COALESCE(NULLIF(u.name, ''), NULLIF(trim(r.first_name || ' ' || r.last_name), ''), ''),
		       c.body
		  FROM session_captions c
		  JOIN webinars w ON w.id = c.webinar_id
		  LEFT JOIN users u ON starts_with(c.identity, 'user_') AND u.id::text = substr(c.identity, 6)
		  LEFT JOIN registrations r ON starts_with(c.identity, 'att_') AND r.join_key = substr(c.identity, 5)
		 WHERE (w.slug = $1 OR w.id::text = $1) AND c.at >= $2 AND c.at <= $3
		 ORDER BY c.at, c.id
		 LIMIT $4`, slug, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CaptionLine{}
	for rows.Next() {
		var l CaptionLine
		if err := rows.Scan(&l.At, &l.Identity, &l.Name, &l.Text); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// SpeakerNames is the name behind each identity it can resolve: an account, or a registration.
func (s *Store) SpeakerNames(ctx context.Context, identities []string) (map[string]string, error) {
	var users, keys []string
	for _, id := range identities {
		switch {
		case strings.HasPrefix(id, "user_"):
			users = append(users, strings.TrimPrefix(id, "user_"))
		case strings.HasPrefix(id, "att_"):
			keys = append(keys, strings.TrimPrefix(id, "att_"))
		}
	}
	out := map[string]string{}
	if len(users) == 0 && len(keys) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT 'user_' || id::text, name FROM users WHERE id::text = ANY($1::text[])
		UNION ALL
		SELECT 'att_' || join_key, trim(first_name || ' ' || last_name)
		  FROM registrations WHERE join_key = ANY($2::text[])`, users, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}
