/* Calling (31 Oct 2026, docs/calling.md): a host rings another account into a meeting.
 *
 * One row per call. It rings for 45 seconds (expires_at) and ends in exactly one of accepted,
 * declined, cancelled or missed; the move out of ringing is a conditional UPDATE, so two
 * devices answering at once cannot both win. The callee gets a seat on the meeting's panel for
 * the length of the ring (added_panelist remembers that the call gave it, so a call that is not
 * answered takes back only what it gave). The rows are also the abuse limits: calls per caller
 * per hour, and the callee's declines of that caller in a row.
 *
 * push_messages carries a call's machine data (data) and whether the apps get it as a data
 * message with no notification of their own to draw (data_only): see store.PushMessage.
 */
CREATE TABLE calls (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    caller_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    webinar_id     uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    state          text NOT NULL DEFAULT 'ringing'
                   CHECK (state IN ('ringing', 'accepted', 'declined', 'cancelled', 'missed')),
    added_panelist boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    ended_at       timestamptz,
    CHECK (caller_id <> callee_id)
);
CREATE INDEX calls_caller_idx ON calls (caller_id, created_at DESC);
CREATE INDEX calls_pair_idx ON calls (callee_id, caller_id, created_at DESC);
CREATE INDEX calls_ringing_idx ON calls (expires_at) WHERE state = 'ringing';
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

ALTER TABLE push_messages
    ADD COLUMN data jsonb,
    ADD COLUMN data_only boolean NOT NULL DEFAULT false;
