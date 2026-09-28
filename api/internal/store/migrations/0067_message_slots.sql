/* Message slots: one row per attendee message, in two layers.
 *
 * A slot is a kind (confirmation, reminder, replay, followup_<group>) with channels,
 * timing, wording and a switch. crm_message_defaults is the coach's choice for every
 * webinar. webinar_message_settings stores only what differs; a NULL column means
 * "use the default".
 *
 * Timing jsonb:
 *   {"type":"immediate"}
 *   {"type":"before","minutes":[1440,60]}
 *   {"type":"on_publish"}
 *   {"type":"after_end","minutes":120}
 *   {"type":"next_morning","hour":9}
 *
 * The backfill is a function so a test can run it again after the tables have been
 * truncated. ON CONFLICT DO NOTHING, so a second run does not overwrite a later edit.
 */
CREATE TABLE crm_message_defaults (
    host_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN (
                   'confirmation','reminder','replay',
                   'followup_high','followup_engaged','followup_passive',
                   'followup_risk','followup_no_show')),
    channels   text[] NOT NULL DEFAULT '{}',
    timing     jsonb NOT NULL DEFAULT '{}',
    template   text NOT NULL DEFAULT '',
    language   text NOT NULL DEFAULT '',
    params     jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled    boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, kind)
);

/* NULL in any column but kind means "inherit the account default". */
CREATE TABLE webinar_message_settings (
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN (
                   'confirmation','reminder','replay',
                   'followup_high','followup_engaged','followup_passive',
                   'followup_risk','followup_no_show')),
    channels   text[],
    timing     jsonb,
    template   text,
    language   text,
    params     jsonb,
    enabled    boolean,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, kind)
);

CREATE OR REPLACE FUNCTION crm_backfill_message_slots() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    /* Account wording from the reminder templates. Email stays on: that channel was
     * never stored on the template row, and it defaults on for a webinar. */
    INSERT INTO crm_message_defaults
        (host_id, kind, channels, timing, template, language, params, enabled)
    SELECT t.host_id,
           CASE t.kind
               WHEN 'wa_registration_confirmed' THEN 'confirmation'
               WHEN 'wa_reminder' THEN 'reminder'
               ELSE 'replay'
           END,
           ARRAY['email','whatsapp']::text[],
           CASE t.kind
               WHEN 'wa_registration_confirmed' THEN '{"type":"immediate"}'::jsonb
               WHEN 'wa_reminder' THEN '{"type":"before","minutes":[1440,60]}'::jsonb
               ELSE '{"type":"on_publish"}'::jsonb
           END,
           t.name,
           t.language,
           COALESCE(t.params, '[]'::jsonb),
           true
      FROM crm_reminder_templates t
     WHERE t.name <> ''
       AND t.kind IN ('wa_registration_confirmed','wa_reminder','wa_replay')
    ON CONFLICT (host_id, kind) DO NOTHING;

    /* Follow-up recipes are drips. The first step's wait is "after the end". */
    INSERT INTO crm_message_defaults
        (host_id, kind, channels, timing, template, language, params, enabled)
    SELECT d.host_id,
           CASE d.recipe
               WHEN 'offer_high' THEN 'followup_high'
               WHEN 'thanks_engaged' THEN 'followup_engaged'
               WHEN 'replay_passive' THEN 'followup_passive'
               WHEN 'replay_risk' THEN 'followup_risk'
               ELSE 'followup_no_show'
           END,
           ARRAY['whatsapp']::text[],
           jsonb_build_object('type', 'after_end', 'minutes',
               COALESCE(s.delay_minutes, CASE d.recipe
                   WHEN 'offer_high' THEN 60
                   WHEN 'replay_passive' THEN 1440
                   WHEN 'replay_risk' THEN 1440
                   ELSE 120
               END)),
           COALESCE(s.template_name, ''),
           COALESCE(s.template_language, ''),
           COALESCE((
               SELECT jsonb_agg(token)
                 FROM (
                   SELECT CASE
                       WHEN jsonb_typeof(elem) = 'string' THEN elem #>> '{}'
                       WHEN COALESCE(elem->>'field', '') <> '' THEN elem->>'field'
                       ELSE COALESCE(elem->>'text', '')
                   END AS token
                     FROM jsonb_array_elements(COALESCE(s.params, '[]'::jsonb)) elem
                 ) q
                WHERE token <> ''
           ), '[]'::jsonb),
           d.active
      FROM crm_drips d
      LEFT JOIN crm_drip_steps s ON s.drip_id = d.id AND s.position = 0
     WHERE d.recipe IN (
         'replay_no_show','offer_high','thanks_engaged','replay_passive','replay_risk')
    ON CONFLICT (host_id, kind) DO NOTHING;

    /* Per webinar: the three option fields. A missing emailReminders key means on,
     * a missing whatsappReminders key means off, a missing reminders key means
     * a day before and an hour before — the same defaults the Go reader applies. */
    INSERT INTO webinar_message_settings
        (webinar_id, kind, channels, timing, enabled)
    SELECT w.id, 'confirmation',
           ARRAY(
               SELECT v.ch
                 FROM (VALUES
                     (1, 'email', true),
                     (2, 'whatsapp', COALESCE((w.options->>'whatsappReminders')::boolean, false))
                 ) AS v(ord, ch, on_)
                WHERE v.on_
                ORDER BY v.ord
           ),
           '{"type":"immediate"}'::jsonb,
           true
      FROM webinars w
    ON CONFLICT (webinar_id, kind) DO NOTHING;

    INSERT INTO webinar_message_settings
        (webinar_id, kind, channels, timing, enabled)
    SELECT w.id, 'reminder', ch.channels,
           jsonb_build_object('type', 'before', 'minutes', mins.minutes),
           cardinality(ch.channels) > 0 AND jsonb_array_length(mins.minutes) > 0
      FROM webinars w
      CROSS JOIN LATERAL (
          SELECT CASE
              WHEN w.options ? 'reminders'
               AND jsonb_typeof(w.options->'reminders') = 'array'
                  THEN w.options->'reminders'
              ELSE '[1440,60]'::jsonb
          END AS minutes
      ) mins
      CROSS JOIN LATERAL (
          SELECT ARRAY(
              SELECT v.ch
                FROM (VALUES
                    (1, 'email', COALESCE((w.options->>'emailReminders')::boolean, true)),
                    (2, 'whatsapp', COALESCE((w.options->>'whatsappReminders')::boolean, false))
                ) AS v(ord, ch, on_)
               WHERE v.on_
               ORDER BY v.ord
          ) AS channels
      ) ch
    ON CONFLICT (webinar_id, kind) DO NOTHING;
END;
$$;

SELECT crm_backfill_message_slots();
