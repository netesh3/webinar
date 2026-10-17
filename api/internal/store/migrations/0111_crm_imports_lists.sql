/* Contact import from a CSV, and saved lists.
 *
 * A coach uploads the export of their students (most come from TagMango) under a
 * broadcast's "Who gets the message", and the people in it become contacts and a
 * saved list they can send to again.
 *
 * Lists are their own tables rather than tags. A tag fires the `tag_added` drip
 * trigger and bot steps, and crm_broadcasts.tag_id is ON DELETE RESTRICT, so a tag
 * a broadcast went to can never be deleted. A list is a frozen set of people from
 * one import (or more, added later) that a host must be able to delete without
 * touching the contacts or the broadcasts that used it.
 */
CREATE TABLE crm_lists (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    source     text NOT NULL DEFAULT 'import',
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Last time people were added (another CSV imported into it) or it was renamed.
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_lists_host_name_key ON crm_lists (host_id, lower(name));

CREATE TABLE crm_list_members (
    list_id    uuid NOT NULL REFERENCES crm_lists (id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES crm_contacts (id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX crm_list_members_contact_idx ON crm_list_members (contact_id);

/* One upload. raw is the file as sent, kept between the preview and the commit so the
 * host can change the column mapping without uploading again; it is cleared at commit.
 * The consent fields are the record of who confirmed the people agreed to WhatsApp
 * messages, and when — what Meta asks for if a number is reported. */
CREATE TABLE crm_imports (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    file_name         text NOT NULL DEFAULT '',
    raw               text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'committed')),
    list_id           uuid REFERENCES crm_lists (id) ON DELETE SET NULL,
    consent_confirmed boolean NOT NULL DEFAULT false,
    confirmed_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    confirmed_at      timestamptz,
    counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    committed_at      timestamptz
);
CREATE INDEX crm_imports_host_idx ON crm_imports (host_id, created_at DESC);

/* Columns an import fills that nothing else had: TagMango's extras (payment cycle,
 * last transaction, subscription expiry), and where a WhatsApp opt-in came from. */
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS whatsapp_opt_in_source text NOT NULL DEFAULT '';
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS whatsapp_opt_in_import_id uuid
    REFERENCES crm_imports (id) ON DELETE SET NULL;

-- A broadcast can go to a saved list. SET NULL, not RESTRICT: deleting a list later
-- must not be blocked by the broadcasts that already went out to it.
ALTER TABLE crm_broadcasts ADD COLUMN IF NOT EXISTS list_id uuid REFERENCES crm_lists (id) ON DELETE SET NULL;
ALTER TABLE crm_broadcasts DROP CONSTRAINT IF EXISTS crm_broadcasts_audience_check;
ALTER TABLE crm_broadcasts ADD CONSTRAINT crm_broadcasts_audience_check CHECK (audience IN
    ('opted_in','webinar','tag','segment','contacts','list'));
