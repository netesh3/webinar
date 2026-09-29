package crmstore

import (
	"context"
	"encoding/json"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Message slots: the account default and the per-webinar override.
 *
 * A NULL column on the webinar row is "inherit", so the scan keeps a set-flag
 * beside every nullable value. The resolver in package engage is the only
 * reader that combines the two.
 */

// DefaultSlot is one stored account default. Every column is present.
type DefaultSlot struct {
	Kind     string
	Channels []string
	Timing   types.MessageTiming
	Template string
	Language string
	Params   []string
	Enabled  bool
}

// WebinarSlot is one override. A false *Set means the column is NULL.
type WebinarSlot struct {
	Kind        string
	Channels    []string
	ChannelsSet bool
	Timing      types.MessageTiming
	TimingSet   bool
	Template    string
	TemplateSet bool
	Language    string
	LanguageSet bool
	Params      []string
	ParamsSet   bool
	Enabled     bool
	EnabledSet  bool
}

// MessageDefaults is the host's stored defaults, keyed by kind.
func (s *Store) MessageDefaults(ctx context.Context, hostID string) (map[string]DefaultSlot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kind, channels, timing, template, language, params, enabled
		  FROM crm_message_defaults
		 WHERE host_id = $1::uuid`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]DefaultSlot{}
	for rows.Next() {
		var (
			d         DefaultSlot
			timingRaw []byte
			paramsRaw []byte
		)
		if err := rows.Scan(&d.Kind, &d.Channels, &timingRaw, &d.Template, &d.Language, &paramsRaw, &d.Enabled); err != nil {
			return nil, err
		}
		if err := decodeTiming(timingRaw, &d.Timing); err != nil {
			return nil, err
		}
		d.Params, err = decodeParams(paramsRaw)
		if err != nil {
			return nil, err
		}
		if d.Channels == nil {
			d.Channels = []string{}
		}
		out[d.Kind] = d
	}
	return out, rows.Err()
}

// WebinarMessageSettings is one webinar's overrides, keyed by kind.
func (s *Store) WebinarMessageSettings(ctx context.Context, slug string) (map[string]WebinarSlot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT s.kind,
		       s.channels IS NOT NULL, s.channels,
		       s.timing IS NOT NULL, s.timing,
		       s.template IS NOT NULL, COALESCE(s.template, ''),
		       s.language IS NOT NULL, COALESCE(s.language, ''),
		       s.params IS NOT NULL, s.params,
		       s.enabled IS NOT NULL, COALESCE(s.enabled, false)
		  FROM webinar_message_settings s
		  JOIN webinars w ON w.id = s.webinar_id
		 WHERE w.slug = $1`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]WebinarSlot{}
	for rows.Next() {
		var (
			w         WebinarSlot
			timingRaw []byte
			paramsRaw []byte
		)
		if err := rows.Scan(&w.Kind,
			&w.ChannelsSet, &w.Channels,
			&w.TimingSet, &timingRaw,
			&w.TemplateSet, &w.Template,
			&w.LanguageSet, &w.Language,
			&w.ParamsSet, &paramsRaw,
			&w.EnabledSet, &w.Enabled); err != nil {
			return nil, err
		}
		if w.TimingSet {
			if err := decodeTiming(timingRaw, &w.Timing); err != nil {
				return nil, err
			}
		}
		if w.ParamsSet {
			w.Params, err = decodeParams(paramsRaw)
			if err != nil {
				return nil, err
			}
		}
		if w.Channels == nil {
			w.Channels = []string{}
		}
		out[w.Kind] = w
	}
	return out, rows.Err()
}

// UpsertMessageDefault writes one account default, replacing that kind.
func (s *Store) UpsertMessageDefault(ctx context.Context, hostID string, slot types.MessageSlot) error {
	timing, err := json.Marshal(slot.Timing)
	if err != nil {
		return err
	}
	params, err := json.Marshal(nonNil(slot.Params))
	if err != nil {
		return err
	}
	channels := slot.Channels
	if channels == nil {
		channels = []string{}
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO crm_message_defaults
		    (host_id, kind, channels, timing, template, language, params, enabled, updated_at)
		VALUES ($1::uuid, $2, $3::text[], $4::jsonb, $5, $6, $7::jsonb, $8, now())
		ON CONFLICT (host_id, kind) DO UPDATE SET
		    channels = EXCLUDED.channels,
		    timing = EXCLUDED.timing,
		    template = EXCLUDED.template,
		    language = EXCLUDED.language,
		    params = EXCLUDED.params,
		    enabled = EXCLUDED.enabled,
		    updated_at = now()`,
		hostID, slot.Kind, channels, string(timing), slot.Template, slot.Language, string(params), slot.Enabled)
	return err
}

/* UpsertWebinarMessage writes one override row. A nil field is stored as NULL,
 * which resolution reads as "inherit the default". The whole row is replaced:
 * a field the caller left out stops being an override. */
func (s *Store) UpsertWebinarMessage(ctx context.Context, slug string, patch types.MessageSlotPatch) error {
	var timing any
	if patch.Timing != nil {
		raw, err := json.Marshal(patch.Timing)
		if err != nil {
			return err
		}
		timing = string(raw)
	}
	var params any
	if patch.Params != nil {
		raw, err := json.Marshal(nonNil(*patch.Params))
		if err != nil {
			return err
		}
		params = string(raw)
	}
	var channels any
	if patch.Channels != nil {
		ch := *patch.Channels
		if ch == nil {
			ch = []string{}
		}
		channels = ch
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO webinar_message_settings
		    (webinar_id, kind, channels, timing, template, language, params, enabled, updated_at)
		SELECT w.id, $2, $3::text[], $4::jsonb, $5, $6, $7::jsonb, $8, now()
		  FROM webinars w
		 WHERE w.slug = $1
		ON CONFLICT (webinar_id, kind) DO UPDATE SET
		    channels = EXCLUDED.channels,
		    timing = EXCLUDED.timing,
		    template = EXCLUDED.template,
		    language = EXCLUDED.language,
		    params = EXCLUDED.params,
		    enabled = EXCLUDED.enabled,
		    updated_at = now()`,
		slug, patch.Kind, channels, timing, patch.Template, patch.Language, params, patch.Enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

// BackfillMessageSlots re-runs the migration's copy from templates, recipes and options.
func (s *Store) BackfillMessageSlots(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `SELECT crm_backfill_message_slots()`)
	return err
}

/* RetargetRecipeDue moves enrollments that just joined a recipe onto the slot's
 * due time. created_at >= since keeps people already on the sequence where they are.
 */
func (s *Store) RetargetRecipeDue(ctx context.Context, slug, recipe string, due, since time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE crm_drip_enrollments e
		   SET next_due_at = $4
		  FROM crm_drips d
		  JOIN webinars w ON w.slug = $1 AND w.host_id = d.host_id
		 WHERE e.drip_id = d.id
		   AND d.recipe = $2
		   AND e.webinar_id = w.id
		   AND e.state = 'active'
		   AND e.position = 0
		   AND e.created_at >= $3`,
		slug, recipe, since, due)
	return err
}

func decodeTiming(raw []byte, dst *types.MessageTiming) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

func decodeParams(raw []byte) ([]string, error) {
	if len(raw) == 0 {
		return []string{}, nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

func nonNil(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}
