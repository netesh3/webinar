package store

import (
	"context"
	"encoding/json"
)

/* Server-side captions (migrations/0125, deploy/captions).
 *
 * Two flags rather than one, because "the host asked for it" and "it is actually running"
 * are different facts and the browsers need the second: they stop their own on-device
 * Whisper only when the agent has said it is live, so a dispatch no worker ever picked up
 * leaves the room on local captions instead of on none. */

// SetServerCaptions records the host's request. Turning it on also turns captions on (the
// overlay is gated on captions_enabled); turning it off clears the agent's live report too,
// so the browsers take over at once rather than when the agent gets round to leaving.
func (s *Store) SetServerCaptions(ctx context.Context, slug string, on bool) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET
			server_captions      = $2,
			server_captions_live = CASE WHEN $2 THEN server_captions_live ELSE false END,
			captions_enabled     = CASE WHEN $2 THEN true ELSE captions_enabled END,
			captions_shown_live  = captions_shown_live OR ($2 AND status = 'live'),
			updated_at           = now()
		 WHERE slug = $1`, slug, on)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

/* RequestCaptionAgent records that the caption agent has been asked into the room for the AI's
 * transcript only: server_captions on, like SetServerCaptions(true), but captions_enabled —
 * whether people see the lines — left as it is. */
func (s *Store) RequestCaptionAgent(ctx context.Context, slug string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET server_captions = true, updated_at = now() WHERE slug = $1`, slug)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ServerCaptionsRequested reports whether the host has asked for server captions.
func (s *Store) ServerCaptionsRequested(ctx context.Context, slug string) (bool, error) {
	var on bool
	err := s.pool.QueryRow(ctx, `SELECT server_captions FROM webinars WHERE slug = $1`, slug).Scan(&on)
	if noRows(err) {
		return false, ErrNotFound
	}
	return on, err
}

/* SetServerCaptionsLive is the agent's report. Only applied while the host's request stands:
 * an agent that is still on its way out after the host turned it off must not flip the room
 * back to server captions. Reports whether the row changed, so the caller pushes metadata
 * only when the browsers have something to react to. */
func (s *Store) SetServerCaptionsLive(ctx context.Context, slug string, live bool) (changed bool, err error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET server_captions_live = $2, updated_at = now()
		 WHERE slug = $1 AND server_captions AND server_captions_live <> $2`, slug, live)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ClearServerCaptions resets both flags, for a session that has ended.
func (s *Store) ClearServerCaptions(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE webinars SET server_captions = false, server_captions_live = false
		 WHERE slug = $1 AND (server_captions OR server_captions_live)`, slug)
	return err
}

// TranscriptSegment is one line of the after-session transcript. Start and End are Unix
// milliseconds, so segments from different speakers interleave by time.
type TranscriptSegment struct {
	Identity string `json:"identity"`
	Name     string `json:"name,omitempty"`
	Start    int64  `json:"start"`
	End      int64  `json:"end"`
	Text     string `json:"text"`
}

// SaveSessionTranscript stores one finished transcript for the webinar behind slug.
func (s *Store) SaveSessionTranscript(ctx context.Context, slug, model string, segments []TranscriptSegment) error {
	return s.SaveSessionTranscriptIn(ctx, slug, model, "", segments)
}

/* SaveSessionTranscriptIn is SaveSessionTranscript with the language it was captioned in (a
 * types.CaptionLanguages code, as the agent last streamed); empty stores the webinar's
 * captions language as it stands. */
func (s *Store) SaveSessionTranscriptIn(ctx context.Context, slug, model, language string, segments []TranscriptSegment) error {
	if segments == nil {
		segments = []TranscriptSegment{}
	}
	body, err := json.Marshal(segments)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO session_transcripts (webinar_id, segments, model, language)
		SELECT w.id, $2::jsonb, $3, coalesce(nullif($4, ''), w.options->>'captionsLanguage', $5)
		  FROM webinars w WHERE w.slug = $1`, slug, string(body), model, language, DefaultCaptionsLanguage())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// LatestSessionTranscript returns the newest stored transcript for slug, ErrNotFound if none.
func (s *Store) LatestSessionTranscript(ctx context.Context, slug string) (model string, segments []TranscriptSegment, err error) {
	var raw []byte
	err = s.pool.QueryRow(ctx, `
		SELECT t.model, t.segments
		  FROM session_transcripts t JOIN webinars w ON w.id = t.webinar_id
		 WHERE w.slug = $1
		 ORDER BY t.created_at DESC, t.id DESC LIMIT 1`, slug).Scan(&model, &raw)
	if noRows(err) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	err = json.Unmarshal(raw, &segments)
	return model, segments, err
}
