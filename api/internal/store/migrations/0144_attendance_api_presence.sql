-- When this attendee was last heard from over the API rather than seen on the video server:
-- the presence poll an attendee's browser sends while its LiveKit connection is down
-- (api/internal/api/presence.go). The host's Participants panel lists anyone heard from in the
-- last minute beside the people LiveKit reports, so somebody who can still chat and raise a
-- hand is never missing from it, and can be brought to the stage. The polls stop when they
-- leave, and the minute runs out.
ALTER TABLE attendance ADD COLUMN api_seen_at timestamptz;
