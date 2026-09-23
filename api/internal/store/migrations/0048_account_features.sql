-- Per-account feature switches, and the one thing a host can ask us to do to their
-- WhatsApp number.
--
-- Everything in the CRM so far has been on for every host who connected WhatsApp.
-- That was fine while the whole of it was "send the messages this host asked for",
-- and it stops being fine here: the features added alongside this migration label
-- other people, write to everybody who registered for a webinar, and register a
-- phone number with Meta using a PIN. Whether an account may do those is a decision
-- somebody has to make per customer, so it is recorded per customer.
--
-- A text[] of keys rather than a boolean column each.
--
-- can_host and can_cdn_broadcast are columns because they are part of what an account
-- IS, and there are two of them. These are switches on individual pieces of one
-- product area, and the list grows with every phase: as columns, each new one would
-- be a migration, a scan list, an endpoint and a response field, and the twelfth
-- would still need all four. As keys, a new switch is a constant in api/types and
-- nothing here. The cost is that the database no longer enumerates the valid values —
-- there is no CHECK against a list that only the application knows — so the API
-- refuses an unknown key before it is ever written. See types.Features.
--
-- Absent means off, and nothing defaults to on. Every switch either spends the host's
-- money or writes to somebody else's phone, so an administrator turning one on is the
-- record that a person decided to.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS features text[] NOT NULL DEFAULT '{}';

/* When this host's WhatsApp number was registered with Cloud API from here.
 *
 * A number created inside the Embedded Signup dialog cannot send anything until it has
 * been registered, and Meta's register call takes a six-digit two-step verification
 * PIN. The PIN is NOT here, and there is no column for it anywhere: the host chooses
 * it, types it into the connect flow, and it is passed straight to Meta. Storing it
 * would mean keeping the second factor for somebody else's WhatsApp Business Account
 * in our database, which is a liability with no matching use — nothing this server does
 * later needs it, and Meta's own two-step settings is where it is changed.
 *
 * NULL for every number that was already registered when it was connected, which is
 * every number a host migrated in. This says "we did this", not "this number works".
 */
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS whatsapp_registered_at timestamptz;
