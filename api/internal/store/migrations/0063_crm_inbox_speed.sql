/* Inbox speed: saved replies, and snoozing a conversation.
 *
 * crm_snippets are the host's own quick replies, shown as chips above the composer. Plain
 * text: they are only ever sent inside the 24-hour window, where WhatsApp allows the
 * host's own words. Ordered by position so the host's favourites come first.
 *
 * inbox_snoozed_until hides a conversation from "Needs reply" until then. A new message
 * from them wakes it early, which is the same rule Mark done follows: the snooze is about
 * the message the host has already read, not the next one.
 */
CREATE TABLE crm_snippets (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 40),
    body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 4096),
    position   int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_snippets_host_idx ON crm_snippets (host_id, position, created_at);

ALTER TABLE crm_contacts
    ADD COLUMN inbox_snoozed_until timestamptz,
    ADD COLUMN inbox_snoozed_at    timestamptz;
