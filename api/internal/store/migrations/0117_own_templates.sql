/* Templates the host wrote here, recorded instead of recognised by name.
 *
 * Until now a template written in the app was named wl_own_ and eight random hex
 * digits, and that prefix was how it was told apart from one made in WhatsApp
 * Manager (only those can have translations added here). Templates are now named
 * from the title the host types, so the prefix cannot do that job any more.
 *
 * One row per name: a template's translations share its name. Beside crm_templates
 * rather than in it, because that table is a cache replaced on every sync.
 * title is what the host typed, to show instead of the name. It is empty for the
 * templates backfilled below.
 */
CREATE TABLE crm_own_templates (
    host_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL,
    title      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, name)
);

-- Every wl_own_ template already written here: the cache, and what the host set
-- beside it (which outlives a sync that has not caught up yet).
INSERT INTO crm_own_templates (host_id, name)
SELECT host_id, name FROM crm_templates WHERE name LIKE 'wl\_own\_%'
UNION
SELECT host_id, name FROM crm_template_defaults WHERE name LIKE 'wl\_own\_%'
UNION
SELECT host_id, name FROM crm_template_media WHERE name LIKE 'wl\_own\_%'
ON CONFLICT DO NOTHING;
