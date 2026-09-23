-- The host's WhatsApp message templates, cached from Meta.
--
-- A cache and nothing more: Meta owns these rows. A template is created and
-- approved in WhatsApp Manager (or by API), and what is stored here is a copy of
-- what Meta said about it at the last sync. Nothing in the product edits a row —
-- the sync replaces them — because a local edit would mean sending a body Meta
-- never approved, which Meta rejects and which would look like our bug.
--
-- It exists at all because the alternative is a Graph round trip on every screen
-- that names a template: the inbox picker, a broadcast, a reminder about to be
-- sent at 3am. Meta rate-limits template reads per WABA, and a reminder that
-- fails because a *list* call was throttled would be absurd.
--
-- Identity is (host, name, language). The same template is submitted and
-- approved once per translation, and a send names both — so "webinar_reminder"
-- alone does not identify a thing that can be sent.

CREATE TABLE crm_templates (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    name     text NOT NULL,
    -- Meta's code, e.g. 'en', 'en_US', 'pt_BR'. Sent back verbatim; guessing a
    -- variant is how somebody receives a message in the wrong dialect.
    language text NOT NULL,

    -- Meta's own vocabulary, upper-cased: APPROVED / PENDING / REJECTED / PAUSED
    -- / DISABLED. Kept as free text rather than a CHECK because Meta has added
    -- states before (PAUSED, IN_APPEAL) and an unknown one should show up in the
    -- UI as itself, not abort a sync.
    status   text NOT NULL DEFAULT '',
    -- MARKETING / UTILITY / AUTHENTICATION. Decides both what Meta charges and
    -- what consent a send needs: marketing requires opt-in, a utility message
    -- about a webinar somebody registered for does not.
    category text NOT NULL DEFAULT '',

    -- The approved text, placeholders ({{1}}, {{2}}) left in. Stored so a host
    -- can read what they are about to send, and so the compose box can preview
    -- it with the variables filled.
    header   text NOT NULL DEFAULT '',
    body     text NOT NULL DEFAULT '',
    footer   text NOT NULL DEFAULT '',
    -- How many placeholders the body has. Exactly how many values a send must
    -- supply: Meta rejects a mismatch rather than leaving a blank, so this is
    -- checked before spending a Graph call.
    variables integer NOT NULL DEFAULT 0,

    -- Empty when this template can be sent from here; otherwise the reason it
    -- cannot, in words a host can read ("its header is image"). Text rather than
    -- a boolean because a template greyed out with no explanation is a support
    -- ticket. Derived at sync time, so a template that becomes sendable when the
    -- code grows support for media headers says so after the next refresh.
    unsupported text NOT NULL DEFAULT '',

    -- When Meta last confirmed this row. Shown as "last checked", and the thing
    -- that decides whether a stale cache is worth re-reading before a send.
    synced_at  timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX crm_templates_host_key ON crm_templates (host_id, name, language);
-- Every read is "this host's templates, alphabetically".
CREATE INDEX crm_templates_host_name_idx ON crm_templates (host_id, name);
