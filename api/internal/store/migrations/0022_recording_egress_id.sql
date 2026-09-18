-- Egress ID for server-side recording via LiveKit Egress.
--
-- When a recording is driven server-side by LiveKit Egress, this holds the
-- egress_id returned by StartRoomCompositeEgress so StopEgress and the
-- webhook handler can match the egress event back to this recording row.
ALTER TABLE recordings ADD COLUMN egress_id text;
CREATE INDEX recordings_egress_id_idx ON recordings (egress_id) WHERE egress_id IS NOT NULL;
